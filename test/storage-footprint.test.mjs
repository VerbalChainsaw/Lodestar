import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { storageFootprint } from "../scripts/storage-footprint.mjs";

const cli = fileURLToPath(new URL("../scripts/storage-footprint.mjs", import.meta.url));

function fixture(t) {
  const root = realpathSync(tmpdir());
  const dir = mkdtempSync(join(root, "lodestar-footprint-"));
  t.after(() => {
    const actual = realpathSync(dir);
    assert.equal(actual, dir);
    assert.equal(dirname(actual), root);
    rmSync(actual, { recursive: true });
  });
  return { dir, file: join(dir, "db.sqlite") };
}

test("offline footprint agrees with SQLite page and freelist metrics and preserves bytes", t => {
  const { dir, file } = fixture(t);
  const db = new DatabaseSync(file);
  let pages, free;
  try {
    db.exec("PRAGMA page_size=65536; CREATE TABLE data (a BLOB); INSERT INTO data VALUES (zeroblob(400000)); DELETE FROM data");
    pages = db.prepare("PRAGMA page_count").get().page_count;
    free = db.prepare("PRAGMA freelist_count").get().freelist_count;
    assert(free > 0);
  } finally { db.close(); }
  const before = readFileSync(file);
  const snapshot = storageFootprint(file);
  assert.deepEqual(snapshot.sqlite_header, {
    state: "consistent_fields", page_bytes: 65536, allocated_pages: pages,
    free_pages: free, reusable_page_bytes_estimate: 65536 * free,
  });
  assert.equal(snapshot.sampled_total_bytes, before.length);
  assert.equal(snapshot.integrity, "not_checked");
  assert.deepEqual(readdirSync(dir), ["db.sqlite"]);
  assert.deepEqual(readFileSync(file), before);
});

test("actual WAL and SHM count toward footprint without implying current freelist", t => {
  const { dir, file } = fixture(t);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE data (v); INSERT INTO data VALUES (42)");
    const files = readdirSync(dir);
    const before = files.map(name => readFileSync(join(dir, name)));
    const snapshot = storageFootprint(file);
    assert.deepEqual(snapshot.sqlite_header, { state: "sidecars_present" });
    let sum = 0;
    for (const [name, suffix] of Object.entries({ main: "", wal: "-wal", shm: "-shm" })) {
      assert.equal(snapshot.file_bytes[name], statSync(file + suffix).size);
      sum += snapshot.file_bytes[name];
    }
    assert.equal(snapshot.sampled_total_bytes, sum);
    assert.deepEqual(readdirSync(dir), files);
    assert.deepEqual(files.map(name => readFileSync(join(dir, name))), before);
  } finally { db.close(); }
});

test("a rollback journal is counted and suppresses page conclusions", t => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE data (v); INSERT INTO data VALUES (42); BEGIN; UPDATE data SET v=99");
    const journal = readFileSync(file + "-journal");
    const snapshot = storageFootprint(file);
    assert.equal(snapshot.file_bytes.journal, journal.length);
    assert.equal(snapshot.sampled_total_bytes, snapshot.file_bytes.main + journal.length);
    assert.deepEqual(snapshot.sqlite_header, { state: "sidecars_present" });
    assert.deepEqual(readFileSync(file + "-journal"), journal);
  } finally { db.close(); }
});

test("obsolete SQLite header counters are not reported as usable page metrics", t => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  try { db.exec("CREATE TABLE data (v)"); } finally { db.close(); }
  const bytes = readFileSync(file);
  bytes.writeUInt32BE((bytes.readUInt32BE(24) + 1) >>> 0, 92);
  writeFileSync(file, bytes);
  assert.deepEqual(storageFootprint(file).sqlite_header, { state: "unverified_fields" });
  assert.deepEqual(readFileSync(file), bytes);
});

test("missing and non-SQLite files cannot claim integrity", t => {
  const { dir, file } = fixture(t);
  assert.throws(() => storageFootprint(dir), /regular file/);
  assert.throws(() => storageFootprint(file), /not found/);
  writeFileSync(file, "invalid");
  assert.deepEqual(storageFootprint(file).sqlite_header, { state: "not_sqlite_header" });
  assert.equal(storageFootprint(file).integrity, "not_checked");
});

test("command requires an explicit file, emits structured JSON, and preserves fixture bytes", t => {
  const { dir, file } = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
  const usage = run();
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /explicit SQLite file/);
  const missing = run(file);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error, "storage_observation_failed");
  const db = new DatabaseSync(file);
  try { db.exec("CREATE TABLE data (v)"); } finally { db.close(); }
  const before = readFileSync(file);
  const sampled = run(file);
  assert.equal(sampled.status, 0, sampled.stderr);
  assert.deepEqual(JSON.parse(sampled.stdout), storageFootprint(file));
  assert.deepEqual(readdirSync(dir), ["db.sqlite"]);
  assert.deepEqual(readFileSync(file), before);
});
