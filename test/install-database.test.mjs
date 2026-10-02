import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";
import { migrationPreflight } from "../src/schema-migration.mjs";
import { prepareInstallDatabase } from "../src/install-database.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-install-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, database: path.join(root, "café & selected store.db"),
    backupPath: path.join(root, "accepted backup.db"), migrationRequestPath: path.join(root, "migration.json") };
}
function oldStore(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_V4_SQL);
  const metadata = db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)");
  for (const [key, value] of Object.entries({ schema_version: "4", created_at: "2026-09-30T00:00:00.000Z",
    database_instance_id: "a".repeat(64), database_revision: "9", database_epoch: "b".repeat(64) })) metadata.run(key, value);
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)").run("fact:kept", "fact", "Kept", "project:test",
    '{"state":"known","value":{"kept":true}}', "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
  db.close();
}
test("installer initializes only explicitly and current store validation preserves bytes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareInstallDatabase(f), { code: "database_not_found" });
  assert.equal((await prepareInstallDatabase({ ...f, initialize: true })).created, true);
  const bytes = await readFile(f.database);
  assert.equal((await prepareInstallDatabase(f)).healthy, true);
  assert.deepEqual(await readFile(f.database), bytes);
});
test("schema4 requires explicit migration and independent restore-tested backup", async (t) => {
  const f = await fixture(t); oldStore(f.database);
  const before = await readFile(f.database), evidence = await migrationPreflight(f.database);
  await assert.rejects(prepareInstallDatabase(f), (e) => e.code === "unsupported_schema" && /migrat/i.test(e.action));
  assert.deepEqual(await readFile(f.database), before);
  const result = await prepareInstallDatabase({ ...f, migrate: true });
  assert.equal(result.healthy, true); assert.equal(result.migrated, true);
  assert.equal((await migrationPreflight(f.backupPath)).logical_digest, evidence.logical_digest);
  const db = new DatabaseSync(f.database, { readOnly: true });
  assert.equal(db.prepare("SELECT name FROM records WHERE id='fact:kept'").get().name, "Kept"); db.close();
  const request = await readFile(f.migrationRequestPath);
  assert.equal((await prepareInstallDatabase({ ...f, migrate: true })).replayed, true);
  assert.deepEqual(await readFile(f.migrationRequestPath), request);
});
test("request fsync failure preserves schema4 source and exact backup/request for retry", async (t) => {
  const f = await fixture(t); oldStore(f.database);
  const before = await readFile(f.database);
  const probe = await open(path.join(f.root, "sync-probe"), "wx"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.sync;
  let requestSyncs = 0;
  const mocked = t.mock.method(prototype, "sync", async function () {
    if (existsSync(f.migrationRequestPath)) {
      requestSyncs++;
      throw Object.assign(new Error("injected request fsync failure"), { code: "EIO" });
    }
    return original.call(this);
  });
  try {
    await assert.rejects(prepareInstallDatabase({ ...f, migrate: true }), { code: "EIO" });
    assert.deepEqual(await readFile(f.database), before);
    const request = await readFile(f.migrationRequestPath), backup = await readFile(f.backupPath);
    await assert.rejects(prepareInstallDatabase({ ...f, migrate: true }), { code: "EIO" });
    assert.deepEqual(await readFile(f.database), before);
    assert.deepEqual(await readFile(f.migrationRequestPath), request);
    assert.deepEqual(await readFile(f.backupPath), backup);
    assert.equal(requestSyncs, 2);
    mocked.mock.restore();
    assert.equal((await prepareInstallDatabase({ ...f, migrate: true })).healthy, true);
    assert.deepEqual(await readFile(f.migrationRequestPath), request);
    assert.deepEqual(await readFile(f.backupPath), backup);
  } finally { mocked.mock.restore(); }
});
for (const fault of ["AfterBackup", "AfterRequest", "AfterMigration"]) {
  test(`saved migration request reconciles interruption ${fault}`, async (t) => {
    const f = await fixture(t); oldStore(f.database);
    await assert.rejects(prepareInstallDatabase({ ...f, migrate: true, fault }), { code: "install_interrupted" });
    const request = fault === "AfterBackup" ? null : await readFile(f.migrationRequestPath);
    assert.equal((await prepareInstallDatabase({ ...f, migrate: true })).healthy, true);
    if (request) assert.deepEqual(await readFile(f.migrationRequestPath), request);
  });
}
test("future schema, corrupt input, foreign request and occupied backup preserve evidence", async (t) => {
  const f = await fixture(t); oldStore(f.database);
  const db = new DatabaseSync(f.database); db.exec("UPDATE metadata SET value='99' WHERE key='schema_version'"); db.close();
  let before = await readFile(f.database);
  await assert.rejects(prepareInstallDatabase({ ...f, migrate: true }), { code: "unsupported_schema" });
  assert.deepEqual(await readFile(f.database), before);
  await writeFile(f.database, "corrupt"); before = await readFile(f.database);
  await assert.rejects(prepareInstallDatabase({ ...f, migrate: true }));
  assert.deepEqual(await readFile(f.database), before);
  await rm(f.database); oldStore(f.database);
  await writeFile(f.backupPath, "foreign backup");
  await assert.rejects(prepareInstallDatabase({ ...f, migrate: true }), { code: "migration_backup_conflict" });
  assert.equal(await readFile(f.backupPath, "utf8"), "foreign backup");
  await writeFile(f.migrationRequestPath, '{"v":5,"request_id":"foreign","preflight":{"source":{"path":"elsewhere"}},"backup":{}}');
  await assert.rejects(prepareInstallDatabase({ ...f, migrate: true }), { code: "install_request_conflict" });
});
