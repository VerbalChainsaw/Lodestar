import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LODESTAR_VERSION } from "../src/version.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMANDS = [
  "start", "init", "put", "get", "find", "links", "delete", "doctor",
  "import", "export", "work", "handoff", "decision", "skills",
];

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

function npmRun(args, cwd) {
  const bundled = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmCli = process.env.npm_execpath ?? (existsSync(bundled) ? bundled : null);
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, npmCli ? [npmCli, ...args] : args, {
    cwd, encoding: "utf8", shell: !npmCli && process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.stack);
  return result.stdout;
}

function raw(entry, args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd, input, encoding: "utf8", windowsHide: true,
  });
}

function ok(entry, args, options = {}) {
  const result = raw(entry, args, options);
  const expectedStatus = options.status ?? 0;
  assert.equal(result.status, expectedStatus, result.stderr || result.error?.stack);
  assert.equal(result.stderr, "", `successful ${args.join(" ")} wrote stderr`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, result.stdout);
  return envelope;
}

function fails(entry, args, options = {}) {
  const result = raw(entry, args, options);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.stdout, "", `failed ${args.join(" ")} wrote stdout`);
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.ok, false, result.stderr);
  return envelope;
}

function concurrent(entry, invocations, cwd) {
  return Promise.all(invocations.map(({ args, input }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? "");
  })));
}

async function packedEntry(directory) {
  const packDirectory = path.join(directory, "pack");
  const prefix = path.join(directory, "prefix");
  await mkdir(packDirectory, { recursive: true });
  const report = JSON.parse(npmRun(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory], ROOT,
  ));
  const archive = path.join(packDirectory, report[0].filename);
  npmRun([
    "install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive,
  ], ROOT);
  const entry = path.join(prefix, "node_modules", "lodestar-agent-context", "lodestar.mjs");
  await access(entry);
  return entry;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function legacyStore(directory) {
  const generation = "a".repeat(64);
  const source = path.join(directory, "legacy");
  const root = path.join(source, "generations", generation);
  await writeJson(path.join(source, "current.json"), { v: 1, generation });
  await writeJson(path.join(root, "catalog.json"), {
    v: 1, projects: [{ id: "p:demo", name: "Demo", aliases: ["demo"], roots: ["/demo"] }],
  });
  await writeJson(path.join(root, "schema", "store.json"), { v: 1, record: "context-record" });
  await mkdir(path.join(root, "records"), { recursive: true });
  await writeFile(path.join(root, "records", "global.jsonl"), `${JSON.stringify({
    v: 1, id: "g:rule", kind: "rule", priority: 100, scope: ["global"],
    links: [], aliases: ["guardrail"], summary: "Inspect before changing.",
  })}\n`);
  await mkdir(path.join(root, "records", "projects"), { recursive: true });
  await writeFile(path.join(root, "records", "projects", "p-demo.jsonl"), "");
  await writeJson(path.join(root, "indexes", "locator-health.json"), {
    v: 1, generation, locators: {},
  });
  return source;
}

function record(id, value, extra = {}) {
  return {
    id, type: "note", name: id, scope: "global",
    content: { state: "known", value }, aliases: [], links: [], sources: [], ...extra,
  };
}

function handoffPacket(overrides = {}) {
  return {
    goal: "Continue the Lodestar end-to-end proof",
    rules: ["Preserve current user work"],
    entries: [{ key: "storage", state: "fact", text: "Use one SQLite database",
      scope: ["project"], generation: 1, provenance: { kind: "repo",
        sourceRef: "AGENTS.md", observedAt: "2026-08-13T12:00:00.000Z" } }],
    work: { completed: [], current: ["verification"], files: [] },
    nextMove: "Continue the end-to-end proof",
    evidence: [],
    ...overrides,
  };
}

