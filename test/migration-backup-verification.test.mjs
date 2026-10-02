import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

for (const alias of ["same-path", "hard-link"]) {
  test(`migration requires a separate backup image (${alias})`, async (t) => {
    const { directory, file } = await v4Store(t);
    const preflight = await migrationPreflight(file);
    const backupPath = alias === "same-path" ? file : path.join(directory, "alias.db");
    if (alias === "hard-link") await link(file, backupPath);
    const bytes = await readFile(file);
    const request = { v: 5, request_id: `migration:${alias}`, preflight,
      backup: { path: backupPath, logical_digest: preflight.logical_digest,
        schema_fingerprint: preflight.schema_fingerprint } };
    await assert.rejects(migrateDatabase(file, { request }), (error) =>
      error.code === "migration_source_conflict" && /separate|independent/i.test(error.action));
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(await readFile(backupPath), bytes);
    assert.equal((await migrationPreflight(file)).schema_version, 4);
  });
}

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

test("backup refuses existing accepted artifact and source aliases without changing bytes", async (t) => {
  const { directory, file } = await v4Store(t);
  const backupPath = path.join(directory, "accepted.db");
  await createMigrationBackup(file, backupPath);
  const priorBytes = await readFile(backupPath);
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE records SET name='new source'");
  raw.close();
  const sourceBytes = await readFile(file);
  const sourceAlias = path.join(directory, "source-alias.db");
  await link(file, sourceAlias);
  for (const destination of [backupPath, file, sourceAlias]) {
    await assert.rejects(createMigrationBackup(file, destination), ({ code, identifiers, action }) =>
      code === "migration_backup_conflict" && identifiers.backup === destination && /fresh/i.test(action));
    assert.deepEqual(await readFile(backupPath), priorBytes);
    assert.deepEqual(await readFile(file), sourceBytes);
  }
});

test("competing backup creators exclusively publish one complete restore-checked artifact", async (t) => {
  const { directory, file } = await v4Store(t);
  const destination = path.join(directory, "race.db");
  const before = await readFile(file);
  const expected = await migrationPreflight(file);
  const results = await Promise.allSettled([
    createMigrationBackup(file, destination), createMigrationBackup(file, destination),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const failure = results.find(({ status }) => status === "rejected");
  assert.equal(failure.reason.code, "migration_backup_conflict");
  assert.equal((await migrationPreflight(destination)).logical_digest, expected.logical_digest);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual((await readdir(directory)).sort(), ["race.db", "source.db"]);
});

test("backup fails safely for occupied directories and unusable parent paths", async (t) => {
  const { directory, file } = await v4Store(t);
  const before = await readFile(file);
  const occupied = path.join(directory, "occupied");
  await mkdir(occupied);
  await writeFile(path.join(occupied, "keep"), "keep");
  await assert.rejects(createMigrationBackup(file, occupied));
  await assert.rejects(createMigrationBackup(file, path.join(directory, "missing", "backup.db")),
    ({ code }) => code === "migration_backup_failed");
  assert.deepEqual(await readFile(file), before);
  assert.equal(await readFile(path.join(occupied, "keep"), "utf8"), "keep");
  assert.deepEqual((await readdir(directory)).sort(), ["occupied", "source.db"]);
});

test("documented backup command refuses existing and racing destinations and restores a fresh artifact", async (t) => {
  const { directory, file } = await v4Store(t);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const command = /^lodestar (migration-backup) --db \$db \$backup\r?$/mu.exec(readme)?.[1];
  assert.ok(command, "exercise the exact documented public backup command");
  const run = (destination) => spawnSync(process.execPath,
    [fileURLToPath(new URL("../lodestar.mjs", import.meta.url)),
      command, '--db', file, destination], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  const backupPath = path.join(directory, "recipe.db");
  assert.equal(run(backupPath).status, 0);
  const sourceBytes = await readFile(file), backupBytes = await readFile(backupPath);
  const expected = await migrationPreflight(file);
  assert.equal((await migrationPreflight(backupPath)).logical_digest, expected.logical_digest);
  for (const destination of [backupPath, file]) {
    const refused = run(destination);
    assert.notEqual(refused.status, 0);
    const failure = JSON.parse(refused.stderr);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'migration_backup_conflict');
    assert.equal(failure.error.identifiers.backup, destination);
    assert.match(failure.error.action, /Preserve.*fresh backup path/);
    assert.deepEqual(await readFile(file), sourceBytes);
    assert.deepEqual(await readFile(backupPath), backupBytes);
  }
  // The recipe and helper share the exclusive publication boundary.
  const racePath = path.join(directory, "recipe-race.db");
  const helper = createMigrationBackup(file, racePath);
  const recipe = run(racePath);
  const result = await Promise.allSettled([helper]);
  assert.equal(Number(recipe.status === 0) + Number(result[0].status === "fulfilled"), 1);
  assert.equal((await migrationPreflight(racePath)).logical_digest, expected.logical_digest);
  assert.deepEqual(await readFile(file), sourceBytes);
});

test("documented migration request preserves an existing exact request and rejects mismatched evidence", async (t) => {
  const { directory, file } = await v4Store(t);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const script = /^node -e "([^\r\n]+migration-request\.json[^\r\n]+)"\r?$/mu.exec(readme)?.[1];
  assert.ok(script, "execute the exact documented request-creation script");
  const backupPath = path.join(directory, 'request-backup.db');
  await createMigrationBackup(file, backupPath);
  const source = await migrationPreflight(file), backup = await migrationPreflight(backupPath);
  await writeFile(path.join(directory, 'preflight.json'), JSON.stringify({ data: source }));
  await writeFile(path.join(directory, 'backup-preflight.json'), JSON.stringify({ data: backup }));
  const run = () => spawnSync(process.execPath, ['-e', script], { cwd: directory, encoding: 'utf8', timeout: 20000 });
  const original = await readFile(file);
  assert.equal(run().status, 0);
  const requestPath = path.join(directory, 'migration-request.json');
  const exact = await readFile(requestPath);
  const repeated = run();
  assert.notEqual(repeated.status, 0, 'an existing exact recovery request cannot be replaced');
  assert.match(repeated.stderr, /EEXIST/);
  assert.deepEqual(await readFile(requestPath), exact);
  await writeFile(path.join(directory, 'backup-preflight.json'), JSON.stringify({ data: { ...backup, logical_digest: '0'.repeat(64) } }));
  const mismatched = run();
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /Backup does not match source preflight/);
  assert.deepEqual(await readFile(requestPath), exact);
  assert.deepEqual(await readFile(file), original);
});
