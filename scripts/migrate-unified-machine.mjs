import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { initializeDatabase, openConnection, transaction } from "../src/database.mjs";
import { convertV070 } from "../src/legacy-v070/convert.mjs";
import { readV070Store } from "../src/legacy-v070/read.mjs";
import { resolveProject } from "../src/project.mjs";
import { writeRecordSnapshot } from "../src/records.mjs";
import { allocateRevision } from "../src/revisions.mjs";

const local = process.env.LOCALAPPDATA;
const profile = process.env.USERPROFILE;
if (!local || !profile) throw new Error("LOCALAPPDATA and USERPROFILE are required");
const live = process.env.LODESTAR_MIGRATION_LIVE ?? path.join(local, "Lodestar", "lodestar.db");
const legacy = process.env.LODESTAR_MIGRATION_LEGACY ?? path.join(profile, ".lodestar");
const glimpse = process.env.LODESTAR_MIGRATION_GLIMPSE
  ?? path.join(local, "Glimpse", "glimpse.db");
const mode = process.argv[2] ?? "--dry-run";
if (!["--dry-run", "--stage"].includes(mode)) {
  throw new Error("Use --dry-run or --stage");
}
const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
const backupRoot = process.env.LODESTAR_MIGRATION_BACKUPS
  ?? path.join(local, "Lodestar", "backups");
const backup = path.join(backupRoot, `unified-${stamp}`);
const stage = mode === "--stage" ? path.join(backup, "lodestar-unified.db")
  : path.join(local, "Lodestar", `lodestar-unified-dryrun-${process.pid}.db`);
const expectedMissing = Number(process.env.LODESTAR_MIGRATION_EXPECTED_MISSING ?? 15);

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
async function treeDigest(root) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name), absolute = path.join(directory, entry.name);
      hash.update(relative);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) hash.update(await readFile(absolute));
      else throw new Error(`Unsupported legacy entry: ${absolute}`);
    }
  }
  await visit(root);
  return hash.digest("hex");
}
const iso = (milliseconds, fallback) => Number.isFinite(milliseconds)
  ? new Date(milliseconds).toISOString() : fallback;
const shortHash = (value) => createHash("sha256").update(String(value))
  .digest("hex").slice(0, 20);
const isAbsoluteWorkspaceLocation = (value) => {
  const location = String(value ?? "").trim();
  return /^[A-Za-z]:[\\/]/u.test(location)
    || /^\/mnt\/[A-Za-z](?:\/|$)/u.test(location)
    || /^\\\\(?:wsl(?:\.localhost)?\$)[\\/]/iu.test(location);
};
const parse = (text) => JSON.parse(text);
function boundedName(value) {
  let result = "";
  for (const character of String(value)) {
    if (Buffer.byteLength(result + character, "utf8") > 256) break;
    result += character;
  }
  return result;
}

