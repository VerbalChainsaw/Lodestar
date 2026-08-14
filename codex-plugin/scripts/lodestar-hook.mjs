#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizePrompt, attestTool, recordTail, startupContext,
} from "./lodestar-runtime.mjs";
import { resolvePluginData } from "./lodestar-mcp.mjs";

const script = fileURLToPath(import.meta.url);
export async function handleHook(input, dataDir) {
  if (input.hook_event_name === "UserPromptSubmit") {
    const authorization = await authorizePrompt(input, dataDir);
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
  if (input.hook_event_name === "SessionStart") return { continue: true,
    hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: await startupContext(input) } };
  if (input.hook_event_name === "Stop") {
    await recordTail(input, "assistant", input.last_assistant_message ?? "");
    return { continue: true };
  }
  return { continue: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let text = ""; for await (const chunk of process.stdin) text += chunk;
  const input = text.trim() ? JSON.parse(text) : {};
  process.stdout.write(JSON.stringify(await handleHook(input, resolvePluginData())));
}
