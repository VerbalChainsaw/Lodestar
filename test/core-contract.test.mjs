import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { createMigrationBackup, migrateDatabase,
  migrationPreflight, promoteRecoveredDatabase, recoveryPreflight } from "../src/schema-migration.mjs";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";
import { deleteRecord, getRawRecord, getRecord, getRecordHistory, putRecord,
  writeBasis } from "../src/records.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-v5-core-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file, {
    now: () => new Date("2026-09-06T10:00:00.000Z"),
  });
  return file;
}

function shortRequest(db, requestId, id, input) {
  return {
    v: 5,
    request_id: requestId,
    write_basis: writeBasis(db, {
      projectScope: "project:test",
      targets: [{ kind: "record", id }],
    }),
    input,
  };
}

test("guarded put replays once, detects stale writes, and preserves retirement history", async (t) => {
  const file = await fixture(t);
  const db = await openWriteDatabase(file);
  const create = shortRequest(db, "request:create", "fact:test", {
    mode: "create",
    record: {
      id: "fact:test",
      kind: "fact",
      name: "Test fact",
      scope: "project:test",
      availability: "known",
      priority: 1,
      data: { command: "node --test" },
      aliases: ["test fact"],
      links: [],
      sources: [],
      semantics: {
        subject: "build:test-command",
        lifecycle: "current",
        context_role: "orientation",
        basis: "asserted",
        applicability: { project: "project:test", checkout: null },
      },
    },
  });
  const first = putRecord(db, create, {
    now: () => new Date("2026-09-06T10:01:00.000Z"),
  });
  assert.equal(first.revision, 1);
  assert.equal(first.request.replayed, false);
  assert.equal(first.data.v, 5);
  assert.equal(first.data.semantics.subject, "build:test-command");

  const replay = putRecord(db, create, {
    now: () => new Date("2026-09-06T10:02:00.000Z"),
  });
  assert.equal(replay.revision, 1);
  assert.equal(replay.request.replayed, true);
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value, "1");

  assert.throws(() => putRecord(db, { ...create, input: {
    ...create.input,
    record: { ...create.input.record, name: "Changed" },
  } }), ({ code }) => code === "request_conflict");

  const staleBasis = create.write_basis;
  assert.throws(() => putRecord(db, {
    v: 5,
    request_id: "request:stale",
    write_basis: staleBasis,
    input: { mode: "update", id: "fact:test",
      set: { data: { command: "npm test" } }, remove: [] },
  }), ({ code }) => code === "revision_conflict");

  const retirement = deleteRecord(db, shortRequest(db, "request:retire", "fact:test", {
    id: "fact:test", reason: "Superseded by current source",
  }), { now: () => new Date("2026-09-06T10:03:00.000Z") });
  assert.equal(retirement.data.retired, true);
  assert.equal(getRecordHistory(db, "fact:test").versions.length, 1);
  assert.equal(getRawRecord(db, "fact:test").raw_associations.aliases[0].alias, "test fact");
  db.close();
});

test("write fences reject old and unadmitted writers while admitted current writes work", async (t) => {
  const file = await fixture(t);
  const old = new DatabaseSync(file);
  assert.throws(() => old.prepare("UPDATE metadata SET value='7' WHERE key='database_revision'").run(),
    /no such function: lodestar_write_contract/u);
  old.close();

  const current = await openWriteDatabase(file);
  assert.throws(() => current.prepare("UPDATE metadata SET value='7' WHERE key='database_revision'").run(),
    /unsafe use of lodestar_write_contract/u);
  const request = shortRequest(current, "request:fenced", "fact:fenced", {
    mode: "create",
    record: { id: "fact:fenced", kind: "fact", name: "Fenced",
      scope: "project:test", availability: "known", data: {}, aliases: [],
      links: [], sources: [], semantics: null },
  });
  assert.equal(putRecord(current, request).data.id, "fact:fenced");
  current.close();
});

test("unrelated target bases do not conflict on the database revision", async (t) => {
  const file = await fixture(t);
  const first = await openWriteDatabase(file);
  const second = await openWriteDatabase(file);
  const firstRequest = shortRequest(first, "request:first", "fact:first", {
    mode: "create", record: { id: "fact:first", kind: "fact", name: "First",
      scope: "project:test", availability: "known", data: {}, aliases: [],
      links: [], sources: [], semantics: null },
  });
  const secondRequest = shortRequest(second, "request:second", "fact:second", {
    mode: "create", record: { id: "fact:second", kind: "fact", name: "Second",
      scope: "project:test", availability: "known", data: {}, aliases: [],
      links: [], sources: [], semantics: null },
  });
  assert.equal(putRecord(first, firstRequest).revision, 1);
  assert.equal(putRecord(second, secondRequest).revision, 2);
  first.close();
  second.close();
});

