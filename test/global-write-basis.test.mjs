import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

const globalSemantics = {
  lifecycle: "unresolved", context_role: "on_demand", basis: "observed",
  applicability: { project: null, checkout: null },
};

test("global read basis preserves explicit null through update and idempotent replay", async (t) => {
  const f = await fixture(t);
  const id = "knowledge:global-basis";
  await f.create(id, "knowledge", { value: 1 }, "global", globalSemantics);
  const read = await f.cli(["get", id]);
  assert.equal(read.code, 0);
  const basis = read.value.data.write_basis;
  assert.equal(basis.project_scope, null);
  const request = { v: 5, request_id: "global-update", write_basis: basis,
    input: { mode: "update", id, set: { data: { value: 2 } }, remove: [] } };
  const updated = await f.cli(["put"], request);
  assert.equal(updated.code, 0, JSON.stringify(updated.value));
  assert.equal(updated.value.data.data.value, 2);
  assert.equal(updated.value.data.semantics.applicability.project, null);
  const replay = await f.cli(["put"], request);
  assert.equal(replay.code, 0, JSON.stringify(replay.value));
  assert.equal(replay.value.data.revision, updated.value.data.revision);
  const stale = await f.cli(["put"], { ...request, request_id: "stale-global-update",
    input: { ...request.input, set: { data: { value: 3 } } } });
  assert.notEqual(stale.code, 0);
  assert.equal((await f.cli(["get", id])).value.data.data.value, 2);
});

test("global find basis is directly usable without modifying its scope", async (t) => {
  const f = await fixture(t);
  const id = "knowledge:find-basis";
  await f.create(id, "knowledge", { value: 1 }, "global", globalSemantics);
  const found = await f.cli(["find", "find-basis"]);
  assert.equal(found.code, 0);
  const record = found.value.data.records.find((r) => r.id === id);
  assert.ok(record);
  assert.equal(record.write_basis.project_scope, null);
  const updated = await f.cli(["put"], { v: 5, request_id: "find-update", write_basis: record.write_basis,
    input: { mode: "update", id, set: { data: { value: 2 } }, remove: [] } });
  assert.equal(updated.code, 0, JSON.stringify(updated.value));
});

test("global dependency basis stays unscoped in project orientation", async (t) => {
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  await f.create("knowledge:global-dependency", "knowledge", { value: 1 }, "global", globalSemantics);
  await f.create("knowledge:orientation", "knowledge", {}, "project:test",
    { context_role: "orientation", lifecycle: "current" });
  const link = await f.request({ mode: "update", id: "knowledge:orientation",
    set: { links: [{ relationship: "depends-on", to_id: "knowledge:global-dependency" }] }, remove: [] },
    [{ kind: "record", id: "knowledge:orientation" }], "project:test");
  assert.equal((await f.cli(["put"], link)).code, 0);
  const start = await f.cli(["start", "--cwd", f.root]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  const record = start.value.data.context.find((r) => r.id === "knowledge:global-dependency");
  assert.ok(record);
  assert.equal(record.write_basis.project_scope, null);
  const result = await f.cli(["put"], { v: 5, request_id: "orientation-dependency-update",
    write_basis: record.write_basis,
    input: { mode: "update", id: record.id, set: { data: { value: 2 } }, remove: [] } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
});

test("scoped read basis retains project mapping and rejects a mismatched project", async (t) => {
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const id = "knowledge:scoped-basis";
  await f.create(id, "knowledge", { value: 1 }, "project:test");
  const read = await f.cli(["get", id]);
  assert.equal(read.code, 0);
  const basis = read.value.data.write_basis;
  assert.equal(basis.project_scope, "project:test");
  const request = { v: 5, request_id: "scoped-update", write_basis: basis,
    input: { mode: "update", id, set: { data: { value: 2 } }, remove: [] } };
  const updated = await f.cli(["put"], request);
  assert.equal(updated.code, 0, JSON.stringify(updated.value));
  const fresh = (await f.cli(["get", id])).value.data.write_basis;
  const wrong = await f.cli(["put"], { ...request, request_id: "wrong-project",
    write_basis: { ...fresh, project_scope: "project:other" } });
  assert.notEqual(wrong.code, 0);
  assert.equal((await f.cli(["get", id])).value.data.data.value, 2);
});
