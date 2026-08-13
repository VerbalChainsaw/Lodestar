import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleHook } from "../codex-plugin/scripts/lodestar-hook.mjs";
import { executeHandoff } from "../codex-plugin/scripts/lodestar-runtime.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  work: { items: [], files: [], symbols: [], commands: [], errors: [], urls: [], ids: [], tests: [] },
  nextMove: "Run the next focused verification",
  evidence: ["Disposable plugin-chain test"],
};

test("the Lodestar plugin starts, authorizes, redacts, saves, and claims one baton", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-plugin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prior = {
    LODESTAR_DB: process.env.LODESTAR_DB,
    LODESTAR_NODE: process.env.LODESTAR_NODE,
    LODESTAR_ENTRY: process.env.LODESTAR_ENTRY,
  };
  process.env.LODESTAR_DB = path.join(directory, "lodestar.db");
  process.env.LODESTAR_NODE = process.execPath;
  process.env.LODESTAR_ENTRY = path.join(ROOT, "lodestar.mjs");
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

  const authorization = await handleHook({
    hook_event_name: "UserPromptSubmit", session_id: "source", turn_id: "turn-1",
    cwd: directory, prompt: "handoff now",
  }, directory);
  assert.match(authorization.hookSpecificOutput.additionalContext, /handoff_now/u);
  const attested = await handleHook({
    hook_event_name: "PreToolUse", session_id: "source", turn_id: "turn-1",
    tool_use_id: "tool-1", cwd: directory, tool_name: "lodestar__handoff_now",
    tool_input: { packet },
  }, directory);
  assert.equal(attested.hookSpecificOutput.permissionDecision, "allow");
  const saved = await executeHandoff("lodestar__handoff_now",
    attested.hookSpecificOutput.updatedInput, directory);
  assert.equal(saved.record.kind, "handoff");
  assert.equal(saved.record.data.packet.integrity.redaction.count, 1);
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
