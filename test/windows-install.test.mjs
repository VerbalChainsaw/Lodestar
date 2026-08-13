import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installWslShim,
  installWindowsPosixShim,
  renderWslShim,
  renderWindowsPosixShim,
} from "../src/windows-install.mjs";

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
  assert.match(shim, /exec \/init "\$NODE_BIN" -- "\$LODESTAR_ENTRY_WIN" "\$@"/u);
  assert.doesNotMatch(shim, /exec "\$NODE_BIN"/u);
  assert.doesNotMatch(shim, /LODESTAR_DB=/u);
});

test("the Windows POSIX shim installer writes an executable atomically", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "bin", "lodestar");
  await installWindowsPosixShim(target);
  assert.equal(await readFile(target, "utf8"), renderWindowsPosixShim());
  const bashTarget = process.platform === "win32"
    ? `/mnt/${target[0].toLowerCase()}${target.slice(2).replaceAll("\\", "/")}`
    : target;
  const syntax = spawnSync("bash", ["-n", bashTarget], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("the WSL shim installer writes an executable atomically", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-wsl-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "lodestar");
  await installWslShim(target);
  assert.equal(await readFile(target, "utf8"), renderWslShim());
  const bashTarget = process.platform === "win32"
    ? `/mnt/${target[0].toLowerCase()}${target.slice(2).replaceAll("\\", "/")}`
    : target;
  const syntax = spawnSync("bash", ["-n", bashTarget], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});
