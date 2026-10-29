import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import test from "node:test";
import { admittedTransaction, openConnection, openWriteDatabase } from "../src/database.mjs";
import { errorPayload } from "../src/errors.mjs";
import { directInterfaceSelection } from "../src/interface-config.mjs";
import { listRecovery, prepareCliJournal, retireCliJournal, storeCliResponse } from "../src/recovery-journal.mjs";
import { putRecord } from "../src/records.mjs";
import { currentRevision } from "../src/revisions.mjs";
import { fixture } from "./helpers/contract.mjs";

const faults = [
  ["FULL", () => Object.assign(new Error("private commit storage marker"),
    { code: "ERR_SQLITE_ERROR", errcode: 13 }), "database_storage_full"],
  ["IOERR", () => Object.assign(new Error("private commit storage marker"),
    { code: "ERR_SQLITE_ERROR", errcode: 10 }), "database_io_failed"],
  ["unclassified", () => new Error("private commit storage marker"), "database_error"],
];

for (const [label, fault, code] of faults) {
  test(`active ${label} commit failure is already branded and rolled back`, () => {
    const db = openConnection(":memory:");
    db.exec("CREATE TABLE marker(value TEXT)");
    const exec = db.exec.bind(db), original = fault();
    try {
      db.exec = (sql) => { if (sql === "COMMIT") throw original; return exec(sql); };
      assert.throws(() => admittedTransaction(db, () => {
        db.exec("INSERT INTO marker VALUES ('uncommitted')");
      }), (error) => {
        assert.equal(errorPayload(error).code, code);
        assert.equal(error.cause, original);
        assert.notEqual(errorPayload(error).identifiers.committed, "unknown");
        assert.notEqual(errorPayload(error).identifiers.committed, true);
        assert.doesNotMatch(JSON.stringify(errorPayload(error)), /private commit storage marker/u);
        return true;
      });
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare("SELECT count(*) AS count FROM marker").get().count, 0);
      assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
      db.exec = exec;
      admittedTransaction(db, () => db.exec("INSERT INTO marker VALUES ('confirmed')"));
      assert.equal(db.prepare("SELECT count(*) AS count FROM marker").get().count, 1);
    } finally { db.exec = exec; db.close(); }
  });
}

async function requestFor(f) {
  const id = "fact:commit-rollback";
  return f.request({ mode: "create", record: { id, kind: "fact", name: id,
    scope: "global", data: {}, aliases: [], links: [], sources: [] } }, [{ kind: "record", id }]);
}

for (const [label, fault, code] of faults.slice(0, 2)) {
  test(`actual CLI ${label} rollback retires its known rejected journal`, async (t) => {
    const f = await fixture(t), request = await requestFor(f);
    const before = await readFile(f.database), exec = DatabaseSync.prototype.exec;
    let result;
    try {
      DatabaseSync.prototype.exec = function (sql) {
        if (sql === "COMMIT") throw fault();
        return exec.call(this, sql);
      };
      result = await f.cli(["put"], request);
    } finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(result.code, 5);
    assert.equal(result.value.error.code, code);
    assert.equal(result.value.revision, 0);
    assert.doesNotMatch(JSON.stringify(result.value), /private commit storage marker/u);
    assert.deepEqual(await readFile(f.database), before);
    assert.deepEqual(await readdir(path.join(f.root, "cli-pending")), []);
    const listed = await f.cli(["recovery", "list"]);
    assert.equal(listed.code, 0);
    assert.deepEqual(listed.value.data.journals, []);
    assert.deepEqual(listed.value.data.settled_journals, []);
  });
}

test("a later known rollback cannot settle an earlier unknown invocation", async (t) => {
  const f = await fixture(t), request = await requestFor(f);
  const selection = await directInterfaceSelection(f.database);
  const prepare = () => prepareCliJournal(selection, "put", { options: {}, positionals: [] }, ["put"],
    { stdin: Readable.from([JSON.stringify(request)]) });
  const first = await prepare(), second = await prepare();
  assert.equal(first.context.prior_outcome_unknown, false);
  assert.equal(second.context.prior_outcome_unknown, true);
  const before = await Promise.all([first, second].flatMap(journal =>
    ["request.json", "context.json"].map(name => readFile(path.join(journal.folder, name)))));
  const db = await openWriteDatabase(f.database), exec = db.exec.bind(db);
  let failure;
  try {
    db.exec = (sql) => { if (sql === "COMMIT") throw faults[0][1](); return exec(sql); };
    try { putRecord(db, request); } catch (error) { failure = error; }
    assert.equal(errorPayload(failure).code, "database_storage_full");
    assert.equal(currentRevision(db), 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM records").get().count, 0);
  } finally { db.exec = exec; db.close(); }
  const envelope = { v: 5, ok: false, operation: "put", revision: 0,
    database_instance_id: request.database_instance_id, database_epoch: request.database_epoch,
    request: { id: request.request_id },
    scope: { project: null, cwd: null, session: null, actor: null },
    error: errorPayload(failure), more: false, next: [failure.action] };
  await storeCliResponse(second, envelope);
  assert.equal(await retireCliJournal(second, envelope), false);
  const listing = await listRecovery(selection);
  assert.equal(listing.journals.length, 2);
  assert.deepEqual(listing.settled_journals, []);
  assert.equal(listing.journals.every(journal => journal.replay_eligible), true);
  assert.deepEqual(await Promise.all([first, second].flatMap(journal =>
    ["request.json", "context.json"].map(name => readFile(path.join(journal.folder, name))))), before);
});
