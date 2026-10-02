import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeDatabase, openConnection, openDiagnosticDatabase,
  openReadDatabase, readMetadata, transaction } from "../src/database.mjs";
import { sqliteError } from "../src/database-schema.mjs";
import { lodestarError } from "../src/errors.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "lodestar-storage-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "state.db") };
}

const writerSource = `
  import { DatabaseSync } from 'node:sqlite';
  const started = Date.now();
  const stage = (name) => process.stderr.write(name + ' ' + (Date.now() - started) + 'ms\\n');
  stage('startup');
  const db = new DatabaseSync(process.argv[1]);
  stage('opened');
  db.function('lodestar_write_contract', {}, () => 5);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=4; BEGIN IMMEDIATE');
  stage('transaction');
  db.prepare('UPDATE records SET name=?').run('u'.repeat(12000));
  stage('updated');
  process.stdout.write('READY\\n');
  setInterval(() => {}, 1000);
`;

async function interruptWriter(t, file, { source = writerSource, readyTimeoutMs = 10000 } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, file],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  let stdout = "", stderr = "", failure, readyTimer;
  const details = () => ({ executable: process.execPath, file, pid: child.pid,
    code: child.exitCode, signal: child.signalCode, stdout, stderr });
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    await new Promise((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error(`Owned writer not ready: ${JSON.stringify(details())}`)), readyTimeoutMs);
      child.stdout.on("data", (data) => {
        stdout += data;
        if (stdout.includes("READY")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Owned writer exited before kill: ${JSON.stringify(details())}`)));
    });
    assert.equal(child.kill("SIGKILL"), true, "terminate only the writer created by this fixture");
  } catch (error) { failure = error; }
  finally {
    clearTimeout(readyTimer);
    // Cleanup belongs to this lexical scope: the filesystem after-hook must
    // never run while this exact writer still owns the database or its pipes.
    if (child.pid && child.exitCode === null && child.signalCode === null && !child.killed)
      assert.equal(child.kill("SIGKILL"), true, `Owned writer cleanup failed: ${JSON.stringify(details())}`);
    let closeTimer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error(`Owned writer did not close: ${JSON.stringify(details())}`, { cause: failure })), 5000);
      })]);
    } finally { clearTimeout(closeTimer); }
  }
  const result = { ...details(), stdout_closed: child.stdout.destroyed, stderr_closed: child.stderr.destroyed };
  t.diagnostic(JSON.stringify({ owned_writer_closed: result }));
  if (failure) { failure.cleanup = result; throw failure; }
  return result;
}

test("owned writer readiness failure closes its SQLite holder before fixture removal", { timeout: 10000 }, async (t) => {
  const { root, file } = await fixture(t);
  await initializeDatabase(file);
  let failure;
  try {
    await interruptWriter(t, file, { readyTimeoutMs: 3000, source: `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('HOLDING\\n');
      setInterval(() => {}, 1000);
    ` });
  } catch (error) { failure = error; }
  assert.match(failure?.message ?? "", /Owned writer not ready/);
  assert.match(failure.cleanup.stdout, /HOLDING/);
  assert.equal(failure.cleanup.signal, "SIGKILL");
  assert.equal(failure.cleanup.stdout_closed, true);
  assert.equal(failure.cleanup.stderr_closed, true);
  await rm(root, { recursive: true, force: true });
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("native SQLITE_FULL names storage and preserves the failed transaction", async (t) => {
  const { root, file } = await fixture(t);
  const db = openConnection(file);
  try {
  db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('committed')");
  const count = db.prepare("PRAGMA page_count").get().page_count;
  db.exec(`PRAGMA max_page_count=${count}`);
  const before = await readFile(file);
  let surfaced;
  try { transaction(db, () => db.exec("INSERT INTO probe VALUES(zeroblob(1048576))")); }
  catch (error) { surfaced = error; }
  assert.equal(surfaced?.cause?.errcode, 13, "fixture must produce real SQLITE_FULL");
  t.diagnostic(JSON.stringify({ native_code: surfaced.cause.code,
    errcode: surfaced.cause.errcode, surfaced_code: surfaced.code }));
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT value FROM probe").get().value, "committed");
  assert.deepEqual(await readFile(file), before);
  assert.equal(surfaced.code, "database_storage_full");
  assert.equal(surfaced.identifiers.database, file);
  assert.equal(surfaced.identifiers.storage_directory, root);
  assert.equal(surfaced.identifiers.sqlite_errcode, 13);
  assert.match(surfaced.action, /page.limit/i);
  assert.match(surfaced.action, /exact request/i);
  assert.match(surfaced.action, /reconcil/i);
  } finally { db.close(); }
});

test("interrupted writer leaves a genuine hot journal; ordinary reads preserve it", { timeout: 30000 }, async (t) => {
  const { root, file } = await fixture(t);
  await initializeDatabase(file);
  // Twelve large records still exceed the four-page writer cache. The native
  // journal header and rollback error below independently prove the spill.
  const fixtureRows = 12;
  const fixtureDb = new DatabaseSync(file);
  fixtureDb.function("lodestar_write_contract", {}, () => 5);
  fixtureDb.exec("BEGIN IMMEDIATE");
  const insert = fixtureDb.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)");
  for (let i = 0; i < fixtureRows; i += 1) insert.run(`fact:${i}`, "fact", "c".repeat(12000), "project:test",
    '{"state":"known","value":{"kept":true}}', "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
  fixtureDb.exec("COMMIT");
  fixtureDb.close();
  await interruptWriter(t, file);
  const journalPath = `${file}-journal`;
  const journal = await readFile(journalPath);
  assert.ok(journal.length > 512);
  assert.equal(journal.subarray(0, 8).toString("hex"), "d9d505f920a163d7");
  const crashedBytes = await readFile(file);
  const metadataRead = async (location) => {
    const db = openConnection(location, { readOnly: true });
    try { readMetadata(db); } finally { db.close(); }
  };
  for (const read of [openReadDatabase, openDiagnosticDatabase, metadataRead]) {
    let surfaced;
    try { const db = await read(file); db.close(); }
    catch (error) { surfaced = error; }
    assert.equal(surfaced?.cause?.errcode, 776, "native READONLY_ROLLBACK proves SQLite needs hot-journal rollback writes");
    t.diagnostic(JSON.stringify({ reader: read.name, journal_bytes: journal.length,
      journal_header: journal.subarray(0, 8).toString("hex"), errcode: surfaced.cause.errcode,
      database_sha256: createHash("sha256").update(crashedBytes).digest("hex"),
      journal_sha256: createHash("sha256").update(journal).digest("hex"),
      surfaced_code: surfaced.code }));
    assert.deepEqual(await readFile(file), crashedBytes);
    assert.deepEqual(await readFile(journalPath), journal);
    assert.equal(surfaced.code, "database_recovery_required");
    assert.equal(surfaced.identifiers.database, file);
    assert.equal(surfaced.identifiers.journal, journalPath);
    assert.equal(surfaced.identifiers.storage_directory, root);
    assert.match(surfaced.action, /preserve/i);
    assert.match(surfaced.action, /journal/i);
    assert.match(surfaced.action, /exact request/i);
    assert.match(surfaced.action, /writ/i);
  }
  // Independent oracle: explicit SQLite recovery of a disposable copy restores
  // committed values. Keep the original failed-read database and journal intact.
  const recovered = path.join(root, "recovered.db");
  await copyFile(file, recovered);
  await copyFile(journalPath, `${recovered}-journal`);
  const control = new DatabaseSync(recovered);
  assert.equal(control.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(control.prepare("SELECT COUNT(*) AS count FROM records WHERE name=?").get("c".repeat(12000)).count, fixtureRows);
  control.close();
  assert.deepEqual(await readFile(file), crashedBytes);
  assert.deepEqual(await readFile(journalPath), journal);
});

test("shared storage classification preserves native causes, branded errors and invalid metadata", () => {
  for (const [errcode, expected] of [[13, "database_storage_full"], [776, "database_recovery_required"],
    [264, "database_recovery_required"], [8, "database_read_only"], [10, "database_io_failed"]]) {
    const raw = Object.assign(new Error("native fixture"), { code: "ERR_SQLITE_ERROR", errcode });
    const normalized = sqliteError(raw, "fixture.db");
    assert.equal(normalized.code, expected);
    assert.equal(normalized.cause, raw);
    assert.equal(normalized.identifiers.sqlite_errcode, errcode);
    if (errcode === 264) assert.equal(normalized.identifiers.journal, "fixture.db-wal");
  }
  const branded = lodestarError("invalid_database", "invalid timestamp");
  assert.equal(sqliteError(branded, "fixture.db"), branded);
  const raw = new DatabaseSync(":memory:");
  try { assert.throws(() => readMetadata(raw), ({ code }) => code === "invalid_database"); }
  finally { raw.close(); }
  const unrelated = Object.assign(new Error("foreign error"), { code: "OTHER_ERROR", errcode: 13 });
  assert.equal(sqliteError(unrelated, "fixture.db").code, "database_error");
});

test("ordinary read-only connections stay query-only with DELETE/FULL writers", async (t) => {
  const { file } = await fixture(t);
  await initializeDatabase(file);
  const writer = openConnection(file);
  assert.equal(writer.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  assert.equal(writer.prepare("PRAGMA synchronous").get().synchronous, 2);
  writer.close();
  const before = await readFile(file);
  const reader = await openReadDatabase(file);
  assert.equal(reader.prepare("PRAGMA query_only").get().query_only, 1);
  assert.throws(() => reader.exec("DELETE FROM metadata"));
  reader.close();
  assert.deepEqual(await readFile(file), before);
});
