import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

async function registerFixture(t) {
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  return f;
}

function rejectionRecord(overrides = {}) {
  return {
    id: "rejection:materialized-views",
    kind: "rejection",
    name: "Materialized views — rejected",
    scope: "project:test",
    availability: "known",
    priority: 200,
    data: { subject: "materialized views", verdict: "never-revisit",
      reason: "Rebuild cost and staleness outweighed read speed; revisit only on recorded user direction." },
    aliases: ["materialized views", "matview approach"],
    links: [],
    sources: [],
    semantics: { subject: "materialized-views", basis: "asserted", lifecycle: "current",
      context_role: "orientation", applicability: { project: "project:test", checkout: null } },
    ...overrides,
  };
}

async function putCreate(f, id, record) {
  const body = await f.request({ mode: "create", record },
    [{ kind: "record", id }], "project:test");
  return f.cli(["put"], body);
}

function noteRecord(overrides = {}) {
  return {
    id: "note:matview-proposal",
    kind: "note",
    name: "Matview proposal",
    scope: "project:test",
    availability: "known",
    data: { subject: "materialized views", text: "proposal" },
    aliases: ["matview proposal"],
    links: [],
    sources: [],
    ...overrides,
  };
}

async function createRejection(f, overrides = {}) {
  const record = rejectionRecord(overrides);
  const result = await putCreate(f, record.id, record);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  return result;
}

test("a colliding subject receives a persisted, replayable rejection advisory", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const record = noteRecord();
  const body = await f.request({ mode: "create", record }, [{ kind: "record", id: record.id }], "project:test");
  const created = await f.cli(["put"], body);
  assert.equal(created.code, 0, JSON.stringify(created.value));
  assert.ok(Array.isArray(created.value.next)
    && created.value.next.some((line) => line.includes("rejection:materialized-views")),
  JSON.stringify(created.value));
  const replay = await f.cli(["put"], body);
  assert.equal(replay.code, 0, JSON.stringify(replay.value));
  assert.deepEqual(replay.value.next, created.value.next);
  assert.equal(replay.value.request.replayed, true);
});

test("unrelated subjects stay silent", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const record = noteRecord({ id: "note:other", aliases: [], data: { subject: "widget counts", text: "x" } });
  const created = await putCreate(f, record.id, record);
  assert.equal(created.code, 0, JSON.stringify(created.value));
  assert.ok(!JSON.stringify(created.value).includes("Settled rejection"), JSON.stringify(created.value));
});

test("updating a record into a rejected subject receives the advisory", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const seed = noteRecord({ id: "note:seeded", aliases: [], data: { subject: "widget counts", text: "x" } });
  assert.equal((await putCreate(f, seed.id, seed)).code, 0);
  const update = await f.request({ mode: "update", id: seed.id,
    set: { data: { subject: "materialized views", text: "x" } }, remove: [] },
  [{ kind: "record", id: seed.id }], "project:test");
  const updated = await f.cli(["put"], update);
  assert.equal(updated.code, 0, JSON.stringify(updated.value));
  assert.ok(Array.isArray(updated.value.next)
    && updated.value.next.some((line) => line.includes("rejection:materialized-views")),
  JSON.stringify(updated.value));
});

test("retired rejections are silent and leave orientation", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const retire = await f.request({ mode: "update", id: "rejection:materialized-views",
    set: { semantics: { subject: "materialized-views", basis: "asserted", lifecycle: "superseded",
      context_role: "orientation", applicability: { project: "project:test", checkout: null },
      retirement_reason: "Superseded in test." } }, remove: [] },
  [{ kind: "record", id: "rejection:materialized-views" }], "project:test");
  assert.equal((await f.cli(["put"], retire)).code, 0, "retire");
  const record = noteRecord({ aliases: [] });
  const created = await putCreate(f, record.id, record);
  assert.ok(!JSON.stringify(created.value).includes("Settled rejection"), JSON.stringify(created.value));
  const start = await f.cli(["start", "--cwd", f.root]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.ok(!start.value.data.context.some(({ id }) => id === "rejection:materialized-views"));
});

test("rejections surface in find and orientation with their selection reason", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const found = await f.cli(["find", "materialized"]);
  assert.equal(found.code, 0, JSON.stringify(found.value));
  assert.ok(found.value.data.records.some(({ id }) => id === "rejection:materialized-views"),
    JSON.stringify(found.value.data.records.map(({ id }) => id)));
  const start = await f.cli(["start", "--cwd", f.root]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  const entry = start.value.data.context.find(({ id }) => id === "rejection:materialized-views");
  assert.ok(entry, JSON.stringify(start.value.data.context.map(({ id }) => id)));
  assert.equal(entry.selection_reason, "orientation");
});

test("alias reuse fails with the rejection identified", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const record = noteRecord({ id: "note:alias-clash", aliases: ["matview approach"] });
  const result = await putCreate(f, record.id, record);
  assert.notEqual(result.code, 0);
  assert.match(JSON.stringify(result.value), /alias_conflict/);
  assert.match(JSON.stringify(result.value), /rejection:materialized-views/);
});

test("a duplicate rejection for the same subject is refused", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const attempt = await putCreate(f, "rejection:matviews-duplicate",
    rejectionRecord({ id: "rejection:matviews-duplicate" }));
  assert.notEqual(attempt.code, 0, JSON.stringify(attempt.value));
});

test("update without remove explains the remove rule", async (t) => {
  const f = await registerFixture(t);
  const seed = noteRecord({ id: "note:seeded", aliases: [], data: { subject: "widget counts", text: "x" } });
  assert.equal((await putCreate(f, seed.id, seed)).code, 0);
  const update = await f.request({ mode: "update", id: seed.id, set: { name: "Renamed" } },
    [{ kind: "record", id: seed.id }], "project:test");
  const result = await f.cli(["put"], update);
  assert.notEqual(result.code, 0);
  assert.match(JSON.stringify(result.value), /invalid_mutation_contract/);
  assert.match(JSON.stringify(result.value), /remove/);
});
