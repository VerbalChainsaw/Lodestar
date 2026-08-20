import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeMachinePath, resolveIdentity, resolveProject,
  startSnapshotProjection,
} from "../src/agent-state.mjs";
import { runCli } from "../src/cli.mjs";
import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { putRecord } from "../src/records.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "lodestar.db");
  await initializeDatabase(database);
  const db = await openWriteDatabase(database);
  putRecord(db, { id: "project:lodestar", type: "project", name: "Lodestar", scope: "global",
    content: { state: "known", value: { roots: [directory] } }, aliases: [], links: [], sources: [] });
  db.close();
  return { database, directory };
}

async function invokeRaw(args, input = "") {
  let stdout = "", stderr = "";
  const exitCode = await runCli(args, { stdin: Readable.from([input]),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } } });
  return { exitCode, stdout, stderr };
}

async function invoke(args, input = "") {
  const { exitCode, stdout, stderr } = await invokeRaw(args, input);
  assert.equal(exitCode, 0, stderr);
  return { text: stdout, value: JSON.parse(stdout) };
}

const projectRecord = (id, text, required = false) => ({ id, type: "instruction",
  name: id, scope: "project:lodestar", content: { state: "known", value: { required, text } },
  aliases: [], links: [], sources: [] });

const handoffPacket = (overrides = {}) => ({
  goal: "Continue Lodestar",
  rules: ["Preserve current work"],
  entries: [{ key: "database", state: "fact", text: "Use SQLite", scope: ["project"],
    generation: 1, provenance: { kind: "repo", sourceRef: "AGENTS.md",
      observedAt: "2026-08-13T12:00:00.000Z" } }],
  work: { completed: [], current: [], files: [] }, nextMove: "Run the next check",
  evidence: [], ...overrides,
});

test("Windows and WSL paths share one project identity and startup replays", async (t) => {
  const { database, directory } = await fixture(t);
  const windows = "C:/Users/demo/Project With Spaces", wsl = "/mnt/c/Users/demo/Project With Spaces";
  assert.equal(normalizeMachinePath(wsl), windows);
  assert.equal(normalizeMachinePath("C:\\"), normalizeMachinePath("/mnt/c"));

  const db = await openWriteDatabase(database);
  assert.equal(resolveProject(db, directory).scope, "project:lodestar");
  putRecord(db, { id: "project:cross-platform", type: "project", name: "Cross platform",
    scope: "global", content: { state: "known", value: { roots: [windows] } },
    aliases: [], links: [], sources: [] });
  assert.equal(resolveProject(db, windows).scope, "project:cross-platform");
  assert.equal(resolveProject(db, wsl).scope, "project:cross-platform");
  putRecord(db, projectRecord("instruction:required", "Always include this.", true));
  for (let index = 0; index < 14; index += 1) {
    putRecord(db, projectRecord(`context:${index}`, `${index}:${"x".repeat(1_200)}`));
  }
  db.close();

  const args = ["start", "--db", database, "--cwd", directory, "--session", "reader"];
  const first = await invoke(args);
  const changed = await openWriteDatabase(database);
  putRecord(changed, projectRecord("context:after-start", "newer registry state"));
  changed.close();
  const second = await invoke(args);
  assert.equal(first.text, second.text);
  assert.equal(first.value.data.startup_snapshot.id, second.value.data.startup_snapshot.id);
  assert.equal(first.value.data.startup_snapshot.digest, second.value.data.startup_snapshot.digest);
  assert.equal(first.value.data.context.some(({ id }) => id === "context:after-start"), false);
  assert.deepEqual(first.value.data.budget,
    { bytes: null, source: "unbounded", applies_to: "optional", target_met: true });
  assert.equal(first.value.data.required[0].id, "g:lodestar:required-governance");
  assert.equal(first.value.data.required[1].id, "instruction:required");
  assert.equal(first.value.data.required[0].data.required, true);
  assert.match(first.value.data.required[0].data.text, /trusted technical partner/u);
  assert.deepEqual(first.value.data.available, []);
  assert.equal(first.value.more, false);
  assert.deepEqual(first.value.next, []);
  const windowsDialect = await invoke([
    "start", "--db", database, "--cwd", windows, "--session", "reader",
  ]);
  const crossDialect = await invoke(["start", "--db", database,
    "--cwd", wsl, "--session", "reader"]);
  assert.equal(crossDialect.value.scope.project, windowsDialect.value.scope.project);
  assert.equal(crossDialect.value.scope.cwd, windowsDialect.value.scope.cwd);
});

