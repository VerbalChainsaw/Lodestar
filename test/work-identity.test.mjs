import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = process.env.LODESTAR_PLUGIN_ROOT ?? path.join(ROOT, "codex-plugin");
const TEST_ENTRY = process.env.LODESTAR_TEST_ENTRY ?? path.join(ROOT, "lodestar.mjs");
const { handleHook } = await import(pathToFileURL(
  path.join(PLUGIN_ROOT, "scripts", "lodestar-hook.mjs")));
const { executeHandoff, executeWork } = await import(pathToFileURL(
  path.join(PLUGIN_ROOT, "scripts", "lodestar-runtime.mjs")));

// A shell has no session id, so any CLI-side fallback can only guess which session is
// calling. A wrong guess does not merely mislabel: work records are keyed by actor, so
// the guess captures a peer's marker and the next write overwrites it. Identity for
// advisory presence therefore comes from the host attestation, exactly as continuity
// does, and this exercises the case that previously lost a peer's work silently.
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-work-identity-"));
  const prior = { ...process.env };
  process.env.LODESTAR_DB = path.join(directory, "registry.db");
  process.env.LODESTAR_NODE = process.execPath;
  process.env.LODESTAR_ENTRY = TEST_ENTRY;
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID",
    "OPENCODE_SESSION_ID"]) delete process.env[key];
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function call(directory, session, turn, command, input = {}) {
  const tool = `lodestar__lodestar_work_${command}`;
  const attested = await handleHook({
    hook_event_name: "PreToolUse", session_id: session, turn_id: turn,
    tool_use_id: `${session}-${turn}-${command}`, cwd: directory,
    tool_name: tool, tool_input: input,
  }, directory);
  assert.equal(attested.hookSpecificOutput?.permissionDecision, "allow",
    "work needs no spoken authorization, only an exact host session");
  return await executeWork(tool, attested.hookSpecificOutput.updatedInput, directory);
}

test("two sessions in one project keep separate advisory identities", async (t) => {
  const directory = await fixture(t);
  for (const session of ["session-A", "session-B"]) {
    await handleHook({ hook_event_name: "SessionStart", session_id: session, cwd: directory },
      directory);
  }

  const first = await call(directory, "session-A", "t1", "start", { report: "A loads" });
  const second = await call(directory, "session-B", "t1", "start", { report: "B renders" });
  assert.equal(first.result.data.actor, "codex:session-A");
  assert.equal(second.result.data.actor, "codex:session-B");

  const status = await call(directory, "session-A", "t2", "status");
  assert.equal(status.result.records.length, 2, "both peers are visible");
  assert.deepEqual(
    new Set(status.result.records.map(({ data }) => data.actor)),
    new Set(["codex:session-A", "codex:session-B"]),
  );

  // The failure this replaces: A's write landed under B's actor, and B's next write
  // overwrote it, leaving one record.
  await call(directory, "session-A", "t3", "done", { report: "A finished" });
  const after = await call(directory, "session-B", "t4", "status");
  assert.deepEqual(after.result.records.map(({ data }) => data.actor), ["codex:session-B"],
    "closing one session's work must not close a peer's");
});

test("a work attestation cannot be replayed or reused as continuity", async (t) => {
  const directory = await fixture(t);
  await handleHook({ hook_event_name: "SessionStart", session_id: "s", cwd: directory },
    directory);
  const tool = "lodestar__lodestar_work_start";
  const attested = await handleHook({
    hook_event_name: "PreToolUse", session_id: "s", turn_id: "t1", tool_use_id: "u1",
    cwd: directory, tool_name: tool, tool_input: { report: "once" },
  }, directory);
  const token = attested.hookSpecificOutput.updatedInput;

  await executeWork(tool, token, directory);
  await assert.rejects(() => executeWork(tool, token, directory), /attestation/u,
    "one token, one use");
  await assert.rejects(
    () => executeHandoff("lodestar__lodestar_handoff_now", token, directory),
    /attestation/u,
    "a work token must never authorize a baton",
  );
});

