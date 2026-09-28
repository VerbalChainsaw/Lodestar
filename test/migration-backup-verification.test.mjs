import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SCHEMA_V4_SQL } from "../src/schema.mjs";
import { createMigrationBackup, migrateDatabase, migrationPreflight } from "../src/schema-migration.mjs";

async function v4Store(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-backup-check-"));
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
    "fact:kept", "fact", "Kept", "project:test",
    '{"state":"known","value":{"kept":true},"_lodestar":{"priority":0,"revision":9}}',
    "2026-09-06T09:00:00.000Z", "2026-09-06T09:00:00.000Z",
  );
  raw.close();
  return { directory, file };
}

test("migration refuses backup evidence whose file is missing at the claimed path", async (t) => {
  const { directory, file } = await v4Store(t);
  const preflight = await migrationPreflight(file);
  const backup = await createMigrationBackup(file, path.join(directory, "backup.db"));
  const missing = path.join(directory, "gone.db");
  const request = { v: 5, request_id: "migration:missing-backup",
    preflight, backup: { ...backup, path: missing } };
  await assert.rejects(migrateDatabase(file, { request }),
    ({ code, identifiers }) => code === "migration_source_conflict"
      && identifiers.backup === missing);
  assert.equal((await migrationPreflight(file)).logical_digest, preflight.logical_digest);
});

test("migration refuses a tampered backup that no longer matches its evidence", async (t) => {
  const { directory, file } = await v4Store(t);
  const preflight = await migrationPreflight(file);
  const backupPath = path.join(directory, "backup.db");
  const backup = await createMigrationBackup(file, backupPath);
  const tamper = new DatabaseSync(backupPath);
  tamper.prepare("UPDATE records SET name='Tampered' WHERE id='fact:kept'").run();
  tamper.close();
  const request = { v: 5, request_id: "migration:tampered-backup", preflight, backup };
  await assert.rejects(migrateDatabase(file, { request }),
    ({ code, identifiers }) => code === "migration_source_conflict"
      && identifiers.actual_digest !== undefined
      && identifiers.actual_digest !== identifiers.expected_digest);
  assert.equal((await migrationPreflight(file)).logical_digest, preflight.logical_digest);
});
