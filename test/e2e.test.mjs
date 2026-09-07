import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LODESTAR_VERSION } from "../src/version.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;

function npm(args, cwd) {
  const bundled = path.join(path.dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js");
  const cli = process.env.npm_execpath ?? (existsSync(bundled) ? bundled : null);
  const command = cli ? NODE : process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, cli ? [cli, ...args] : args,
    { cwd, encoding: "utf8", shell: !cli && process.platform === "win32" });
  assert.equal(result.status, 0, result.stderr || result.error?.stack);
  return result.stdout;
}

function invoke(entry, args, { input, cwd } = {}) {
  const result = spawnSync(NODE, [entry, ...args],
    { input, cwd, encoding: "utf8", windowsHide: true });
  const text = (result.stdout.trim() ? result.stdout : result.stderr).trim();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr,
    value: text ? JSON.parse(text) : null };
}

async function installPacked(directory) {
  const pack = path.join(directory, "pack");
  const prefix = path.join(directory, "prefix");
  await mkdir(pack, { recursive: true });
  const report = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", pack], ROOT));
  const archive = path.join(pack, report[0].filename);
  npm(["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive], ROOT);
  const packageRoot = path.join(prefix, "node_modules", "lodestar-agent-context");
  const entry = path.join(packageRoot, "lodestar.mjs");
  await access(entry);
  return { packageRoot, entry };
}

test("the staged package installs and exercises the current one-shot contract", {
  timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-2-installed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { packageRoot, entry } = await installPacked(directory);
  const database = path.join(directory, "state", "lodestar.db");
  const clientHome = path.join(directory, "client-home");

  const version = invoke(entry, ["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.value.v, 5);
  assert.equal(version.value.data.version, LODESTAR_VERSION);

  const initialized = invoke(entry, ["init", "--db", database]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const basis = {
    database_instance_id: initialized.value.database_instance_id,
    database_epoch: initialized.value.database_epoch,
    project_scope: "project:test",
    checkout: null,
    targets: [
      { kind: "record", id: "fact:installed", expected_revision: null },
      { kind: "record", id: "project:test", expected_revision: null },
    ],
  };
  const request = {
    v: 5,
    request_id: "installed-create",
    write_basis: basis,
    input: { mode: "create", record: {
      id: "fact:installed", kind: "fact", name: "Installed fact",
      scope: "project:test", availability: "known", priority: 10,
      data: { command: "npm test" }, aliases: ["installed fact"], links: [], sources: [],
      semantics: { subject: "build:test-command", lifecycle: "current",
        context_role: "orientation", basis: "asserted",
        applicability: { project: "project:test", checkout: null } },
    } },
  };
  const created = invoke(entry, ["put", "--db", database], { input: JSON.stringify(request) });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.value.request.replayed, false);
  assert.equal(invoke(entry, ["put", "--db", database], { input: JSON.stringify(request) })
    .value.request.replayed, true);

  const read = invoke(entry, ["get", "installed fact", "--db", database]);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.value.data.id, "fact:installed");
  assert.equal(read.value.data.data.command, "npm test");
  assert.equal(read.value.data.write_basis.database_epoch, basis.database_epoch);

  const retired = invoke(entry, ["delete", "--db", database], { input: JSON.stringify({
    v: 5, request_id: "installed-retire", write_basis: read.value.data.write_basis,
    input: { id: "fact:installed", reason: "Replaced by current source" },
  }) });
  assert.equal(retired.status, 0, retired.stderr);
  assert.equal(retired.value.data.retired, true);
  const history = invoke(entry, ["get", "fact:installed", "--history", "--db", database]);
  assert.equal(history.status, 0, history.stderr);
  assert.ok(history.value.data.versions.length >= 1);

  const skills = invoke(entry, ["skills", "verify", "--target", "codex", "--home", clientHome]);
  assert.equal(skills.status, 4);
  assert.equal(skills.value.data.contract, 5);
  assert.equal(await access(clientHome).then(() => true, () => false), false);

  const setupArgs = ["setup", "--target", "all", "--home", clientHome,
    "--hermes-home", path.join(clientHome, ".hermes")];
  const plan = invoke(entry, setupArgs);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.value.data.applied, false);
  assert.equal(await access(clientHome).then(() => true, () => false), false);
  const installedSkills = invoke(entry, [...setupArgs, "--apply"]);
  assert.equal(installedSkills.status, 0, installedSkills.stderr);
  assert.equal(installedSkills.value.data.verified, true);
  const repeatedSetup = invoke(entry, [...setupArgs, "--apply"]);
  assert.equal(repeatedSetup.status, 0, repeatedSetup.stderr);
  assert.ok(repeatedSetup.value.data.results.every(({ action, backup }) => action === "current" && backup === null));

  const mcp = path.join(packageRoot, "codex-plugin", "scripts", "lodestar-mcp.mjs");
  const nativeRequest = { ...request, request_id: "installed-native-create",
    write_basis: { ...basis, targets: [
      { kind: "record", id: "fact:native", expected_revision: null },
      { kind: "record", id: "project:test", expected_revision: null },
    ] },
    input: { ...request.input, record: { ...request.input.record,
      id: "fact:native", name: "Native fact", aliases: [] } } };
  const described = spawnSync(NODE, [mcp], {
    cwd: directory, encoding: "utf8",
    env: { ...process.env, LODESTAR_NODE: NODE, LODESTAR_ENTRY: entry, LODESTAR_DB: database },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "lodestar_mutate", arguments: { operation: "put", request: nativeRequest } } })}\n`,
  });
  assert.equal(described.status, 0, described.stderr);
  const response = JSON.parse(described.stdout);
  assert.equal(response.result.structuredContent.v, 5);
  assert.equal(response.result.structuredContent.data.id, "fact:native");
  assert.equal(invoke(entry, ["get", "fact:native", "--db", database]).value.data.id,
    "fact:native");
});
