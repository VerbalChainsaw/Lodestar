import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  initializeDatabase,
  migrateDatabase,
  openReadDatabase,
} from "../src/database.mjs";
import { CONTINUITY_SCHEMA_SQL } from "../src/continuity-schema.mjs";
import { LEGACY_SCHEMA_SQL } from "../src/schema.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-v1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lodestar.db");
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  db.exec(LEGACY_SCHEMA_SQL);
  const metadata = db.prepare(
    "INSERT INTO metadata(key, value) VALUES (?, ?)",
  );
  metadata.run("schema_version", "1");
  metadata.run("created_at", "2026-07-30T10:00:00.000Z");
  db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "record:preserved",
    "note",
    "Preserved",
    "global",
    '{"state":"known","value":"kept"}',
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
  );
  db.close();
  return { directory, file };
}

test("a schema-v1 database backs up, migrates once, and preserves registry data", async (t) => {
  const { directory, file } = await fixture(t);
  const now = () => new Date("2026-08-12T20:10:00.000Z");
  const snapshot = async () => ({
    digest: createHash("sha256").update(await readFile(file)).digest("hex"),
    entries: (await readdir(directory)).sort(),
  });
  const beforeRead = await snapshot();
  await assert.rejects(
    openReadDatabase(file),
    ({ code }) => code === "unsupported_schema",
  );
  assert.deepEqual(await snapshot(), beforeRead);

  const initialized = await initializeDatabase(file, { now });
  const first = initialized.migration;
  assert.equal(first.migrated, true);
  assert.equal(first.from_schema_version, 1);
  assert.equal(first.schema_version, 3);
  assert.match(first.database_instance_id, /^[0-9a-f]{64}$/u);
  await access(first.backup_path);

  const backup = new DatabaseSync(first.backup_path, { readOnly: true });
  assert.equal(
    backup.prepare("SELECT value FROM metadata WHERE key = ?")
      .get("schema_version").value,
    "1",
  );
  assert.equal(
    backup.prepare("SELECT id FROM records").get().id,
    "record:preserved",
  );
  backup.close();

  const db = await openReadDatabase(file);
  assert.equal(
    db.prepare("SELECT id FROM records").get().id,
    "record:preserved",
  );
  assert.equal(
    db.prepare("SELECT value FROM metadata WHERE key = ?")
      .get("schema_version").value,
    "3",
  );
  db.close();

  const before = (await readdir(directory)).sort();
  const second = await migrateDatabase(file, { now });
  assert.equal(second.migrated, false);
  assert.equal(second.backup_path, null);
  assert.equal(second.database_instance_id, first.database_instance_id);
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test("a backup failure blocks schema migration without changing schema v1", async (t) => {
  const { file } = await fixture(t);
  await assert.rejects(
    migrateDatabase(file, {
      copy: async () => {
        throw new Error("injected backup failure");
      },
    }),
    ({ code, identifiers }) =>
      code === "migration_backup_failed"
      && identifiers.database === file,
  );
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db.prepare("SELECT value FROM metadata WHERE key = ?")
      .get("schema_version").value,
    "1",
  );
  assert.equal(
    db.prepare(
      "SELECT count(*) AS count FROM sqlite_schema "
        + "WHERE name LIKE 'continuity_%'",
    ).get().count,
    0,
  );
  db.close();
});

test("an empty schema-v2 database retires its specialized continuity tables", async (t) => {
  const { directory, file } = await fixture(t);
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  raw.exec(CONTINUITY_SCHEMA_SQL);
  raw.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run("database_instance_id", "a".repeat(64));
  raw.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run("database_revision", "17");
  raw.prepare("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
  raw.close();

  const migration = await migrateDatabase(file, {
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(migration.from_schema_version, 2);
  assert.equal(migration.schema_version, 3);
  await access(migration.backup_path);
  const db = await openReadDatabase(file);
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value, "17");
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema "
    + "WHERE name LIKE 'continuity_%'").get().count, 0);
  assert.equal(db.prepare("SELECT id FROM records").get().id, "record:preserved");
  db.close();
  assert.ok((await readdir(directory)).some((name) => name.includes(".schema-v2-")));
});

test("schema-v2 migration halts rather than dropping nonempty continuity state", async (t) => {
  const { file } = await fixture(t);
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  raw.exec(CONTINUITY_SCHEMA_SQL);
  const metadata = raw.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  metadata.run("database_instance_id", "b".repeat(64));
  metadata.run("database_revision", "0");
  raw.prepare("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
  raw.prepare("INSERT INTO continuity_lanes VALUES (?,?,?,?,?,?,?,?)").run(
    "lane", "project:test", "session", "inert", null, 1,
    "2026-08-13T12:00:00.000Z", "2026-08-13T12:00:00.000Z",
  );
  raw.close();

  await assert.rejects(migrateDatabase(file), ({ code, identifiers }) =>
    code === "migration_state_conflict"
      && identifiers.counts.continuity_lanes === 1);
  const unchanged = new DatabaseSync(file, { readOnly: true });
  assert.equal(unchanged.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, "2");
  assert.equal(unchanged.prepare("SELECT count(*) AS count FROM continuity_lanes").get().count, 1);
  unchanged.close();
});
