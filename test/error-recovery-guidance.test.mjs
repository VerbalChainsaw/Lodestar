import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runCli } from "../src/cli.mjs";
import { decorateError, errorResult, lodestarError, wrapError } from "../src/errors.mjs";
import { parseCliResult } from "../src/interface-client.mjs";
import { fixture } from "./helpers/contract.mjs";

async function injectedInputFailure(database, failure, { mutation = false } = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(mutation ? ["--db", database, "put"] : ["--args-stdin"], {
    stdin: { async *[Symbol.asyncIterator]() { throw failure; } },
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  return { code, stdout, stderr, envelope: JSON.parse(stderr) };
}

function recoveryGuidance(action) {
  assert.match(action, /preserve.*exact/iu);
  assert.match(action, /request.*(?:bytes|ID)/iu);
  assert.match(action, /database/iu); assert.match(action, /journal/iu);
  assert.match(action, /configured.*(?:runtime|Lodestar)/iu);
  assert.match(action, /doctor/); assert.match(action, /--db/);
  assert.match(action, /get --raw --/);
  assert.match(action, /receipt/iu); assert.match(action, /current.*record/iu);
  assert.match(action, /reconcil/iu); assert.match(action, /exact.*replay|replay.*exact/iu);
  assert.doesNotMatch(action, /^Retry|retry the command|new request/iu);
}

test("unknown argument-input failure preserves recovery evidence and remains uncertain to its write consumer", async (t) => {
  const f = await fixture(t);
  const accepted = await f.create("fact:kept", "fact", { kept: true });
  const before = await readFile(f.database);
  const raw = Object.assign(new Error("PRIVATE diagnostic with credential SECRET"), {
    code: "database_write_failed", identifiers: { token: "SECRET" }, action: "Retry immediately" });
  const result = await injectedInputFailure(f.database, raw);
  assert.equal(result.code, 1); assert.equal(result.stdout, "");
  assert.equal(result.envelope.error.code, "internal_error");
  assert.deepEqual(result.envelope.error.identifiers, {});
  assert.equal(result.envelope.request, null); assert.equal(result.envelope.revision, null);
  assert.doesNotMatch(result.stderr, /PRIVATE|SECRET|Retry immediately/);
  recoveryGuidance(result.envelope.error.action);
  assert.deepEqual(result.envelope.next, [result.envelope.error.action]);
  const consumed = parseCliResult({ ...result, exitCode: result.code, elapsedMs: 0,
    operation: "put", args: ["put"], dispatched: true, effect: "record_write" });
  assert.equal(consumed.kind, "TransportError"); assert.equal(consumed.mayHaveCommitted, true);

  // Exercise the existing configured CLI reads named by recovery guidance.
  const doctor = await f.cli(["doctor"]);
  assert.equal(doctor.code, 0); assert.equal(doctor.value.data.healthy, true);
  const receipt = await f.cli(["get", "--raw", "--", accepted.value.receipt_id]);
  assert.equal(receipt.code, 0); assert.equal(receipt.value.data.raw_record.type, "mutation-receipt");
  const record = await f.cli(["get", "--raw", "--", "fact:kept"]);
  assert.equal(record.code, 0); assert.deepEqual(JSON.parse(record.value.data.raw_record.content_json).value, { kept: true });
  assert.deepEqual(await readFile(f.database), before);
});

test("write input failure identifies its pre-dispatch journal boundary and gives usable recovery reads", async (t) => {
  const f = await fixture(t), before = await readFile(f.database);
  let accesses = 0, stdout = '', stderr = '';
  const raw = new Proxy({}, { get() { accesses += 1; throw new Error('SECRET'); },
    ownKeys() { accesses += 1; throw new Error('SECRET'); },
    getOwnPropertyDescriptor() { accesses += 1; throw new Error('SECRET'); } });
  const code = await runCli(['--db', f.database, 'put'], {
    stdin: { async *[Symbol.asyncIterator]() { throw raw; } },
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
  const envelope = JSON.parse(stderr);
  assert.equal(code, 1); assert.equal(stdout, '');
  assert.equal(envelope.error.code, 'recovery_journal_failed');
  assert.equal(envelope.error.identifiers.committed, false);
  assert.equal(envelope.error.identifiers.journal_root, path.join(path.dirname(f.database), 'cli-pending'));
  assert.match(envelope.error.message, /No current write was dispatched/);
  recoveryGuidance(envelope.error.action);
  assert.equal(accesses, 0); assert.doesNotMatch(stderr, /SECRET/);
  assert.deepEqual(await readFile(f.database), before);
});

test("unknown public read failure retains read classification and supports diagnosis without altering state", async (t) => {
  const f = await fixture(t); await f.create("fact:kept", "fact", { kept: true });
  const before = await readFile(f.database), original = DatabaseSync.prototype.prepare;
  let injections = 0, stdout = "", stderr = "";
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (sql === "SELECT id FROM records WHERE id = ?") {
      injections += 1; throw new Error("PRIVATE injected record-read failure");
    }
    return original.call(this, sql, ...args);
  };
  let code;
  try {
    code = await runCli(["--db", f.database, "get", "--", "fact:kept"], {
      stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } },
    });
  } finally { DatabaseSync.prototype.prepare = original; }
  assert.equal(injections, 1); assert.equal(code, 1); assert.equal(stdout, "");
  const envelope = JSON.parse(stderr);
  assert.equal(envelope.error.code, "internal_error"); assert.doesNotMatch(stderr, /PRIVATE/);
  assert.match(envelope.error.action, /reported read|repeat that read/iu);
  assert.match(envelope.error.action, /--db/);
  assert.doesNotMatch(envelope.error.action, /whether a write|request bytes|before replay/iu);
  const consumed = parseCliResult({ stdout, stderr, exitCode: code, elapsedMs: 0,
    operation: "get", args: ["get", "--", "fact:kept"], effect: "read" });
  assert.equal(consumed.kind, "EnvelopeError"); assert.notEqual(consumed.mayHaveCommitted, true);
  assert.equal((await f.cli(["doctor"])).code, 0);
  assert.equal((await f.cli(["get", "--raw", "--", "fact:kept"])).code, 0);
  assert.deepEqual(await readFile(f.database), before);
});

test("known missing-action conflict gets preservation guidance without changing its typed rejection", async (t) => {
  const f = await fixture(t), before = await readFile(f.database);
  const error = lodestarError("request_conflict", "Request ID already belongs to different accepted input.",
    { identifiers: { request_id: "request:original", receipt_id: "mutation-receipt:known" } });
  const result = await injectedInputFailure(f.database, error, { mutation: true });
  assert.equal(result.code, 3); assert.equal(result.envelope.error.code, "request_conflict");
  assert.equal(result.envelope.error.identifiers.request_id, "request:original");
  recoveryGuidance(result.envelope.error.action);
  const consumed = parseCliResult({ ...result, exitCode: result.code, elapsedMs: 0,
    operation: "put", args: ["put"], effect: "record_write" });
  assert.equal(consumed.kind, "EnvelopeError");
  assert.deepEqual(await readFile(f.database), before);
});

test("explicit typed correction and wrapper identity remain unchanged", async (t) => {
  const f = await fixture(t), before = await readFile(f.database);
  const action = "Use the existing receipt_read_args to inspect the accepted receipt before exact replay.";
  const error = lodestarError("request_conflict", "Request ID already belongs to accepted input.",
    { identifiers: { request_id: "request:original" }, action });
  assert.equal(wrapError(error, "database_error", "Discarded outer message"), error);
  const result = await injectedInputFailure(f.database, error);
  assert.equal(result.code, 3); assert.equal(result.envelope.error.action, action);
  assert.deepEqual(result.envelope.next, [action]);
  assert.deepEqual(await readFile(f.database), before);
});

for (const kind of ["getters", "proxy", "revoked-proxy"]) {
  test(`raw ${kind} failure cannot run diagnostic accessors or expose its values`, async (t) => {
    const f = await fixture(t), before = await readFile(f.database);
    let accesses = 0, raw;
    if (kind === "getters") {
      raw = {};
      for (const key of ["code", "message", "identifiers", "action", "name"]) {
        Object.defineProperty(raw, key, { get() { accesses += 1; throw new Error("SECRET accessor"); } });
      }
    } else if (kind === "proxy") {
      raw = new Proxy({}, { get() { accesses += 1; throw new Error("SECRET trap"); },
        ownKeys() { accesses += 1; throw new Error("SECRET trap"); },
        getOwnPropertyDescriptor() { accesses += 1; throw new Error("SECRET trap"); } });
    } else {
      const pair = Proxy.revocable({}, {}); raw = pair.proxy; pair.revoke();
    }
    assert.equal(decorateError(raw, { selected: "caller-owned" }), raw);
    assert.equal(errorResult(raw).envelope.error.code, "internal_error");
    const wrapped = wrapError(raw, "database_error", "Caller-owned storage failure.", { identifiers: { stage: "fixture" } });
    assert.equal(errorResult(wrapped).envelope.error.code, "database_error");
    const result = await injectedInputFailure(f.database, raw);
    assert.equal(result.code, 1); assert.equal(result.envelope.error.code, "internal_error");
    recoveryGuidance(result.envelope.error.action);
    assert.equal(accesses, 0); assert.doesNotMatch(result.stderr, /SECRET/);
    assert.deepEqual(await readFile(f.database), before);
  });
}

test("actual error-envelope encoding failure uses safe fallback without leaking invalid diagnostics", async (t) => {
  const f = await fixture(t), before = await readFile(f.database);
  const error = lodestarError("request_conflict", "PRIVATE typed diagnostic", {
    identifiers: { private_diagnostic: 1n }, action: "PRIVATE action" });
  const result = await injectedInputFailure(f.database, error);
  assert.equal(result.code, 3, "encoding fallback retains the original typed exit classification");
  assert.equal(result.envelope.operation, "cli"); assert.equal(result.envelope.error.code, "internal_error");
  assert.deepEqual(result.envelope.error.identifiers, {}); assert.deepEqual(result.envelope.next, []);
  recoveryGuidance(result.envelope.error.action); assert.doesNotMatch(result.stderr, /PRIVATE|private_diagnostic/);
  const consumed = parseCliResult({ ...result, exitCode: result.code, elapsedMs: 0,
    operation: "put", args: ["put"], effect: "record_write" });
  assert.equal(consumed.kind, "TransportError"); assert.equal(consumed.mayHaveCommitted, true);
  assert.deepEqual(await readFile(f.database), before);
});
