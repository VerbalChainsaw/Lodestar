import assert from "node:assert/strict";
import test from "node:test";
import { loadFindPages } from "../src/interface-client.mjs";

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
