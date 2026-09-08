import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderWslShim } from "../src/windows-install.mjs";
import { temporaryDirectory } from "./helpers/contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function npm(args, cwd) {
  const bundled = path.join(path.dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js");
  const cli = process.env.npm_execpath ?? (existsSync(bundled) ? bundled : null);
  const result = run(cli ? NODE : process.platform === "win32" ? "npm.cmd" : "npm",
    cli ? [cli, ...args] : args, { cwd, shell: !cli && process.platform === "win32" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function linuxPath(value) {
  const result = run("wsl.exe", ["--exec", "wslpath", "-u", value]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function replies(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test("a cached plugin launched by native WSL Node keeps the Windows one-shot boundary", {
  timeout: 120_000,
}, async (t) => {
  if (process.platform !== "win32") return t.skip("the WSL ownership boundary is Windows-hosted");
  const available = spawnSync("wsl.exe", ["--exec", "sh", "-c",
    "test -x /init && command -v wslpath >/dev/null"], {
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  if (available.error?.code === "ENOENT") return t.skip("WSL is unavailable");
  if (available.error) throw available.error;
  if (available.status !== 0) return t.skip("WSL interop is unavailable");
  const nativeHomeResult = run("wsl.exe", ["--exec", "sh", "-c", 'printf %s "$HOME"']);
  assert.equal(nativeHomeResult.status, 0, nativeHomeResult.stderr);
  const nativeHome = nativeHomeResult.stdout;
  const discoveredNode = run("wsl.exe", ["--exec", "sh", "-c", "command -v node || true"]).stdout.trim();
  const nodeCandidates = [...new Set([
    process.env.LODESTAR_TEST_WSL_NODE,
    discoveredNode,
    `${nativeHome}/.local/opt/node-current/bin/node`,
  ].filter(Boolean))];
  const linuxNode = nodeCandidates.find((candidate) => {
    const version = spawnSync("wsl.exe", ["--exec", candidate, "--version"], {
      encoding: "utf8", windowsHide: true, timeout: 60_000,
    });
    const match = /^v(\d+)\.(\d+)\.(\d+)/u.exec(version.stdout.trim());
    return !version.error && version.status === 0 && match
      && (Number(match[1]) > 24 || Number(match[1]) === 24 && Number(match[2]) >= 15);
  });
  if (!linuxNode) return t.skip("WSL has no native Node 24.15.0 or newer runtime");

  const directory = await temporaryDirectory(t, "lodestar-plugin-wsl-");
  const pack = path.join(directory, "pack");
  const prefix = path.join(directory, "prefix");
  await mkdir(pack, { recursive: true });
  const report = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", pack], ROOT));
  const archive = path.join(pack, report[0].filename);
  npm(["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive], ROOT);
  const packageRoot = path.join(prefix, "node_modules", "lodestar-agent-context");
  const entry = path.join(packageRoot, "lodestar.mjs");
  const server = path.join(packageRoot, "codex-plugin", "scripts", "lodestar-mcp.mjs");
  const database = path.join(directory, "state", "lodestar.db");
  const shim = path.join(directory, "bin", "lodestar");
  await mkdir(path.dirname(shim), { recursive: true });
  await mkdir(path.dirname(database), { recursive: true });
  await writeFile(shim, renderWslShim({ entry }));

  const linuxShim = linuxPath(shim);
  const linuxBin = linuxPath(path.dirname(shim));
  const linuxServer = linuxPath(server);
  const linuxDatabase = linuxPath(database);
  const linuxHome = linuxPath(path.join(directory, "linux-home"));
  const nativePathResult = run("wsl.exe", ["--exec", "sh", "-c", 'printf %s "$PATH"']);
  assert.equal(nativePathResult.status, 0, nativePathResult.stderr);
  assert.equal(run("wsl.exe", ["--exec", "chmod", "+x", linuxShim]).status, 0);
  const initialized = run(NODE, [entry, "init", "--db", database]);
  assert.equal(initialized.status, 0, initialized.stderr);

  const invokeMcp = (messages, inheritedDatabase = linuxDatabase) => run("wsl.exe", ["--exec", "env",
    "-u", "LODESTAR_COMMAND", "-u", "LODESTAR_NODE", "-u", "LODESTAR_ENTRY",
    `PATH=${linuxBin}:${nativePathResult.stdout}`, `LODESTAR_DB=${inheritedDatabase}`, `HOME=${linuxHome}`,
    linuxNode, linuxServer], {
    cwd: packageRoot,
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  });
  const request = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
  const id = `wsl-long:${"読😀".repeat(30000)}`;
  const first = replies(invokeMcp([
    request(1, "initialize", { protocolVersion: "2025-03-26" }),
    request(2, "tools/list"),
    request(3, "tools/call", { name: "lodestar_describe", arguments: {} }),
    request(4, "tools/call", { name: "lodestar_read", arguments: {
      operation: "start", arguments: ["--cwd", nativeHome],
    } }),
    request(5, "tools/call", { name: "lodestar_read", arguments: {
      operation: "get", arguments: [id],
    } }),
  ]));
  assert.deepEqual(first[1].result.tools.map(({ name }) => name),
    ["lodestar_describe", "lodestar_read", "lodestar_mutate"]);
  assert.equal(first[2].result.structuredContent.contract, 5);
  assert.equal(first[3].result.structuredContent.ok, true);
  const expectedCwd = run("wsl.exe", ["--exec", "wslpath", "-w", nativeHome]).stdout.trim()
    .replaceAll("\\", "/");
  assert.equal(first[3].result.structuredContent.data.project.cwd, expectedCwd);
  assert.equal(first[4].result.structuredContent.error.code, "record_not_found");

  const text = "WSL mutation bytes — 日本語\r\nsecond line";
  const create = {
    v: 5, request_id: "plugin-wsl-create",
    write_basis: first[4].result.structuredContent.error.identifiers.write_basis,
    input: { mode: "create", record: {
      id, kind: "note", name: "WSL plugin record", scope: "global",
      availability: "known", data: { text }, aliases: [], links: [], sources: [],
    } },
  };
  const second = replies(invokeMcp([
    request(6, "tools/call", { name: "lodestar_mutate", arguments: {
      operation: "put", request: create,
    } }),
    request(9, "tools/call", { name: "lodestar_read", arguments: {
      operation: "get", arguments: ["--", "--db"],
    } }),
  ]));
  assert.equal(second[0].result.structuredContent.ok, true);
  assert.equal(second[1].result.structuredContent.error.code, "record_not_found");
  assert.equal(second[1].result.structuredContent.database_instance_id,
    JSON.parse(initialized.stdout).database_instance_id,
    "a positional --db token after the delimiter must not select another database");

  const third = replies(invokeMcp([
    request(7, "tools/call", { name: "lodestar_read", arguments: {
      operation: "get", arguments: [id, "--db", linuxDatabase],
    } }),
    request(8, "tools/call", { name: "lodestar_read", arguments: {
      operation: "get", arguments: [id, "--db", `${nativeHome}/lodestar-rejected.db`],
    } }),
  ], `${nativeHome}/inherited-forbidden.db`));
  assert.equal(third[0].result.structuredContent.data.data.text, text,
    "an explicit Windows-mounted database must override an inherited Linux database");
  assert.match(third[1].error.message, /SQLite must remain on a Windows filesystem/u);

  const cli = run(NODE, [entry, "--args-stdin"], {
    input: JSON.stringify(["get", id, "--db", database]),
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).data.data.text, text);
  assert.equal(await readFile(database).then((bytes) => bytes.length > 0), true);
});
