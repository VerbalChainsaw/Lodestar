import assert from "node:assert/strict";
import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { openConnection, readMetadata } from "../src/database.mjs";
import { databaseFile, sqliteError } from "../src/database-schema.mjs";
import { errorPayload } from "../src/errors.mjs";
import { createMigrationBackup, migrationPreflight } from "../src/schema-migration.mjs";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";

async function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "lodestar-native-path-"));
  assert.ok(path.resolve(root).startsWith(parent + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "café & source.db");
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA_V4_SQL);
    const insert = db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)");
    for (const [key, value] of Object.entries({ schema_version: "4",
      created_at: "2026-09-30T00:00:00.000Z", database_instance_id: "a".repeat(64),
      database_revision: "0", database_epoch: "b".repeat(64) })) insert.run(key, value);
  } finally { db.close(); }
  return { root, file };
}

async function directoryAtLength(root, total) {
  let directory = root;
  while (directory.length < total) {
    const remaining = total - directory.length;
    const length = remaining > 81 ? 80 : Math.max(1, remaining - 1);
    directory = path.join(directory, "d".repeat(length));
  }
  await mkdir(directory, { recursive: true });
  return directory;
}

test("owned ordinary, relative and alias inputs preserve resolved public locations", async (t) => {
  const { file } = await fixture(t);
  const alias = path.dirname(file) + path.sep + ".." + path.sep
    + path.basename(path.dirname(file)) + path.sep + path.basename(file);
  const inputs = [file, path.relative(process.cwd(), file), alias];
  if (process.platform === "win32") inputs.push(file.slice(0, 2) + path.relative(process.cwd(), file));
  for (const input of inputs) {
    const raw = new DatabaseSync(input, { readOnly: true });
    const expected = raw.location(); raw.close();
    const db = openConnection(input, { readOnly: true });
    try {
      assert.equal(databaseFile(db), expected);
      assert.equal(databaseFile(db, "explicit-public.db"), "explicit-public.db");
      assert.equal(readMetadata(db).schema_version, "4");
      if (!input.startsWith("\\\\?\\")) assert.ok(!databaseFile(db).startsWith("\\\\?\\"));
    } finally { db.close(); }
  }
});

test("memory, temporary, non-string and foreign native locations retain their presentation", async (t) => {
  const { file } = await fixture(t);
  for (const input of [":memory:", "", Buffer.from(file), pathToFileURL(file)]) {
    const raw = new DatabaseSync(input);
    const expected = raw.location(); raw.close();
    const db = openConnection(input);
    try { assert.equal(databaseFile(db), expected); assert.equal(db.prepare("SELECT 1 AS n").get().n, 1); }
    finally { db.close(); }
  }
  const raw = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(databaseFile(raw), raw.location()); }
  finally { raw.close(); }
});

test("owned long selected filenames open while inferred diagnostics retain the logical path",
  { skip: process.platform !== "win32" }, async (t) => {
    const { root, file } = await fixture(t);
    const directory = await directoryAtLength(root, 180);
    const selected = path.join(directory, "s".repeat(350 - directory.length - 4) + ".db");
    assert.equal(selected.length, 350); await copyFile(file, selected);
    const before = await readFile(selected);
    const db = openConnection(selected, { readOnly: true });
    try {
      assert.equal(databaseFile(db), selected);
      assert.equal(readMetadata(db).schema_version, "4");
      db.prepare = () => { throw Object.assign(new Error("private query failure"), { code: "ERR_SQLITE_ERROR", errcode: 14 }); };
      assert.throws(() => readMetadata(db), (error) => errorPayload(error).identifiers.database === selected);
    } finally { db.close(); }
    assert.deepEqual(await readFile(selected), before);
  });

test("long backup destination passes restore accounting and preserves its public filename",
  { skip: process.platform !== "win32" }, async (t) => {
    const { root, file } = await fixture(t);
    const directory = await directoryAtLength(root, 180);
    const destination = path.join(directory, "b".repeat(350 - directory.length - 4) + ".db");
    const before = await readFile(file);
    const result = await createMigrationBackup(file, destination);
    assert.equal(result.path, destination);
    assert.equal((await migrationPreflight(destination)).source.path, destination);
    assert.equal(result.logical_digest, (await migrationPreflight(file)).logical_digest);
    assert.deepEqual(await readFile(file), before);
    const backup = await readFile(destination);
    await assert.rejects(createMigrationBackup(file, destination), { code: "migration_backup_conflict" });
    assert.deepEqual(await readFile(destination), backup);
    assert.deepEqual(await readdir(directory), [path.basename(destination)]);
  });

test("long backup parent supports actual native staging and backup target",
  { skip: process.platform !== "win32" }, async (t) => {
    const { root, file } = await fixture(t);
    const directory = await directoryAtLength(root, 300);
    const destination = path.join(directory, "accepted backup.db");
    const result = await createMigrationBackup(file, destination);
    assert.equal(result.path, destination);
    assert.equal((await migrationPreflight(destination)).logical_digest, result.logical_digest);
    assert.deepEqual(await readdir(directory), [path.basename(destination)]);
  });

