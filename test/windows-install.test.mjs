import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installWslShim,
  installWindowsPosixShim,
  parseWslUncTarget,
  resolveClientStateHome,
  renderWslShim,
  renderWindowsPosixShim,
} from "../src/windows-install.mjs";

test("WSL UNC targets preserve the distribution and Linux path", () => {
  assert.deepEqual(
    parseWslUncTarget(String.raw`\\wsl.localhost\Ubuntu\home\phixx\.local\bin\lodestar`),
    { distribution: "Ubuntu", linuxPath: "/home/phixx/.local/bin/lodestar" },
  );
  assert.deepEqual(
    parseWslUncTarget(String.raw`\\wsl$\Debian\home\agent\lodestar`),
    { distribution: "Debian", linuxPath: "/home/agent/lodestar" },
  );
  assert.equal(parseWslUncTarget(String.raw`C:\Users\agent\lodestar`), null);
});

test("WSL clients keep managed write state on the Linux filesystem", async () => {
  const home = String.raw`\\wsl.localhost\Ubuntu\home\phixx`;
  assert.equal(
    await resolveClientStateHome(home),
    String.raw`\\wsl.localhost\Ubuntu\home\phixx\.local\state`,
  );
});

test("the Windows POSIX shim converts paths explicitly", () => {
  const shim = renderWindowsPosixShim({ node: String.raw`C:\selected\node.exe`,
    entry: String.raw`C:\selected\node_modules\lodestar-agent-context\lodestar.mjs` });
  assert.match(shim, /NODE_BIN_WIN='C:\\selected\\node\.exe'/u);
  assert.match(shim, /LODESTAR_ENTRY_WIN='C:\\selected\\node_modules/u);
  assert.doesNotMatch(shim, /node-\*/u);
  assert.match(shim, /MSYS2_ARG_CONV_EXCL='\*'/u);
});

test("the WSL shim crosses the Windows-owned one-shot boundary", () => {
  const shim = renderWslShim({ node: String.raw`C:\selected\node.exe`,
    entry: String.raw`C:\selected\node_modules\lodestar-agent-context\lodestar.mjs` });
  assert.match(shim, /wslpath -w/u);
  assert.doesNotMatch(shim, /node-\*/u);
  assert.match(shim, /NODE_BIN='C:\\selected\\node\.exe'/u);
  assert.match(shim, /defaults\+=\(--home/u);
  assert.match(shim, /defaults\+=\(--hermes-home/u);
  assert.doesNotMatch(shim, /--codex-bootstrap|--claude-bootstrap|--hermes-bootstrap|--opencode-bootstrap/u);
  assert.match(shim, /--cwd\|--home\|--codex-home\|--claude-home/u);
  assert.match(shim,
    /exec \/init "\$\(wslpath -u "\$NODE_BIN"\)" -- "\$LODESTAR_ENTRY_WIN" "\$\{arguments\[@\]\}"/u);
  assert.doesNotMatch(shim, /exec "\$NODE_BIN"/u);
  assert.match(shim, /check_database_path/u);
});

// The installed shim is checked by piping its bytes to `bash -n` on stdin. Passing a
// path instead would require guessing the dialect of whichever bash is on PATH: Git
// Bash reads C:\x as /c/x, WSL bash as /mnt/c/x, and the wrong guess reports a missing
// file as a syntax failure. Stdin removes the dialect from the assertion entirely.
function assertBashSyntax(t, source) {
  const syntax = spawnSync("bash", ["-n"], { input: source, encoding: "utf8" });
  if (syntax.error?.code === "ENOENT") {
    t.skip("bash is not available to check shim syntax");
    return;
  }
  assert.equal(syntax.status, 0, syntax.stderr);
}

test("the Windows POSIX shim installer writes an executable atomically", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "bin", "lodestar");
  await installWindowsPosixShim(target);
  const installed = await readFile(target, "utf8");
  assert.equal(installed, renderWindowsPosixShim());
  assertBashSyntax(t, installed);
});

test("the WSL shim installer writes an executable atomically", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-wsl-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "lodestar");
  await installWslShim(target);
  const installed = await readFile(target, "utf8");
  assert.equal(installed, renderWslShim());
  assertBashSyntax(t, installed);
});

// Guards the guard: proves `bash -n` on stdin actually rejects a parse error, so a
// green shim check above means the shim parsed rather than the check being inert.
test("the shim syntax check rejects a parse error", () => {
  const syntax = spawnSync("bash", ["-n"], {
    input: "if [ -z \"$X\" ; then echo hi\n",
    encoding: "utf8",
  });
  if (syntax.error?.code === "ENOENT") return;
  assert.notEqual(syntax.status, 0);
});

