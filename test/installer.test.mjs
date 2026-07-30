import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  installLodestar,
  resolveNpmInvocation,
} from "../install.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

async function withTemp(prefix, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeLegacyStore(root) {
  const projectRoot = path.join(root, "project");
  await mkdir(path.join(root, "records", "projects"), { recursive: true });
  await mkdir(projectRoot);
  await writeFile(path.join(root, "catalog.json"), JSON.stringify({
    v: 1,
    projects: [{
      id: "p:demo",
      name: "Demo",
      roots: [projectRoot],
      context: "records/projects/demo.jsonl",
    }],
  }));
  await writeFile(
    path.join(root, "records", "global.jsonl"),
    `${JSON.stringify({
      id: "g:rules",
      kind: "rule",
      priority: 1_000,
      required: true,
      scope: ["global"],
      links: [],
    })}\n`,
  );
  await writeFile(
    path.join(root, "records", "projects", "demo.jsonl"),
    `${JSON.stringify({
      id: "p:demo:index",
      kind: "index",
      priority: 900,
      required: true,
      links: [],
    })}\n`,
  );
}

test("installer dry-run returns a complete plan without starting npm", async () => {
  await withTemp("lodestar-installer-plan-", async (root) => {
    const output = [];
    const result = await installLodestar([
      "--dry-run",
      "--package",
      packageRoot,
      "--prefix",
      path.join(root, "prefix"),
      "--home",
      path.join(root, "state"),
      "--skip-codex",
    ], {
      spawn: () => assert.fail("dry-run must not start a subprocess"),
      stdout: (line) => output.push(JSON.parse(line)),
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.plan.package_name, "lodestar-agent-context");
    assert.equal(result.plan.install_codex, false);
    assert.equal(result.plan.legacy_home, null);
    assert.deepEqual(output, [result]);
    await assert.rejects(access(path.join(root, "prefix")));
  });
});

test("installer rejects unsupported Node and unknown arguments", async () => {
  await assert.rejects(
    installLodestar([], {
      nodeVersion: "21.9.0",
      stdout: () => {},
    }),
    { code: "node-version-unsupported" },
  );
  await assert.rejects(
    installLodestar(["--surprise"], { stdout: () => {} }),
    { code: "installer-argument-invalid" },
  );
  assert.throws(
    () => resolveNpmInvocation({
      platform: "win32",
      pathApi: path.win32,
      nodeExecutable: "C:\\missing\\node.exe",
      fileExists: () => false,
      env: { PATH: "" },
    }),
    (error) =>
      error.code === "installer-npm-unavailable"
      && error.detail.repair.includes("Node.js 22"),
  );
});

test("installer performs an isolated package, state, and Codex installation", async () => {
  await withTemp("lodestar-installer-e2e-", async (root) => {
    const prefix = path.join(root, "prefix");
    const stateHome = path.join(root, "state");
    const codexHome = path.join(root, "codex");
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.join(packageRoot, "install.mjs"),
      "--package",
      packageRoot,
      "--prefix",
      prefix,
      "--home",
      stateHome,
      "--codex-home",
      codexHome,
    ], {
      cwd: packageRoot,
      timeout: 30_000,
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.package.version, "0.4.0");
    assert.equal(result.initialized.created, true);
    assert.equal(result.codex.ok, true);
    assert.match(
      await readFile(path.join(codexHome, "AGENTS.md"), "utf8"),
      /BOOT=agentctx start/,
    );

    const npmRoot = process.platform === "win32"
      ? path.join(prefix, "node_modules")
      : path.join(prefix, "lib", "node_modules");
    const installedMain = path.join(
      npmRoot,
      "lodestar-agent-context",
      "agentctx.mjs",
    );
    const doctor = await execFileAsync(process.execPath, [
      installedMain,
      "doctor",
      "--home",
      stateHome,
    ]);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  });
});

test("installer upgrades a legacy store through the installed public package", async () => {
  await withTemp("lodestar-installer-legacy-", async (root) => {
    const prefix = path.join(root, "prefix");
    const stateHome = path.join(root, "state");
    const legacyHome = path.join(root, "legacy");
    await writeLegacyStore(legacyHome);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.join(packageRoot, "install.mjs"),
      "--package",
      packageRoot,
      "--prefix",
      prefix,
      "--home",
      stateHome,
      "--legacy-home",
      legacyHome,
      "--skip-codex",
    ], {
      cwd: packageRoot,
      timeout: 30_000,
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.initialized, null);
    assert.equal(result.migration.migrated, true);
    assert.equal(result.migration.records, 2);
    const npmRoot = process.platform === "win32"
      ? path.join(prefix, "node_modules")
      : path.join(prefix, "lib", "node_modules");
    const doctor = await execFileAsync(process.execPath, [
      path.join(npmRoot, "lodestar-agent-context", "agentctx.mjs"),
      "doctor",
      "--home",
      stateHome,
    ]);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  });
});
