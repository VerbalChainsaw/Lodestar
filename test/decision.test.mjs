import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decisionDrop, decisionInjection, decisionProjection, decisionSet, decisionStatus,
} from "../src/decision.mjs";
import { diagnoseDatabase } from "../src/doctor.mjs";
import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { resolveIdentity, resolveProject } from "../src/project.mjs";
import { putRecord } from "../src/records.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-decision-"));
  const database = path.join(directory, "lodestar.db");
  await initializeDatabase(database);
  const db = await openWriteDatabase(database);
  t.after(() => db.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  putRecord(db, { id: "project:decision", type: "project", name: "Decision fixture",
    scope: "global", content: { state: "known", value: { roots: [directory] } },
    aliases: [], links: [], sources: [] });
  const project = resolveProject(db, directory);
  const identity = resolveIdentity({ session: "source", agent: "codex", harness: "test" }, {}, true);
  return { db, database, directory, project, identity };
}

test("decision events are append-only and A to B to A suppresses resurrection", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  assert.equal(decisionSet(db, project, identity, "database", "SQLite",
    { database, reason: "embedded" }).changed, true);
  assert.equal(decisionSet(db, project, identity, "database", "PostgreSQL",
    { database, reason: "centralized writes" }).changed, true);
  assert.equal(decisionSet(db, project, identity, "database", "SQLite",
    { database, reason: "local-first" }).changed, true);
  const state = decisionProjection(db, project);
  assert.deepEqual(state.facts.map(({ key, value }) => [key, value]), [["database", "SQLite"]]);
  assert.deepEqual(state.dead.map(({ key, value }) => [key, value]), [["database", "PostgreSQL"]]);
  // The projection carries the golden-rule marker vocabulary, not prose.
  assert.match(state.projection,
    /\[DECISION key=database status=ACCEPTED value=SQLite date=\d{4}-\d{2}-\d{2} reason=local-first\]/u);
  // The dead entry's reason is the reason of the event that killed it, not the
  // reason that created the superseded value.
  assert.match(state.projection,
    /\[SUPERSEDED key=database by=database value=PostgreSQL date=\d{4}-\d{2}-\d{2} reason=local-first reopen=director\]/u);
  // DEAD is the power-word: the negation sentence is the product.
  assert.match(state.projection,
    /PostgreSQL is DEAD; do not propose, use, or restore it\. Use SQLite\./u);
  assert.doesNotMatch(state.projection, /\[DEAD key=database/u);
  const count = db.prepare("SELECT count(*) AS count FROM records "
    + "WHERE type='decision-event'").get().count;
  assert.equal(count, 3);
  assert.equal(decisionSet(db, project, identity, "database", "SQLite", { database }).changed,
    false);
  assert.equal(db.prepare("SELECT count(*) AS count FROM records "
    + "WHERE type='decision-event'").get().count, count);
});

test("decision drop renders a DEAD marker and injection still disables projection", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  decisionSet(db, project, identity, "test_runner", "node:test", { database });
  decisionSet(db, project, identity, "database", "SQLite", { database });
  assert.equal(decisionDrop(db, project, identity, "database",
    { database, reason: "removed" }).changed, true);
  assert.equal(decisionDrop(db, project, identity, "database", { database }).changed, false);
  const dropped = decisionProjection(db, project).projection;
  assert.match(dropped,
    /\[DEAD key=database value=SQLite date=\d{4}-\d{2}-\d{2} reason=removed reopen=director\]/u);
  assert.match(dropped,
    /SQLite is DEAD; do not propose, use, or restore it\. It has no replacement\. Reason: removed\./u);
  assert.equal(decisionInjection(db, project, identity, false, { database }).changed, true);
  const disabled = decisionProjection(db, project);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.projection, "");
  assert.deepEqual(disabled.facts.map(({ key }) => key), ["test-runner"]);
  assert.equal(decisionInjection(db, project, identity, true, { database }).changed, true);
  const report = diagnoseDatabase(db, { database });
  assert.equal(report.checks.decisions.healthy, true);
  assert.equal(report.checks.decisions.events, 5);
  assert.equal(report.healthy, true);
});

test("decision status blocks and unblocks a fact and blocks project separately", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  decisionSet(db, project, identity, "database", "SQLite", { database });
  assert.equal(decisionStatus(db, project, identity, "database", "blocked",
    { database, reason: "waiting on vendor" }).changed, true);
  const state = decisionProjection(db, project);
  assert.equal(state.facts.length, 0);
  assert.deepEqual(state.blocked.map(({ key }) => key), ["database"]);
  assert.equal(state.blocked[0].status, "blocked");
  assert.match(state.projection, /## BLOCKED/u);
  assert.match(state.projection, /status=BLOCKED/u);
  assert.equal(decisionStatus(db, project, identity, "database", "blocked",
    { database }).changed, false);
  assert.equal(decisionStatus(db, project, identity, "database", "accepted",
    { database, reason: "resolved" }).changed, true);
  const reopened = decisionProjection(db, project);
  assert.equal(reopened.blocked.length, 0);
  assert.deepEqual(reopened.facts.map(({ key }) => key), ["database"]);
  assert.equal(decisionStatus(db, project, identity, "missing-key", "blocked",
    { database }).changed, false);
  assert.throws(() => decisionStatus(db, project, identity, "database", "weird",
    { database }), { code: "invalid_input" });
  assert.equal(diagnoseDatabase(db, { database }).checks.decisions.healthy, true);
});

