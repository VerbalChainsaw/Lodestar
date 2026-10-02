import assert from "node:assert/strict";
import test from "node:test";
import { openConnection, admittedTransaction, transaction } from "../src/database.mjs";
import { lodestarError, errorPayload, exitCodeFor } from "../src/errors.mjs";
import { boundedDiagnosticValue } from "../src/diagnostics.mjs";

function fixture(t) {
  const db = openConnection(":memory:");
  db.exec("CREATE TABLE marker(value TEXT)");
  const exec = db.exec.bind(db);
  t.after(() => { db.exec = exec; if (db.isTransaction) exec("ROLLBACK"); db.close(); });
  return { db, exec, rows: () => db.prepare("SELECT count(*) AS n FROM marker").get().n };
}
const ioFailure = () => Object.assign(new Error("private native marker"),
  { code: "ERR_SQLITE_ERROR", errcode: 10 });
const primary = () => lodestarError("invalid_input", "Primary validation failure", {
  identifiers: { field: "example" }, action: "Correct the example field.",
});

test("failed trusted schema admission is descriptive and never runs the write callback", (t) => {
  const { db, exec, rows } = fixture(t);
  const setupError = ioFailure();
  db.exec = (sql) => { if (sql === "PRAGMA trusted_schema = ON") throw setupError; return exec(sql); };
  let called = false, failure;
  assert.throws(() => admittedTransaction(db, () => { called = true; }, "fixture.db"), (error) => {
    failure = error; const payload = errorPayload(error);
    assert.equal(payload.code, "database_connection_cleanup_failed");
    assert.equal(payload.identifiers.phase, "trusted_schema_admission");
    assert.equal(payload.identifiers.committed, false);
    assert.equal(payload.identifiers.transaction_active, false);
    assert.equal(payload.identifiers.cleanup.code, "database_io_failed");
    assert.match(payload.action, /close|discard|reopen/iu);
    return true;
  });
  assert.equal(called, false); assert.equal(rows(), 0);
  assert.throws(() => transaction(db, () => { called = true; }), (error) => error === failure);
  assert.equal(called, false);
});

test("successful rollback preserves the exact primary error and discards uncommitted work", (t) => {
  const { db, rows } = fixture(t);
  const failure = primary();
  assert.throws(() => admittedTransaction(db, () => {
    db.exec("INSERT INTO marker VALUES ('temporary')"); throw failure;
  }), (error) => error === failure);
  assert.equal(db.isTransaction, false); assert.equal(rows(), 0);
});

for (const phase of ["operation", "commit"]) {
  test(`failed rollback after ${phase} reports both causes and refuses connection reuse`, (t) => {
    const { db, exec, rows } = fixture(t);
    const original = primary(), rollbackError = ioFailure();
    db.exec = (sql) => {
      if (sql === "ROLLBACK") throw rollbackError;
      if (phase === "commit" && sql === "COMMIT") throw ioFailure();
      return exec(sql);
    };
    let failure;
    assert.throws(() => admittedTransaction(db, () => {
      db.exec("INSERT INTO marker VALUES ('temporary')");
      if (phase === "operation") throw original;
    }, "fixture.db"), (error) => {
      failure = error; const payload = errorPayload(error);
      assert.equal(payload.code, "database_rollback_failed");
      assert.equal(payload.identifiers.phase, "rollback");
      assert.equal(payload.identifiers.database, "fixture.db");
      assert.equal(payload.identifiers.committed, "unknown");
      assert.equal(payload.identifiers.transaction_active, true);
      assert.equal(payload.identifiers.primary.code, phase === "operation" ? "invalid_input" : "database_io_failed");
      assert.equal(payload.identifiers.cleanup.code, "database_io_failed");
      assert.match(payload.action, /close|discard|reopen/iu);
      assert.match(payload.action, /receipt|exact request/iu);
      assert.equal(exitCodeFor(error), 5);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors[1], rollbackError);
      if (phase === "operation") assert.equal(error.cause.errors[0], original);
      return true;
    });
    assert.equal(db.isTransaction, true); assert.equal(rows(), 1);
    let called = false;
    for (const invoke of [admittedTransaction, transaction]) {
      assert.throws(() => invoke(db, () => { called = true; }), (error) => error === failure);
    }
    assert.equal(called, false);
  });
}

for (const phase of ["successful_commit", "primary_failure"]) {
  test(`trusted schema reset failure after ${phase} remains causal and truthful`, (t) => {
    const { db, exec, rows } = fixture(t);
    const original = primary(), cleanupError = ioFailure();
    db.exec = (sql) => { if (sql === "PRAGMA trusted_schema = OFF") throw cleanupError; return exec(sql); };
    let failure;
    assert.throws(() => admittedTransaction(db, () => {
      db.exec("INSERT INTO marker VALUES ('written')");
      if (phase === "primary_failure") throw original;
    }, "fixture.db"), (error) => {
      failure = error; const payload = errorPayload(error);
      assert.equal(payload.code, "database_connection_cleanup_failed");
      assert.equal(payload.identifiers.phase, "trusted_schema_reset");
      assert.equal(payload.identifiers.committed, phase === "successful_commit");
      assert.equal(payload.identifiers.cleanup.code, "database_io_failed");
      assert.equal(payload.identifiers.primary?.code ?? null, phase === "primary_failure" ? "invalid_input" : null);
      assert.match(payload.action, /close|discard|reopen/iu);
      assert.ok(error.cause instanceof AggregateError);
      assert.ok(error.cause.errors.includes(cleanupError));
      if (phase === "primary_failure") assert.ok(error.cause.errors.includes(original));
      return true;
    });
    assert.equal(db.isTransaction, false); assert.equal(rows(), phase === "successful_commit" ? 1 : 0);
    let called = false;
    assert.throws(() => admittedTransaction(db, () => { called = true; }), (error) => error === failure);
    assert.equal(called, false);
  });
}

test("unreadable diagnostic enumeration has an explicit marker", () => {
  const value = new Proxy({}, { ownKeys() { throw new Error("private enumeration marker"); } });
  assert.equal(boundedDiagnosticValue(value).diagnostic_unreadable, true);
  assert.equal(errorPayload(lodestarError("database_error", "Known error", { identifiers: value }))
    .identifiers.diagnostic_unreadable, true);
});

test("diagnostic key bounds omit whole keys instead of coalescing unrelated values", () => {
  const prefix = "x".repeat(300);
  const value = { [prefix + "a"]: "first", [prefix + "b"]: "second", short: "kept" };
  const result = boundedDiagnosticValue(value);
  assert.equal(result.short, "kept"); assert.equal(result.diagnostic_omitted_keys, 2);
  assert.equal(Object.keys(result).some((key) => key.startsWith("x")), false);
});

test("diagnostic omission counters do not overwrite an existing same-named field", () => {
  const value = { diagnostic_omitted_properties: "original" };
  for (let i = 0; i < 40; i++) value["z" + String(i).padStart(2, "0")] = i;
  const result = boundedDiagnosticValue(value);
  assert.equal(result.diagnostic_omitted_properties, 9);
  assert.equal(result.diagnostic_value.diagnostic_omitted_properties, "original");
});
