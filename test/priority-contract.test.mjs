import assert from "node:assert/strict";
import test from "node:test";
import { PUT_INPUT_SCHEMA } from "../src/records.mjs";
import { validatePutInput } from "../src/validate.mjs";
import { fixture } from "./helpers/contract.mjs";

const priorities = [Number.MIN_SAFE_INTEGER, -1, 0, Number.MAX_SAFE_INTEGER];

test("priority validators and published schema share the full safe-integer domain", () => {
  for (const branch of [PUT_INPUT_SCHEMA.oneOf[0].properties.record,
    PUT_INPUT_SCHEMA.oneOf[1].properties.set, PUT_INPUT_SCHEMA.oneOf[2].properties.record]) {
    assert.equal(branch.properties.priority.minimum, Number.MIN_SAFE_INTEGER);
    assert.equal(branch.properties.priority.maximum, Number.MAX_SAFE_INTEGER);
  }
  const input = { id: "fact:priority", type: "fact", name: "Priority", scope: "global",
    content: { state: "known", value: {} }, aliases: [], links: [], sources: [] };
  for (const priority of priorities) {
    assert.doesNotThrow(() => validatePutInput({ ...input, priority,
      content: { ...input.content, _lodestar: { priority, revision: 1 } } }));
  }
  for (const priority of [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1,
    0.5, NaN, Infinity, -Infinity, "-1", null]) {
    assert.throws(() => validatePutInput({ ...input, priority }), (error) => {
      assert.equal(error.code, "invalid_input");
      assert.equal(error.identifiers.field, "priority");
      return true;
    });
  }
});

test("CLI create, update, replace and exact replay preserve negative and boundary priorities", async (t) => {
  const f = await fixture(t), id = "fact:priority";
  const record = { id, kind: "fact", name: "Priority", scope: "global",
    data: {}, aliases: [], links: [], sources: [] };
  const inputs = priorities.map((priority, index) => index === 0
    ? { mode: "create", record: { ...record, priority } }
    : { mode: "update", id, set: { priority }, remove: [] });
  inputs.push({ mode: "replace", record: { ...record, priority: Number.MIN_SAFE_INTEGER } });
  for (const input of inputs) {
    const request = await f.request(input, [{ kind: "record", id }]);
    const priority = input.record?.priority ?? input.set.priority;
    const accepted = await f.cli(["put"], request);
    assert.equal(accepted.code, 0, JSON.stringify(accepted.value));
    assert.equal(accepted.value.data.priority, priority);
    const read = await f.cli(["get", id]);
    assert.equal(read.code, 0);
    assert.equal(read.value.data.priority, priority);
    const replay = await f.cli(["put"], request);
    assert.equal(replay.code, 0, JSON.stringify(replay.value));
    assert.equal(replay.value.request.replayed, true);
    assert.equal(replay.value.revision, accepted.value.revision);
    assert.equal(replay.value.receipt_id, accepted.value.receipt_id);
    assert.deepEqual(replay.value.data, accepted.value.data);
  }
});
