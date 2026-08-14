import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = process.env.LODESTAR_PLUGIN_ROOT ?? path.join(ROOT, "codex-plugin");
const TEST_ENTRY = process.env.LODESTAR_TEST_ENTRY ?? path.join(ROOT, "lodestar.mjs");
const { handleHook } = await import(pathToFileURL(
  path.join(PLUGIN_ROOT, "scripts", "lodestar-hook.mjs"),
));
const { executeHandoff, parseEnvelope, parseHandoffCommand } = await import(pathToFileURL(
  path.join(PLUGIN_ROOT, "scripts", "lodestar-runtime.mjs"),
));

test("the plugin recovers the envelope even when a runtime prepends notices", () => {
  const envelope = '{"v":1,"ok":false,"error":{"code":"database_not_found"}}';

  assert.equal(parseEnvelope(envelope).error.code, "database_not_found");
  assert.equal(parseEnvelope(`${envelope}\n`).error.code, "database_not_found");
  assert.equal(
    parseEnvelope(
      "(node:1) ExperimentalWarning: SQLite is an experimental feature\n"
        + "(Use `node --trace-warnings ...` to show where the warning was created)\n"
        + envelope,
    ).error.code,
    "database_not_found",
    "a prepended runtime warning must not hide the real error code",
  );
  assert.equal(parseEnvelope('{\n  "v": 1,\n  "ok": true\n}').ok, true);

  assert.equal(parseEnvelope(""), null);
  assert.equal(parseEnvelope("   "), null);
  assert.equal(parseEnvelope("LODESTAR ERROR: runtime not found"), null);
  assert.equal(parseEnvelope("notice\n{not json}"), null);
});

const packet = {
  goal: "Continue the unified Lodestar verification",
  rules: ["Preserve the one-suite command contract"],
  entries: [{
    key: "verification.state",
    state: "fact",
    text: "The API_KEY=secret-value must be redacted before storage.",
    scope: ["project"],
    provenance: {
      kind: "repo",
      sourceRef: "test/plugin.test.mjs",
      observedAt: "2026-08-13T12:00:00.000Z",
    },
    generation: 1,
  }],
  work: { completed: [], current: ["plugin verification"], files: [] },
  nextMove: "Run the next focused verification",
  evidence: [],
};

test("only the five exact continuity commands receive host authorization", () => {
  for (const command of ["arm", "status", "checkpoint", "now", "disarm"]) {
    assert.equal(parseHandoffCommand(`handoff ${command}`), command);
  }
  for (const prompt of ["handoff now please", "please handoff now", "handoff save",
    "lodestar handoff now", "Handoff now", "handoff  now"]) {
    assert.equal(parseHandoffCommand(prompt), null, prompt);
  }
});

