import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCli, parseCliResult } from "../src/interface-client.mjs";

const fixture = JSON.parse(await readFile(new URL("./cli-protocol-cases.json", import.meta.url), "utf8"));
const envelope = (entry, ok) => {
  const result = { v: 5, ok, operation: entry.operation,
  revision: 7, database_instance_id: "a".repeat(64), database_epoch: "b".repeat(64),
  ...(ok ? { data: { reference: "public:opaque-handoff-ref" } } : { error: {
    code: "revision_conflict", message: "Observed revision changed.",
    action: "Read the current basis and resolve the saved request.",
    identifiers: { request_id: "ll-fixture", record_id: "handoff:public" } } }),
    more: false, next: [] };
  for (const name of entry.omit ?? []) delete result[name];
  return Object.assign(result, entry.set ?? {});
};
const render = (parts, entry) => parts.map((part) =>
  part === "@success" ? JSON.stringify(envelope(entry, true)) :
    part === "@error" ? JSON.stringify(envelope(entry, false)) : part).join("\n");

for (const entry of fixture.cases) test(`shared CLI protocol: ${entry.id}`, () => {
  const result = parseCliResult({ stdout: render(entry.stdout, entry),
    stderr: render(entry.stderr, entry), exitCode: entry.exitCode, elapsedMs: 1,
    operation: entry.operation, args: entry.args, effect: entry.effect, dispatched: true });
  const kind = result.kind === "EnvelopeSuccess" ? "success" :
    result.kind === "EnvelopeError" ? "error" : "transport_error";
  assert.equal(kind, entry.expect.kind);
  if (entry.expect.code) assert.equal(result.kind === "EnvelopeError"
    ? result.envelope.error.code : result.code, entry.expect.code);
  if (Object.hasOwn(entry.expect, "mayHaveCommitted"))
    assert.equal(result.mayHaveCommitted, entry.expect.mayHaveCommitted);
  if (entry.expect.mayHaveCommitted)
    assert.match(result.message, /outcome.*unknown.*saved request/i);
  if (entry.expect.reportedErrorCode)
    assert.equal(result.envelope?.error?.code, entry.expect.reportedErrorCode);
  if (entry.id.startsWith("semantic-")) {
    assert.deepEqual(result.envelope, envelope(entry, false), "Full semantic envelope must survive classification.");
    if (entry.expect.mayHaveCommitted) assert.ok(result.message.includes(entry.expect.action));
  }
  if (kind === "error") {
    assert.equal(result.envelope.error.action, entry.expect.action ?? "Read the current basis and resolve the saved request.");
    assert.equal(result.envelope.error.identifiers.request_id, "ll-fixture");
  }
  if (entry.expect.reference) assert.equal(result.envelope.data.reference, entry.expect.reference);
  assert.doesNotMatch(result.diagnostics ?? "", /PRIVATE_BODY_MARKER/);
});

test("semantic response cannot imply a dispatched write when no dispatch occurred", () => {
  for (const entry of fixture.cases.filter(row => row.id.startsWith("semantic-") && row.expect.mayHaveCommitted)) {
    const result = parseCliResult({stdout: "", stderr: render(entry.stderr, entry), exitCode:5,
      elapsedMs:1, operation:entry.operation, effect:entry.effect, dispatched:false});
    assert.equal(result.kind, "EnvelopeError");
    assert.notEqual(result.mayHaveCommitted, true);
  }
});

test("spawn error names configured runtime and retains certainly unsent write outcome", async () => {
  const missingNode = path.join(tmpdir(), `lodestar-missing-node-${randomUUID()}.exe`);
  const result = await executeCli({ node: missingNode, cli: "fixture.mjs", database: "fixture.db" },
    { operation: "put", args: ["put"], effect: "record_write" });
  assert.equal(result.kind, "TransportError");
  assert.equal(result.code, "spawn_failed");
  assert.equal(result.mayHaveCommitted, false);
  assert.match(result.message, /configured Node|executable/i);
});
