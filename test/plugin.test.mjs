import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HANDOFF_ENTRY_KEY_PATTERN as CORE_ENTRY_KEY_PATTERN }
  from "../src/continuity.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = process.env.LODESTAR_PLUGIN_ROOT ?? path.join(ROOT, "codex-plugin");
const TEST_ENTRY = process.env.LODESTAR_TEST_ENTRY ?? path.join(ROOT, "lodestar.mjs");
const { handleHook } = await import(pathToFileURL(
  path.join(PLUGIN_ROOT, "scripts", "lodestar-hook.mjs"),
));
const {
  executeHandoff,
  extractDecisionMarkers,
  HANDOFF_ENTRY_KEY_PATTERN: PLUGIN_ENTRY_KEY_PATTERN,
  parseEnvelope,
  parseHandoffCommand,
  STARTUP_CONTEXT_PREFIX,
  STARTUP_CONTEXT_SUFFIX,
} = await import(pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lodestar-runtime.mjs")));

// The installed plugin is a separate artifact from the npm package, stamped by hand as
// <version>+codex.<timestamp>. Nothing forced the two to agree, so a Codex Desktop build
// ran 1.1.0 against a 1.2.2 registry and reported 1.1.0 over MCP while doing it.
test("the Codex plugin declares the package version", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, "codex-plugin", ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(
    manifest.version.split("+")[0],
    packageJson.version,
    "codex-plugin/.codex-plugin/plugin.json must track the package version",
  );

  // And the server must report that manifest rather than a literal of its own.
  const server = await readFile(
    path.join(ROOT, "codex-plugin", "scripts", "lodestar-mcp.mjs"), "utf8",
  );
  assert.match(server, /serverInfo:\s*\{\s*name:\s*"lodestar",\s*version:\s*pluginVersion\(\)/u);
  assert.doesNotMatch(server, /version:\s*"\d+\.\d+\.\d+"/u, "no hardcoded version");
});

test("the core validator and Codex packet contract use the same entry-key pattern", () => {
  assert.equal(PLUGIN_ENTRY_KEY_PATTERN, CORE_ENTRY_KEY_PATTERN);
});

test("the plugin declares no client-specific context caps", async () => {
  const manifest = JSON.parse(await readFile(
    path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8",
  ));
  for (const event of ["UserPromptSubmit", "SessionStart"]) {
    assert.equal("additionalContextLimit" in manifest.hooks[event][0].hooks[0], false);
  }
});

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

test("the hook executable accepts BOM-prefixed JSON for prompt and stop events", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-hook-stdin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = path.join(PLUGIN_ROOT, "scripts", "lodestar-hook.mjs");

  const invoke = async (input) => {
    const child = spawn(process.execPath, [hook], {
      cwd: directory,
      env: { ...process.env, PLUGIN_DATA: directory,
        LODESTAR_DB: path.join(directory, "missing", "lodestar.db"),
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
    child.stdin.end(`\uFEFF${JSON.stringify(input)}`, "utf8");
    return { status: await completed, stdout, stderr };
  };

  for (const input of [
    { hook_event_name: "UserPromptSubmit", session_id: "bom", turn_id: "prompt",
      cwd: directory, prompt: "ordinary prompt" },
    { hook_event_name: "Stop", session_id: "bom", turn_id: "stop", cwd: directory,
      stop_hook_active: false, last_assistant_message: "ordinary response" },
  ]) {
    const result = await invoke(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  }
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

// The security property is that the whole prompt is the command and nothing else, which
// is what stops a passing mention from authorizing a baton write. Case, spacing, a
// command sigil and a trailing period are not part of that property. Rejecting them
// bounced `$handoff now` in Codex Desktop, and the agent fell back to the raw CLI.
test("only the five continuity commands receive host authorization", () => {
  for (const command of ["arm", "status", "checkpoint", "now", "disarm"]) {
    assert.equal(parseHandoffCommand(`handoff ${command}`), command);
  }
  for (const prompt of ["$handoff now", "/handoff now", "!handoff now", "> handoff now",
    "lodestar handoff now", "Handoff Now", "handoff  now", "handoff now.", "HANDOFF NOW"]) {
    assert.equal(parseHandoffCommand(prompt), "now", prompt);
  }
  // Anything with words of its own around it is prose, not a command. "don't handoff
  // now" must never authorize the thing it is refusing.
  for (const prompt of ["handoff now please", "please handoff now", "don't handoff now",
    "handoff save", "handoff", "handoff now and then disarm", "why did handoff now fail",
    "```handoff now```", "handoff now?"]) {
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
  const startup = sourceStart.hookSpecificOutput.additionalContext;
  assert.ok(startup.startsWith(STARTUP_CONTEXT_PREFIX));
  assert.ok(startup.endsWith(STARTUP_CONTEXT_SUFFIX));
  const projection = JSON.parse(startup.slice(
    STARTUP_CONTEXT_PREFIX.length, -STARTUP_CONTEXT_SUFFIX.length,
  ));
  assert.deepEqual(projection.budget,
    { bytes: null, source: "unbounded", applies_to: "optional", target_met: true });
  const governance = projection.required.find(({ id }) =>
    id === "g:lodestar:required-governance");
  assert.equal(governance.data.v, 3);
  assert.match(governance.data.text, /## Core Governance Integrity/u);
  assert.match(governance.data.text, /## Reality Anchoring and Surface Integrity/u);
  assert.match(governance.data.text, /## Anti-Certainty Psychosis/u);

  let turn = 0;
  const execute = async (command, input = {}) => {
    turn += 1;
    const turnId = `turn-${turn}`;
    const authorization = await handleHook({ hook_event_name: "UserPromptSubmit",
      session_id: "source", turn_id: turnId, cwd: directory,
      prompt: `handoff ${command}` }, directory);
    assert.match(authorization.hookSpecificOutput.additionalContext,
      new RegExp(`lodestar_handoff_${command}`, "u"));
    if (["arm", "checkpoint", "now"].includes(command)) {
      assert.ok(authorization.hookSpecificOutput.additionalContext
        .includes("entry keys must match ^[a-z0-9][a-z0-9.-]*$"));
    }
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
  // Work is exposed alongside continuity because only the host knows the session id;
  // a shell cannot supply one, and guessing it captures a concurrent peer's marker.
  assert.deepEqual(replies[1].result.tools.map(({ name }) => name), [
    "lodestar_handoff_arm", "lodestar_handoff_status", "lodestar_handoff_checkpoint",
    "lodestar_handoff_now", "lodestar_handoff_disarm",
    "lodestar_work_start", "lodestar_work_done", "lodestar_work_status",
  ]);
  const arm = replies[1].result.tools.find(({ name }) => name === "lodestar_handoff_arm");
  assert.equal(
    arm.inputSchema.properties.packet.properties.entries.items.properties.key.pattern,
    "^[a-z0-9][a-z0-9.-]*$",
  );
  assert.equal(replies[2].result.isError, false);
  assert.equal(replies[2].result.structuredContent.result.recovery.data.state, "pending");
});
test("decision markers parse into their golden-rule families", () => {
  const text = [
    "[DECISION key=db:engine status=ACCEPTED value=\"PostgreSQL\" date=2026-08-19 reason=\"centralized writes\"]",
    "[DECISION key=campaign-governor status=BLOCKED value=hold date=2026-08-19 reason=\"waiting on operator\"]",
    "[DEAD key=old-db value=sqlite date=2026-08-19 reason=removed]",
    "[SUPERSEDED key=db:engine by=db:engine value=SQLite date=2026-08-19 reason=local-first]",
  ].join("\n");
  const markers = extractDecisionMarkers(text);
  assert.equal(markers.length, 4);
  assert.deepEqual(markers.map((marker) => marker.kind),
    ["DECISION", "DECISION", "DEAD", "SUPERSEDED"]);
  assert.equal(markers[0].value, "PostgreSQL");
  assert.equal(markers[0].status, "accepted");
  assert.equal(markers[1].status, "blocked");
  assert.equal(markers[2].key, "old-db");
  assert.equal(markers[3].by, "db:engine");
  assert.equal(extractDecisionMarkers("no markers in this prose").length, 0);
  assert.equal(extractDecisionMarkers("[DECISION reason=\"just prose\"]").length, 0);
});

test("the Stop hook captures decision markers into the ledger idempotently", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-plugin-markers-"));
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

  const stop = (turnId, message) => handleHook({ hook_event_name: "Stop",
    session_id: "marker", turn_id: turnId, cwd: directory,
    last_assistant_message: message }, directory);

  // First turn: value-bearing facts and one blocked decision land in the ledger.
  await stop("m1", [
    "[DECISION key=db:engine status=ACCEPTED value=postgres reason=\"centralized writes\"]",
    "[DECISION key=gate status=BLOCKED value=closed reason=\"waiting on vendor\"]",
    "[DECISION key=old-path status=ACCEPTED value=sqlite reason=baseline]",
  ].join("\n"));
  // Replaying the same facts is a no-op.
  await stop("m2", "[DECISION key=db:engine status=ACCEPTED value=postgres reason=\"centralized writes\"]");

  const read = () => {
    const db = new DatabaseSync(path.join(directory, "lodestar.db"), { readOnly: true });
    const events = db.prepare("SELECT json_extract(content_json,'$.value.event') AS event, "
      + "json_extract(content_json,'$.value.key') AS key, "
      + "json_extract(content_json,'$.value.value') AS value, "
      + "json_extract(content_json,'$.value.status') AS status, "
      + "json_extract(content_json,'$.value.reason') AS reason, "
      + "json_extract(content_json,'$.value.successor') AS successor "
      + "FROM records WHERE type='decision-event' ORDER BY "
      + "json_extract(content_json,'$._lodestar.revision')").all();
    db.close();
    return events;
  };

  let events = read();
  assert.equal(events.length, 3, JSON.stringify(events));
  const byKey = new Map(events.map((event) => [`${event.event}:${event.key}`, event]));
  assert.equal(byKey.get("set:db-engine").value, "postgres");
  assert.equal(byKey.get("set:gate").status, "blocked");
  assert.equal(byKey.get("set:old-path").value, "sqlite");

  // A later turn kills old-path; the kill lands once and replays as a no-op.
  const kill = "[SUPERSEDED key=old-path by=db:engine value=sqlite reason=\"replaced by the registry\"]";
  await stop("m3", kill);
  await stop("m4", kill);
  events = read();
  assert.equal(events.length, 4, JSON.stringify(events));
  assert.equal(events.filter((event) => event.event === "drop" && event.key === "old-path").length, 1);
  assert.match(events.at(-1).reason, /superseded by db:engine/u);
  // The SUPERSEDED marker's by= survives as the successor edge, not just prose
  // (successor keys normalize like decision keys: db:engine -> db-engine).
  assert.equal(events.at(-1).successor, "db-engine");
});