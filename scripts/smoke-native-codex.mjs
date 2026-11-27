import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_ENTRIES, runNativeCheck } from "./build-native-codex.mjs";

export function validateNativeArchive(archive) {
  const entries = runNativeCheck("tar", ["-tzf", archive]).stdout.trimEnd().split(/\r?\n/u);
  const seen = new Set();
  for (const item of entries) {
    const parts = item.replace(/\/$/u, "").split("/");
    assert.ok(!/[\\:\u0000-\u001f\u007f]/u.test(item)
      && parts.every((part) => part && part !== "." && part !== ".."
        && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)),
    `unsafe native archive path: ${JSON.stringify(item)}`);
    assert.ok([...NATIVE_ENTRIES, "LICENSE"].includes(parts[0]), `unexpected native archive member: ${item}`);
    const normalized = parts.join("/").toLowerCase();
    assert.ok(!seen.has(normalized), `duplicate native archive path: ${item}`);
    seen.add(normalized);
  }
  // GNU tar and bsdtar use the leading mode character for the member type.
  // Inspect before extraction: a checksum alone cannot make links safe.
  const modes = runNativeCheck("tar", ["-tvzf", archive]).stdout.trimEnd().split(/\r?\n/u);
  assert.equal(modes.length, entries.length, "native archive listings disagree");
  for (const line of modes) {
    assert.match(line, /^[-d][rwxStTs-]{9}\s/u,
      "native archive must contain only regular files and directories; links and special entries are refused");
  }
  return entries;
}

export async function smokeNativeCodex(archivePath, coreEntry) {
  const archive = await realpath(archivePath), entry = await realpath(coreEntry);
  const coreRoot = path.dirname(entry);
  const core = JSON.parse(await readFile(path.join(coreRoot, "package.json"), "utf8"));
  assert.equal(core.name, "lodestar-agent-context");
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  const checksum = await readFile(path.join(path.dirname(archive), "SHA256SUMS"), "utf8");
  assert.ok(checksum.split(/\r?\n/u).includes(`${sha256}  ${path.basename(archive)}`),
    "native archive must match its recorded checksum");
  validateNativeArchive(archive);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lodestar-native-smoke-"));
  try {
    // Mimic a native cache root, independent of both source and installed core.
    const plugin = path.join(temporary, "plugins", "cache", "personal", "lodestar", "candidate");
    const data = path.join(temporary, "plugins", "data", "lodestar-personal");
    await mkdir(plugin, { recursive: true });
    await mkdir(data, { recursive: true });
    runNativeCheck("tar", ["-xzf", archive, "-C", plugin]);
    const manifest = JSON.parse(await readFile(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(path.basename(archive), `lodestar-native-codex-${manifest.version}.tgz`);
    const mcp = JSON.parse(await readFile(path.join(plugin, ".mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers.lodestar.args, ["./scripts/lodestar-mcp.mjs"]);
    const hooks = JSON.parse(await readFile(path.join(plugin, "hooks", "hooks.json"), "utf8"));
    assert.ok(hooks.hooks.PreCompact && hooks.hooks.SessionStart && hooks.hooks.PreToolUse);
    const env = { ...process.env, LODESTAR_ENTRY: entry, LODESTAR_NODE: process.execPath,
      LODESTAR_DB: path.join(temporary, "fixture.db"), PLUGIN_DATA: data };
    const initialized = runNativeCheck(process.execPath, [path.join(plugin, "scripts", "lodestar-mcp.mjs")], {
      cwd: plugin, env,
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "native-package-smoke", version: "1" },
      } })}\n`,
    });
    const response = JSON.parse(initialized.stdout.trim());
    assert.equal(response.result.serverInfo.version, manifest.version);
    const tests = (await readdir(path.join(plugin, "tests"))).filter((name) => name.endsWith(".test.mjs")).sort();
    assert.ok(tests.includes("json-boundary.test.mjs") && tests.includes("compaction.test.mjs"));
    const result = runNativeCheck(process.execPath,
      ["--test", "--test-concurrency=1", ...tests.map((name) => path.join(plugin, "tests", name))],
      { cwd: plugin, env, timeout: 300_000 });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { archive, sha256, adapter_version: manifest.version, core_version: core.version,
      core_entry: entry, test_files: tests, isolated_cached_payload: true,
      native_desktop_precompact_delivery: "not-tested" };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/smoke-native-codex.mjs <native-archive.tgz> <packed-core/lodestar.mjs>");
    console.log(JSON.stringify(await smokeNativeCodex(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
