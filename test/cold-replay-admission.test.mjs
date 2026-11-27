import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { admittedTransaction, openWriteDatabase } from "../src/database.mjs";
import { pendingMutation } from "../src/pending.mjs";
import { mutate, preparePutEvidence, putRecord } from "../src/records.mjs";
import { archivedReceiptHeader, archivedReceiptPointer, decodeReceiptStorage, encodeReceiptStorage, retiredReceiptFence } from "../src/receipt-storage.mjs";
import { fixture } from "./helpers/contract.mjs";

const hash = "1".repeat(64);
async function setup(t, codec = "archive", operation = "probe") {
  const cleanup = [];
  const f = await fixture({ after: fn => cleanup.push(fn) });
  const db = await openWriteDatabase(f.database), other = await openWriteDatabase(f.database);
  t.after(async () => { db.close(); other.close(); for (const fn of cleanup) await fn(); });
  other.exec("PRAGMA busy_timeout=0");
  const target = { kind: "record", id: "replay-probe" };
  const input = { mode: "create", record: { id: target.id, kind: "knowledge", name: target.id,
    scope: "global", availability: "known", data: { note: "synthetic" }, aliases: [], links: [], sources: [] } };
  const request = await f.request(operation === "pending.promote"
    ? { id: "pending:synthetic", destination: { operation: "put", input } } : input, [target]);
  const unrelated = await f.request({ purpose: "independent writer" }, []);
  const saved = operation === "put" ? putRecord(db, request) :
    mutate(db, operation, request, () => ({ data: { value: "synthetic", ...(codec === "gzip" ? { pad: "x".repeat(4000) } : {}) } }));
  const row = db.prepare("SELECT * FROM records WHERE id=?").get(saved.receipt_id);
  const raw = decodeReceiptStorage(row.content_json, { id: row.id });
  const manifest = path.join(f.root, "manifest.json");
  const cache = path.join(f.root, "archive-cache", "restored.db");
  fs.mkdirSync(path.dirname(cache));
  const archive = new DatabaseSync(cache);
  archive.exec("CREATE TABLE metadata(key,value); CREATE TABLE records(id,type,name,scope,content_json,created_at,updated_at)");
  archive.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)")
    .run(row.id, row.type, row.name, row.scope, raw, row.created_at, row.updated_at);
  archive.close();
  const s = fs.statSync(cache, { bigint: true });
  fs.writeFileSync(manifest, JSON.stringify({ format: "isolated-lean-candidate-v1",
    archive_sha256: hash, snapshot_sha256: hash, snapshot_bytes: Number(s.size), snapshot_metadata: {} }));
  fs.writeFileSync(cache + ".receipt.json", JSON.stringify({ state: "verified_restore",
    sha256: hash, archive_sha256: hash, cache_identity: { size: String(s.size), mtime_ns: String(s.mtimeNs), ino: String(s.ino) } }));
  const replace = (content) => admittedTransaction(other, () => other.prepare("UPDATE records SET content_json=? WHERE id=?").run(content, row.id));
  if (codec === "gzip") assert.equal(JSON.parse(encodeReceiptStorage(raw, row.id))._lodestar_storage.codec, "gzip");
  if (codec === "archive") replace(archivedReceiptHeader(raw, row.id, manifest, hash));
  if (codec === "archive-pointer") replace(archivedReceiptPointer(row.id, saved.revision, manifest, hash));
  function duringManifest(observer, run) {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (file === manifest) observer();
      return read.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    try { return run(); }
    finally { fs.readFileSync = read; syncBuiltinESMExports(); }
  }
  const replay = (body = request) => mutate(db, operation, body, () => assert.fail("replayed callback"));
  return { db, other, unrelated, saved, row, request, replay, replace, manifest, cache, duringManifest };
}

for (const codec of ["archive", "archive-pointer"]) test(codec + " exact replay releases the writer before reading cache", async (t) => {
  const f = await setup(t, codec);
  let reads = 0;
  const result = f.duringManifest(() => {
    reads++;
    assert.equal(f.db.isTransaction, false);
    assert.doesNotThrow(() => mutate(f.other, "probe", f.unrelated, () => ({ data: { progressed: true } })));
  }, f.replay);
  assert.equal(reads, 1);
  assert.deepEqual(result, { ...f.saved, request: { ...f.saved.request, replayed: true } });
  assert.throws(() => f.replay({ ...f.request, input: { changed: true } }), { code: "request_conflict" });
  const retained = admittedTransaction(f.db, () => {
    assert.throws(() => f.duringManifest(() => assert.fail("nested archive I/O"), f.replay), { code: "invalid_transaction" });
    return f.db.isTransaction;
  });
  assert.equal(retained, true);
});

test("lost or replaced identity is fenced, not reexecuted, even on put preflight", async (t) => {
  const gone = await setup(t, "archive", "put");
  assert.throws(() => gone.duringManifest(() => admittedTransaction(gone.other, () =>
    gone.other.prepare("DELETE FROM records WHERE id=?").run(gone.row.id)),
  () => putRecord(gone.db, gone.request)), { code: "revision_conflict" });
  const swapped = await setup(t, "archive-pointer");
  assert.throws(() => swapped.duringManifest(() => swapped.replace(swapped.row.content_json), swapped.replay), { code: "revision_conflict" });
  const changed = await setup(t);
  const epoch = "2".repeat(64);
  assert.throws(() => changed.duringManifest(() => admittedTransaction(changed.other, () =>
    changed.other.prepare("UPDATE metadata SET value=? WHERE key='database_epoch'").run(epoch)), changed.replay),
  { code: "database_epoch_conflict" });
});