test("the Lodestar plugin runs all five commands, redacts, and restores one recovery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-plugin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prior = {
    LODESTAR_DB: process.env.LODESTAR_DB,
    LODESTAR_NODE: process.env.LODESTAR_NODE,
    LODESTAR_ENTRY: process.env.LODESTAR_ENTRY,
  };
  process.env.LODESTAR_DB = path.join(directory, "lodestar.db");
  process.env.LODESTAR_NODE = process.execPath;
  process.env.LODESTAR_ENTRY = TEST_ENTRY;
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const sourceStart = await handleHook({
    hook_event_name: "SessionStart", session_id: "source", cwd: directory,
  }, directory);
  assert.match(sourceStart.hookSpecificOutput.additionalContext, /Lodestar startup context/u);

  let turn = 0;
  const execute = async (command, input = {}) => {
    turn += 1;
    const turnId = `turn-${turn}`;
    const authorization = await handleHook({ hook_event_name: "UserPromptSubmit",
      session_id: "source", turn_id: turnId, cwd: directory,
      prompt: `handoff ${command}` }, directory);
    assert.match(authorization.hookSpecificOutput.additionalContext,
      new RegExp(`lodestar_handoff_${command}`, "u"));
    const toolName = `lodestar__lodestar_handoff_${command}`;
    const attested = await handleHook({ hook_event_name: "PreToolUse", session_id: "source",
      turn_id: turnId, tool_use_id: `tool-${turn}`, cwd: directory,
      tool_name: toolName, tool_input: input }, directory);
    assert.equal(attested.hookSpecificOutput.permissionDecision, "allow");
    const result = await executeHandoff(toolName,
      attested.hookSpecificOutput.updatedInput, directory);
    await assert.rejects(() => executeHandoff(toolName,
      attested.hookSpecificOutput.updatedInput, directory), /attestation/u);
    return result;
  };

  const armed = await execute("arm", { packet });
  assert.equal(armed.result.lane.data.state, "armed");
  await handleHook({ hook_event_name: "UserPromptSubmit", session_id: "source",
    turn_id: "tail-user", cwd: directory, prompt: "API_KEY=tail-secret" }, directory);
  const checked = await execute("checkpoint", { packet: { ...packet,
    nextMove: "Open the successor session" } });
  assert.equal(checked.result.packet.recentTail.items.length, 1);
  assert.doesNotMatch(JSON.stringify(checked), /secret-value|tail-secret/u);
  assert.equal((await execute("status")).result.lane.data.state, "armed");
  assert.equal((await execute("disarm")).result.changed, true);
  const saved = await execute("now", { packet });
  assert.equal(saved.result.recovery.data.state, "pending");
  assert.doesNotMatch(JSON.stringify(saved), /secret-value/u);

  const sourceRetry = await handleHook({
    hook_event_name: "SessionStart", session_id: "source", cwd: directory,
  }, directory);
  assert.match(sourceRetry.hookSpecificOutput.additionalContext, /"handoff":null/u);
  const claimant = await handleHook({
    hook_event_name: "SessionStart", session_id: "next", cwd: directory,
  }, directory);
  assert.match(claimant.hookSpecificOutput.additionalContext, /"claimed_by":"next"/u);
  const third = await handleHook({
    hook_event_name: "SessionStart", session_id: "third", cwd: directory,
  }, directory);
  assert.match(third.hookSpecificOutput.additionalContext, /"handoff":null/u);
});

test("the plugin MCP stdio transport initializes, lists, and executes the authorized tool", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-plugin-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await handleHook({
    hook_event_name: "UserPromptSubmit", session_id: "mcp-source", turn_id: "turn-mcp",
    cwd: directory, prompt: "handoff now",
  }, directory);
  const attested = await handleHook({
    hook_event_name: "PreToolUse", session_id: "mcp-source", turn_id: "turn-mcp",
    tool_use_id: "tool-mcp", cwd: directory, tool_name: "lodestar__lodestar_handoff_now",
    tool_input: { packet },
  }, directory);
  const server = path.join(PLUGIN_ROOT, "scripts", "lodestar-mcp.mjs");
  const child = spawn(process.execPath, [server], {
    cwd: directory,
    env: { ...process.env, PLUGIN_DATA: directory,
      LODESTAR_DB: path.join(directory, "lodestar.db"),
      LODESTAR_NODE: process.execPath, LODESTAR_ENTRY: TEST_ENTRY },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status));
  });
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "lodestar_handoff_now",
        arguments: attested.hookSpecificOutput.updatedInput } },
  ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  assert.equal(await completed, 0);
  assert.equal(stderr, "");
  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, "lodestar");
  assert.deepEqual(replies[1].result.tools.map(({ name }) => name), [
    "lodestar_handoff_arm", "lodestar_handoff_status", "lodestar_handoff_checkpoint",
    "lodestar_handoff_now", "lodestar_handoff_disarm",
  ]);
  assert.equal(replies[2].result.isError, false);
  assert.equal(replies[2].result.structuredContent.result.recovery.data.state, "pending");
});
