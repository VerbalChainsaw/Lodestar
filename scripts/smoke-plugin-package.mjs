import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);

async function declaredPluginRoot(packageRoot) {
  const root = path.resolve(packageRoot);
  const candidates = [root, path.join(root, "codex-plugin")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, ".codex-plugin", "plugin.json"))) return candidate;
  }
  throw new Error(`No Codex plugin manifest was found in ${root}.`);
}

function isolatedEnvironment(directory, database) {
  const home = path.join(directory, "home");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    APPDATA: path.join(home, "AppData", "Roaming"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    HERMES_HOME: path.join(home, ".hermes"),
    OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
    LODESTAR_DB: database,
  };
  delete env.LODESTAR_NODE;
  delete env.LODESTAR_ENTRY;
  delete env.LODESTAR_COMMAND;
  return env;
}

function runCli(entry, args, { env, input } = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8", env, input, windowsHide: true, timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = (result.stdout || result.stderr).trim();
  return { ...result, value: output ? JSON.parse(output) : null };
}

function runServer(server, messages, { cacheRoot, env, resolveCommand }) {
  const command = resolveCommand(server.command);
  const input = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const result = spawnSync(command, server.args ?? [], {
    cwd: path.resolve(cacheRoot, server.cwd ?? "."),
    encoding: "utf8",
    env,
    input,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: Math.max(16 * 1024 * 1024, Buffer.byteLength(input) * 4),
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "", "the plugin server must keep successful responses on stdout");
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function request(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

export async function smokePluginPackage(packageRoot, {
  resolveCommand = (command) => command === "node" ? process.execPath : command,
} = {}) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const packageEntry = path.join(resolvedPackageRoot, "lodestar.mjs");
  const sourcePluginRoot = await declaredPluginRoot(resolvedPackageRoot);
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, "lodestar-plugin-smoke-"));
  const cacheRoot = path.join(directory, "cache");
  const database = path.join(directory, "state", "lodestar.db");
  const env = isolatedEnvironment(directory, database);

  try {
    await mkdir(path.dirname(database), { recursive: true });
    await cp(sourcePluginRoot, cacheRoot, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(cacheRoot, ".codex-plugin", "plugin.json"), "utf8"));
    const mcpPath = path.resolve(cacheRoot, manifest.mcpServers);
    const declared = JSON.parse(await readFile(mcpPath, "utf8"));
    const servers = declared.mcpServers ?? declared;
    const server = servers.lodestar;
    assert.ok(server && typeof server.command === "string", "the manifest must declare the Lodestar MCP server");

    const initialized = runCli(packageEntry, ["init", "--db", database], { env });
    assert.equal(initialized.status, 0, initialized.stderr);

    const first = runServer(server, [
      request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } }),
      request(2, "tools/list"),
      request(3, "tools/call", { name: "lodestar_describe", arguments: {} }),
      request(4, "tools/call", { name: "lodestar_read", arguments: {
        operation: "get", arguments: ["plugin-package-smoke", "--db", database],
      } }),
    ], { cacheRoot, env, resolveCommand });
    assert.equal(first[0].result.serverInfo.name, "lodestar");
    assert.deepEqual(first[1].result.tools.map(({ name }) => name), [
      "lodestar_describe", "lodestar_read", "lodestar_mutate",
    ]);
    assert.equal(first[2].result.structuredContent.contract, 5);
    const missing = first[3].result.structuredContent;
    assert.equal(first[3].result.isError, true);
    assert.equal(missing.error.code, "record_not_found");

    const text = `plugin cache — 日本語 — café\r\n${"larger payload Ω\r\n".repeat(4096)}`;
    const create = {
      v: 5,
      request_id: "plugin-package-create",
      write_basis: missing.error.identifiers.write_basis,
      input: { mode: "create", record: {
        id: "plugin-package-smoke", kind: "note", name: "Plugin package smoke",
        scope: "global", availability: "known", data: { text },
        aliases: ["plugin smoke alias"], links: [], sources: [],
      } },
    };
    const stale = { ...create, request_id: "plugin-package-stale" };
    const second = runServer(server, [
      request(5, "tools/call", { name: "lodestar_mutate", arguments: { operation: "put", request: create } }),
      request(6, "tools/call", { name: "lodestar_mutate", arguments: { operation: "put", request: create } }),
    ], { cacheRoot, env, resolveCommand });
    assert.equal(second[0].result.structuredContent.request?.replayed, false,
      JSON.stringify(second[0]));
    assert.equal(second[1].result.structuredContent.request?.replayed, true,
      JSON.stringify(second[1]));
    assert.equal(second[1].result.structuredContent.revision,
      second[0].result.structuredContent.revision);

    const beforeStale = runCli(packageEntry,
      ["get", "plugin-package-smoke", "--history", "--db", database], { env });
    assert.equal(beforeStale.status, 0, beforeStale.stderr);
    const third = runServer(server, [
      request(7, "tools/call", { name: "lodestar_mutate", arguments: { operation: "put", request: stale } }),
      request(8, "tools/call", { name: "lodestar_read", arguments: {
        operation: "get", arguments: ["plugin smoke alias", "--db", database],
      } }),
    ], { cacheRoot, env, resolveCommand });
    assert.equal(third[0].result.isError, true);
    assert.equal(third[0].result.structuredContent.ok, false);
    assert.equal(third[0].result.structuredContent.error.code, "revision_conflict");
    assert.equal(third[1].result.structuredContent.data.data.text, text);

    const current = runCli(packageEntry, ["get", "plugin-package-smoke", "--db", database], { env });
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.value.data.data.text, text);
    assert.equal(current.value.data.revision, second[0].result.structuredContent.revision);
    const afterStale = runCli(packageEntry,
      ["get", "plugin-package-smoke", "--history", "--db", database], { env });
    assert.equal(afterStale.status, 0, afterStale.stderr);
    assert.deepEqual(afterStale.value.data.versions, beforeStale.value.data.versions,
      "a rejected stale write must not alter history");

    const retire = {
      v: 5,
      request_id: "plugin-package-retire",
      write_basis: current.value.data.write_basis,
      input: { id: "plugin-package-smoke", reason: "Packaged plugin behavior verified" },
    };
    const retired = runServer(server, [
      request(9, "tools/call", { name: "lodestar_mutate", arguments: { operation: "delete", request: retire } }),
    ], { cacheRoot, env, resolveCommand });
    assert.equal(retired[0].result.structuredContent.data.retired, true);
    const historical = runCli(packageEntry, ["get", "plugin-package-smoke", "--db", database], { env });
    assert.equal(historical.status, 0, historical.stderr);
    assert.equal(historical.value.data.semantics.lifecycle, "historical");
    assert.equal(sourcePluginRoot, resolvedPackageRoot,
      "a release candidate must declare the whole package root as its Codex plugin root");

    return {
      ok: true,
      contract: 5,
      declared_plugin_root: path.relative(resolvedPackageRoot, sourcePluginRoot) || ".",
      cached_whole_package: sourcePluginRoot === resolvedPackageRoot,
      exact_cli_read: true,
      rejected_stale_write_preserved_state: true,
      replayed_mutation: true,
      retirement: true,
      unicode_line_endings_and_larger_payload: true,
    };
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith("lodestar-plugin-smoke-"));
    await rm(directory, { recursive: true, force: true });
    assert.equal(await access(directory).then(() => true, () => false), false);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  const packageRoot = path.resolve(process.argv[2] ?? ".package-smoke/node_modules/lodestar-agent-context");
  try {
    console.log(JSON.stringify(await smokePluginPackage(packageRoot)));
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
