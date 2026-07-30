import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

function npmInvocation(args) {
  if (process.platform !== "win32") return ["npm", args];
  const npmCli = process.env.npm_execpath
    ?? path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
  return [process.execPath, [npmCli, ...args]];
}

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await filesBelow(entryPath));
    } else {
      paths.push(entryPath);
    }
  }
  return paths;
}

test("package is private-state-free and its lift benchmark is runnable", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lodestar-pack-"));
  try {
    const [npm, npmArgs] = npmInvocation([
      "pack",
      "--json",
      "--pack-destination",
      temp,
    ]);
    const { stdout } = await execFileAsync(
      npm,
      npmArgs,
      { cwd: packageRoot },
    );
    const [{ filename }] = JSON.parse(stdout);
    const unpacked = path.join(temp, "unpacked");
    await execFileAsync("tar", [
      "-xzf",
      path.join(temp, filename),
      "-C",
      temp,
    ]);
    await import("node:fs/promises").then(({ rename }) =>
      rename(path.join(temp, "package"), unpacked),
    );

    const packedFiles = await filesBelow(unpacked);
    const packedText = (
      await Promise.all(packedFiles.map((file) => readFile(file, "utf8")))
    ).join("\n");
    const forbidden = [
      "zero" + "p",
      "phi" + "xx",
      "Suno" + "Savvy",
      "Jobby" + "Job",
    ];
    for (const marker of forbidden) {
      assert.equal(
        packedText.toLowerCase().includes(marker.toLowerCase()),
        false,
        `packed content contains forbidden marker: ${marker}`,
      );
    }
    assert.equal(
      packedFiles.some((file) =>
        path.relative(unpacked, file) === path.join("docs", "evaluation.md")),
      true,
      "packed benchmark is missing its methodology",
    );
    const { stdout: benchmarkJson } = await execFileAsync(process.execPath, [
      path.join(unpacked, "tools", "benchmark-lift.mjs"),
      "--json",
      "--runs",
      "1",
      "--projects",
      "10",
      "--documents",
      "8",
      "--document-bytes",
      "1024",
    ]);
    assert.equal(JSON.parse(benchmarkJson).passed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
