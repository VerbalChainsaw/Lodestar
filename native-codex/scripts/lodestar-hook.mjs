#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizePrompt, attestTool, captureNotes, recordTail, startupContext,
  checkpointForCompaction, compactRecoveryContext,
} from "./lodestar-runtime.mjs";
import { resolvePluginData } from "./lodestar-mcp.mjs";
import { assertJsonValue, readHookJson } from "./lodestar-json.mjs";

const script = fileURLToPath(import.meta.url);
const captureResult = (errors) => ({ continue: true, ...(errors.length ? {
  captureErrors: errors, systemMessage: `Lodestar optional capture failed: ${errors.join("; ")}` } : {}) });
async function optionalCapture(run, label, errors) {
  try { await run(); } catch (error) { errors.push(`${label}: ${error.message}`); }
}
export async function handleHook(input, dataDir, options = {}) {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid hook input");
    assertJsonValue(input);
  }
  catch { return { continue: false, stopReason: "lodestar_invalid_input",
    systemMessage: "Lodestar hook input contains unsupported JSON values." }; }
  if (input.hook_event_name === "PreCompact") {
    try {
      const result = await checkpointForCompaction(input, dataDir, options);
      return { continue: true, ...(result.bound ? { systemMessage:
        `Lodestar compaction checkpoint ${result.changed ? "saved" : "unchanged"}: ${result.handoff_id} revision ${result.revision}.` } : {}) };
    } catch (error) { return { continue: false, stopReason: "lodestar_checkpoint_failed",
      systemMessage: `Lodestar compaction checkpoint failed: ${error.message}` }; }
  }
  if (input.hook_event_name === "SessionStart" && input.source === "compact") {
    try {
      const additionalContext = await compactRecoveryContext(input, dataDir, options);
      if (additionalContext !== null) return { continue: true,
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
    } catch (error) { return { continue: false, stopReason: "lodestar_compact_recovery_failed",
      systemMessage: `Lodestar compact recovery failed: ${error.message}` }; }
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    const authorization = await authorizePrompt(input, dataDir);
    if (authorization) return { continue: true, hookSpecificOutput: {
      hookEventName: "UserPromptSubmit", additionalContext: authorization.additionalContext } };
    const errors = [];
    await optionalCapture(() => recordTail(input, "user", input.prompt, { dataDir }), "user tail", errors);
    return captureResult(errors);
  }
  if (input.hook_event_name === "PreToolUse") {
    const result = await attestTool(input, dataDir);
    if (!result.matched) return { continue: true };
    return { hookSpecificOutput: { hookEventName: "PreToolUse",
      permissionDecision: result.allowed ? "allow" : "deny",
      ...(result.allowed ? { updatedInput: result.updatedInput }
        : { permissionDecisionReason: result.reason }) } };
  }
  if (input.hook_event_name === "SessionStart") return { continue: true,
    hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: await startupContext(input) } };
  if (input.hook_event_name === "Stop") {
    const message = input.last_assistant_message ?? "";
    const errors = [];
    await optionalCapture(() => recordTail(input, "assistant", message, { dataDir }), "assistant tail", errors);
    await optionalCapture(() => captureNotes(input, message, { dataDir }), "pending notes", errors);
    return captureResult(errors);
  }
  return { continue: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let input, inputReady = false;
  try { input = await readHookJson(process.stdin); inputReady = true; }
  catch (error) {
    process.stdout.write(JSON.stringify({ continue: false, stopReason: "lodestar_invalid_input",
      systemMessage: `Lodestar hook input rejected: ${error.message}` }));
  }
  if (inputReady) process.stdout.write(JSON.stringify(await handleHook(input, resolvePluginData())));
}
