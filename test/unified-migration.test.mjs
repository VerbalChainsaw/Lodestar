import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { decisionProjection } from "../src/decision.mjs";
import { importUnified } from "../src/legacy-v070/unified.mjs";
import { resolveProject } from "../src/project.mjs";
import { getRecordById, putRecord } from "../src/records.mjs";
import { workStatus } from "../src/work.mjs";

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};
const packet = {
  goal: "Continue after migration",
  rules: ["Preserve current work"],
  entries: [{ key: "database", state: "fact", text: "Use SQLite", scope: ["project"],
    generation: 1, provenance: { kind: "repo", sourceRef: "AGENTS.md",
      observedAt: "2026-08-13T12:00:00.000Z" } }],
  work: { completed: [], current: ["migration"], files: [] },
  nextMove: "Verify the imported lane",
  evidence: [],
};
async function legacyKnowledge(directory) {
  const generation = "a".repeat(64), source = path.join(directory, "knowledge");
  const root = path.join(source, "generations", generation);
  await writeJson(path.join(source, "current.json"), { v: 1, generation });
  await writeJson(path.join(root, "catalog.json"), { v: 1, projects: [] });
  await writeJson(path.join(root, "schema", "store.json"), { v: 1,
    record: "context-record" });
  await mkdir(path.join(root, "records", "projects"), { recursive: true });
  await writeFile(path.join(root, "records", "global.jsonl"), `${JSON.stringify({
    v: 1, id: "g:migrated", kind: "rule", priority: 100, scope: ["global"],
    links: [], aliases: ["migrated-rule"], summary: "Keep this knowledge." })}\n`);
  await writeJson(path.join(root, "indexes", "locator-health.json"), {
    v: 1, generation, locators: {},
  });
  return source;
}
function workDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE work_sessions (id INTEGER PRIMARY KEY, workspace_key TEXT, "
    + "workspace_name TEXT, actor_key TEXT, agent TEXT, harness TEXT, session_hint TEXT, "
    + "started_at_ms INTEGER, last_seen_at_ms INTEGER, completed_at_ms INTEGER, "
    + "description TEXT, completion_note TEXT, close_reason TEXT, branch TEXT, "
    + "location TEXT, host TEXT, client_version TEXT)");
  db.prepare("INSERT INTO work_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    1, "project", "Project", "codex:old", "codex", "codex", "old",
    Date.parse("2026-08-13T10:00:00.000Z"), Date.parse("2026-08-13T11:00:00.000Z"),
    null, "Continue migration", null, null, "main", ".", "host", "1");
  db.close();
}
async function sourceDatabase(file) {
  await initializeDatabase(file);
  const db = await openWriteDatabase(file);
  putRecord(db, { id: "note:source", type: "note", name: "Source record", scope: "global",
    content: { state: "known", value: { text: "Existing current record" } },
    aliases: [], links: [], sources: [] });
  db.close();
}

test("one manifest imports every legacy state class once with checksums and backups", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-unified-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "destination.db");
  await initializeDatabase(destination);
  const knowledge = await legacyKnowledge(directory);
  const work = path.join(directory, "work.db");
  workDatabase(work);
  const decisions = path.join(directory, "events.jsonl");
  await writeFile(decisions, [
    { v: 1, id: "one", kind: "set", key: "database", value: "SQLite",
      reason: "local", ts: "2026-08-13T10:00:00.000Z" },
    { v: 1, id: "two", kind: "set", key: "database", value: "PostgreSQL",
      reason: "trial", ts: "2026-08-13T11:00:00.000Z" },
    { v: 1, id: "three", kind: "set", key: "database", value: "SQLite",
      reason: "restored", ts: "2026-08-13T12:00:00.000Z" },
  ].map(JSON.stringify).join("\n") + "\n");
  const continuity = path.join(directory, "continuity.json");
  await writeJson(continuity, { v: 1, lanes: [{ ownerSessionId: "old-session", packet }] });
  const current = path.join(directory, "current.db");
  await sourceDatabase(current);
  const projectRoot = path.join(directory, "project");
  await mkdir(projectRoot);
  const project = { scope: "project:migrated", name: "Migrated", root: projectRoot };
  const manifest = path.join(directory, "migration.json");
  await writeJson(manifest, { v: 1, sources: [
    { kind: "knowledge-v070", path: path.relative(directory, knowledge) },
    { kind: "work-sqlite", path: path.basename(work), project },
    { kind: "decision-jsonl", path: path.basename(decisions), project },
    { kind: "continuity-json", path: path.basename(continuity), project },
    { kind: "lodestar-sqlite", path: path.basename(current) },
  ] });

  let serial = 0;
  const options = { sourcePath: manifest, database: destination,
    now: () => new Date("2026-08-13T13:00:00.000Z"), backupId: () => `b${++serial}` };
  const first = await importUnified(options);
  assert.equal(first.committed, true);
  assert.ok(first.sources.every(({ repeated }) => repeated === false));
  await access(first.backup_path);
  const backupHash = createHash("sha256").update(await readFile(first.backup_path)).digest("hex");
  assert.equal(backupHash.length, 64);
  const second = await importUnified(options);
  assert.ok(second.sources.every(({ repeated, count }) => repeated && count === 0));
  await access(second.backup_path);

  const db = await openWriteDatabase(destination);
  assert.equal(getRecordById(db, "g:migrated").id, "g:migrated");
  assert.equal(getRecordById(db, "note:source").id, "note:source");
  assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE type='migration-source'")
    .get().count, 5);
  const resolved = resolveProject(db, projectRoot);
  assert.equal(workStatus(db, resolved).records.length, 1);
  const state = decisionProjection(db, resolved);
  assert.equal(state.facts[0].value, "SQLite");
  assert.deepEqual(state.dead.map(({ value }) => value), ["PostgreSQL"]);
  assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE type='handoff-lane'")
    .get().count, 1);
  db.close();
});