function liveRecords(db) {
  const aliases = db.prepare("SELECT alias FROM aliases WHERE record_id=? ORDER BY alias");
  const sources = db.prepare("SELECT origin,freshness,metadata_json FROM sources "
    + "WHERE record_id=? ORDER BY origin");
  return db.prepare("SELECT * FROM records ORDER BY id").all().map((row) => ({
    record: { id: row.id, type: row.type, name: row.name, scope: row.scope,
      content: parse(row.content_json), aliases: aliases.all(row.id).map(({ alias }) => alias),
      links: [], sources: sources.all(row.id).map((source) => ({ origin: source.origin,
        freshness: source.freshness, metadata: parse(source.metadata_json) })) },
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

function availableAliases(db, record) {
  const aliasOwner = db.prepare("SELECT 1 ok FROM aliases WHERE alias=?");
  const recordOwner = db.prepare("SELECT 1 ok FROM records WHERE id=?");
  return record.aliases.filter((alias) => alias !== record.id
    && !aliasOwner.get(alias) && !recordOwner.get(alias));
}

function workRecord(row, project, fallback) {
  const startedAt = iso(row.started_at_ms, fallback);
  const updatedAt = iso(row.completed_at_ms ?? row.last_seen_at_ms, startedAt);
  return {
    record: { id: `work:glimpse:${row.id}`, type: "work",
      name: boundedName(row.description || row.completion_note || `Glimpse work ${row.id}`),
      scope: project.scope, content: { state: "known", value: {
        status: row.completed_at_ms === null ? "open" : "closed", actor: row.actor_key,
        agent: row.agent, harness: row.harness, session: row.session_hint,
        current_work: row.description, completion: row.completion_note,
        close_reason: row.close_reason, workspace_key: row.workspace_key,
        workspace_name: row.workspace_name, branch: row.branch, location: row.location,
        host: row.host, client_version: row.client_version, started_at: startedAt,
        last_seen_at: iso(row.last_seen_at_ms, startedAt),
        completed_at: row.completed_at_ms === null ? null : iso(row.completed_at_ms, updatedAt),
        legacy_history_id: Number(row.id),
      } }, aliases: [], links: [], sources: [] }, createdAt: startedAt, updatedAt,
  };
}

async function build() {
  const before = { live: await digest(live), legacy: await treeDigest(legacy),
    glimpse: await digest(glimpse) };
  const source = await readV070Store(legacy), converted = convertV070(source).records;
  const generationTime = (await stat(path.join(legacy, "generations", source.generation)))
    .mtime.toISOString();
  const sourceDb = new DatabaseSync(live, { readOnly: true });
  const liveCount = Number(sourceDb.prepare("SELECT count(*) n FROM records").get().n);
  if (liveCount !== 885) throw new Error(`Expected 885 authoritative records, got ${liveCount}`);
  const originals = liveRecords(sourceDb);
  const originalLinks = sourceDb.prepare("SELECT * FROM links ORDER BY from_id,relationship,to_id").all();
  sourceDb.close();
  const glimpseDb = new DatabaseSync(glimpse, { readOnly: true });
  const workRows = glimpseDb.prepare("SELECT * FROM work_sessions ORDER BY started_at_ms,id")
    .all().map((row) => ({ ...row }));
  glimpseDb.close();

  if (mode === "--stage") {
    await mkdir(backup, { recursive: true });
    await copyFile(live, path.join(backup, "lodestar-before.db"));
    await copyFile(glimpse, path.join(backup, "glimpse.db"));
    await cp(legacy, path.join(backup, "generation-store"), { recursive: true, errorOnExist: true });
    const copied = { live: await digest(path.join(backup, "lodestar-before.db")),
      legacy: await treeDigest(path.join(backup, "generation-store")),
      glimpse: await digest(path.join(backup, "glimpse.db")) };
    if (JSON.stringify(before) !== JSON.stringify(copied)) {
      throw new Error("A recovery backup does not match its source");
    }
  }

  await initializeDatabase(stage);
  const db = openConnection(stage);
  let missingCount = 0;
  transaction(db, () => {
    for (const item of originals) writeRecordSnapshot(db, item.record, {
      createdAt: item.createdAt, updatedAt: item.updatedAt,
      revision: allocateRevision(db), enforceRecordLimit: false,
    });
    const known = new Set(originals.map(({ record }) => record.id));
    const missing = converted.filter(({ id }) => !known.has(id)).sort((a, b) =>
      a.id.localeCompare(b.id));
    for (const original of missing) {
      const record = { ...original, aliases: availableAliases(db, original), links: [] };
      writeRecordSnapshot(db, record, { createdAt: generationTime, updatedAt: generationTime,
        revision: allocateRevision(db), enforceRecordLimit: false });
      known.add(record.id); missingCount += 1;
    }
    for (const row of workRows) {
      const project = isAbsoluteWorkspaceLocation(row.location) ? resolveProject(db, row.location) : {
        scope: `project:workspace:${shortHash(row.workspace_key)}`, cwd: row.location };
      const item = workRecord(row, project, generationTime);
      writeRecordSnapshot(db, item.record, { createdAt: item.createdAt, updatedAt: item.updatedAt,
        revision: allocateRevision(db), enforceRecordLimit: false });
      known.add(item.record.id);
    }
    const link = db.prepare("INSERT OR IGNORE INTO links(from_id,relationship,to_id,created_at) "
      + "VALUES (?,?,?,?)");
    for (const item of originalLinks) {
      link.run(item.from_id, item.relationship, item.to_id, item.created_at);
    }
    for (const record of missing) for (const item of record.links) {
      if (known.has(item.to_id)) link.run(record.id, item.relationship, item.to_id, generationTime);
    }
    const ordered = db.prepare("SELECT id,content_json FROM records "
      + "ORDER BY updated_at,id COLLATE BINARY").all();
    const revise = db.prepare("UPDATE records SET content_json=? WHERE id=?");
    ordered.forEach((row, index) => {
      const content = parse(row.content_json);
      content._lodestar = { ...content._lodestar, revision: index + 1 };
      revise.run(JSON.stringify(content), row.id);
    });
    db.prepare("UPDATE metadata SET value=? WHERE key='database_revision'")
      .run(String(ordered.length));
  }, stage);
  const integrity = db.prepare("PRAGMA integrity_check").all();
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  const counts = { records: Number(db.prepare("SELECT count(*) n FROM records").get().n),
    knowledge: Number(db.prepare("SELECT count(*) n FROM records WHERE type!='work'").get().n),
    work: Number(db.prepare("SELECT count(*) n FROM records WHERE type='work'").get().n),
    aliases: Number(db.prepare("SELECT count(*) n FROM aliases").get().n),
    links: Number(db.prepare("SELECT count(*) n FROM links").get().n),
    sources: Number(db.prepare("SELECT count(*) n FROM sources").get().n) };
  const required = ["g:codex:context", "g:codex:engineering", "g:user:work-style",
    "p:agent-context", "g:project:durable-handoff", "g:project:jordanmcp:control-link-20260811",
    "p:agent-context:memory:lodestar-v1.0.3-codex-installation"];
  const missingRequired = required.filter((id) =>
    !db.prepare("SELECT 1 ok FROM records WHERE id=?").get(id));
  const continuityRows = ["continuity_lanes", "continuity_packets", "continuity_transfers",
    "continuity_events"].reduce((total, table) => total
      + Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n), 0);
  db.close();
  if (missingCount !== expectedMissing) {
    throw new Error(`Expected ${expectedMissing} restored records, got ${missingCount}`);
  }
  if (counts.records !== liveCount + missingCount + workRows.length
    || counts.work !== workRows.length) throw new Error(`Unified count mismatch: ${JSON.stringify(counts)}`);
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || foreignKeys.length) {
    throw new Error("Unified database integrity verification failed");
  }
  if (missingRequired.length) throw new Error(`Missing representative records: ${missingRequired}`);
  if (continuityRows !== 0) throw new Error("Fresh database contains legacy continuity rows");
  const after = { live: await digest(live), legacy: await treeDigest(legacy),
    glimpse: await digest(glimpse) };
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("A source changed during migration");
  const result = { ok: true, mode, stage, backup: mode === "--stage" ? backup : null,
    counts, restored_generation_records: missingCount, imported_work_records: workRows.length,
    source_hashes: before };
  if (mode === "--dry-run") await unlink(stage);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await build();
