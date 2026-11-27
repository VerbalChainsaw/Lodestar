import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openReadDatabase } from "../src/database.mjs";
import { normalizeMutationRequest } from "../src/records.mjs";
import { currentRevision } from "../src/revisions.mjs";
import { fixture } from "./helpers/contract.mjs";

const cli = fileURLToPath(new URL("../lodestar.mjs", import.meta.url));
const malformedTargets = [
  ["missing", undefined],
  ["null", null],
  ["object", {}],
  ["string", "record:target"],
  ["number", 1],
  ["boolean", true],
];

async function requestFor(f, targets) {
  const id = "fact:invalid-targets";
  const absent = await f.cli(["get", id]);
  assert.equal(absent.value.error.code, "record_not_found");
  const basis = { ...absent.value.error.identifiers.write_basis };
  if (targets === undefined) delete basis.targets;
  else basis.targets = targets;
  return { v: 5, request_id: "invalid-targets", write_basis: basis,
    input: { mode: "create", record: { id, kind: "fact", name: id,
      scope: "global", data: { preserved: true }, aliases: [], links: [], sources: [] } } };
}

async function storedState(database) {
  const db = await openReadDatabase(database);
  try {
    return { revision: currentRevision(db),
      records: db.prepare("SELECT count(*) AS count FROM records").get().count,
      receipts: db.prepare("SELECT count(*) AS count FROM records WHERE type='mutation-receipt'").get().count };
  } finally { db.close(); }
}

function invoke(database, request) {
  const result = spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", cli, "--db", database, "put"],
    { input: JSON.stringify(request), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "", "a rejected request must emit only its error envelope");
  return { status: result.status, envelope: JSON.parse(result.stderr) };
}

for (const [label, targets] of malformedTargets) {
  test(`malformed ${label} write-basis targets fail directly and through the CLI without persistence`, async (t) => {
    const f = await fixture(t), request = await requestFor(f, targets);
    const before = await readFile(f.database);
    assert.throws(() => normalizeMutationRequest(request), (error) => {
      assert.equal(error.code, "invalid_mutation_contract");
      assert.equal(error.identifiers.field, "write_basis.targets");
      return true;
    });
    const result = invoke(f.database, request);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.v, 5);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.error.code, "invalid_mutation_contract");
    assert.equal(result.envelope.error.identifiers.field, "write_basis.targets");
    assert.deepEqual(await storedState(f.database), { revision: 0, records: 0, receipts: 0 });
    assert.deepEqual(await readFile(f.database), before);
  });
}

for (const field of ["project_scope", "checkout"]) {
  for (const [label, value] of [["missing", undefined], ["boolean", false],
    ["number", 0], ["array", []], ["object", {}]]) {
    test(`public basis rejects ${label} ${field} without persistence`, async (t) => {
      const f = await fixture(t), request = await requestFor(f, []);
      if (value === undefined) delete request.write_basis[field];
      else request.write_basis[field] = value;
      const before = await readFile(f.database);
      assert.throws(() => normalizeMutationRequest(request), (error) => {
        assert.equal(error.code, "invalid_mutation_contract");
        assert.equal(error.identifiers.field, `write_basis.${field}`);
        return true;
      });
      const result = invoke(f.database, request);
      assert.equal(result.status, 2);
      assert.equal(result.envelope.error.code, "invalid_mutation_contract");
      assert.equal(result.envelope.error.identifiers.field, `write_basis.${field}`);
      assert.deepEqual(await storedState(f.database), { revision: 0, records: 0, receipts: 0 });
      assert.deepEqual(await readFile(f.database), before);
    });
  }
}

test("public basis accepts null and string bindings while canonical checkout stays optional", async (t) => {
  const f = await fixture(t), request = await requestFor(f, []);
  for (const [project_scope, checkout] of [[null, null], ["project:test", f.root]]) {
    const normalized = normalizeMutationRequest({ ...request,
      write_basis: { ...request.write_basis, project_scope, checkout } });
    assert.equal(normalized.project_scope, project_scope);
    assert.equal(normalized.checkout, checkout);
    const { checkout: _checkout, ...canonical } = normalized;
    assert.equal(normalizeMutationRequest(canonical).checkout, null);
  }
});

test("an empty targets array is valid and still enforces the operation's required preconditions", async (t) => {
  const f = await fixture(t), request = await requestFor(f, []);
  const before = await readFile(f.database);
  assert.deepEqual(normalizeMutationRequest(request).preconditions, []);
  const result = invoke(f.database, request);
  assert.equal(result.status, 2);
  assert.equal(result.envelope.error.code, "missing_precondition");
  assert.deepEqual(await storedState(f.database), { revision: 0, records: 0, receipts: 0 });
  assert.deepEqual(await readFile(f.database), before);
});

