#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  executeHandoff, executeWork, HANDOFF_COMMANDS, WORK_COMMANDS, workToolCommand,
} from "./lodestar-runtime.mjs";

// Read from the manifest beside this script rather than a literal. A hardcoded version
// reports whatever was true when it was typed, so an installed build silently claims to
// be a release it is not.
function pluginVersion(scriptUrl = import.meta.url) {
  try {
    const manifest = path.join(path.dirname(path.dirname(fileURLToPath(scriptUrl))),
      ".codex-plugin", "plugin.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function resolvePluginData(
  pluginData = process.env.PLUGIN_DATA,
  scriptUrl = import.meta.url,
) {
  if (pluginData) return pluginData;
  const file = fileURLToPath(scriptUrl), scripts = path.dirname(file);
  const version = path.dirname(scripts), plugin = path.dirname(version);
  const marketplace = path.dirname(plugin), cache = path.dirname(marketplace);
  return path.join(path.dirname(cache), "data",
    `${path.basename(plugin)}-${path.basename(marketplace)}`);
}

const packet = { type: "object", additionalProperties: true };
const tools = HANDOFF_COMMANDS.map((command) => ({
  name: `lodestar_handoff_${command}`,
  description: `${command[0].toUpperCase()}${command.slice(1)} the exact host-authorized `
    + "Lodestar continuity state for this project and session.",
  inputSchema: ["arm", "checkpoint", "now"].includes(command)
    ? { type: "object", additionalProperties: false, required: ["packet"],
      properties: { packet } }
    : { type: "object", additionalProperties: false, properties: {} },
}));

// Exposed as tools rather than left to the shell so each call carries the host
// session. A shell has no session id, so a CLI fallback can only guess, and a wrong
// guess overwrites a concurrent peer's marker.
tools.push(...WORK_COMMANDS.map((command) => ({
  name: `lodestar_work_${command}`,
  description: command === "status"
    ? "List advisory work reports for this project."
    : `Mark this session's advisory work as ${command} for this project.`,
  inputSchema: command === "status"
    ? { type: "object", additionalProperties: false, properties: {} }
    : { type: "object", additionalProperties: false,
      ...(command === "start" ? { required: ["report"] } : {}),
      properties: { report: { type: "string",
        description: "One line describing the work area." } } },
})));

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id,
    error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }
    : { jsonrpc: "2.0", id, result })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolvePluginData();
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    try {
      if (message.method === "initialize") reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "lodestar", version: pluginVersion() },
      });
      else if (message.method === "ping") reply(message.id, {});
      else if (message.method === "tools/list") reply(message.id, { tools });
      else if (message.method === "tools/call"
          && tools.some(({ name }) => name === message.params?.name)) {
        const run = workToolCommand(message.params.name) ? executeWork : executeHandoff;
        const result = await run(
          `lodestar__${message.params.name}`,
          message.params.arguments ?? {},
          dataDir,
        );
        reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result, isError: false });
      } else reply(message.id, null, new Error(`Method not found: ${message.method}`));
    } catch (error) { reply(message.id, null, error); }
  }
}
