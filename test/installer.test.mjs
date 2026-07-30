import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { installLodestar } from "../install.mjs";

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
    assert.equal(result.package.version, "0.3.0");
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
