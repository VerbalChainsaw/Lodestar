import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";
import { createMigrationBackup, migrationPreflight } from "../src/schema-migration.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-backup-copy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.db");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_V4_SQL);
  const insert = db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)");
  for (const [key, value] of Object.entries({ schema_version: "4", created_at: "2026-09-30T00:00:00.000Z",
    database_instance_id: "a".repeat(64), database_revision: "0" })) insert.run(key, value);
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)").run("fact:large", "fact", "Large", "project:test",
    JSON.stringify({ state: "known", value: "x".repeat(600000) }),
    "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
  db.close();
  return { directory, file, destination: path.join(directory, "backup.db") };
}

async function withFsOverrides(overrides, operation) {
  const originals = Object.fromEntries(Object.keys(overrides).map((key) => [key, fs.promises[key]]));
  Object.assign(fs.promises, overrides);
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { Object.assign(fs.promises, originals); syncBuiltinESMExports(); }
}

test("backup remains available when filesystem hard links are unsupported", async (t) => {
  const { file, destination } = await fixture(t);
  const before = await readFile(file);
  let links = 0;
  await withFsOverrides({ link: async () => {
    links += 1;
    throw Object.assign(new Error("fixture volume does not support hard links"), { code: "ENOTSUP" });
  } }, async () => {
    const result = await createMigrationBackup(file, destination);
    assert.equal(result.logical_digest, (await migrationPreflight(file)).logical_digest);
    assert.equal((await migrationPreflight(destination)).logical_digest, result.logical_digest);
  });
  assert.equal(links, 0, "one native copy policy needs no hard-link probe");
  assert.deepEqual(await readFile(file), before);
});

test("exclusive backup copy uses bounded chunks, completes short writes and flushes before acceptance", async (t) => {
  const { file, destination } = await fixture(t);
  const originalOpen = fs.promises.open;
  let reserved = 0, syncs = 0, writes = 0, maximum = 0;
  await withFsOverrides({ open: async (location, flags, ...rest) => {
    const handle = await originalOpen(location, flags, ...rest);
    if (location === destination) {
      assert.equal(flags, "wx"); reserved += 1;
      const write = handle.write.bind(handle), sync = handle.sync.bind(handle);
      handle.write = async (buffer, offset, length, position) => {
        writes += 1; maximum = Math.max(maximum, length);
        assert.ok(buffer.byteLength <= 64 * 1024, "copy buffer is bounded");
        return write(buffer, offset, Math.min(length, 10003), position);
      };
      handle.sync = async () => { syncs += 1; return sync(); };
    }
    return handle;
  } }, async () => {
    const result = await createMigrationBackup(file, destination);
    assert.equal((await migrationPreflight(destination)).logical_digest, result.logical_digest);
  });
  assert.equal(reserved, 1);
  assert.equal(syncs, 1);
  assert.ok(writes > 10);
  assert.ok(maximum <= 64 * 1024);
});

for (const fault of ["write", "sync", "zero-write"]) {
  test(`backup ${fault} failure preserves unaccepted output and reports the exact destination`, async (t) => {
    const { file, destination } = await fixture(t);
    const before = await readFile(file);
    const originalOpen = fs.promises.open;
    let writes = 0;
    await withFsOverrides({ open: async (location, flags, ...rest) => {
      const handle = await originalOpen(location, flags, ...rest);
      if (location === destination && flags === "wx") {
        const write = handle.write.bind(handle);
        handle.write = async (...args) => {
          writes += 1;
          if (fault === "zero-write") return { bytesWritten: 0, buffer: args[0] };
          if (fault === "write" && writes > 1) throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
          return write(...args);
        };
        if (fault === "sync") handle.sync = async () => {
          throw Object.assign(new Error("injected flush I/O failure"), { code: "EIO" });
        };
      }
      return handle;
    } }, async () => {
      await assert.rejects(createMigrationBackup(file, destination), ({ code, identifiers, action }) =>
        code === "migration_backup_failed" && identifiers.backup === destination
          && identifiers.destination_created === true && identifiers.backup_accepted === false
          && /unaccepted/i.test(action) && /preserve/i.test(action));
    });
    const retained = await readFile(destination);
    if (fault === "write") assert.equal(retained.length, 64 * 1024);
    if (fault === "zero-write") assert.equal(retained.length, 0);
    if (fault === "sync") assert.ok(retained.length > 64 * 1024);
    assert.deepEqual(await readFile(file), before);
    const retainedStat = await stat(destination);
    await assert.rejects(createMigrationBackup(file, destination), ({ code }) => code === "migration_backup_conflict");
    assert.deepEqual(await readFile(destination), retained);
    assert.equal((await stat(destination)).ino, retainedStat.ino);
  });
}

test("failed backup never unlinks a replacement pathname after its reserved output moves", async (t) => {
  const { directory, file, destination } = await fixture(t);
  const originalOpen = fs.promises.open;
  const partialPath = path.join(directory, "moved-unaccepted.db");
  const replacement = Buffer.from("another owner's replacement artifact");
  const before = await readFile(file);
  await withFsOverrides({ open: async (location, flags, ...rest) => {
    const handle = await originalOpen(location, flags, ...rest);
    if (location === destination && flags === "wx") {
      const write = handle.write.bind(handle);
      let writes = 0;
      handle.write = async (...args) => {
        writes += 1;
        if (writes === 1) return write(...args);
        await rename(destination, partialPath);
        await writeFile(destination, replacement);
        throw Object.assign(new Error("copy failed after pathname replacement"), { code: "EIO" });
      };
    }
    return handle;
  } }, async () => {
    await assert.rejects(createMigrationBackup(file, destination), ({ code, identifiers }) =>
      code === "migration_backup_failed" && identifiers.backup_accepted === false);
  });
  assert.deepEqual(await readFile(destination), replacement);
  assert.equal((await stat(partialPath)).size, 64 * 1024);
  assert.deepEqual(await readFile(file), before);
});

test("completed copy with mismatched logical contents is preserved and never accepted", async (t) => {
  const { file, destination } = await fixture(t);
  const originalOpen = fs.promises.open;
  let changed = false;
  await withFsOverrides({ open: async (location, flags, ...rest) => {
    const handle = await originalOpen(location, flags, ...rest);
    if (location === destination && flags === "wx") {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (!changed) {
          changed = true;
          const raw = new DatabaseSync(destination);
          raw.exec("UPDATE records SET name='changed copy'");
          raw.close();
        }
      };
    }
    return handle;
  } }, async () => {
    await assert.rejects(createMigrationBackup(file, destination), ({ code, identifiers }) =>
      code === "migration_backup_failed" && identifiers.backup_accepted === false);
  });
  assert.notEqual((await migrationPreflight(destination)).logical_digest, (await migrationPreflight(file)).logical_digest);
});