test("schema-4 migration preserves raw numeric evidence, rejects stale preflight, and replays", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-v4-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.db");
  const raw = new DatabaseSync(file);
  raw.exec(SCHEMA_V4_SQL);
  const metadata = raw.prepare("INSERT INTO metadata(key,value) VALUES(?,?)");
  metadata.run("schema_version", "4");
  metadata.run("created_at", "2026-09-06T09:00:00.000Z");
  metadata.run("database_instance_id", "a".repeat(64));
  metadata.run("database_revision", "9");
  metadata.run("database_epoch", "b".repeat(64));
  raw.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)").run(
    "fact:large", "fact", "Large", "project:test",
    '{"state":"known","value":{"exact":9007199254740993,"sibling":"kept"},"_lodestar":{"priority":0,"revision":9}}',
    "2026-09-06T09:00:00.000Z", "2026-09-06T09:00:00.000Z",
  );
  const retained = raw.prepare("UPDATE records SET name=name WHERE id='fact:large'");

  const preflight = await migrationPreflight(file);
  assert.deepEqual(preflight.numeric_issues.map(({ id, pointer }) => [id, pointer]),
    [["fact:large", "/value/exact"]]);
  const backup = await createMigrationBackup(file, path.join(directory, "source.backup.db"));
  assert.equal(backup.logical_digest, preflight.logical_digest);
  const request = { v: 5, request_id: "migration:one", preflight, backup };
  raw.prepare("UPDATE records SET name='Changed' WHERE id='fact:large'").run();
  await assert.rejects(migrateDatabase(file, { request }),
    ({ code, identifiers }) => code === "migration_source_conflict"
      && identifiers.field === "logical_digest");
  raw.prepare("UPDATE records SET name='Large' WHERE id='fact:large'").run();
  const migrated = await migrateDatabase(file, { request,
    now: () => new Date("2026-09-06T09:10:00.000Z") });
  assert.equal(migrated.schema_version, 5);
  assert.equal(migrated.revision, 10);
  assert.throws(() => retained.run(), /no such function: lodestar_write_contract/u);
  raw.close();

  const current = await openWriteDatabase(file);
  assert.match(getRawRecord(current, "fact:large").raw_record.content_json,
    /9007199254740993/u);
  assert.throws(() => getRecord(current, "fact:large"),
    ({ code, identifiers }) => code === "record_requires_source_correction"
      && identifiers.pointer === "/value/exact");
  current.close();

  const replay = await migrateDatabase(file, { request });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 10);
});

test("recovered-image promotion retains instance identity and allocates one new epoch", async (t) => {
  const file = await fixture(t);
  const db = await openWriteDatabase(file);
  const acceptedPut = shortRequest(db, "request:before-recovery", "fact:kept", {
    mode: "create", record: { id: "fact:kept", kind: "fact", name: "Kept",
      scope: "project:test", availability: "known", data: { kept: true }, aliases: [],
      links: [], sources: [], semantics: null },
  });
  putRecord(db, acceptedPut);
  const oldBasis = writeBasis(db, { projectScope: "project:test", targets: [] });
  const acceptedSource = path.join(path.dirname(file), "accepted-image.db");
  await sqliteBackup(db, acceptedSource);
  db.close();
  const request = { v: 5, request_id: "recovery:one",
    database_instance_id: oldBasis.database_instance_id,
    database_epoch: oldBasis.database_epoch,
    reason: "Promote the fully accounted recovered current-schema image.",
    recovery: await recoveryPreflight(file, acceptedSource) };
  await assert.rejects(promoteRecoveredDatabase(file, { request: { ...request, recovery: {} } }),
    ({ code }) => code === "invalid_mutation_contract");
  const promoted = await promoteRecoveredDatabase(file, { request,
    now: () => new Date("2026-09-06T11:00:00.000Z") });
  assert.equal(promoted.database_instance_id, oldBasis.database_instance_id);
  assert.notEqual(promoted.database_epoch, oldBasis.database_epoch);
  assert.equal(promoted.revision, 2);
  const replay = await promoteRecoveredDatabase(file, { request });
  assert.equal(replay.replayed, true);
  assert.equal(replay.database_epoch, promoted.database_epoch);

  const current = await openWriteDatabase(file);
  assert.throws(() => putRecord(current, acceptedPut),
    ({ code }) => code === "database_epoch_conflict");
  assert.equal(getRecord(current, "fact:kept").content.value.kept, true);
  current.close();
});
