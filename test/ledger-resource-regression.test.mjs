import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import { canonicalStringify, parseJsonText } from "../src/json.mjs";
import { executeCli, loadFindPages, parseCliResult } from "../src/interface-client.mjs";
import { fixture } from "./helpers/contract.mjs";

test("deep small JSON reports a typed resource limit before recursive processing", () => {
  const text = "[".repeat(5000) + "0" + "]".repeat(5000);
  assert.throws(() => parseJsonText(text), (error) => error.code === "resource_limit" &&
    error.identifiers.maximum === 1024 && /nest|flatten/i.test(error.action));
  assert.throws(() => canonicalStringify(JSON.parse(text)), { code: "resource_limit" });
});
test("supported JSON depth boundary roundtrips; the next level is explicitly refused", () => {
  const text = "[".repeat(1024) + "0" + "]".repeat(1024);
  assert.equal(canonicalStringify(parseJsonText(text)), text);
  assert.throws(() => parseJsonText(`[${text}]`), { code: "resource_limit" });
});
test("negative JSON zero uses the documented mathematical zero normalization", () => {
  assert.equal(canonicalStringify(parseJsonText('{"value":-0}')), '{"value":0}');
});
test("SQLite's lower persisted JSON depth limit rejects loudly and rolls back without corruption", async (t) => {
  const f = await fixture(t);
  const data = JSON.parse("[".repeat(1005) + "0" + "]".repeat(1005));
  const request = await f.request({ mode: "create", record: { id: "fact:depth", kind: "fact",
    name: "Depth", scope: "global", data, aliases: [], links: [], sources: [] } }, [{ kind: "record", id: "fact:depth" }]);
  const before = await readFile(f.database);
  const result = await f.cli(["put"], request);
  assert.equal(result.value.error?.code, "resource_limit", JSON.stringify(result.value));
  assert.equal(result.value.error.identifiers.maximum, 1000);
  assert.match(result.value.error.action, /flatten|linked/i);
  assert.deepEqual(await readFile(f.database), before);
  const supported = JSON.parse("[".repeat(900) + "0" + "]".repeat(900));
  await f.create("fact:supported-depth", "fact", supported);
  assert.deepEqual((await f.cli(["get", "fact:supported-depth"])).value.data.data, supported);
});
test("empty advancing pages stop at the page budget with a pinned continuation", async () => {
  let calls = 0;
  const result = await loadFindPages({ cli: "fixture" }, ["--all", "--limit", "1"], {
    maxPages: 3, execute: async (_selection, invocation) => {
      calls += 1;
      assert.ok(calls <= 4, "finite witness prevents the old unbounded loop");
      return { kind: "EnvelopeSuccess", envelope: { revision: 7, database_instance_id: "store",
        database_epoch: "epoch", more: calls < 4, data: { records: [], record_errors: [], complete: calls >= 4 },
        next: [{ command: "find", args: ["--all", "--limit", "1", "--offset", String(calls), "--at-revision", "7"] }] } };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.complete, false);
  assert.equal(result.revision, 7);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.continuation.args, ["--all", "--limit", "1", "--offset", "3", "--at-revision", "7"]);
  assert.match(result.advisories.join(" "), /3 pages|page limit.*3/i);
});
test("a diagnostic-only empty page with valid coverage can continue normally", async () => {
  let calls = 0;
  const result = await loadFindPages({}, ["--all", "--limit", "1"], { maxPages: 3,
    execute: async () => ({ kind: "EnvelopeSuccess", envelope: { revision: 7,
      database_instance_id: "store", database_epoch: "epoch", more: ++calls === 1,
      data: { records: calls === 1 ? [] : [{ id: "note:valid" }],
        record_errors: calls === 1 ? [{ id: "note:damaged", code: "source_correction" }] : [] },
      next: calls === 1 ? [{ command: "find", args: ["--all", "--limit", "1", "--offset", "1", "--at-revision", "7"] }] : [] } }) });
  assert.equal(calls, 2);
  assert.equal(result.records[0].id, "note:valid");
  assert.equal(result.recordErrors.length, 1);
  assert.equal(result.complete, false);
});
test("invalid response bytes identify the channel and preserve write uncertainty", () => {
  const success = JSON.stringify({ v: 5, ok: true, operation: "put", revision: 7,
    database_instance_id: "store", database_epoch: "epoch", more: false, next: [], data: {} });
  for (const resource of ["cli_stdout", "cli_stderr"]) {
    const result = parseCliResult({ stdout: resource === "cli_stdout" ? Buffer.from([255]) : success,
      stderr: resource === "cli_stderr" ? Buffer.from([255]) : "", exitCode: 0,
      operation: "put", effect: "record_write", dispatched: true });
    assert.equal(result.code, "invalid_utf8");
    assert.equal(result.mayHaveCommitted, true);
    assert.equal(result.identifiers.resource, resource);
    assert.ok(result.message.includes(resource));
    assert.ok(result.diagnostics.includes(resource));
  }
});
test("pre-aborted writes never invoke spawn and explicitly report no dispatch", async (t) => {
  const abort = new AbortController(); abort.abort();
  const original = childProcess.spawn;
  let spawns = 0;
  const spy = mock.method(childProcess, "spawn", (...args) => { spawns += 1; return original(...args); });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  const result = await executeCli({ node: process.execPath, cli: "unused-script.mjs", database: "unused.db" },
    { operation: "put", args: ["put"], effect: "record_write", signal: abort.signal });
  assert.equal(spawns, 0);
  assert.equal(result.code, "cancelled");
  assert.equal(result.mayHaveCommitted, false);
  assert.match(result.message, /no.*dispatch/i);
});
