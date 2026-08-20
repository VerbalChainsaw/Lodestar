import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { beginImmediate, commit, openConnection, rollback } from "../database.mjs";
import { diagnoseDatabase } from "../doctor.mjs";
import { lodestarError } from "../errors.mjs";
import { canonicalStringify } from "../json.mjs";
import { hash, recordInput } from "../project.mjs";
import { coercePutRecord, getRecordById, normalizeRecord,
  writeRecordSnapshot } from "../records.mjs";
import { allocateRevision } from "../revisions.mjs";
import { createSchema } from "../schema.mjs";
import { createHandoffPacket } from "../continuity.mjs";
import { convertV070 } from "./convert.mjs";
import { readV070Store } from "./read.mjs";

const KINDS = new Set([
  "knowledge-v070", "work-sqlite", "decision-jsonl", "continuity-json", "lodestar-sqlite",
]);
const checksum = (value) => createHash("sha256").update(value).digest("hex");
const exists = async (file) => lstat(file).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
async function files(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw lodestarError("invalid_input",
      "Migration sources may not contain symbolic links.");
    if (entry.isDirectory()) found.push(...await files(root, absolute));
    else if (entry.isFile()) found.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return found.sort((left, right) => left.localeCompare(right));
}
async function fingerprint(source) {
  const resolved = await realpath(source.path);
  const info = await lstat(resolved);
  const inventory = info.isDirectory() ? await files(resolved) : [""];
  const digest = createHash("sha256");
  let bytes = 0;
  for (const relative of inventory) {
    const file = relative ? path.join(resolved, relative) : resolved;
    digest.update(relative).update("\0");
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.byteLength;
      digest.update(chunk);
    }
    digest.update("\0");
  }
  return { ...source, path: resolved, checksum: digest.digest("hex"), bytes,
    files: inventory.length };
}
function project(source) {
  const value = typeof source.project === "string"
    ? { scope: source.project } : source.project;
  if (!value || typeof value.scope !== "string" || !value.scope.startsWith("project:")) {
    throw lodestarError("invalid_input", `${source.kind} requires a canonical project scope.`);
  }
  return value;
}
function timestamp(value) {
  const date = value === null || value === undefined ? null : new Date(value);
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function inputShape(record) {
  return coercePutRecord(record);
}
function sameRecord(left, right) {
  const clean = (value) => {
    const copy = structuredClone(value);
    delete copy.content.value._lodestar;
    return copy;
  };
  return canonicalStringify(clean(left)) === canonicalStringify(clean(right));
}
function write(db, value, createdAt, updatedAt) {
  const current = db.prepare("SELECT id FROM records WHERE id=?").get(value.id);
  if (current) {
    if (!sameRecord(inputShape(normalizeRecord(getRecordById(db, value.id))), value)) {
      throw lodestarError("migration_conflict", "A migrated record conflicts with live state.",
        { identifiers: { id: value.id } });
    }
    return false;
  }
  writeRecordSnapshot(db, { ...value, links: [] }, { createdAt, updatedAt,
    revision: allocateRevision(db), enforceRecordLimit: false });
  return true;
}
function insertLinks(db, records, createdAt) {
  const insert = db.prepare("INSERT OR IGNORE INTO links VALUES (?, ?, ?, ?)");
  for (const record of records) for (const link of record.links ?? []) {
    insert.run(record.id, link.relationship, link.to_id, createdAt);
  }
}
function ensureProject(db, value, now) {
  if (db.prepare("SELECT id FROM records WHERE id=?").get(value.scope)) return;
  const root = value.root ? path.resolve(value.root) : null;
  write(db, recordInput(value.scope, "project", value.name ?? value.scope,
    "global", 1000, { roots: root ? [root] : [], migrated: true }), now, now);
}
function readSqlite(source) {
  const db = openConnection(source.path, { readOnly: true, writeIntent: false });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all().map(({ name }) => name));
    if (source.kind === "work-sqlite") {
      if (!tables.has("work_sessions")) throw new Error("work_sessions is missing");
      return db.prepare("SELECT * FROM work_sessions ORDER BY id").all();
    }
    if (!tables.has("records")) throw new Error("records is missing");
    return db.prepare("SELECT id FROM records ORDER BY id").all()
      .map(({ id }) => inputShape(normalizeRecord(getRecordById(db, id))));
  } finally { db.close(); }
}
async function prepareSource(source) {
  const locked = await fingerprint(source);
  if (source.kind === "knowledge-v070") {
    const legacy = await readV070Store(locked.path);
    return { ...locked, records: convertV070(legacy).records };
  }
  if (source.kind === "work-sqlite" || source.kind === "lodestar-sqlite") {
    return { ...locked, rows: readSqlite(locked) };
  }
  const text = await readFile(locked.path, "utf8");
  if (source.kind === "decision-jsonl") {
    const rows = text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch {
        throw lodestarError("invalid_input", `Decision event line ${index + 1} is invalid.`);
      }
    });
    return { ...locked, rows };
  }
  return { ...locked, value: JSON.parse(text) };
}
function migrationId(source) {
  return `migration-source:${checksum(`${source.kind}\0${source.path}\0${source.checksum}`)}`;
}
function importKnowledge(db, source, now) {
  const records = source.records ?? source.rows;
  let count = 0;
  for (const record of records) if (write(db, record, now, now)) count += 1;
  insertLinks(db, records, now);
  return count;
}
function importWork(db, source, now) {
  const target = project(source);
  ensureProject(db, target, now);
  let count = 0;
  for (const row of source.rows) {
    const id = `work:migrated:${hash(`${source.checksum}\0${row.id}`, 32)}`;
    const started = timestamp(row.started_at_ms) ?? now;
    const seen = timestamp(row.last_seen_at_ms) ?? started;
    const completed = timestamp(row.completed_at_ms);
    const value = recordInput(id, "work", `${row.agent}: ${row.description}`,
      target.scope, 0, { status: completed ? "closed" : "open", actor: row.actor_key,
        agent: row.agent, harness: row.harness, session: row.session_hint,
        current_work: row.description, completion: row.completion_note ?? null,
        close_reason: row.close_reason ?? null, branch: row.branch ?? null,
        location: row.location ?? target.root ?? null, started_at: started,
        last_seen_at: seen, completed_at: completed });
    if (write(db, value, started, completed ?? seen)) count += 1;
  }
  return count;
}
function importDecisions(db, source, now) {
  const target = project(source);
  ensureProject(db, target, now);
  let count = 0;
  for (const [index, row] of source.rows.entries()) {
    if (!["set", "drop"].includes(row.kind)) throw lodestarError("invalid_input",
      "A decision migration event has an unsupported operation.");
    const id = `decision:migrated:${hash(`${source.checksum}\0${row.id ?? index}`, 32)}`;
    const recorded = timestamp(row.ts) ?? now;
    const value = recordInput(id, "decision-event", `Decision event ${index + 1}`,
      target.scope, 900, { v: 1, event_id: id, actor: "migration", session: "migration",
        recorded_at: recorded, event: row.kind, key: row.key,
        value: row.kind === "set" ? row.value : null, reason: row.reason ?? "" });
    if (write(db, value, recorded, recorded)) count += 1;
  }
  return count;
}
function importContinuity(db, source, now) {
  const target = project(source);
  ensureProject(db, target, now);
  const entries = source.value.recoveries ?? source.value.lanes ?? [];
  let count = 0;
  for (const [index, entry] of entries.entries()) {
    const owner = entry.sourceSession ?? entry.ownerSessionId;
    const identity = { session: owner, actor: entry.sourceActor ?? `migration:${owner}` };
    const packet = createHandoffPacket({ scope: target.scope, cwd: target.root ?? null },
      identity, entry.packet, null, { items: [], omitted: 0, cursor: index + 1 }, now);
    const packetRecord = recordInput(`handoff-packet:${hash(packet.id, 40)}`, "handoff-packet",
      `Continuity packet ${packet.id}`, target.scope, 1000, { packet });
    const created = packet.integrity.created_at;
    if (write(db, packetRecord, created, created)) count += 1;
    const laneId = `handoff-lane:${hash(`${source.checksum}\0${owner}\0${index}`, 32)}`;
    const lane = recordInput(laneId, "handoff-lane", `Continuity lane ${index + 1}`,
      target.scope, 1000, { v: 1, project: target.scope, owner_session: owner,
        owner_actor: entry.sourceActor ?? `migration:${owner}`, state: "armed",
        active_packet_id: packet.id, created_at: now, updated_at: now });
    if (write(db, lane, now, now)) count += 1;
  }
  return count;
}
function applySource(db, source, now) {
  const id = migrationId(source);
  if (db.prepare("SELECT id FROM records WHERE id=?").get(id)) return { repeated: true, count: 0 };
  let count;
  if (["knowledge-v070", "lodestar-sqlite"].includes(source.kind)) {
    count = importKnowledge(db, source, now);
  } else if (source.kind === "work-sqlite") count = importWork(db, source, now);
  else if (source.kind === "decision-jsonl") count = importDecisions(db, source, now);
  else count = importContinuity(db, source, now);
  const record = recordInput(id, "migration-source", `Migration ${source.kind}`,
    "global", 1000, { kind: source.kind, source_path: source.path,
      source_checksum: source.checksum, source_bytes: source.bytes,
      source_files: source.files, imported_count: count, migrated_at: now });
  write(db, record, now, now);
  return { repeated: false, count };
}
async function manifest(sourcePath) {
  const file = await realpath(sourcePath);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value?.v !== 1 || !Array.isArray(value.sources) || value.sources.length === 0) {
    throw lodestarError("invalid_input", "The unified migration manifest is invalid.");
  }
  const sources = value.sources.map((source) => {
    if (!KINDS.has(source.kind) || typeof source.path !== "string") {
      throw lodestarError("invalid_input", "A migration source entry is invalid.");
    }
    return { ...source, path: path.resolve(path.dirname(file), source.path) };
  });
  return { file, sources };
}
export async function importUnified({ sourcePath, database, dryRun = false,
  now = () => new Date(), backupId = randomUUID }) {
  const plan = await manifest(sourcePath);
  const prepared = [];
  for (const source of plan.sources) prepared.push(await prepareSource(source));
  const date = now(), migratedAt = date.toISOString();
  let backup = null, db;
  if (dryRun) {
    db = openConnection(":memory:");
    createSchema(db, { createdAt: migratedAt });
  } else {
    if (!await exists(database)) throw lodestarError("database_not_found",
      "Initialize Lodestar before importing a unified migration manifest.");
    backup = `${database}.import-${migratedAt.replace(/[-:.]/gu, "")}-${backupId()}.bak`;
    await copyFile(database, backup, fsConstants.COPYFILE_EXCL);
    db = openConnection(database, { writeIntent: true });
  }
  beginImmediate(db, database);
  try {
    const results = prepared.map((source) => ({ kind: source.kind,
      checksum: source.checksum, ...applySource(db, source, migratedAt) }));
    const report = diagnoseDatabase(db, { database });
    if (!report.healthy) throw lodestarError("import_validation_failed",
      `Unified migration failed: ${report.issues.map(({ code }) => code).join(", ")}.`,
      { identifiers: { issues: report.issues } });
    for (let index = 0; index < prepared.length; index += 1) {
      const verified = await fingerprint(plan.sources[index]);
      if (verified.checksum !== prepared[index].checksum) throw lodestarError(
        "migration_source_changed", "A migration source changed before commit.");
    }
    if (dryRun) rollback(db);
    else commit(db, database);
    return { dry_run: dryRun, committed: !dryRun, manifest: plan.file,
      backup_path: backup, sources: results, doctor_ok: true };
  } catch (error) {
    rollback(db);
    throw error;
  } finally { db.close(); }
}
