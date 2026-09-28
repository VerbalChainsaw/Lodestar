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
    semantics: { subject: "rejection:materialized-views", basis: "asserted", lifecycle: "current",
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

test("unrelated subjects stay silent and non-advisory receipts replay unchanged", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const record = noteRecord({ id: "note:other", aliases: [], data: { subject: "widget counts", text: "x" } });
  const body = await f.request({ mode: "create", record }, [{ kind: "record", id: record.id }], "project:test");
  const created = await f.cli(["put"], body);
  assert.equal(created.code, 0, JSON.stringify(created.value));
  assert.ok(!JSON.stringify(created.value).includes("Settled rejection"), JSON.stringify(created.value));
  const replay = await f.cli(["put"], body);
  assert.equal(replay.code, 0, JSON.stringify(replay.value));
  assert.deepEqual(replay.value.data, created.value.data);
  assert.deepEqual(replay.value.next ?? [], created.value.next ?? []);
  assert.equal(replay.value.request.replayed, true);
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
    set: { semantics: { subject: "rejection:materialized-views", basis: "asserted", lifecycle: "superseded",
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
  assert.equal(result.code, 3, JSON.stringify(result.value));
  assert.equal(result.value.error.code, "alias_conflict");
  assert.match(result.value.error.action, /rejection:materialized-views/);
});

test("a duplicate rejection for the same subject is refused even with distinct aliases", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const attempt = await putCreate(f, "rejection:matviews-duplicate",
    rejectionRecord({ id: "rejection:matviews-duplicate", aliases: ["matviews duplicate"] }));
  assert.notEqual(attempt.code, 0, JSON.stringify(attempt.value));
  assert.equal(attempt.value.ok, false);
});

test("update without remove explains the remove rule", async (t) => {
  const f = await registerFixture(t);
  const seed = noteRecord({ id: "note:seeded", aliases: [], data: { subject: "widget counts", text: "x" } });
  assert.equal((await putCreate(f, seed.id, seed)).code, 0);
  const update = await f.request({ mode: "update", id: seed.id, set: { name: "Renamed" } },
    [{ kind: "record", id: seed.id }], "project:test");
  const result = await f.cli(["put"], update);
  assert.equal(result.code, 2, JSON.stringify(result.value));
  assert.equal(result.value.error.code, "invalid_mutation_contract");
  assert.ok(result.value.error.action.includes('"remove": []'), JSON.stringify(result.value));
});

test("an ordinary record with the domain slug coexists with the rejection", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const fact = await f.request({ mode: "create", record: {
    id: "fact:matviews-history", kind: "fact", name: "Matviews history", scope: "project:test",
    availability: "known",
    data: { text: "ordinary record about the materialized views decision history" },
    aliases: ["matviews fact"], links: [], sources: [],
    semantics: { subject: "materialized-views", basis: "asserted", lifecycle: "current",
      context_role: "orientation", applicability: { project: "project:test", checkout: null } } } },
  [{ kind: "record", id: "fact:matviews-history" }], "project:test");
  const created = await f.cli(["put"], fact);
  assert.equal(created.code, 0, JSON.stringify(created.value));
});

test("a global rejection with matching applicability fires and appears in orientation", async (t) => {
  const f = await registerFixture(t);
  const record = rejectionRecord({
    id: "rejection:global-matviews",
    name: "Global matviews rejection",
    scope: "global",
    data: { subject: "global materialized views", verdict: "never-revisit", reason: "Global-settled." },
    aliases: ["global matviews"],
    semantics: { subject: "rejection:global-matviews", basis: "asserted", lifecycle: "current",
      context_role: "orientation", applicability: { project: "project:test", checkout: null } },
  });
  assert.equal((await putCreate(f, record.id, record)).code, 0);
  const note = noteRecord({ id: "note:global-matview", aliases: [], data: { subject: "global materialized views", text: "x" } });
  const created = await putCreate(f, note.id, note);
  assert.equal(created.code, 0, JSON.stringify(created.value));
  assert.ok(created.value.next?.some((line) => line.includes("rejection:global-matviews")),
    JSON.stringify(created.value));
  const start = await f.cli(["start", "--cwd", f.root]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.ok(start.value.data.context.some(({ id }) => id === "rejection:global-matviews"));
});

test("advisory bounds: cap, ordering, truncation, and type safety", async (t) => {
  const f = await registerFixture(t);
  const long = "L".repeat(200);
  const parts = [
    { id: "rejection:bounds-a", reason: long },
    { id: "rejection:bounds-b" },
    { id: "rejection:bounds-c", reason: 42 },
    { id: "rejection:bounds-d", reason: "short reason" },
  ];
  for (const { id, reason } of parts) {
    const record = {
      id, kind: "rejection", name: id, scope: "project:test", availability: "known", priority: 5,
      data: { subject: "bounds case", verdict: "never-revisit",
        ...(reason === undefined ? {} : { reason }) },
      aliases: [], links: [], sources: [],
      semantics: { subject: `rejection:${id.slice("rejection:".length)}`, basis: "asserted",
        lifecycle: "current", context_role: "orientation",
        applicability: { project: "project:test", checkout: null } },
    };
    const result = await putCreate(f, id, record);
    assert.equal(result.code, 0, JSON.stringify(result.value));
  }
  const note = noteRecord({ id: "note:bounds", aliases: [], data: { subject: "bounds case", text: "x" } });
  const created = await putCreate(f, note.id, note);
  assert.equal(created.code, 0, JSON.stringify(created.value));
  const lines = created.value.next.filter((line) => line.includes("Settled rejection"));
  assert.equal(lines.length, 3, JSON.stringify(created.value.next));
  assert.ok(lines[0].includes("rejection:bounds-a") && lines[1].includes("rejection:bounds-b")
    && lines[2].includes("rejection:bounds-c"), JSON.stringify(lines));
  assert.ok(lines[0].includes("..."), "long reason truncated");
  assert.ok(!lines[0].includes("L".repeat(141)), "reason cut at the bound");
  assert.ok(!created.value.next.some((line) => /undefined|null/.test(line)), JSON.stringify(created.value.next));
  assert.ok(created.value.next.some((line) => line.includes("more current rejection")),
    JSON.stringify(created.value.next));
});

test("rejection writes themselves receive no advisory", async (t) => {
  const f = await registerFixture(t);
  await createRejection(f);
  const sibling = rejectionRecord({ id: "rejection:matviews-sibling",
    aliases: ["matviews sibling"],
    semantics: { subject: "rejection:matviews-sibling", basis: "asserted", lifecycle: "current",
      context_role: "orientation", applicability: { project: "project:test", checkout: null } } });
  const result = await putCreate(f, sibling.id, sibling);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.ok(!JSON.stringify(result.value).includes("Settled rejection"), JSON.stringify(result.value));
});
