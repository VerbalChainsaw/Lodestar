#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizePrompt, attestTool, captureNotes, recordTail, startupContext,
} from "./lodestar-runtime.mjs";
import { resolvePluginData } from "./lodestar-mcp.mjs";

const script = fileURLToPath(import.meta.url);
export async function handleHook(input, dataDir) {
  if (input.hook_event_name === "UserPromptSubmit") {
    let authorization = null;
    try {
      authorization = await authorizePrompt(input, dataDir);
    } catch {
      // Fail soft: a host that does not provide every identity field must not
      // take the session with it. The baton is simply not granted.
    }
    if (authorization) return { continue: true, hookSpecificOutput: {
      hookEventName: "UserPromptSubmit", additionalContext: authorization.additionalContext } };
    await recordTail(input, "user", input.prompt);
    return { continue: true };
  }
  if (input.hook_event_name === "PreToolUse") {
    const result = await attestTool(input, dataDir);
    if (!result.matched) return { continue: true };
    return { hookSpecificOutput: { hookEventName: "PreToolUse",
      permissionDecision: result.allowed ? "allow" : "deny",
      ...(result.allowed ? { updatedInput: result.updatedInput }
        : { permissionDecisionReason: result.reason }) } };
  }
  if (input.hook_event_name === "SessionStart") {
    let additionalContext;
    try {
      additionalContext = await startupContext(input);
    } catch (error) {
      // Fail soft like every other hook path: a missing or broken Lodestar
      // runtime must not block the host session from starting.
      additionalContext = "Lodestar unavailable: startup context could not be "
        + `loaded (${error?.message ?? "unknown error"}). The session can `
        + "continue; run `lodestar doctor` to diagnose.";
    }
    return { continue: true,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
  }
  if (input.hook_event_name === "Stop") {
    const message = input.last_assistant_message ?? "";
    await recordTail(input, "assistant", message);
    await captureNotes(input, message);
    return { continue: true };
  }
  return { continue: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let text = ""; for await (const chunk of process.stdin) text += chunk;
  const payload = text.replace(/^\uFEFF/u, "").trim();
  const input = payload ? JSON.parse(payload) : {};
  process.stdout.write(JSON.stringify(await handleHook(input, resolvePluginData())));
}