test("native and subclass Promise callback overrides cannot prevent rollback or rejection consumption", () => {
  const databaseModule = new URL("../src/database.mjs", import.meta.url).href;
  const recordsModule = new URL("../src/records.mjs", import.meta.url).href;
  const revisionsModule = new URL("../src/revisions.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { openConnection, initializeConnection, admittedTransaction, transaction } from ${JSON.stringify(databaseModule)};
    import { mutate, writeBasis, writeRecordSnapshot } from ${JSON.stringify(recordsModule)};
    import { currentRevision } from ${JSON.stringify(revisionsModule)};
    class CallbackPromise extends Promise {}
    let overrideCalls = 0;
    const rejected = (kind) => {
      if (kind === "rejecting thenable") return { then(_resolve, reject) {
        reject(new Error("private rejecting thenable marker"));
      } };
      if (kind === "throwing thenable") return { then() {
        throw new Error("private throwing thenable marker");
      } };
      const result = kind === "subclass" ? CallbackPromise.reject(new Error("private rejected callback marker"))
        : Promise.reject(new Error("private rejected callback marker"));
      if (kind === "catch" || kind === "subclass") result.catch = () => {
        overrideCalls += 1; throw new Error("must not invoke overridden catch");
      };
      if (kind === "then" || kind === "subclass") result.then = () => {
        overrideCalls += 1; throw new Error("must not invoke overridden then");
      };
      if (kind === "then getter") Object.defineProperty(result, "then", { get() {
        overrideCalls += 1; throw new Error("must not read overridden then getter");
      } });
      return result;
    };
    const db = openConnection(":memory:");
    try {
      initializeConnection(db, { createdAt: "2026-10-14T00:00:00.000Z" });
      const request = { v: 5, request_id: "rejected-callback", write_basis: writeBasis(db), input: {} };
      const callbackKinds = ["plain", "catch", "then", "then getter", "subclass",
        "rejecting thenable", "throwing thenable"];
      for (const kind of callbackKinds) {
        assert.throws(() => mutate(db, "test:callback", request, ({ revision, timestamp }) => {
          writeRecordSnapshot(db, { id: "fact:uncommitted", type: "fact", name: "Uncommitted",
            scope: "global", content: { state: "known", value: { temporary: true } },
            aliases: [], links: [], sources: [] },
          { createdAt: timestamp, updatedAt: timestamp, revision });
          return rejected(kind);
        }), { code: "invalid_mutation_contract" });
        assert.equal(currentRevision(db), 0);
        assert.equal(db.isTransaction, false);
        assert.equal(db.prepare("SELECT count(*) AS count FROM records").get().count, 0);
        assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(overrideCalls, 0);
      }
      const syncRequest = { ...request, request_id: "sync-callback" };
      const accepted = mutate(db, "test:callback", syncRequest, () => ({ data: { accepted: true } }));
      assert.equal(accepted.revision, 1);
      assert.equal(accepted.request.replayed, false);
      const replay = mutate(db, "test:callback", syncRequest, () => { throw new Error("must replay"); });
      assert.equal(replay.request.replayed, true);
      assert.deepEqual(replay.data, accepted.data);
      assert.equal(currentRevision(db), 1);
      const transactionDb = openConnection(":memory:");
      try {
        transactionDb.exec("CREATE TABLE marker(value TEXT)");
        const nestedTransaction = (connection, operation) => transaction(connection, () => transaction(connection, operation));
        for (const invoke of [transaction, admittedTransaction, nestedTransaction]) {
          for (const kind of callbackKinds) {
            assert.throws(() => invoke(transactionDb, () => {
              transactionDb.exec("INSERT INTO marker VALUES ('temporary')");
              return rejected(kind);
            }), { code: "invalid_transaction" });
            assert.equal(transactionDb.isTransaction, false);
            assert.equal(transactionDb.prepare("SELECT count(*) AS count FROM marker").get().count, 0);
            assert.equal(transactionDb.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(overrideCalls, 0);
          }
        }
        assert.equal(transaction(transactionDb, () => "still synchronous"), "still synchronous");
      } finally { transactionDb.close(); }
      console.log("survived and replayed");
    } finally { db.close(); }
  `;
  const result = spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "survived and replayed");
});
