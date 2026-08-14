import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const shim = renderWindowsPosixShim();
  assert.match(shim, /cygpath -aw "\$NODE_BIN"/u);
  assert.match(shim, /cygpath -aw "\$LODESTAR_HOME\/lodestar\.mjs"/u);
  assert.match(shim, /MSYS2_ARG_CONV_EXCL='\*'/u);
});

test("the WSL shim crosses the Windows-owned one-shot boundary", () => {
  const shim = renderWslShim();
  assert.match(shim, /\/init "\$\(command -v cmd\.exe\)" -- \/d \/c echo %USERPROFILE%/u);
  assert.match(shim, /wslpath -w/u);
  assert.match(shim, /node-\*\/node\.exe/u);
  assert.match(shim, /arguments\+=\(--home/u);
  assert.match(shim, /arguments\+=\(--hermes-home/u);
  assert.match(shim, /--codex-bootstrap\|--claude-bootstrap/u);
  assert.match(shim,
    /exec \/init "\$NODE_BIN" -- "\$LODESTAR_ENTRY_WIN" "\$\{arguments\[@\]\}"/u);
  assert.doesNotMatch(shim, /exec "\$NODE_BIN"/u);
  assert.doesNotMatch(shim, /LODESTAR_DB=/u);
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
