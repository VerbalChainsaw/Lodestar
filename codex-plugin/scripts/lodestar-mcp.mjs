#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { executeHandoff } from "./lodestar-runtime.mjs";

export function resolvePluginData(pluginData = process.env.PLUGIN_DATA, scriptUrl = import.meta.url) {
  if (pluginData) return pluginData;
  const file = fileURLToPath(scriptUrl), scripts = path.dirname(file), version = path.dirname(scripts);
  const plugin = path.dirname(version), marketplace = path.dirname(plugin), cache = path.dirname(marketplace);
  return path.join(path.dirname(cache), "data", `${path.basename(plugin)}-${path.basename(marketplace)}`);
}
const tool = { name: "handoff_now",
  description: "Save the exact host-authorized, validated Lodestar handoff for the next session.",
  inputSchema: { type: "object", additionalProperties: false, required: ["packet"],
    properties: { packet: { type: "object", additionalProperties: true } } } };
function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id,
    error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }
    : { jsonrpc: "2.0", id, result })}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolvePluginData();
  for await (const line of createInterface({ input: process.stdin })) {
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    try {
      if (message.method === "initialize") reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} }, serverInfo: { name: "lodestar", version: "1.1.0" } });
      else if (message.method === "ping") reply(message.id, {});
      else if (message.method === "tools/list") reply(message.id, { tools: [tool] });
      else if (message.method === "tools/call" && message.params?.name === tool.name) {
        const result = await executeHandoff(message.params.name,
          message.params.arguments ?? {}, dataDir);
        reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result, isError: false });
      } else reply(message.id, null, new Error(`Method not found: ${message.method}`));
    } catch (error) { reply(message.id, null, error); }
  }
}
