import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { diagnoseDatabase } from "../src/doctor.mjs";
import {
  PENDING_MAXIMUM, pendingAdd, pendingCount, pendingDrop, pendingList, pendingPromote,
  pendingScope,
} from "../src/pending.mjs";
import { resolveProject } from "../src/project.mjs";
import { putRecord } from "../src/records.mjs";
import { requiredBudgetNotice, startProjection } from "../src/agent-state.mjs";
import { extractNotes } from "../codex-plugin/scripts/lodestar-runtime.mjs";

const IDENTITY = { actor: "agent:session", agent: "agent", session: "session", harness: null };
const now = () => new Date("2026-08-14T00:00:00.000Z");

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-pending-"));
  const file = path.join(directory, "registry.db");
  await initializeDatabase(file);
  const db = await openWriteDatabase(file);
  // One hook, closing before removing: Windows refuses to unlink an open database.
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "project");
  putRecord(db, {
    id: "p:demo", type: "project", name: "Demo", scope: "global",
    content: { state: "known", value: { roots: [root] } },
  }, {});
  return { db, file, project: resolveProject(db, directory) };
}

test("a captured candidate costs the startup budget nothing", async (t) => {
  const { db, file, project } = await fixture(t);
  const before = startProjection(db, project, IDENTITY, { database: file });
  const baseline = JSON.stringify(before.data).length;

  for (const text of ["first candidate", "second candidate", "third candidate"]) {
    pendingAdd(db, project, IDENTITY, text, { database: file, now });
  }

  const after = startProjection(db, project, IDENTITY, { database: file });
  // The quarantine scope is not one `start` selects, so capture can be automatic without
  // competing for the 16 KiB every session must carry.
  assert.equal(after.data.context.length, before.data.context.length);
  assert.equal(after.data.required.length, before.data.required.length);
  assert.equal(after.data.pending, 3);
  // Only the integer count differs.
  assert.ok(JSON.stringify(after.data).length - baseline < 32);
});

test("identical text from one source captures once", async (t) => {
  const { db, file, project } = await fixture(t);
  const first = pendingAdd(db, project, IDENTITY, "renderer reaches sqlite via preload",
    { database: file, now });
  const repeat = pendingAdd(db, project, IDENTITY, "renderer reaches sqlite via preload",
    { database: file, now });
  assert.equal(first.added, true);
  assert.equal(repeat.added, false);
  assert.equal(pendingCount(db, project), 1);

  // A different source is a distinct observation and is kept.
  const other = pendingAdd(db, project, IDENTITY, "renderer reaches sqlite via preload",
    { database: file, now, source: "hook" });
  assert.equal(other.added, true);
  assert.equal(pendingCount(db, project), 2);
});

test("promotion moves a candidate into project scope without making it required", async (t) => {
  const { db, file, project } = await fixture(t);
  const added = pendingAdd(db, project, IDENTITY, "migrations are append-only",
    { database: file, now });
  const promoted = pendingPromote(db, project, IDENTITY, added.record.id, { database: file, now });

  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.scope, project.scope);
  assert.equal(promoted.record.data.required, false);
  assert.equal(pendingCount(db, project), 0);

  const projection = startProjection(db, project, IDENTITY, { database: file });
  assert.equal(projection.data.pending, 0);
  // Promotion never enlarges what every session must carry.
  assert.equal(
    JSON.stringify(projection.data.required).includes("append-only"),
    false,
  );
  assert.equal(
    projection.data.context.some(({ data }) => data.text === "migrations are append-only"),
    true,
  );
});

test("candidates are addressable only from their own project", async (t) => {
  const { db, file, project } = await fixture(t);
  const added = pendingAdd(db, project, IDENTITY, "scoped candidate", { database: file, now });
  const other = { ...project, scope: "project:other" };

  assert.equal(pendingScope(other), "pending:project:other");
  for (const call of [
    () => pendingPromote(db, other, IDENTITY, added.record.id, { database: file, now }),
    () => pendingDrop(db, other, added.record.id, { database: file }),
  ]) {
    assert.throws(call, { code: "pending_not_found" });
  }
  assert.equal(pendingCount(db, project), 1);
});

test("dropping removes the candidate and nothing else", async (t) => {
  const { db, file, project } = await fixture(t);
  const keep = pendingAdd(db, project, IDENTITY, "keep me", { database: file, now });
  const discard = pendingAdd(db, project, IDENTITY, "discard me", { database: file, now });

  const dropped = pendingDrop(db, project, discard.record.id, { database: file });
  assert.equal(dropped.dropped, true);

  const listed = pendingList(db, project);
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.records.map(({ id }) => id), [keep.record.id]);
});