test("an explicit startup target never demotes oversized required context", async (t) => {
  const { database, directory } = await fixture(t);
  const db = await openWriteDatabase(database);
  putRecord(db, projectRecord("instruction:oversized", "x".repeat(20_000), true));
  db.close();
  await invoke(["handoff", "now", "--db", database, "--cwd", directory,
    "--session", "source"], JSON.stringify(handoffPacket()));

  // `start` is the first command of every session, so refusing to run stops all work in
  // the project — over one record someone marked required. It used to throw
  // resource_limit here and the project was dead until a human edited the registry.
  const started = await invoke(["start", "--db", database, "--cwd", directory,
    "--session", "claimant", "--startup-budget", "1024"]);
  assert.equal(started.value.ok, true);
  assert.ok(Buffer.byteLength(started.text, "utf8") > 1024, "required content exceeds target");
  assert.ok(started.value.data.required.some(({ id }) => id === "instruction:oversized"));
  assert.ok(Array.isArray(started.value.data.available));
  assert.deepEqual(started.value.data.budget,
    { bytes: 1024, source: "option", applies_to: "optional", target_met: false });

  // And because startup ran, the waiting baton was claimed as it would be on any
  // ordinary session. The old refusal rolled that back and stranded the handoff.
  const status = await invoke(["handoff", "status", "--db", database, "--cwd", directory,
    "--session", "claimant"]);
  assert.equal(status.value.data.recovery.data.state, "claimed");
  assert.equal(status.value.data.recovery.data.claimed_by, "claimant");

  const roomy = await invoke(["start", "--db", database, "--cwd", directory,
    "--session", "roomy", "--startup-budget", "300000"]);
  assert.equal(roomy.value.data.budget.bytes, 300000);
  assert.equal(roomy.value.data.budget.source, "option");
  assert.equal(roomy.value.data.budget.target_met, true);
});

test("unbounded startup queries every optional record by default", async (t) => {
  const { database, directory } = await fixture(t);
  const db = await openWriteDatabase(database);
  for (let index = 0; index < 225; index += 1) {
    putRecord(db, projectRecord(`context:uncapped:${index}`, `${index}`));
  }
  db.close();

  const started = await invoke(["start", "--db", database, "--cwd", directory,
    "--session", "uncapped"]);
  assert.equal(started.value.data.context.length, 225);
  assert.equal(started.value.data.available.length, 0);
  assert.deepEqual(started.value.data.available, []);
  assert.equal(started.value.data.budget.source, "unbounded");
  assert.equal(started.value.more, false);
});

test("startup keeps an oversized handoff packet complete and atomic", async (t) => {
  const { database, directory } = await fixture(t);
  const db = await openWriteDatabase(database);
  for (let index = 0; index < 30; index += 1) {
    putRecord(db, projectRecord(`context:counted:${index}`, `${index}:${"x".repeat(1_200)}`));
  }
  db.close();
  await invoke(["handoff", "now", "--db", database, "--cwd", directory,
    "--session", "source"], JSON.stringify(handoffPacket({
    goal: "g".repeat(4_096), nextMove: "n".repeat(4_096),
  })));
  const started = await invoke(["start", "--db", database, "--cwd", directory,
    "--session", "claimant"]);
  assert.equal(started.value.data.handoff.packet.goal, "g".repeat(4_096));
  assert.equal(started.value.data.handoff.packet.nextMove, "n".repeat(4_096));
  assert.equal(started.value.data.context.length, 30);
  assert.deepEqual(started.value.data.available, []);
  assert.deepEqual(started.value.next, []);
});

test("start initializes an absent registry without a separate setup command", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-first-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "state", "lodestar.db");
  const started = await invoke([
    "start", "--db", database, "--cwd", directory, "--session", "first",
  ]);
  assert.equal(started.value.operation, "start");
  assert.equal(started.value.revision, 1);
  assert.equal(started.value.data.startup_snapshot.persisted, true);
  assert.equal(started.value.data.handoff, null);
  const status = await invoke(["work", "status", "--db", database, "--cwd", directory]);
  assert.deepEqual(status.value.data.records, []);
});

