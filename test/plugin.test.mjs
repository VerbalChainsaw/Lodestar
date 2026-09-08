import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS, MUTATION_INPUTS } from "../src/cli-commands.mjs";
import { AGENT_BOOTSTRAP } from "../src/bootstrap.mjs";
import { MUTATION_REQUEST_SCHEMA, PUT_INPUT_SCHEMA, DELETE_INPUT_SCHEMA } from "../src/records.mjs";
import { CONTRACT_VERSION } from "../src/schema.mjs";
import { LODESTAR_VERSION } from "../src/version.mjs";
import { callNativeTool, NATIVE_TOOLS } from "../codex-plugin/scripts/lodestar-mcp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = path.join(ROOT, "codex-plugin", "scripts", "lodestar-mcp.mjs");

test("native tools derive the installed command and mutation contract", async () => {
  assert.deepEqual(NATIVE_TOOLS.map(({ name }) => name), [
    "lodestar_describe", "lodestar_read", "lodestar_mutate",
  ]);
  for (const tool of NATIVE_TOOLS) assert.equal(tool.inputSchema.type, "object",
    `${tool.name} must declare an object input schema for MCP clients`);
  const described = await callNativeTool("lodestar_describe");
  assert.equal(described.contract, CONTRACT_VERSION);
  assert.equal(described.package_version, LODESTAR_VERSION);
  assert.deepEqual(described.operating_guide, AGENT_BOOTSTRAP);
  assert.deepEqual(described.commands, COMMANDS);
  assert.deepEqual(described.mutation_request, MUTATION_REQUEST_SCHEMA);
  assert.deepEqual(described.mutation_inputs.put, PUT_INPUT_SCHEMA);
  assert.deepEqual(described.mutation_inputs.delete, DELETE_INPUT_SCHEMA);
  assert.equal(Object.hasOwn(described.read_operations, "decision.status"), false);
  for (const operation of ["put", "delete", ...Object.keys(MUTATION_INPUTS)]) {
    const branch = NATIVE_TOOLS[2].inputSchema.oneOf.find(
      ({ properties }) => properties.operation.const === operation,
    );
    assert.ok(branch, `missing native mutation operation ${operation}`);
    assert.equal(branch.properties.request.properties.v.const, CONTRACT_VERSION);
    assert.deepEqual(branch.properties.request.required, MUTATION_REQUEST_SCHEMA.required);
    if (Object.hasOwn(MUTATION_INPUTS, operation)) {
      assert.deepEqual(branch.properties.request.properties.input, MUTATION_INPUTS[operation]);
    }
  }
});

test("the plugin declares MCP and skill capabilities without hooks", async () => {
  const plugin = JSON.parse(await readFile(path.join(ROOT,
    ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.version, LODESTAR_VERSION);
  assert.deepEqual(plugin.interface.capabilities, ["skills", "MCP tools"]);
  assert.equal(Object.hasOwn(plugin, "hooks"), false);
  await assert.rejects(readFile(path.join(ROOT, "codex-plugin", "hooks", "hooks.json")),
    { code: "ENOENT" });
});

test("the MCP stdio transport lists and executes the installed contract-5 runtime", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-native-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [SERVER], {
    cwd: directory,
    env: { ...process.env, LODESTAR_NODE: process.execPath,
      LODESTAR_ENTRY: path.join(ROOT, "lodestar.mjs"),
      LODESTAR_DB: path.join(directory, "absent.db") },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "lodestar_describe", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "lodestar_read", arguments: { operation: "start", arguments: ["--cwd", directory] } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "lodestar_read", arguments: { operation: "skills.verify",
        arguments: ["--target", "codex", "--home", path.join(directory, "missing-home")] } } },
  ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  assert.equal(await completed, 0);
  assert.equal(stderr, "");
  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.version, LODESTAR_VERSION);
  assert.deepEqual(replies[1].result.tools.map(({ name }) => name),
    ["lodestar_describe", "lodestar_read", "lodestar_mutate"]);
  assert.equal(replies[2].result.structuredContent.contract, 5);
  assert.equal(replies[3].result?.isError, true, "core execution errors must reach the model as tool results");
  assert.equal(replies[3].result.structuredContent.error.code, "database_not_found");
  assert.deepEqual(JSON.parse(replies[3].result.content[0].text), replies[3].result.structuredContent);
  assert.equal(replies[4].result.structuredContent.ok, true,
    "an ok contract envelope remains a native success when CLI status means attention");
  assert.equal(replies[4].result.structuredContent.data.verified, false);
});
