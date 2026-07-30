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
import { gzip } from "node:zlib";
import test from "node:test";

import {
  boundedGunzip,
  INSTALLER_VERSION,
  installLodestar,
  installerHelpText,
  installWindowsCompatibilityShims,
  packageMetadata,
  packageTransition,
  resolveNpmInvocation,
} from "../install.mjs";

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
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

test("installer dry-run inspects npm root and returns a complete plan", async () => {
  await withTemp("lodestar-installer-plan-", async (root) => {
    const output = [];
    const prefix = path.join(root, "prefix");
    const npmRoot = path.join(prefix, "lib", "node_modules");
    const result = await installLodestar([
      "--dry-run",
      "--package",
      packageRoot,
      "--prefix",
      prefix,
      "--home",
      path.join(root, "state"),
      "--skip-codex",
    ], {
      spawn: (_command, args) => {
        assert.deepEqual(args.slice(-4, -1), [
          "root",
          "--global",
          "--prefix",
        ]);
        assert.equal(path.resolve(args.at(-1)), path.resolve(prefix));
        return { status: 0, stdout: npmRoot, stderr: "" };
      },
      stdout: (line) => output.push(JSON.parse(line)),
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.plan.package_name, "lodestar-agent-context");
    assert.equal(result.plan.install_codex, false);
    assert.equal(result.plan.legacy_home, null);
    assert.equal(result.plan.installed_version, null);
    assert.equal(result.plan.transition, "install");
    assert.deepEqual(output, [result]);
    await assert.rejects(access(path.join(root, "prefix")));
  });
});

test("installer reports package transitions and refuses accidental downgrade", async () => {
  assert.equal(packageTransition(null, "0.6.1"), "install");
  assert.equal(packageTransition("0.6.1", "0.6.1"), "reinstall");
  assert.equal(packageTransition("0.5.0", "0.6.1"), "upgrade");
  assert.equal(packageTransition("0.7.0", "0.6.1"), "downgrade");
  assert.equal(packageTransition("1.0.0-beta.2", "1.0.0-beta.10"), "upgrade");
  assert.equal(packageTransition("1.0.0-beta", "1.0.0"), "upgrade");
  assert.equal(packageTransition("1.0.0+old", "1.0.0+new"), "reinstall");
  assert.equal(packageTransition("development", "0.6.1"), "replace-unknown");

  await withTemp("lodestar-installer-transition-", async (root) => {
    const prefix = path.join(root, "prefix");
    const npmRoot = path.join(prefix, "lib", "node_modules");
    const installedRoot = path.join(npmRoot, "lodestar-agent-context");
    await mkdir(installedRoot, { recursive: true });
    const spawn = () => ({ status: 0, stdout: npmRoot, stderr: "" });

    await writeFile(path.join(installedRoot, "package.json"), JSON.stringify({
      name: "lodestar-agent-context",
      version: "0.5.0",
    }));
    const upgrade = await installLodestar([
      "--dry-run",
      "--package",
      packageRoot,
      "--prefix",
      prefix,
      "--skip-codex",
    ], { spawn, stdout: () => {} });
    assert.equal(upgrade.plan.installed_version, "0.5.0");
    assert.equal(upgrade.plan.transition, "upgrade");

    await writeFile(path.join(installedRoot, "package.json"), JSON.stringify({
      name: "lodestar-agent-context",
      version: "9.0.0",
    }));
    await assert.rejects(
      installLodestar([
        "--dry-run",
        "--package",
        packageRoot,
        "--prefix",
        prefix,
        "--skip-codex",
      ], { spawn, stdout: () => {} }),
      { code: "installer-downgrade-refused" },
    );
    const downgrade = await installLodestar([
      "--dry-run",
      "--allow-downgrade",
      "--package",
      packageRoot,
      "--prefix",
      prefix,
      "--skip-codex",
    ], { spawn, stdout: () => {} });
    assert.equal(downgrade.plan.transition, "downgrade");

    await writeFile(path.join(installedRoot, "package.json"), JSON.stringify({
      name: "lodestar-agent-context",
      version: "development",
    }));
    await assert.rejects(
      installLodestar([
        "--dry-run",
        "--package",
        packageRoot,
        "--prefix",
        prefix,
        "--skip-codex",
      ], { spawn, stdout: () => {} }),
      { code: "installer-version-replacement-refused" },
    );
    const explicitReplacement = await installLodestar([
      "--dry-run",
      "--allow-downgrade",
      "--package",
      packageRoot,
      "--prefix",
      prefix,
      "--skip-codex",
    ], { spawn, stdout: () => {} });
    assert.equal(explicitReplacement.plan.transition, "replace-unknown");
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

test("installer help and version succeed without package or npm access", async () => {
  const helpOutput = [];
  const help = await installLodestar(["--help"], {
    nodeVersion: "1.0.0",
    spawn: () => assert.fail("help must not start npm"),
    stdout: (line) => helpOutput.push(line),
  });
  assert.deepEqual(help, { ok: true, help: true });
  assert.deepEqual(helpOutput, [installerHelpText()]);
  assert.match(helpOutput[0], /--dry-run/);
  assert.match(helpOutput[0], /--allow-downgrade/);

  const versionOutput = [];
  const version = await installLodestar(["--version"], {
    nodeVersion: "1.0.0",
    spawn: () => assert.fail("version must not start npm"),
    stdout: (line) => versionOutput.push(line),
  });
  assert.deepEqual(version, { ok: true, version: INSTALLER_VERSION });
  assert.deepEqual(versionOutput, [INSTALLER_VERSION]);
});

test("installer validates tarball identity before invoking npm", async () => {
  await withTemp("lodestar-installer-invalid-tar-", async (root) => {
    const archive = path.join(root, "not-lodestar.tgz");
    await writeFile(archive, "not a gzip archive");
    await assert.rejects(
      packageMetadata(archive),
      { code: "installer-package-invalid" },
    );
    await assert.rejects(
      installLodestar(["--package", archive, "--skip-codex"], {
        spawn: () => assert.fail("invalid package must not invoke npm"),
        stdout: () => {},
      }),
      { code: "installer-package-invalid" },
    );
  });
});

test("installer stops archive expansion at its decompressed byte budget", async () => {
  await withTemp("lodestar-installer-gzip-budget-", async (root) => {
    const archive = path.join(root, "expands.tgz");
    await writeFile(archive, await gzipAsync(Buffer.alloc(8 * 1024)));
    await assert.rejects(
      boundedGunzip(archive, {
        maxCompressedBytes: 1024 * 1024,
        maxExpandedBytes: 1024,
      }),
      /expanded package archive exceeds/,
    );
  });
});

test("Windows compatibility shims replace a stale prefix-bin command", async () => {
  await withTemp("lodestar-installer-shim-", async (root) => {
    const prefix = path.join(root, "prefix");
    const installed = path.join(root, "package");
    const target = path.join(installed, "agentctx.mjs");
    await mkdir(path.join(prefix, "bin"), { recursive: true });
    await mkdir(installed);
    await writeFile(target, "#!/usr/bin/env node\n");
    await writeFile(
      path.join(prefix, "bin", "agentctx.cmd"),
      "@ECHO off\r\nnode C:\\legacy\\agentctx.mjs %*\r\n",
    );

    const result = await installWindowsCompatibilityShims({
      npmPrefix: prefix,
      packageRoot: installed,
      bins: { agentctx: "./agentctx.mjs" },
      nodeExecutable: process.execPath,
      pathApi: path,
    });

    assert.equal(result.bin, path.join(prefix, "bin"));
    assert.deepEqual(result.shims, [
      path.join(prefix, "bin", "agentctx.cmd"),
    ]);
    const shim = await readFile(result.shims[0], "utf8");
    assert.doesNotMatch(shim, /legacy/);
    assert.match(shim, new RegExp(
      process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ));
    assert.match(shim, /package[\\/]agentctx\.mjs/);
  });
});

test("Windows compatibility shim failure restores every earlier shim", async () => {
  await withTemp("lodestar-installer-shim-rollback-", async (root) => {
    const prefix = path.join(root, "prefix");
    const installed = path.join(root, "package");
    await mkdir(path.join(prefix, "bin"), { recursive: true });
    await mkdir(installed);
    await Promise.all([
      writeFile(path.join(installed, "first.mjs"), ""),
      writeFile(path.join(installed, "second.mjs"), ""),
      writeFile(path.join(prefix, "bin", "first.cmd"), "original"),
    ]);
    await assert.rejects(
      installWindowsCompatibilityShims({
        npmPrefix: prefix,
        packageRoot: installed,
        bins: {
          first: "./first.mjs",
          second: "./second.mjs",
        },
        nodeExecutable: process.execPath,
        pathApi: path,
        fsApi: {
          async writeFile(file, content, encoding) {
            if (file.includes("second.cmd.tmp-")) {
              throw Object.assign(new Error("second shim failed"), {
                code: "EIO",
              });
            }
            return writeFile(file, content, encoding);
          },
        },
      }),
    );
    assert.equal(
      await readFile(path.join(prefix, "bin", "first.cmd"), "utf8"),
      "original",
    );
    await assert.rejects(
      access(path.join(prefix, "bin", "second.cmd")),
      { code: "ENOENT" },
    );
  });
});

test("installer restores the previous package when post-install setup fails", async () => {
  await withTemp("lodestar-installer-rollback-", async (root) => {
    const prefix = path.join(root, "prefix");
    const stateHome = path.join(root, "state");
    await installLodestar([
      "--package",
      packageRoot,
      "--prefix",
      prefix,
      "--home",
      stateHome,
      "--skip-codex",
    ], { stdout: () => {} });

    const broken = path.join(root, "broken-package");
    await mkdir(broken);
    await writeFile(path.join(broken, "package.json"), JSON.stringify({
      name: "lodestar-agent-context",
      version: "9.9.9",
      type: "module",
      bin: { agentctx: "./agentctx.mjs" },
    }));
    await writeFile(
      path.join(broken, "agentctx.mjs"),
      "process.stderr.write('setup failed\\n'); process.exit(7);",
    );

    await assert.rejects(
      installLodestar([
        "--package",
        broken,
        "--prefix",
        prefix,
        "--home",
        stateHome,
        "--skip-codex",
      ], { stdout: () => {} }),
      { code: "installer-process-failed" },
    );

    const npmRoot = process.platform === "win32"
      ? path.join(prefix, "node_modules")
      : path.join(prefix, "lib", "node_modules");
    const installed = JSON.parse(await readFile(path.join(
      npmRoot,
      "lodestar-agent-context",
      "package.json",
    ), "utf8"));
    assert.equal(installed.version, (await packageMetadata(packageRoot)).version);
  });
});

test("installer removes state it created when a later adapter step fails", async () => {
  await withTemp("lodestar-installer-state-rollback-", async (root) => {
    const prefix = path.join(root, "prefix");
    const stateHome = path.join(root, "state");
    const broken = path.join(root, "late-failure-package");
    await mkdir(broken);
    await writeFile(path.join(broken, "package.json"), JSON.stringify({
      name: "lodestar-agent-context",
      version: "9.9.8",
      type: "module",
      bin: { agentctx: "./agentctx.mjs" },
    }));
    await writeFile(path.join(broken, "agentctx.mjs"), [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const homeIndex = args.indexOf('--home');",
      "const home = homeIndex >= 0 ? args[homeIndex + 1] : null;",
      "if (args[0] === 'init') {",
      "  fs.mkdirSync(home, { recursive: true });",
      "  process.stdout.write(JSON.stringify({ ok: true, home, created: true }));",
      "} else {",
      "  process.stderr.write('adapter failed');",
      "  process.exitCode = 7;",
      "}",
    ].join("\n"));
    await assert.rejects(
      installLodestar([
        "--package",
        broken,
        "--prefix",
        prefix,
        "--home",
        stateHome,
        "--codex-home",
        path.join(root, "codex"),
      ], { stdout: () => {} }),
      { code: "installer-process-failed" },
    );
    await assert.rejects(access(stateHome), { code: "ENOENT" });
  });
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
    assert.equal(
      result.package.version,
      (await packageMetadata(packageRoot)).version,
    );
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
    if (process.platform === "win32") {
      assert.equal(
        result.compatibility_bin,
        path.join(prefix, "bin"),
      );
      assert.match(
        await readFile(path.join(prefix, "bin", "agentctx.cmd"), "utf8"),
        /lodestar-agent-context[\\/]agentctx\.mjs/,
      );
    }
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