test("work actors coexist in revision order and done closes only its actor", async (t) => {
  const { database, directory } = await fixture(t);
  const common = ["--db", database, "--cwd", directory, "--agent", "codex"];
  await Promise.all([
    invoke(["work", "start", "alpha", ...common, "--session", "a"]),
    invoke(["work", "start", "beta", ...common, "--session", "b"]),
  ]);
  const status = (await invoke(["work", "status", ...common])).value.data.records;
  assert.equal(status.length, 2);
  assert.ok(status[0].revision > status[1].revision);
  assert.deepEqual(new Set(status.map(({ data }) => data.actor)), new Set(["codex:a", "codex:b"]));

  await invoke(["work", "done", "alpha complete", ...common, "--session", "a"]);
  const remaining = (await invoke(["work", ...common])).value.data.records;
  assert.deepEqual(remaining.map(({ data }) => data.actor), ["codex:b"]);
  const history = (await invoke(["work", "history", ...common])).value.data.records;
  assert.equal(history.find(({ data }) => data.actor === "codex:a").data.status, "closed");
  assert.equal(history.find(({ data }) => data.actor === "codex:b").data.status, "open");
});

test("repeated work start updates one active record and a later start creates history", async (t) => {
  const { database, directory } = await fixture(t);
  const common = ["--db", database, "--cwd", directory, "--agent", "codex", "--session", "same"];
  const first = (await invoke(["work", "start", "first", ...common])).value.data;
  const updated = (await invoke(["work", "start", "second", ...common])).value.data;
  assert.equal(updated.id, first.id);
  assert.ok(updated.revision > first.revision);
  assert.equal(updated.data.current_work, "second");
  await invoke(["work", "done", "finished", ...common]);
  const later = (await invoke(["work", "start", "third", ...common])).value.data;
  assert.notEqual(later.id, first.id);
  const history = (await invoke(["work", "history", ...common])).value.data.records;
  assert.equal(history.length, 2);
  assert.equal(history[0].data.status, "open");
  assert.equal(history[1].data.status, "closed");
});

test("handoff now and startup claim are atomic and idempotent", async (t) => {
  const { database, directory } = await fixture(t);
  const common = ["--db", database, "--cwd", directory, "--agent", "codex"];
  const packet = handoffPacket({ goal: "Continue the bounded core" });
  const saved = await invoke(["handoff", "now", ...common, "--session", "source"],
    JSON.stringify(packet));
  const savedAgain = await invoke(["handoff", "now", ...common, "--session", "source"],
    JSON.stringify(packet));
  assert.equal(savedAgain.value.revision, saved.value.revision);
  assert.equal((await invoke(["start", ...common, "--session", "source"])).value.data.handoff, null);

  const attempts = await Promise.all(["next-a", "next-b"].map((session) =>
    invoke(["start", ...common, "--session", session])));
  const winners = attempts.filter(({ value }) => value.data.handoff !== null);
  assert.equal(winners.length, 1);
  const winner = winners[0].value;
  const claimant = winner.scope.session;
  assert.equal(winner.data.handoff.recovery.data.claimed_by, claimant);
  const retry = (await invoke(["start", ...common, "--session", claimant])).value;
  assert.equal(retry.data.handoff.recovery.revision, winner.data.handoff.recovery.revision);
  const loser = claimant === "next-a" ? "next-b" : "next-a";
  assert.equal((await invoke(["start", ...common, "--session", loser])).value.data.handoff, null);
  const status = (await invoke(["handoff", "status", ...common,
    "--session", claimant])).value.data;
  assert.equal(status.recovery.data.state, "claimed");
});

test("state reads tolerate empty state while writes require an actor identity", async (t) => {
  const { database, directory } = await fixture(t);
  assert.throws(() => resolveIdentity({}, {}, true), { code: "identity_required" });
  const status = await invoke(["handoff", "status", "--db", database, "--cwd", directory]);
  assert.deepEqual(status.value.data,
    { lane: null, packet: null, recovery: null, recovery_packet: null });
});

test("handoff now initializes an absent registry and remains readable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-first-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "state", "lodestar.db");
  const common = ["--db", database, "--cwd", directory, "--session", "source"];
  const saved = await invoke(["handoff", "now", ...common], JSON.stringify(handoffPacket()));
  assert.equal(saved.value.data.recovery.kind, "handoff-recovery");
  assert.equal(saved.value.data.recovery.data.state, "pending");
  const status = await invoke(["handoff", "status", "--db", database, "--cwd", directory,
    "--session", "source"]);
  assert.equal(status.value.data.recovery.id, saved.value.data.recovery.id);
});