test("explicit namespace selection and ordinary alias share one native image and lock",
  { skip: process.platform !== "win32" }, async (t) => {
    const { file } = await fixture(t);
    const namespaced = path.toNamespacedPath(file);
    const first = openConnection(file, { configureWrite: false });
    const second = openConnection(namespaced, { configureWrite: false });
    try {
      assert.equal(databaseFile(first), file);
      assert.equal(databaseFile(second), namespaced);
      assert.equal(readMetadata(first).database_instance_id, readMetadata(second).database_instance_id);
      first.exec("BEGIN IMMEDIATE");
      assert.throws(() => second.exec("BEGIN IMMEDIATE"), (error) => (error.errcode & 0xff) === 5);
      first.exec("ROLLBACK"); second.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally { first.close(); second.close(); }
  });

test("native open rejection reports bounded code14 guidance without private exception content", () => {
  const raw = Object.assign(new Error("private source body and secret marker"), {
    code: "ERR_SQLITE_ERROR", errcode: 14, errstr: "private source body and secret marker",
  });
  const payload = errorPayload(sqliteError(raw, "selected-public.db"));
  assert.equal(payload.code, "database_open_failed");
  assert.equal(payload.identifiers.sqlite_errcode, 14);
  assert.equal(payload.identifiers.native_code, "ERR_SQLITE_ERROR");
  assert.match(payload.action, /filename|path/iu);
  assert.match(payload.action, /reinspect|inspect/iu);
  assert.ok(!JSON.stringify(payload).includes("secret marker"));
});

test("actual native open failure keeps its selected public path", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "missing-parent", "selected.db");
  assert.throws(() => openConnection(file, { readOnly: true }), (error) => {
    const payload = errorPayload(error);
    assert.equal(payload.code, "database_open_failed");
    assert.equal(payload.identifiers.database, file);
    assert.equal(payload.identifiers.sqlite_errcode, 14);
    assert.equal(error.cause.errcode, 14);
    return true;
  });
});

test("post-copy native rejection preserves output and safely names verification phase", async (t) => {
  const { file, root } = await fixture(t);
  const destination = path.join(root, "unaccepted.db");
  const before = await readFile(file);
  const originalOpen = fs.promises.open, originalPrepare = DatabaseSync.prototype.prepare;
  let completed = false, getters = 0;
  const raw = Object.assign(new Error(), { code: "ERR_SQLITE_ERROR", errcode: 14 });
  for (const key of ["message", "errstr", "cause", "stack"])
    Object.defineProperty(raw, key, { get() { getters++; throw new Error("private native content"); } });
  fs.promises.open = async (location, flags, ...rest) => {
    const handle = await originalOpen(location, flags, ...rest);
    if (location === destination && flags === "wx") {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); completed = true; };
    }
    return handle;
  };
  DatabaseSync.prototype.prepare = function (...args) {
    if (completed) throw raw;
    return originalPrepare.call(this, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(createMigrationBackup(file, destination), (error) => {
      const payload = errorPayload(error);
      assert.equal(payload.code, "migration_backup_failed");
      assert.equal(payload.identifiers.backup, destination);
      assert.equal(payload.identifiers.destination_created, true);
      assert.equal(payload.identifiers.backup_accepted, false);
      assert.equal(payload.identifiers.phase, "destination_verification");
      assert.equal(payload.identifiers.cause.code, "database_open_failed");
      assert.equal(payload.identifiers.cause.identifiers.database, destination);
      assert.equal(payload.identifiers.cause.identifiers.sqlite_errcode, 14);
      assert.ok(!JSON.stringify(payload).includes("private native content"));
      assert.ok(JSON.stringify(payload).length < 4096);
      return true;
    });
    assert.equal(getters, 0);
    assert.ok((await readFile(destination)).length > 0);
    assert.deepEqual(await readFile(file), before);
  } finally {
    fs.promises.open = originalOpen; DatabaseSync.prototype.prepare = originalPrepare;
    syncBuiltinESMExports();
  }
  assert.equal((await migrationPreflight(destination)).logical_digest,
    (await migrationPreflight(file)).logical_digest);
});

test("backup rejection has a fixed phase and safe cause without reading hostile getters", async (t) => {
  const { file, root } = await fixture(t);
  const original = fs.promises.mkdtemp;
  let getters = 0;
  const hostile = {};
  for (const key of ["code", "errcode", "message", "errstr", "cause", "stack"])
    Object.defineProperty(hostile, key, { get() { getters++; throw new Error("private marker"); } });
  fs.promises.mkdtemp = async () => { throw hostile; }; syncBuiltinESMExports();
  try {
    await assert.rejects(createMigrationBackup(file, path.join(root, "backup.db")), (error) => {
      const payload = errorPayload(error);
      assert.equal(payload.code, "migration_backup_failed");
      assert.equal(payload.identifiers.phase, "staging_creation");
      assert.equal(payload.identifiers.cause.code, "database_error");
      assert.ok(!JSON.stringify(payload).includes("private marker"));
      return true;
    });
    assert.equal(getters, 0);
  } finally { fs.promises.mkdtemp = original; syncBuiltinESMExports(); }
});
