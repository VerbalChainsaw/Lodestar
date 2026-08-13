import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeMachinePath, resolveIdentity, resolveProject } from "../src/agent-state.mjs";
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

async function invoke(args, input = "") {
  let stdout = "", stderr = "";
  const exitCode = await runCli(args, { stdin: Readable.from([input]),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } } });
  assert.equal(exitCode, 0, stderr);
  return { text: stdout, value: JSON.parse(stdout) };
}

const projectRecord = (id, text, required = false) => ({ id, type: "instruction",
  name: id, scope: "project:lodestar", content: { state: "known", value: { required, text } },
  aliases: [], links: [], sources: [] });

test("Windows and WSL paths share one project identity and startup stays bounded", async (t) => {
  const { database, directory } = await fixture(t);
  const windows = normalizeMachinePath(directory), drive = /^([A-Z]):\/(.*)$/u.exec(windows);
  assert.ok(drive, windows);
  const wsl = `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
  assert.equal(normalizeMachinePath(wsl), windows);
  assert.equal(normalizeMachinePath(`${drive[1]}:\\`), normalizeMachinePath(`/mnt/${drive[1]}`));

  const db = await openWriteDatabase(database);
  assert.equal(resolveProject(db, directory).scope, "project:lodestar");
  assert.equal(resolveProject(db, wsl).scope, "project:lodestar");
  putRecord(db, projectRecord("instruction:required", "Always include this.", true));
  for (let index = 0; index < 14; index += 1) {
    putRecord(db, projectRecord(`context:${index}`, `${index}:${"x".repeat(1_200)}`));
  }
  db.close();

  const args = ["start", "--db", database, "--cwd", directory, "--session", "reader"];
  const first = await invoke(args), second = await invoke(args);
  assert.equal(first.text, second.text);
  assert.ok(Buffer.byteLength(first.text, "utf8") <= 16 * 1024);
  assert.equal(first.value.data.required[0].id, "instruction:required");
  assert.equal(first.value.more, true);
  assert.match(first.value.next[0], /^lodestar find /u);
  const crossDialect = await invoke([
    "start", "--db", database, "--cwd", wsl, "--session", "reader",
  ]);
  assert.equal(crossDialect.value.scope.project, first.value.scope.project);
  assert.equal(crossDialect.value.scope.cwd, first.value.scope.cwd);
});

test("start initializes an absent registry without a separate setup command", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-first-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "state", "lodestar.db");
  const started = await invoke([
    "start", "--db", database, "--cwd", directory, "--session", "first",
  ]);
  assert.equal(started.value.operation, "start");
  assert.equal(started.value.revision, 0);
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

test("handoff save and startup claim are atomic and idempotent", async (t) => {
  const { database, directory } = await fixture(t);
  const common = ["--db", database, "--cwd", directory, "--agent", "codex"];
  const packet = { goal: "Continue the bounded core", context: { proof: "temporary database" } };
  const saved = await invoke(["handoff", "save", ...common, "--session", "source"],
    JSON.stringify(packet));
  const savedAgain = await invoke(["handoff", "save", ...common, "--session", "source"],
    JSON.stringify(packet));
  assert.equal(savedAgain.value.revision, saved.value.revision);
  assert.equal((await invoke(["start", ...common, "--session", "source"])).value.data.handoff, null);

  const attempts = await Promise.all(["next-a", "next-b"].map((session) =>
    invoke(["start", ...common, "--session", session])));
  const winners = attempts.filter(({ value }) => value.data.handoff !== null);
  assert.equal(winners.length, 1);
  const winner = winners[0].value;
  const claimant = winner.scope.session;
  assert.equal(winner.data.handoff.data.claimed_by, claimant);
  const retry = (await invoke(["start", ...common, "--session", claimant])).value;
  assert.equal(retry.data.handoff.revision, winner.data.handoff.revision);
  const loser = claimant === "next-a" ? "next-b" : "next-a";
  assert.equal((await invoke(["start", ...common, "--session", loser])).value.data.handoff, null);
  await invoke(["handoff", "clear", ...common, "--session", claimant]);
  const cleared = (await invoke(["handoff", "status", ...common])).value.data.record;
  assert.equal(cleared.data.state, "cleared");
  assert.equal(cleared.data.packet, null);
});

test("state reads tolerate empty state while writes require an actor identity", async (t) => {
  const { database, directory } = await fixture(t);
  assert.throws(() => resolveIdentity({}, {}, true), { code: "identity_required" });
  const status = await invoke(["handoff", "status", "--db", database, "--cwd", directory]);
  assert.deepEqual(status.value.data, { found: false });
});

test("handoff save initializes an absent registry and remains readable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-first-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "state", "lodestar.db");
  const common = ["--db", database, "--cwd", directory, "--session", "source"];
  const saved = await invoke(["handoff", "save", ...common], JSON.stringify({ goal: "continue" }));
  assert.equal(saved.value.data.kind, "handoff");
  assert.equal(saved.value.data.data.state, "pending");
  const status = await invoke(["handoff", "status", "--db", database, "--cwd", directory]);
  assert.equal(status.value.data.record.id, saved.value.data.id);
});
