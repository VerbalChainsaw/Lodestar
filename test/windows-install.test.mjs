import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installWindowsPosixShim,
  renderWindowsPosixShim,
} from "../src/windows-install.mjs";

test("the Windows POSIX shim converts paths explicitly", () => {
  const shim = renderWindowsPosixShim();
  assert.match(shim, /cygpath -aw "\$NODE_BIN"/u);
  assert.match(shim, /cygpath -aw "\$LODESTAR_HOME\/lodestar\.mjs"/u);
  assert.match(shim, /MSYS2_ARG_CONV_EXCL='\*'/u);
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