test("the packed package completes every public operation without touching live state", {
  timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-packed-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = await packedEntry(directory);
  const project = path.join(directory, "project");
  const database = path.join(directory, "registry", "lodestar.db");
  const absent = path.join(directory, "absent.db");
  await mkdir(project);

  // Read from the source of truth: a literal here silently fails every version bump.
  assert.equal(ok(entry, ["--version"]).data.version, LODESTAR_VERSION);
  for (const command of COMMANDS) ok(entry, [command, "--help", "--db", absent]);
  assert.equal(await access(absent).then(() => true, () => false), false);
  assert.equal(fails(entry, ["not-a-command"]).error.code, "unknown_command");

  assert.equal(ok(entry, ["init", "--db", database]).data.created, true);
  const initializedHash = await digest(database);
  assert.equal(ok(entry, ["init", "--db", database]).data.created, false);
  assert.equal(await digest(database), initializedHash, "repeated init changed database bytes");

  const target = record("record:target", { text: "target" }, { aliases: ["target alias"] });
  const linked = record("record:linked", { text: "searchable integration phrase" }, {
    aliases: ["linked alias"],
    links: [{ relationship: "documents", to_id: target.id }],
    sources: [{ origin: "e2e", freshness: "current",
      metadata: { inspection: "inspected", inspected_at: "2026-08-13T12:00:00.000Z" } }],
  });
  ok(entry, ["put", "--db", database], { input: JSON.stringify(target) });
  ok(entry, ["put", "--db", database], { input: JSON.stringify(linked) });
  assert.equal(ok(entry, ["get", "linked alias", "--db", database]).data.id, linked.id);
  assert.deepEqual(ok(entry, ["find", "integration phrase", "--db", database])
    .data.records.map(({ id }) => id), [linked.id]);
  assert.equal(ok(entry, ["links", linked.id, "--db", database]).data.links[0].peer.id,
    target.id);

  const beforeReads = await digest(database);
  const readCommands = [
    ["get", target.id], ["find", "integration"], ["links", linked.id], ["export"],
    ["doctor"], ["work", "status", "--cwd", project],
    ["work", "history", "--cwd", project], ["handoff", "status", "--cwd", project],
  ];
  for (const args of readCommands) ok(entry, [...args, "--db", database], { cwd: project });
  assert.equal(await digest(database), beforeReads, "a read-only CLI operation changed bytes");
  assert.deepEqual((await readdir(path.dirname(database))).filter((name) =>
    name.startsWith("lodestar.db-") || name.startsWith("lodestar.db.")), []);

  const beforeFailure = await digest(database);
  const invalidReplacement = { ...linked, name: "must roll back",
    links: [{ relationship: "documents", to_id: "missing:target" }] };
  assert.equal(fails(entry, ["put", "--db", database], {
    input: JSON.stringify(invalidReplacement),
  }).error.code, "link_target_not_found");
  assert.equal(await digest(database), beforeFailure, "failed put changed database bytes");
  assert.equal(ok(entry, ["get", linked.id, "--db", database]).data.data.name, linked.name);

  const identity = ["--cwd", project, "--session", "work-session", "--agent", "codex",
    "--harness", "e2e"];
  ok(entry, ["work", "start", "first report", ...identity, "--db", database], { cwd: project });
  ok(entry, ["work", "start", "updated report", ...identity, "--db", database], { cwd: project });
  const active = ok(entry, ["work", "status", "--cwd", project, "--db", database], {
    cwd: project,
  });
  assert.equal(active.data.records.length, 1);
  assert.equal(active.data.records[0].data.current_work, "updated report");
  ok(entry, ["work", "done", "complete", ...identity, "--db", database], { cwd: project });
  assert.equal(ok(entry, ["work", "history", "--cwd", project, "--db", database], {
    cwd: project,
  }).data.records[0].data.status, "closed");

  const packet = handoffPacket({ goal: "Claim exactly once" });
  ok(entry, ["handoff", "arm", "--cwd", project, "--session", "source",
    "--agent", "codex", "--harness", "e2e", "--db", database], {
    cwd: project, input: JSON.stringify(packet),
  });
  ok(entry, ["handoff", "checkpoint", "--cwd", project, "--session", "source",
    "--agent", "codex", "--harness", "e2e", "--db", database], {
    cwd: project, input: JSON.stringify(handoffPacket({ nextMove: "Open the next session" })),
  });
  ok(entry, ["handoff", "disarm", "--cwd", project, "--session", "source",
    "--agent", "codex", "--harness", "e2e", "--db", database], { cwd: project });
  ok(entry, ["handoff", "now", "--cwd", project, "--session", "source",
    "--agent", "codex", "--harness", "e2e", "--db", database], {
    cwd: project, input: JSON.stringify(packet),
  });
  const claimants = Array.from({ length: 8 }, (_, index) => ({
    args: ["start", "--cwd", project, "--session", `claim-${index}`, "--agent", "codex",
      "--harness", "e2e", "--db", database],
  }));
  const claims = await concurrent(entry, claimants, project);
  assert.ok(claims.every(({ status, stderr }) => status === 0 && stderr === ""));
  const claimEnvelopes = claims.map(({ stdout }) => JSON.parse(stdout));
  const winners = claimEnvelopes.filter(({ data }) => data.handoff !== null);
  assert.equal(winners.length, 1, "concurrent startup claimed the baton more than once");
  const claimant = winners[0].data.handoff.recovery.data.claimed_by;
  const retry = ok(entry, ["start", "--cwd", project, "--session", claimant,
    "--agent", "codex", "--harness", "e2e", "--db", database], { cwd: project });
  assert.equal(retry.data.handoff.recovery.id, winners[0].data.handoff.recovery.id);

  const decisionIdentity = ["--cwd", project, "--session", "decisions", "--agent", "codex",
    "--harness", "e2e", "--db", database];
  ok(entry, ["decision", "set", "database", "SQLite", "--reason", "initial", ...decisionIdentity],
    { cwd: project });
  ok(entry, ["decision", "set", "database", "PostgreSQL", "--reason", "replaced",
    ...decisionIdentity], { cwd: project });
  ok(entry, ["decision", "set", "database", "SQLite", "--reason", "restored",
    ...decisionIdentity], { cwd: project });
  const decisions = ok(entry, ["decision", "show", "--cwd", project, "--db", database],
    { cwd: project }).data;
  assert.equal(decisions.facts[0].value, "SQLite");
  assert.deepEqual(decisions.dead.map(({ value }) => value), ["PostgreSQL"]);

  const workRacers = Array.from({ length: 6 }, (_, index) => ({
    args: ["work", "start", `race-${index}`, "--cwd", project, "--session", "same-session",
      "--agent", "codex", "--harness", "e2e", "--db", database],
  }));
  const workResults = await concurrent(entry, workRacers, project);
  assert.ok(workResults.every(({ status, stderr }) => status === 0 && stderr === ""));
  const afterRace = ok(entry, ["work", "status", "--cwd", project, "--db", database], {
    cwd: project,
  }).data.records.filter(({ data }) => data.session === "same-session");
  assert.equal(afterRace.length, 1, "same actor acquired multiple active work records");

  const deleted = ok(entry, ["delete", target.id, "--db", database]);
  assert.equal(deleted.data.deleted.links, 1);
  assert.equal(ok(entry, ["links", linked.id, "--db", database]).data.links.length, 0);
  ok(entry, ["delete", linked.id, "--db", database]);
  assert.equal(fails(entry, ["get", linked.id, "--db", database]).error.code,
    "record_not_found");

  const importDatabase = path.join(directory, "import", "lodestar.db");
  const legacy = await legacyStore(directory);
  const dryRun = ok(entry, ["import", legacy, "--dry-run", "--db", importDatabase]);
  assert.equal(dryRun.data.destination.committed, false);
  assert.equal(await access(importDatabase).then(() => true, () => false), false);
  assert.equal(ok(entry, ["import", legacy, "--db", importDatabase])
    .data.destination.committed, true);
  assert.equal(ok(entry, ["get", "guardrail", "--db", importDatabase]).data.id, "g:rule");
  assert.equal(ok(entry, ["doctor", "--db", importDatabase]).data.healthy, true);

  const clientHome = path.join(directory, "clients");
  const hermesHome = path.join(clientHome, "hermes");
  const opencodeRoot = path.join(clientHome, "opencode-skills");
  const clientArgs = ["--target", "all", "--home", clientHome,
    "--hermes-home", hermesHome, "--opencode-root", opencodeRoot];
  const installed = ok(entry, ["skills", "install", ...clientArgs]);
  assert.equal(installed.data.results.length, installed.data.skills.length * 4);
  assert.equal(ok(entry, ["skills", "verify", ...clientArgs]).data.verified, true);
  assert.ok(ok(entry, ["skills", "sync", ...clientArgs]).data.results
    .every(({ action }) => action === "unchanged"));
  ok(entry, ["skills", "remove", ...clientArgs]);
  assert.equal(ok(entry, ["skills", "verify", ...clientArgs], { status: 4 }).data.verified,
    false);
});