test("concurrent same-session starts serialize to one snapshot and one claim", async (t) => {
  const { database, directory } = await fixture(t);
  const common = ["--db", database, "--cwd", directory, "--agent", "codex"];
  await invoke(["handoff", "now", ...common, "--session", "source"],
    JSON.stringify(handoffPacket()));
  const args = ["start", ...common, "--session", "claimant"];
  const [first, second] = await Promise.all([invoke(args), invoke(args)]);
  assert.equal(first.text, second.text);
  assert.equal(first.value.data.handoff.recovery.data.claimed_by, "claimant");
  const db = await openWriteDatabase(database);
  assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE type='startup-snapshot'")
    .get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE type='handoff-recovery' "
    + "AND json_extract(content_json,'$.value.state')='claimed'").get().count, 1);
  db.close();
});

test("corrupt startup snapshots fail closed and generic record writes cannot replace them", async (t) => {
  const { database, directory } = await fixture(t);
  const args = ["start", "--db", database, "--cwd", directory, "--session", "reader"];
  const started = await invoke(args);
  const reserved = { id: started.value.data.startup_snapshot.id, type: "note", name: "replace",
    scope: "project:lodestar", content: { state: "known", value: { text: "bad" } },
    aliases: [], links: [], sources: [] };
  const put = await invokeRaw(["put", "--db", database], JSON.stringify(reserved));
  assert.equal(JSON.parse(put.stderr).error.code, "reserved_record_type");
  const deleted = await invokeRaw(["delete", started.value.data.startup_snapshot.id, "--db", database]);
  assert.equal(JSON.parse(deleted.stderr).error.code, "reserved_record_type");
  const db = await openWriteDatabase(database);
  const row = db.prepare("SELECT content_json FROM records WHERE id=?")
    .get(started.value.data.startup_snapshot.id);
  const content = JSON.parse(row.content_json);
  content.value.digest = "0".repeat(64);
  db.prepare("UPDATE records SET content_json=? WHERE id=?")
    .run(JSON.stringify(content), started.value.data.startup_snapshot.id);
  db.close();
  const failed = await invokeRaw(args);
  assert.equal(failed.exitCode, 3);
  const error = JSON.parse(failed.stderr).error;
  assert.equal(error.code, "startup_snapshot_conflict");
  assert.match(error.action, /same session identity/u);
});

test("a failed first snapshot transaction rolls back its handoff claim and record", async (t) => {
  const { database, directory } = await fixture(t);
  const common = ["--db", database, "--cwd", directory, "--agent", "codex"];
  await invoke(["handoff", "now", ...common, "--session", "source"],
    JSON.stringify(handoffPacket()));
  const db = await openWriteDatabase(database);
  const project = resolveProject(db, directory);
  const actor = resolveIdentity({ session: "claimant", agent: "codex" }, {});
  assert.throws(() => startSnapshotProjection(db, project, actor, {
    database,
    beforePersist: () => { throw new Error("forced snapshot failure"); },
  }), { code: "database_error" });
  assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE type='startup-snapshot'")
    .get().count, 0);
  const recovery = db.prepare("SELECT json_extract(content_json,'$.value.state') AS state, "
    + "json_extract(content_json,'$.value.claimed_by') AS claimed_by FROM records "
    + "WHERE type='handoff-recovery'").get();
  assert.equal(recovery.state, "pending");
  assert.equal(recovery.claimed_by, null);
  db.close();
});

test("start without a session remains stateless and reflects newer registry state", async (t) => {
  const environment = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID", "OPENCODE_SESSION_ID"];
  const prior = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
  for (const key of environment) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { database, directory } = await fixture(t);
  const args = ["start", "--db", database, "--cwd", directory];
  const first = await invoke(args);
  assert.equal(first.value.data.startup_snapshot, undefined);
  const db = await openWriteDatabase(database);
  putRecord(db, projectRecord("context:no-session-new", "new state"));
  db.close();
  const second = await invoke(args);
  assert.equal(second.value.data.startup_snapshot, undefined);
  assert.equal(second.value.data.context.some(({ id }) => id === "context:no-session-new"), true);
  assert.notEqual(second.text, first.text);
});
