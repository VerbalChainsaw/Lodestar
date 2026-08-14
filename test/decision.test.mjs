import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decisionDrop, decisionInjection, decisionProjection, decisionSet,
} from "../src/decision.mjs";
import { diagnoseDatabase } from "../src/doctor.mjs";
import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { resolveIdentity, resolveProject } from "../src/project.mjs";
import { putRecord } from "../src/records.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-decision-"));
  const database = path.join(directory, "lodestar.db");
  await initializeDatabase(database);
  const db = await openWriteDatabase(database);
  t.after(() => db.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  putRecord(db, { id: "project:decision", type: "project", name: "Decision fixture",
    scope: "global", content: { state: "known", value: { roots: [directory] } },
    aliases: [], links: [], sources: [] });
  const project = resolveProject(db, directory);
  const identity = resolveIdentity({ session: "source", agent: "codex", harness: "test" }, {}, true);
  return { db, database, directory, project, identity };
}

test("decision events are append-only and A to B to A suppresses resurrection", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  assert.equal(decisionSet(db, project, identity, "database", "SQLite",
    { database, reason: "embedded" }).changed, true);
  assert.equal(decisionSet(db, project, identity, "database", "PostgreSQL",
    { database, reason: "centralized writes" }).changed, true);
  assert.equal(decisionSet(db, project, identity, "database", "SQLite",
    { database, reason: "local-first" }).changed, true);
  const state = decisionProjection(db, project);
  assert.deepEqual(state.facts.map(({ key, value }) => [key, value]), [["database", "SQLite"]]);
  assert.deepEqual(state.dead.map(({ key, value }) => [key, value]), [["database", "PostgreSQL"]]);
  assert.doesNotMatch(state.projection, /SQLite is DEAD/u);
  assert.match(state.projection, /PostgreSQL is DEAD/u);
  const count = db.prepare("SELECT count(*) AS count FROM records "
    + "WHERE type='decision-event'").get().count;
  assert.equal(count, 3);
  assert.equal(decisionSet(db, project, identity, "database", "SQLite", { database }).changed,
    false);
  assert.equal(db.prepare("SELECT count(*) AS count FROM records "
    + "WHERE type='decision-event'").get().count, count);
});

test("decision drop, injection state, normalization, and doctor remain deterministic", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  decisionSet(db, project, identity, "test_runner", "node:test", { database });
  decisionSet(db, project, identity, "database", "SQLite", { database });
  assert.equal(decisionDrop(db, project, identity, "database",
    { database, reason: "removed" }).changed, true);
  assert.equal(decisionDrop(db, project, identity, "database", { database }).changed, false);
  assert.equal(decisionInjection(db, project, identity, false, { database }).changed, true);
  const disabled = decisionProjection(db, project);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.projection, "");
  assert.deepEqual(disabled.facts.map(({ key }) => key), ["test-runner"]);
  assert.equal(decisionInjection(db, project, identity, true, { database }).changed, true);
  const report = diagnoseDatabase(db, { database });
  assert.equal(report.checks.decisions.healthy, true);
  assert.equal(report.checks.decisions.events, 5);
  assert.equal(report.healthy, true);
});

test("public record mutation cannot rewrite or delete command-owned decision history", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  const written = decisionSet(db, project, identity, "database", "SQLite", { database });
  assert.throws(() => putRecord(db, { id: "manual", type: "decision-event", name: "bad",
    scope: project.scope, content: { state: "known", value: {} }, aliases: [], links: [],
    sources: [] }), { code: "reserved_record_type" });
  assert.equal(written.record.kind, "decision-event");
});