test("decision set accepts an explicit blocked status and supersedes a blocked fact", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  assert.equal(decisionSet(db, project, identity, "gate", "closed",
    { database, status: "blocked" }).changed, true);
  const state = decisionProjection(db, project);
  assert.equal(state.blocked.length, 1);
  assert.throws(() => decisionSet(db, project, identity, "gate", "closed",
    { database, status: "someday" }), { code: "invalid_input" });
  // Replacing a blocked decision moves the old value to the dead ledger.
  assert.equal(decisionSet(db, project, identity, "gate", "open",
    { database, reason: "unblocked" }).changed, true);
  const after = decisionProjection(db, project);
  assert.equal(after.blocked.length, 0);
  assert.deepEqual(after.facts.map(({ key, value }) => [key, value]), [["gate", "open"]]);
  assert.deepEqual(after.dead.map(({ key, value }) => [key, value]), [["gate", "closed"]]);
  assert.match(after.projection, /\[SUPERSEDED key=gate by=gate value=closed/u);
  assert.match(after.projection,
    /closed is DEAD; do not propose, use, or restore it\. Use open\./u);
  assert.equal(diagnoseDatabase(db, { database }).checks.decisions.healthy, true);
});

test("old events without a status replay as accepted", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  decisionSet(db, project, identity, "legacy", "value", { database });
  const state = decisionProjection(db, project);
  assert.equal(state.facts[0].status, "accepted");
  assert.match(state.projection, /status=ACCEPTED/u);
});

test("public record mutation cannot rewrite or delete command-owned decision history", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  const written = decisionSet(db, project, identity, "database", "SQLite", { database });
  assert.throws(() => putRecord(db, { id: "manual", type: "decision-event", name: "bad",
    scope: project.scope, content: { state: "known", value: {} }, aliases: [], links: [],
    sources: [] }), { code: "reserved_record_type" });
  assert.equal(written.record.kind, "decision-event");
});

test("Director-issued kills stay closed; agent kills reopen by evidence", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  const director = identity;
  const agent = resolveIdentity({ session: "agent-session", agent: "codex", harness: "test" },
    {}, true);
  decisionSet(db, project, director, "database", "SQLite", { database });
  assert.equal(decisionDrop(db, project, director, "database",
    { database, reason: "no" }).changed, true);
  // A different session cannot revive a Director-issued kill.
  assert.throws(() => decisionSet(db, project, agent, "database", "SQLite", { database }),
    (error) => error.code === "dead_decision_revival");
  // A replacement value is always allowed.
  assert.equal(decisionSet(db, project, agent, "database", "PostgreSQL",
    { database }).changed, true);
  // The killing session (the Director) can revive the same value.
  assert.equal(decisionSet(db, project, director, "database", "SQLite",
    { database, reason: "revived" }).changed, true);
  const state = decisionProjection(db, project);
  assert.deepEqual(state.facts.map(({ key, value }) => [key, value]), [["database", "SQLite"]]);
  // Agent-issued kills reopen by evidence.
  assert.equal(decisionSet(db, project, agent, "flag", "on",
    { database, authority: "agent" }).changed, true);
  assert.equal(decisionDrop(db, project, agent, "flag",
    { database, authority: "agent" }).changed, true);
  assert.equal(decisionSet(db, project, agent, "flag", "on", { database }).changed, true);
  // A closed kill renders reopen=director on its marker.
  decisionSet(db, project, director, "port", "8080", { database });
  decisionDrop(db, project, director, "port", { database, reason: "closed" });
  assert.match(decisionProjection(db, project).projection,
    /\[DEAD key=port value=8080 date=\d{4}-\d{2}-\d{2} reason=closed reopen=director\]/u);
  assert.equal(diagnoseDatabase(db, { database }).checks.decisions.healthy, true);
});

test("a drop with a successor renders SUPERSEDED and names the successor key", async (t) => {
  const { db, database, project, identity } = await fixture(t);
  decisionSet(db, project, identity, "engine", "legacy", { database });
  assert.equal(decisionDrop(db, project, identity, "engine",
    { database, successor: "engine-v2", reason: "replaced" }).changed, true);
  const state = decisionProjection(db, project);
  assert.deepEqual(state.dead.map(({ key, successor }) => [key, successor]),
    [["engine", "engine-v2"]]);
  assert.match(state.projection, /\[SUPERSEDED key=engine by=engine-v2 value=legacy/u);
  assert.match(state.projection, /Use engine-v2\./u);
  assert.doesNotMatch(state.projection, /It has no replacement/u);
  assert.equal(diagnoseDatabase(db, { database }).checks.decisions.healthy, true);
});
