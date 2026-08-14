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
import { startProjection } from "../src/agent-state.mjs";
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

test("an over-budget startup names the records that caused it", async (t) => {
  const { db, file, project } = await fixture(t);
  for (let index = 0; index < 6; index += 1) {
    putRecord(db, {
      id: `g:bulk${index}`, type: "rule", name: `Bulk ${index}`, scope: "global",
      content: { state: "known", value: { required: true, text: "x".repeat(3000) } },
    }, {});
  }

  // start is the first command of every session, so this failure stops all work. It has
  // to say which records to shrink, or the operator is left guessing.
  try {
    startProjection(db, project, IDENTITY, { database: file });
    assert.fail("expected the startup budget to be exceeded");
  } catch (error) {
    assert.equal(error.code, "resource_limit");
    const largest = error.identifiers.largest_required;
    assert.ok(Array.isArray(largest) && largest.length > 0);
    assert.ok(largest[0].bytes >= largest.at(-1).bytes, "largest first");
    assert.match(largest[0].id, /^g:bulk\d$/u);
    assert.ok(error.identifiers.required_records >= 6);
    assert.match(error.action, /lodestar get g:bulk\d/u);
  }
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
