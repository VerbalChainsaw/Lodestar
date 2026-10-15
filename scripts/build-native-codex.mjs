import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const NATIVE_ENTRIES = Object.freeze([
  ".agents", ".codex-plugin", ".mcp.json", "README.md", "hooks", "scripts", "skills", "tests",
]);

export function runNativeCheck(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
  return result;
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of (await readdir(source)).sort()) {
      await copyTree(path.join(source, entry), path.join(destination, entry));
    }
  } else if (info.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } else {
    throw new Error(`Native release payload must contain only regular files/directories: ${source}`);
  }
}

export async function buildNativeCodex(outputDirectory) {
  const native = path.join(ROOT, "native-codex");
  const manifest = JSON.parse(await readFile(path.join(native, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "lodestar");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  // Both plugin skill trees must come from the same maintained owner.
  runNativeCheck(process.execPath, [path.join(ROOT, "scripts", "build-managed-assets.mjs"), "--check"]);
  const directory = path.resolve(outputDirectory);
  const filename = `lodestar-native-codex-${manifest.version}.tgz`;
  const archive = path.join(directory, filename);
  const checksums = path.join(directory, "SHA256SUMS");
  for (const target of [archive, checksums]) {
    try { await lstat(target); throw new Error(`Refusing to replace an existing native release artifact: ${target}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lodestar-native-pack-"));
  try {
    const stage = path.join(temporary, "plugin");
    await mkdir(stage);
    for (const entry of NATIVE_ENTRIES) {
      await copyTree(path.join(native, entry), path.join(stage, entry));
    }
    // The repository license has one owner; include its current bytes in the archive.
    await copyFile(path.join(ROOT, "LICENSE"), path.join(stage, "LICENSE"));
    const stagedArchive = path.join(temporary, filename);
    runNativeCheck("tar", ["-czf", stagedArchive, "-C", stage, "--", ...NATIVE_ENTRIES, "LICENSE"]);
    const sha256 = createHash("sha256").update(await readFile(stagedArchive)).digest("hex");
    await mkdir(directory, { recursive: true });
    await copyFile(stagedArchive, archive, constants.COPYFILE_EXCL);
    await writeFile(checksums, `${sha256}  ${filename}\n`, { flag: "wx" });
    return { archive, sha256, checksums, adapter_version: manifest.version };
  } finally {
    // This directory is the exact mkdtemp result owned by this invocation.
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/build-native-codex.mjs <new-output-directory>");
    console.log(JSON.stringify(await buildNativeCodex(process.argv[2])));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