test("launcher updates preserve custom bytes and repeated concurrent installs converge", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-shim-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "lodestar");
  const custom = "#!/bin/bash\necho custom local launcher\n";
  await writeFile(target, custom);
  await assert.rejects(installWindowsPosixShim(target), { code: "launcher_conflict" });
  assert.equal(await readFile(target, "utf8"), custom);
  await installWindowsPosixShim(target, { expectedContent: custom });
  const backups = (await readdir(directory)).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(directory, backups[0]), "utf8"), custom);
  await Promise.all([installWindowsPosixShim(target), installWindowsPosixShim(target)]);
  assert.equal(await readFile(target, "utf8"), renderWindowsPosixShim());
  assert.equal((await readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("launcher publication detects changed targets and verifies preserved backup bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-shim-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalWrite = fsPromises.writeFile;
  for (const changed of ["target", "backup"]) {
    const target = path.join(directory, changed);
    const baseline = "#!/bin/bash\necho accepted\n";
    const newer = "#!/bin/bash\necho newer local edit\n";
    await originalWrite(target, baseline);
    const mock = t.mock.method(fsPromises, "writeFile", async (destination, ...args) => {
      await originalWrite(destination, ...args);
      if (String(destination).endsWith(".bak")) {
        await originalWrite(changed === "target" ? target : destination, newer);
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(installWindowsPosixShim(target, { expectedContent: baseline }),
        { code: changed === "target" ? "launcher_conflict" : "launcher_backup_failed" });
      assert.equal(await readFile(target, "utf8"), changed === "target" ? newer : baseline);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("WSL transports actual arguments and working directory across the Windows boundary", async (t) => {
  if (process.platform !== "win32") return t.skip("Requires Windows with WSL interop");
  const available = spawnSync("wsl.exe", ["--", "bash", "-c", "test -x /init && command -v wslpath"],
    { encoding: "utf8", windowsHide: true });
  if (available.status !== 0) return t.skip("WSL interop is unavailable");
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-wsl-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "capture.mjs");
  await writeFile(entry, "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),db:process.env.LODESTAR_DB}));");
  const shim = renderWslShim({ entry });
  const invoke = (cwd, args, prefix = "") => spawnSync("wsl.exe",
    ["--cd", cwd, "--", "bash", "-s", "--", ...args],
    { input: `${prefix}${shim}`, encoding: "utf8", windowsHide: true });
  const parse = (result) => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).argv; };
  const value = (args, name) => args[args.indexOf(name) + 1];
  const home = spawnSync("wsl.exe", ["--", "bash", "-c", "printf %s \"$HOME\""], { encoding: "utf8" }).stdout;
  const homeWin = spawnSync("wsl.exe", ["--", "wslpath", "-w", home], { encoding: "utf8" }).stdout.trim();
  const normal = parse(invoke("/", ["start", "--cwd", home]));
  const elsewhere = parse(invoke("/mnt/c", ["--human", "start", "--cwd", home]));
  assert.equal(value(normal, "--cwd"), homeWin);
  assert.equal(value(elsewhere, "--cwd"), homeWin);
  const inferred = parse(invoke(home, ["start"]));
  assert.equal(value(inferred, "--cwd"), homeWin);
  const skills = parse(invoke(home, ["--human", "skills", "verify", "--target", "all"],
    "export HERMES_HOME=\"$HOME/custom-hermes\"\n"));
  assert.equal(value(skills, "--home"), homeWin);
  assert.equal(value(skills, "--hermes-home"), `${homeWin}\\custom-hermes`);
  const customHomes = parse(invoke(home, ["--human", "setup"],
    "export CODEX_HOME=\"$HOME/custom-codex\" CLAUDE_CONFIG_DIR=\"$HOME/custom-claude\" XDG_CONFIG_HOME=\"$HOME/custom-xdg\" OPENCODE_CONFIG_DIR=\"$HOME/custom-opencode\"\n"));
  assert.equal(value(customHomes, "--codex-home"), `${homeWin}\\custom-codex`);
  assert.equal(value(customHomes, "--claude-home"), `${homeWin}\\custom-claude`);
  assert.equal(value(customHomes, "--xdg-config-home"), `${homeWin}\\custom-xdg`);
  assert.equal(value(customHomes, "--opencode-root"), `${homeWin}\\custom-opencode\\skills`);
  const hostEnvironment = "export HERMES_HOME=\"$HOME/custom-hermes\" CODEX_HOME=\"$HOME/custom-codex\" CLAUDE_CONFIG_DIR=\"$HOME/custom-claude\" XDG_CONFIG_HOME=\"$HOME/custom-xdg\" OPENCODE_CONFIG_DIR=\"$HOME/custom-opencode\"\n";
  const isolated = parse(invoke(home, ["setup", "--home", `${home}/other-user`], hostEnvironment));
  assert.equal(value(isolated, "--home"), `${homeWin}\\other-user`);
  assert.equal(value(isolated, "--hermes-home"), `${homeWin}\\other-user\\.hermes`);
  for (const option of ["--codex-home", "--claude-home", "--xdg-config-home", "--opencode-root"]) {
    assert.equal(isolated.includes(option), false, `${option} must not leak from the caller's environment`);
  }
  const explicit = parse(invoke(home, ["skills", "verify", "--home", `${home}/other-user`,
    "--hermes-home", `${home}/explicit-hermes`, "--codex-home", `${home}/explicit-codex`], hostEnvironment));
  assert.equal(value(explicit, "--hermes-home"), `${homeWin}\\explicit-hermes`);
  assert.equal(value(explicit, "--codex-home"), `${homeWin}\\explicit-codex`);
  const paths = parse(invoke("/mnt/c", ["put", "--db", "/mnt/c/state/not-created.db", "--file", "request file.json"]));
  assert.equal(value(paths, "--db"), "C:\\state\\not-created.db");
  assert.equal(value(paths, "--file"), "C:\\request file.json");
  const fromEnvironment = invoke("/mnt/c", ["doctor"], "export LODESTAR_DB=/mnt/c/state/environment.db\n");
  assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
  assert.equal(JSON.parse(fromEnvironment.stdout).db, "C:\\state\\environment.db");
  const override = parse(invoke("/mnt/c", ["doctor", "--db", "/mnt/c/state/explicit.db"],
    "export LODESTAR_DB=\"$HOME/not-the-selected-database.db\"\n"));
  assert.equal(value(override, "--db"), "C:\\state\\explicit.db");
  const ended = parse(invoke(home, ["start", "--", "--file", "literal"]));
  assert.deepEqual(ended.slice(ended.indexOf("--")), ["--", "--file", "literal"]);
  const rejected = invoke(home, ["init", "--db", `${home}/forbidden.db`]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /SQLite must remain on a Windows filesystem/u);
});
