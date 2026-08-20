import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  claimHandoffInside, handoffArm, handoffCheckpoint, handoffDisarm, handoffNow,
  handoffStartupView, handoffStatus, handoffTail, validateHandoff,
  validateHandoffTransition,
} from "../src/continuity.mjs";
import { CONTINUITY_SCHEMA_SQL } from "../src/continuity-schema.mjs";
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

test("continuity lanes are session-isolated and checkpoint absorbs redacted tail", async (t) => {
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

test("entry-key validation names the rejected field and accepted alphabet", () => {
  const invalid = packet({ entries: [{ ...packet().entries[0],
    key: "account.mutation_guard" }] });
  assert.throws(() => validateHandoff(invalid), (error) => {
    assert.equal(error.code, "invalid_input");
    assert.match(error.message, /entry 0.*key/u);
    assert.ok(error.message.includes("^[a-z0-9][a-z0-9.-]*$"));
    return true;
  });

  const valid = packet({ entries: [{ ...packet().entries[0],
    key: "account.mutation-guard" }] });
  assert.doesNotThrow(() => validateHandoff(valid));
});

test("semantic continuity preserves complete large packets without count or text quotas", () => {
  const long = "continuity ".repeat(8_000);
  const rules = Array.from({ length: 64 }, (_, index) => `rule ${index} ${long}`);
  const entries = Array.from({ length: 80 }, (_, index) => ({
    key: `entry-${index}`, state: "fact", text: long,
    scope: Array.from({ length: 32 }, (_, scope) => `scope-${scope}`),
    generation: 1, provenance: { kind: "repo", sourceRef: long,
      observedAt: "2026-08-13T12:00:00.000Z" },
  }));
  const evidence = Array.from({ length: 90 }, (_, index) => ({ index, detail: long }));
  const input = packet({ goal: long, nextMove: long, rules, entries, evidence,
    work: { current: Array.from({ length: 100 }, (_, index) => `${index}:${long}`) } });

  const validated = validateHandoff(input).packet;
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
});

test("tail capture and startup recovery preserve every item and full text", async (t) => {
  const { db, database, project } = await fixture(t);
  const source = actor("source"), claimant = actor("claimant");
  handoffArm(db, project, source, packet(), { database });
  const text = "tail-text-".repeat(1_000);
  for (let index = 0; index < 20; index += 1) {
    handoffTail(db, project, source, "assistant", `turn-${index}`, `${index}:${text}`,
      { database });
  }
  const saved = handoffNow(db, project, source,
    packet({ goal: text, nextMove: text }), { database });
  assert.equal(saved.packet.recentTail.items.length, 20);
  assert.equal(saved.packet.recentTail.omitted, 0);
  assert.equal(saved.packet.recentTail.items[0].text, `0:${text}`);
  assert.equal(saved.packet.recentTail.items[19].text, `19:${text}`);

  const claim = transaction(db, () => claimHandoffInside(db, project, claimant), database);
  assert.deepEqual(handoffStartupView(claim), {
    recovery: claim.recovery,
    packet: claim.packet,
  });
});

test("continuity storage schema accepts complete long identity and content values", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  db.exec(CONTINUITY_SCHEMA_SQL);
  const longId = "identity-".repeat(100);
  const packetId = "packet-".repeat(100);
  const longText = "stored continuity ".repeat(20_000);
  const timestamp = "2026-08-13T12:00:00.000Z";
  db.prepare("INSERT INTO continuity_lanes VALUES (?,?,?,?,?,?,?,?)").run(
    longId, longId, longId, "armed", null, 1, timestamp, timestamp);
  db.prepare("INSERT INTO continuity_packets VALUES (?,?,?,?,?,?,?,?,?)").run(
    packetId, longId, null, "a".repeat(64), JSON.stringify({ longText }),
    "b".repeat(64), longId, longId, timestamp);
  db.prepare("INSERT INTO continuity_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    longId, null, null, longId, longId, longId, longId, "assistant", longId,
    longText, JSON.stringify({ longText }), null, timestamp);
  db.prepare("INSERT INTO continuity_transfers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    longId, "c".repeat(64), longId, longId, longId, packetId, "failed", longId,
    longId, longId, "failed", longText, timestamp, timestamp);
  assert.equal(db.prepare("SELECT length(packet_json) AS size FROM continuity_packets")
    .get().size > 262_144, true);
  assert.equal(db.prepare("SELECT length(error) AS size FROM continuity_transfers")
    .get().size > 65_536, true);
  db.close();
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