test("missing/corrupt/locked archive and retired receipt stay failures with precise codes", async (t) => {
  const f = await setup(t);
  const lock = new DatabaseSync(f.cache);
  try {
    lock.exec("BEGIN EXCLUSIVE");
    assert.throws(() => f.replay(), { code: "database_busy" });
  } finally { lock.close(); }
  fs.rmSync(f.cache + ".receipt.json");
  assert.throws(() => f.replay(), { code: "archive_restore_required" });
  fs.writeFileSync(f.manifest, "{}");
  assert.throws(() => f.replay(), { code: "database_integrity" });
  f.replace(retiredReceiptFence(f.row.id, f.saved.revision, hash));
  assert.throws(() => f.replay(), { code: "receipt_retired" });
});

for (const codec of ["inline", "gzip"]) test(codec + " ordinary and nested replay keep one admission and no archive I/O", async (t) => {
  const f = await setup(t, codec);
  const exec = f.db.exec.bind(f.db);
  let admissions = 0;
  f.db.exec = (sql) => { if (sql === "BEGIN IMMEDIATE") admissions++; return exec(sql); };
  try {
    assert.equal(f.replay().request.replayed, true);
    assert.equal(admissions, 1);
    assert.equal(admittedTransaction(f.db, f.replay).request.replayed, true);
    assert.equal(admissions, 2);
  } finally { f.db.exec = exec; }
});

test("pending destination retains the private fence and keeps its original result", async (t) => {
  const f = await setup(t, "archive-pointer", "pending.promote");
  const pending = () => pendingMutation(f.db, { scope: "project:synthetic" },
    { actor: "synthetic" }, "promote", f.request);
  let reads = 0;
  assert.deepEqual(f.duringManifest(() => { reads++; }, pending).data, f.saved.data);
  assert.equal(reads, 1);
  assert.throws(() => f.duringManifest(() => admittedTransaction(f.other, () =>
    f.other.prepare("DELETE FROM records WHERE id=?").run(f.row.id)), pending),
  (error) => error.code === "revision_conflict" && error.identifiers.committed === "unknown");
});

test("unconfirmed first admission is not mistaken for a cold marker", async (t) => {
  const f = await setup(t), exec = f.db.exec.bind(f.db);
  f.db.exec = (sql) => {
    if (sql === "COMMIT") throw Error("synthetic commit failure");
    return exec(sql);
  };
  let decoded = false;
  try {
    assert.throws(() => f.duringManifest(() => { decoded = true; }, f.replay));
    assert.equal(decoded, false);
    assert.equal(f.db.isTransaction, false);
  } finally { f.db.exec = exec; }
});

test("a prepared archive failure cannot outrank changed receipt evidence", async (t) => {
  const f = await setup(t, "archive-pointer");
  fs.rmSync(f.cache + ".receipt.json");
  let reads = 0;
  assert.throws(() => f.duringManifest(() => {
    reads++;
    f.replace(f.row.content_json);
  }, f.replay), (error) => error.code === "revision_conflict" && error.identifiers.committed === "unknown");
  assert.equal(reads, 1);
});

test("put preflight and direct mutation retain their distinct error order", async (t) => {
  const f = await setup(t, "archive", "put");
  fs.rmSync(f.cache + ".receipt.json");
  admittedTransaction(f.other, () => f.other.prepare(
    "UPDATE metadata SET value=? WHERE key='database_epoch'").run("2".repeat(64)));
  assert.throws(() => putRecord(f.db, f.request), { code: "archive_restore_required" });
  assert.throws(() => mutate(f.db, "put", f.request, () => assert.fail("replayed callback")),
    { code: "database_epoch_conflict" });
});

test("a private preparation is uninspectable, exact-request/connection bound, and one-use", async (t) => {
  const f = await setup(t);
  const prepared = preparePutEvidence(f.db, f.request.input, f.request, "probe");
  assert.deepEqual(Reflect.ownKeys(prepared), []);
  Object.freeze(prepared);
  const run = (db, request, preparation) => mutate(db, "probe", request,
    () => assert.fail("replayed callback"), { receiptPreparation: preparation });
  const transplant = preparePutEvidence(f.db, f.request.input, f.request, "probe");
  const changed = preparePutEvidence(f.db, f.request.input, f.request, "probe");
  fs.rmSync(f.cache + ".receipt.json");
  assert.throws(() => run(f.db, f.request, { ...prepared }), { code: "archive_restore_required" });
  assert.throws(() => run(f.other, f.request, transplant), { code: "archive_restore_required" });
  assert.throws(() => run(f.db, { ...f.request, input: { changed: true } }, changed), { code: "archive_restore_required" });
  assert.equal(run(f.db, f.request, prepared).request.replayed, true);
  assert.throws(() => run(f.db, f.request, prepared), { code: "archive_restore_required" });
});

for (const operation of ["put", "pending.promote"]) test(operation + " keeps its observation fence with a fallback actor", async (t) => {
  const f = await setup(t, "archive", operation);
  assert.equal(f.request.actor, null);
  const options = { actor: { id: "fallback-actor" } };
  const replay = () => operation === "put" ? putRecord(f.db, f.request, options)
    : pendingMutation(f.db, { scope: "project:synthetic" }, { actor: "synthetic" }, "promote", f.request, options);
  let reads = 0;
  assert.throws(() => f.duringManifest(() => { reads++; }, replay), { code: "request_conflict" });
  assert.equal(reads, 2, "changed normalized request cannot reuse prepared decode");
  assert.throws(() => f.duringManifest(() => admittedTransaction(f.other, () =>
    f.other.prepare("DELETE FROM records WHERE id=?").run(f.row.id)), replay),
  (error) => error.code === "revision_conflict" && error.identifiers.committed === "unknown");
});
