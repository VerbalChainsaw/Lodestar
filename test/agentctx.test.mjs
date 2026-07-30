import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

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

test("package contains no private state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lodestar-pack-"));
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--pack-destination", temp],
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
      "Verbal" + "Chainsaw",
      "C:" + "/Users/",
      "/mnt/c/" + "Users/",
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
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
