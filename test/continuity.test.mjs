import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimHandoffInside, handoffArm, handoffCheckpoint, handoffDisarm, handoffNow,
  handoffStatus, handoffTail, validateHandoff, validateHandoffTransition,
} from "../src/continuity.mjs";
import { initializeDatabase, openWriteDatabase, transaction } from "../src/database.mjs";
import { resolveIdentity, resolveProject } from "../src/project.mjs";
import { putRecord } from "../src/records.mjs";

const packet = (overrides = {}) => ({
  goal: "Continue the Lodestar implementation",
  rules: ["Preserve current user work"],
  entries: [{ key: "storage", state: "fact", text: "Use one SQLite database",
    scope: ["project"], generation: 1, provenance: { kind: "repo",
      sourceRef: "AGENTS.md", observedAt: "2026-08-13T12:00:00.000Z" } }],
  work: { completed: [], current: ["continuity"], files: [] },
  nextMove: "Run focused tests",
  evidence: [],
  ...overrides,
});

const actor = (session) => resolveIdentity({ session, agent: "codex", harness: "test" }, {}, true);

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-continuity-"));
  const database = path.join(directory, "lodestar.db");
  await initializeDatabase(database);
  const db = await openWriteDatabase(database);
  t.after(() => db.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  putRecord(db, { id: "project:continuity", type: "project", name: "Continuity fixture",
    scope: "global", content: { state: "known", value: { roots: [directory] } },
    aliases: [], links: [], sources: [] });
  return { db, database, directory, project: resolveProject(db, directory) };
}

test("continuity lanes are session-isolated and checkpoint absorbs redacted bounded tail", async (t) => {
  const { db, database, project } = await fixture(t);
  const source = actor("source"), other = actor("other");
  const armed = handoffArm(db, project, source, packet(), { database });
  assert.equal(armed.lane.data.state, "armed");
  assert.equal(handoffStatus(db, project, other).lane, null);
  assert.equal(handoffTail(db, project, source, "user", "turn-1",
    "API_KEY=top-secret", { database }).captured, true);
  assert.equal(handoffTail(db, project, source, "user", "turn-1",
    "API_KEY=top-secret", { database }).repeated, true);
  const next = packet({ nextMove: "Continue from the checkpoint" });
  const checked = handoffCheckpoint(db, project, source, next, { database });
  assert.equal(checked.packet.predecessor, armed.packet.id);
  assert.equal(checked.packet.recentTail.items.length, 1);
  assert.doesNotMatch(JSON.stringify(checked.packet), /top-secret/u);
  assert.throws(() => handoffTail(db, project, source, "user", "turn-1",
    "changed replay", { database }), { code: "handoff_replay" });
});

test("dead entries require evidence, fresh generations, and cannot resurrect", () => {
  const prior = validateHandoff(packet()).packet;
  const deadEntry = { ...prior.entries[0], state: "dead", generation: 2,
    provenance: { kind: "decision", sourceRef: "decision:storage",
      observedAt: "2026-08-13T13:00:00.000Z" } };
  const dead = validateHandoff(packet({ entries: [deadEntry], evidence: [{
    key: "dead:storage", kind: "decision", sourceRef: "decision:storage",
  }] })).packet;
  assert.doesNotThrow(() => validateHandoffTransition(prior, dead));
  const resurrected = packet({ entries: [{ ...deadEntry, state: "fact", generation: 3,
    provenance: { ...deadEntry.provenance, observedAt: "2026-08-13T14:00:00.000Z" } }] });
  assert.throws(() => validateHandoffTransition(dead, resurrected), /cannot resurrect/u);
  assert.throws(() => validateHandoff(packet({ entries: [deadEntry] })), /auditable evidence/u);
});