test("secret material is redacted without corrupting the surrounding text", async (t) => {
  const directory = await fixture(t);
  await handleHook({ hook_event_name: "SessionStart", session_id: "s", cwd: directory },
    directory);

  const cases = [
    // A pattern with no capture group passes the match offset as the second replacer
    // argument. Treating that number as a prefix wrote it into the output as
    // `9[REDACTED]`, silently corrupting every redacted key.
    ["key is ghp_aaaaaaaaaaaaaaaaaaaaaa here", "key is [REDACTED] here"],
    ["key is sk-proj-abcdefghijklmno here", "key is [REDACTED] here"],
    // A pattern that does capture keeps its prefix, so the assignment stays readable.
    ["API_KEY=supersecretvalue", "API_KEY=[REDACTED]"],
    ["ordinary work on the loader", "ordinary work on the loader"],
  ];
  for (const [index, [report, expected]] of cases.entries()) {
    const result = await call(directory, "s", `t${index}`, "start", { report });
    assert.equal(result.result.data.current_work, expected);
  }
});

test("a tool is recognized however the host namespaces it", async (t) => {
  const directory = await fixture(t);
  const { canonicalToolName, workToolCommand } = await import(pathToFileURL(
    path.join(PLUGIN_ROOT, "scripts", "lodestar-runtime.mjs")));

  // Hosts present the same tool as lodestar_x, lodestar__lodestar_x, or lodestar/x.
  // Binding an attestation to the exact spelling the hook happened to see made the
  // token valid only for that spelling, and the mismatch surfaced as
  // "Invalid, expired, mismatched, or replayed host attestation" — an error that says
  // nothing about naming, which is how a working plugin looks broken.
  for (const form of ["lodestar_work_start", "lodestar__lodestar_work_start",
    "lodestar/lodestar_work_start"]) {
    assert.equal(workToolCommand(form), "start", form);
    assert.equal(canonicalToolName(form), "lodestar_work_start", form);
  }
  for (const form of ["lodestar_handoff_status", "lodestar__lodestar_handoff_status",
    "lodestar/lodestar_handoff_status"]) {
    assert.equal(canonicalToolName(form), "lodestar_handoff_status", form);
  }
  // A near miss is still a miss.
  for (const form of ["notlodestar_work_start", "lodestar_work_bogus", "work_start"]) {
    assert.equal(workToolCommand(form), null, form);
  }

  // And the attestation survives a namespace change between hook and execution.
  const attested = await handleHook({
    hook_event_name: "PreToolUse", session_id: "s", turn_id: "t1", tool_use_id: "u1",
    cwd: directory, tool_name: "lodestar/lodestar_work_start",
    tool_input: { report: "namespaced" },
  }, directory);
  assert.equal(attested.hookSpecificOutput.permissionDecision, "allow");
  const result = await executeWork("lodestar__lodestar_work_start",
    attested.hookSpecificOutput.updatedInput, directory);
  assert.equal(result.result.data.current_work, "namespaced");
});

test("reading the baton needs no spoken phrase, writing it still does", async (t) => {
  const directory = await fixture(t);
  const ask = async (tool, index) => (await handleHook({
    hook_event_name: "PreToolUse", session_id: "resumed", turn_id: "t1",
    tool_use_id: `u${index}`, cwd: directory,
    tool_name: `lodestar__${tool}`, tool_input: {},
  }, directory)).hookSpecificOutput;

  // Checking continuity is the first thing an agent does when resuming, and a resumed
  // session has no phrase to point at. Gating the read denied that opening move and sent
  // the agent hunting through the plugin source for the reason.
  const status = await ask("lodestar_handoff_status", 0);
  assert.equal(status.permissionDecision, "allow");
  assert.match(status.updatedInput._attestation, /^[a-f0-9]{64}$/u,
    "a read is still bound to this session, turn and cwd");

  // Everything that writes a lane keeps the exact-phrase requirement.
  for (const [index, tool] of ["lodestar_handoff_now", "lodestar_handoff_arm",
    "lodestar_handoff_checkpoint", "lodestar_handoff_disarm"].entries()) {
    const denied = await ask(tool, index + 1);
    assert.equal(denied.permissionDecision, "deny", tool);
  }
});
