import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installWindowsPosixShim,
  installWindowsServiceBootstrap,
  renderWindowsPosixShim,
  renderWindowsServiceBootstrap,
} from "../src/windows-install.mjs";

test("the Windows POSIX shim converts paths explicitly", () => {
  const shim = renderWindowsPosixShim();
  assert.match(shim, /cygpath -aw "\$NODE_BIN"/u);
  assert.match(shim, /cygpath -aw "\$LODESTAR_HOME\/lodestar\.mjs"/u);
  assert.match(shim, /MSYS2_ARG_CONV_EXCL='\*'/u);
});

test("the Windows service bootstrap is identity-bound and argument-safe", () => {
  const bootstrap = renderWindowsServiceBootstrap();
  assert.match(bootstrap, /ValidateSet\("ensure"\)/u);
  assert.match(bootstrap, /\$Options\[0\] -ne "--json"/u);
  assert.match(bootstrap, /127\\\.0\\\.0\\\.1/u);
  assert.match(bootstrap, /schemaVersion -ne \$expectedSchema/u);
  assert.match(bootstrap, /databaseInstanceId -ne \$discovery\.databaseInstanceId/u);
  assert.match(bootstrap, /@\(\$entryPath, "serve", "--port", "0"\)/u);
  assert.doesNotMatch(bootstrap, /packet_json|conversation|prompt.tail/u);
});

test("the Windows POSIX shim installer writes an executable atomically", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-shim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "bin", "lodestar");
  await installWindowsPosixShim(target);
  assert.equal(await readFile(target, "utf8"), renderWindowsPosixShim());
  const syntax = spawnSync("bash", ["-n", target], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("the Windows service bootstrap installer writes atomically", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "bin", "lodestar-service.ps1");
  await installWindowsServiceBootstrap(target);
  assert.equal(await readFile(target, "utf8"), renderWindowsServiceBootstrap());
});