test("now is idempotent, cannot be stolen, and only the next same-project session claims", async (t) => {
  const { db, database, project, directory } = await fixture(t);
  const source = actor("source"), claimant = actor("claimant"), thief = actor("thief");
  const saved = handoffNow(db, project, source, packet(), { database });
  const repeated = handoffNow(db, project, source, packet(), { database });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.recovery.id, saved.recovery.id);
  assert.throws(() => handoffNow(db, project, thief, packet(), { database }),
    { code: "handoff_conflict" });
  assert.equal(transaction(db, () => claimHandoffInside(db, project, source), database), null);
  const outside = resolveProject(db, `${directory}-other-project`);
  assert.equal(transaction(db, () => claimHandoffInside(db, outside, thief), database), null);
  const claimed = transaction(db, () => claimHandoffInside(db, project, claimant), database);
  assert.equal(claimed.recovery.data.claimed_by, "claimant");
  const retry = transaction(db, () => claimHandoffInside(db, project, claimant), database);
  assert.equal(retry.recovery.id, claimed.recovery.id);
  assert.equal(transaction(db, () => claimHandoffInside(db, project, thief), database), null);
  const advanced = handoffNow(db, project, claimant,
    packet({ nextMove: "Continue in a later session" }), { database });
  assert.ok(advanced.recovery.data.generation > claimed.recovery.data.generation);
});

test("a claimed recovery never wedges the project against later sessions", async (t) => {
  const { db, database, project } = await fixture(t);
  const source = actor("source"), gone = actor("gone"), later = actor("later");
  handoffNow(db, project, source, packet(), { database });

  // The successor claims the baton and is never seen again — it crashed, the host was
  // closed, or it was never the intended reader. Its claim used to outlive it forever:
  // no other session could save a baton, and none could take the claim over either, so
  // the project lost continuity permanently with no command to recover it.
  const claimed = transaction(db, () => claimHandoffInside(db, project, gone), database);
  assert.equal(claimed.recovery.data.claimed_by, "gone");
  assert.equal(transaction(db, () => claimHandoffInside(db, project, later), database), null);

  const saved = handoffNow(db, project, later, packet({ nextMove: "Carry on" }), { database });
  assert.equal(saved.recovery.data.state, "pending");
  assert.equal(saved.recovery.data.source_session, "later");
  assert.ok(saved.recovery.data.generation > claimed.recovery.data.generation);

  // An undelivered baton is still protected from a session that did not write it, and
  // the message now says which of the two situations the caller is actually in.
  assert.throws(() => handoffNow(db, project, source, packet({ nextMove: "Steal" }),
    { database }), { code: "handoff_conflict", message: /unclaimed/u });

  // Superseding your own undelivered baton is not theft, and stays idempotent.
  const again = handoffNow(db, project, later, packet({ nextMove: "Revised" }), { database });
  assert.equal(again.changed, true);
  assert.equal(handoffNow(db, project, later, packet({ nextMove: "Revised" }),
    { database }).changed, false);
});

test("disarm is idempotent and refuses an owned pending recovery", async (t) => {
  const { db, database, project } = await fixture(t);
  const source = actor("source");
  handoffArm(db, project, source, packet(), { database });
  handoffNow(db, project, source, packet({ nextMove: "Open the next session" }), { database });
  assert.throws(() => handoffDisarm(db, project, source, { database }),
    { code: "handoff_pending" });
});

test("every continuity refusal names the way out of the state it refused from", async (t) => {
  const { db, database, project } = await fixture(t);
  const me = actor("solo");

  // A refusal that only states the rule reads as "this is not possible", and an agent
  // that believes that abandons Lodestar for the raw CLI. Each of these states does have
  // an exit; the error is the only place the agent will look for it.
  assert.throws(() => handoffCheckpoint(db, project, me, packet(), { database }), (error) => {
    assert.equal(error.code, "handoff_not_armed");
    assert.match(error.action, /handoff arm|handoff now/u);
    return true;
  });

  handoffArm(db, project, me, packet(), { database });
  assert.throws(() => handoffArm(db, project, me, packet({ nextMove: "Other" }), { database }),
    (error) => {
      assert.equal(error.code, "handoff_conflict");
      assert.match(error.action, /handoff checkpoint/u);
      return true;
    });

  handoffNow(db, project, me, packet({ nextMove: "Saved" }), { database });
  assert.throws(() => handoffDisarm(db, project, me, { database }), (error) => {
    assert.equal(error.code, "handoff_pending");
    assert.match(error.action, /handoff checkpoint|claim/u);
    return true;
  });

  // And the exits the messages point at actually work.
  assert.equal(handoffCheckpoint(db, project, me, packet({ nextMove: "Revised" }),
    { database }).changed, true);
});
