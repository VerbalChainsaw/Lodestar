import assert from "node:assert/strict";
import test from "node:test";
import { loadFindPages } from "../src/interface-client.mjs";

test("a final damaged-record page retains diagnostics without inventing a missing cursor", async () => {
  let calls = 0;
  const diagnostic = { id: "note:damaged", code: "source_correction" };
  const result = await loadFindPages({}, ["--all"], { execute: async () => {
    calls += 1;
    return { kind: "EnvelopeSuccess", envelope: {
      more: false, next: ["Inspect note:damaged."], revision: 1,
      database_instance_id: "store", database_epoch: "epoch",
      data: { records: [{ id: "note:valid" }], more: false, complete: false,
        record_errors: [diagnostic] } } };
  } });
  assert.equal(calls, 1);
  assert.equal(result.kind, "ReadSnapshot");
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, [{ id: "note:valid" }]);
  assert.deepEqual(result.recordErrors, [diagnostic]);
  assert.deepEqual(result.advisories, ["Inspect note:damaged."]);
  assert.equal(result.continuation, undefined);
});

test("a truncated page without a cursor still reports incomplete pagination", async () => {
  const result = await loadFindPages({}, ["--all"], { execute: async () => ({
    kind: "EnvelopeSuccess", envelope: { more: true, next: [], revision: 1,
      database_instance_id: "store", database_epoch: "epoch",
      data: { records: [], more: true, complete: false, record_errors: [] } },
  }) });
  assert.equal(result.complete, false);
  assert.deepEqual(result.advisories, ["No valid continuation was returned."]);
});

for (const record of [null, {}, { id: null }, { id: 42 }, { id: "" }]) {
  test(`catalog consumer rejects malformed record ${JSON.stringify(record)}`, async () => {
    const result = await loadFindPages({}, ["--all"], { execute: async () => ({ kind: "EnvelopeSuccess", envelope: {
      more: false, next: [], revision: 1, database_instance_id: "store", database_epoch: "epoch",
      data: { records: [record], record_errors: [] } } }) });
    assert.equal(result.kind, "TransportError"); assert.equal(result.code, "invalid_envelope");
    assert.equal(result.complete, false);
    assert.match(result.message, /record.*0|0.*record/i);
    assert.match(result.message, /inspect|configured|read/i);
    assert.deepEqual(result.records, []);
  });
}