test("capture rejects control characters and secret material", async (t) => {
  const { db, file, project } = await fixture(t);
  for (const bad of ["", "   ", "tokenbell", "export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaa"]) {
    assert.throws(
      () => pendingAdd(db, project, IDENTITY, bad, { database: file, now }),
      { code: "invalid_input" },
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(pendingCount(db, project), 0);
});

test("the queue is a bounded rolling window and reports what it evicted", async (t) => {
  const { db, file, project } = await fixture(t);
  let evicted = [];
  let firstId = null;
  for (let index = 0; index < PENDING_MAXIMUM + 5; index += 1) {
    const added = pendingAdd(db, project, IDENTITY, `candidate ${index}`, { database: file, now });
    firstId ??= added.record.id;
    if (added.evicted?.length) evicted = evicted.concat(added.evicted);
  }
  assert.equal(pendingCount(db, project), PENDING_MAXIMUM);
  // Reaching the cap means review already stopped; keeping the newest is more useful
  // than hoarding, and the eviction is reported rather than silent.
  assert.ok(evicted.includes(firstId), "the oldest candidate is the one evicted");
  const texts = pendingList(db, project, PENDING_MAXIMUM).records.map(({ data }) => data.text);
  assert.equal(texts.includes("candidate 0"), false);
  assert.equal(texts.includes(`candidate ${PENDING_MAXIMUM + 4}`), true);
});

test("an over-budget startup sheds to names instead of refusing to run", async (t) => {
  const { db, file, project } = await fixture(t);
  for (let index = 0; index < 6; index += 1) {
    putRecord(db, {
      id: `g:bulk${index}`, type: "rule", name: `Bulk ${index}`, scope: "global",
      content: { state: "known", value: { required: true, text: "x".repeat(3000) } },
    }, {});
  }

  // 18 KiB of "always present" inside a 16 KiB budget is a contradiction, and `start`
  // used to resolve it by refusing — stopping every session in the project over a
  // marking mistake made somewhere else. It resolves it by demoting instead.
  const result = startProjection(db, project, IDENTITY, { database: file });
  const envelope = Buffer.byteLength(JSON.stringify({ v: 1, ok: true, operation: "start",
    revision: result.revision, data: result.data, more: result.more, next: result.next }), "utf8");
  assert.ok(envelope <= 16 * 1024, `envelope ${envelope} must stay within budget`);
  assert.equal(result.more, true);
  assert.ok(result.data.omitted.required > 0, "required records were demoted");

  // Demoted is not deleted. Every one is named, so the agent fetches the single record
  // it needs rather than searching the whole scope and re-reading what it already had.
  const shed = new Set(result.data.available.map(({ id }) => id));
  const carried = new Set(result.data.required.map(({ id }) => id));
  for (let index = 0; index < 6; index += 1) {
    const id = `g:bulk${index}`;
    assert.ok(shed.has(id) || carried.has(id), `${id} is either carried or named`);
  }
  for (const stub of result.data.available) {
    assert.ok(stub.id && stub.name && stub.kind, `stub is addressable: ${JSON.stringify(stub)}`);
  }
  // The governance record states the operating contract and is the last thing demoted.
  assert.ok(result.data.required.length >= 1, "startup never sheds below the contract");
});

test("the startup budget is configurable, and every source is stated", async (t) => {
  const { db, file, project } = await fixture(t);
  const prior = process.env.LODESTAR_STARTUP_BUDGET;
  t.after(() => {
    if (prior === undefined) delete process.env.LODESTAR_STARTUP_BUDGET;
    else process.env.LODESTAR_STARTUP_BUDGET = prior;
  });
  delete process.env.LODESTAR_STARTUP_BUDGET;
  const budget = (options = {}) => startProjection(db, project, IDENTITY,
    { database: file, ...options }).data.budget;

  // 16 KiB is roughly 4K tokens — generous for a small local model, negligible for a
  // 200K-context host. It is a starting point, so it must be a default and not a wall.
  assert.deepEqual(budget(), { bytes: 16 * 1024, source: "default" });

  // Precedence runs from most immediate to most durable, and a project setting beats a
  // machine one because it is the narrower statement.
  putRecord(db, { id: "config:startup", type: "config", name: "Machine budget",
    scope: "global", content: { state: "known", value: { startup_budget_bytes: 40_960 } } }, {});
  assert.deepEqual(budget(), { bytes: 40_960, source: "global" });
  putRecord(db, { id: "p:config:startup", type: "config", name: "Project budget",
    scope: project.scope,
    content: { state: "known", value: { startup_budget_bytes: 24_576 } } }, {});
  assert.deepEqual(budget(), { bytes: 24_576, source: "project" });
  process.env.LODESTAR_STARTUP_BUDGET = "32768";
  assert.deepEqual(budget(), { bytes: 32_768, source: "environment" });
  assert.deepEqual(budget({ startupBudget: "49152" }), { bytes: 49_152, source: "option" });

  // A budget outside the sane range is a typo, not an instruction. Honouring one would
  // either strangle startup or defeat the bound entirely, so it falls back to default.
  delete process.env.LODESTAR_STARTUP_BUDGET;
  putRecord(db, { id: "config:startup", type: "config", name: "Machine budget",
    scope: "global", content: { state: "known", value: { startup_budget_bytes: 10 } } }, {});
  putRecord(db, { id: "p:config:startup", type: "config", name: "Project budget",
    scope: project.scope, content: { state: "known", value: { startup_budget_bytes: 0 } } }, {});
  assert.deepEqual(budget(), { bytes: 16 * 1024, source: "default" });
  for (const bogus of ["10", "999999999", "abc", "", "16384.5"]) {
    assert.equal(budget({ startupBudget: bogus }).source, "default", bogus);
  }

  // Config describes how the projection is built, so carrying it would spend the budget
  // describing the budget.
  const projected = startProjection(db, project, IDENTITY, { database: file }).data;
  const shown = [...projected.context, ...projected.available].map(({ id }) => id);
  assert.equal(shown.some((id) => id.includes("config:startup")), false);
});

test("a raised budget carries what a default one has to shed", async (t) => {
  const { db, file, project } = await fixture(t);
  for (let index = 0; index < 40; index += 1) {
    putRecord(db, { id: `p:ctx${index}`, type: "note", name: `Note ${index}`,
      scope: project.scope,
      content: { state: "known", value: { text: `${index}:${"x".repeat(900)}` } } }, {});
  }
  const tight = startProjection(db, project, IDENTITY, { database: file }).data;
  const roomy = startProjection(db, project, IDENTITY,
    { database: file, startupBudget: 128 * 1024 }).data;

  assert.ok(roomy.context.length > tight.context.length, "a bigger budget carries more");
  assert.ok(!roomy.omitted.hidden, "and stops hiding names entirely");
  // Whatever the budget, the projection stays inside it.
  for (const [data, limit] of [[tight, 16 * 1024], [roomy, 128 * 1024]]) {
    assert.ok(Buffer.byteLength(JSON.stringify(data), "utf8") <= limit);
  }
});

test("marking a record required reports the budget it just spent", async (t) => {
  const { db, file, project } = await fixture(t);
  const put = (id, scope, text, required) => putRecord(db, { id, type: "rule", name: id, scope,
    content: { state: "known", value: required ? { required: true, text } : { text } } }, {});

  // The cost of `required` is paid at startup, in a session that may be days away and in
  // a project the author never opens. Saying nothing at the moment of the mark is what
  // turned a marking mistake into an unexplained startup somewhere else.
  put("g:cheap", "global", "tiny", true);
  assert.deepEqual(requiredBudgetNotice(db, { scope: "global",
    content: { value: { required: true } } }), {}, "an ordinary mark is silent");

  // A record that is not required never triggers the check at all.
  assert.deepEqual(requiredBudgetNotice(db, { scope: project.scope,
    content: { value: { text: "x" } } }), {});

  put("g:heavy", "global", "x".repeat(20_000), true);
  const notice = requiredBudgetNotice(db, { scope: "global",
    content: { value: { required: true } } });
  assert.equal(notice.more, true);
  assert.match(notice.next[0], /startup budget/u);
  assert.match(notice.next[0], /demote/u);

  // It is a report, never a refusal: a bulk import must not fail on its last record.
  assert.doesNotThrow(() => put("g:another", "global", "x".repeat(4_000), true));
});

test("doctor reports the standing startup cost of global required records", async (t) => {
  const { db, file } = await fixture(t);
  const baseline = diagnoseDatabase(db, { database: file }).checks.startup_budget;
  assert.ok(baseline.global_required_bytes > 0, "the injected governance record is counted");
  assert.equal(baseline.budget_bytes, 16 * 1024);
  assert.equal(
    baseline.project_headroom_bytes,
    baseline.budget_bytes - baseline.global_required_bytes,
  );

  putRecord(db, {
    id: "g:demo:rule", type: "rule", name: "Demo rule", scope: "global",
    content: { state: "known", value: { required: true, text: "x".repeat(2000) } },
  }, {});

  const grown = diagnoseDatabase(db, { database: file }).checks.startup_budget;
  assert.equal(grown.global_required_records, baseline.global_required_records + 1);
  assert.ok(
    grown.project_headroom_bytes < baseline.project_headroom_bytes - 1900,
    "a global required record is charged to every project",
  );
});

test("only an explicit marker line is captured from a turn", () => {
  // Capture must never fire on an ordinary message, or the queue fills with near-misses
  // and stops being worth reviewing.
  assert.deepEqual(extractNotes("I fixed the bug and ran the tests."), []);
  assert.deepEqual(extractNotes("The agent may write LODESTAR NOTE: mid-sentence."), []);
  assert.deepEqual(extractNotes(undefined), []);

  assert.deepEqual(
    extractNotes("Done.\nLODESTAR NOTE: migrations are append-only\nAnything else?"),
    ["migrations are append-only"],
  );
  assert.deepEqual(extractNotes("LODESTAR NOTE: same\nLODESTAR NOTE: same"), ["same"]);
  assert.equal(
    extractNotes([1, 2, 3, 4, 5].map((i) => `LODESTAR NOTE: fact ${i}`).join("\n")).length,
    3,
  );
});

test("doctor raises an issue before the startup budget runs out", async (t) => {
  const { db, file } = await fixture(t);
  assert.equal(
    diagnoseDatabase(db, { database: file }).issues.some(({ code }) => code === "startup_budget_low"),
    false,
  );

  putRecord(db, {
    id: "g:demo:huge", type: "rule", name: "Huge rule", scope: "global",
    content: { state: "known", value: { required: true, text: "x".repeat(12_000) } },
  }, {});

  const report = diagnoseDatabase(db, { database: file });
  const issue = report.issues.find(({ code }) => code === "startup_budget_low");
  // The warning has to arrive while there is still room to act, not once `start`
  // already fails.
  assert.ok(issue, "expected a low-headroom warning");
  assert.ok(issue.identifiers.project_headroom_bytes < 4096);
  assert.match(issue.action, /global required record/u);
});

test("doctor sees the project closest to exceeding the budget, not just the global cost", async (t) => {
  const { db, file } = await fixture(t);
  const clean = diagnoseDatabase(db, { database: file }).checks.startup_budget;
  assert.equal(clean.healthy, true);
  assert.equal(clean.worst_project, null);
  assert.equal(clean.projects_with_required, 0);

  // Global cost stays small; one project loads itself up. `start` sheds on global plus
  // project, so this project is nearly dead — but a global-only measurement calls the
  // whole registry healthy and the outage arrives without warning.
  for (const [index, scope] of ["project:p:light", "project:p:heavy"].entries()) {
    putRecord(db, { id: `p:req${index}`, type: "rule", name: `Rule ${index}`, scope,
      content: { state: "known", value: { required: true, text: "x".repeat(index ? 11_000 : 40) } },
    }, {});
  }

  const budget = diagnoseDatabase(db, { database: file }).checks.startup_budget;
  assert.equal(budget.projects_with_required, 2);
  assert.equal(budget.worst_project.scope, "project:p:heavy");
  assert.ok(budget.project_headroom_bytes > 4096, "the global cost alone still looks fine");
  assert.equal(budget.healthy, false, "but the heaviest project is not");
  assert.equal(budget.worst_project.startup_bytes,
    budget.worst_project.required_bytes + budget.global_required_bytes);

  // The flag and the issue must never disagree: a nested "healthy": false with an empty
  // issue list gives a reader a false to act on and nothing to act with.
  const report = diagnoseDatabase(db, { database: file });
  const issue = report.issues.find(({ code }) => code === "startup_budget_low");
  assert.ok(issue, "an unhealthy budget must always raise its issue");
  assert.equal(issue.identifiers.worst_project, "project:p:heavy");
  assert.match(issue.action, /project:p:heavy/u);
});
