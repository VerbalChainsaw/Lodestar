import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import {
  pendingAdd, pendingCount, pendingDrop, pendingList, pendingPromote,
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
  // competing for the startup budget every session must carry.
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

test("capture rejects empty and control-character text", async (t) => {
  const { db, file, project } = await fixture(t);
  for (const bad of ["", "   ", "bad\u0000text"]) {
    assert.throws(
      () => pendingAdd(db, project, IDENTITY, bad, { database: file, now }),
      { code: "invalid_input" },
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(pendingCount(db, project), 0);
});

test("the queue preserves every candidate and lets the caller choose page size", async (t) => {
  const { db, file, project } = await fixture(t);
  for (let index = 0; index < 205; index += 1) {
    const added = pendingAdd(db, project, IDENTITY, `candidate ${index}`, { database: file, now });
    assert.deepEqual(added.evicted, []);
  }
  assert.equal(pendingCount(db, project), 205);
  const texts = pendingList(db, project, 205).records.map(({ data }) => data.text);
  assert.equal(texts.includes("candidate 0"), true);
  assert.equal(texts.includes("candidate 204"), true);
  assert.throws(() => pendingList(db, project, Number.MAX_SAFE_INTEGER + 1),
    { code: "invalid_input" });
});

test("capture preserves text beyond the former command policy ceiling", async (t) => {
  const { db, file, project } = await fixture(t);
  const text = `mechanism ${"x".repeat(5_000)}`;
  const added = pendingAdd(db, project, IDENTITY, text, { database: file, now });
  assert.equal(added.record.data.text, text);
});

test("an undersized optional target preserves required records", async (t) => {
  const { db, file, project } = await fixture(t);
  for (let index = 0; index < 6; index += 1) {
    putRecord(db, {
      id: `g:bulk${index}`, type: "rule", name: `Bulk ${index}`, scope: "global",
      content: { state: "known", value: { required: true, text: "x".repeat(3000) } },
    }, {});
  }

  const result = startProjection(db, project, IDENTITY,
    { database: file, startupBudget: 16 * 1024 });
  const envelope = Buffer.byteLength(JSON.stringify({ v: 1, ok: true, operation: "start",
    revision: result.revision, data: result.data, more: result.more, next: result.next }), "utf8");
  assert.ok(envelope > 16 * 1024, "required content may exceed an optional-context target");
  assert.equal(result.data.budget.target_met, false);

  const shed = new Set(result.data.available.map(({ id }) => id));
  const carried = new Set(result.data.required.map(({ id }) => id));
  for (let index = 0; index < 6; index += 1) {
    const id = `g:bulk${index}`;
    assert.equal(carried.has(id), true, `${id} remains complete`);
    assert.equal(shed.has(id), false, `${id} is not demoted`);
  }
  assert.equal(result.data.required.length, 7);
});

test("an explicit budget sheds what an unbounded startup carries", async (t) => {
  const { db, file, project } = await fixture(t);
  for (let index = 0; index < 40; index += 1) {
    putRecord(db, { id: `p:ctx${index}`, type: "note", name: `Note ${index}`,
      scope: project.scope,
      content: { state: "known", value: { text: `${index}:${"x".repeat(900)}` } } }, {});
  }
  const tight = startProjection(db, project, IDENTITY,
    { database: file, startupBudget: 24 * 1024 }).data;
  const roomy = startProjection(db, project, IDENTITY, { database: file }).data;

  assert.ok(roomy.context.length > tight.context.length, "a bigger budget carries more");
  assert.deepEqual(roomy.available, []);
  assert.equal(tight.budget.target_met, false,
    "whole optional-record stubs may themselves exceed a caller target");
  assert.deepEqual(roomy.budget, {
    bytes: null, source: "unbounded", applies_to: "optional", target_met: true,
  });
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
  // No artificial capture cap: every explicit marker is a candidate.
  assert.equal(
    extractNotes([1, 2, 3, 4, 5].map((i) => `LODESTAR NOTE: fact ${i}`).join("\n")).length,
    5,
  );
});
