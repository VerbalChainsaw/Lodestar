#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_MAXIMUM_BYTES, parseNativeJson } from "./lodestar-json.mjs";

import {
  executeHandoff, executeWork, HANDOFF_COMMANDS, HANDOFF_PACKET_SCHEMA,
  WORK_COMMANDS, workToolCommand,
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

const tools = HANDOFF_COMMANDS.map((command) => ({
  name: `lodestar_handoff_${command}`,
  description: `${command[0].toUpperCase()}${command.slice(1)} the exact host-authorized `
    + "Lodestar continuity state for this project and session.",
  inputSchema: ["arm", "checkpoint", "now"].includes(command)
    ? { type: "object", additionalProperties: false, required: ["packet"],
      properties: { packet: HANDOFF_PACKET_SCHEMA } }
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
      properties: { ...(command === "done" ? { outcome: { type: "string", enum: ["completed", "verified"] }, evidence: { type: "array", items: {} } } : {}), report: { type: "string",
        description: "One line describing the work area." } } },
})));

function reply(id, result, error, code = -32000) {
  const message = error ? { jsonrpc: "2.0", id,
    error: { code, message: error instanceof Error ? error.message : String(error) } }
    : { jsonrpc: "2.0", id, result };
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (failure) => {
      if (failure) { failure.mcpOutput = true; reject(failure); }
      else resolve();
    });
  });
}

function requestId(value) {
  return value === null || typeof value === "string"
    || typeof value === "number" && Number.isFinite(value);
}

// Native framing stays independent of core selection so ping and tools/list
// remain available before a core runtime can be selected.
export async function* messageFrames(stream) {
  let parts = [], length = 0, overflow = false;
  const append = (tail) => {
    if (overflow || !tail.length) return null;
    length += tail.length;
    if (length > JSON_MAXIMUM_BYTES) {
      overflow = true;
      parts = [];
      return new Error("MCP message exceeds 16 MiB; no tool was dispatched. Resend a smaller complete request.");
    }
    // Do not retain a large input chunk through a small admitted slice.
    parts.push(Buffer.from(tail));
    return null;
  };
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0, newline;
    while ((newline = bytes.indexOf(0x0a, start)) !== -1) {
      const error = append(bytes.subarray(start, newline));
      if (error) yield { error };
      if (!overflow) {
        let frame = Buffer.concat(parts, length);
        if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
        if (frame.length) yield { bytes: frame };
      }
      parts = [];
      length = 0;
      overflow = false;
      start = newline + 1;
    }
    const error = append(bytes.subarray(start));
    if (error) yield { error };
  }
  if (!overflow && length) yield { bytes: Buffer.concat(parts, length) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolvePluginData();
  let outputFailure = false;
  // A failed write also emits a stream error after rejecting its callback.
  process.stdout.on("error", () => { outputFailure = true; });
  try {
    for await (const frame of messageFrames(process.stdin)) {
      if (frame.error) { await reply(null, null, frame.error); continue; }
      let message;
      let line;
      try { line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(frame.bytes); }
      catch { await reply(null, null, new Error("Invalid UTF-8"), -32700); continue; }
      try { message = parseNativeJson(line); }
      catch { await reply(null, null, new Error("Parse error"), -32700); continue; }
      if (message === null || typeof message !== "object" || Array.isArray(message)
          || message.jsonrpc !== "2.0" || typeof message.method !== "string"
          || message.id !== undefined && !requestId(message.id)
          || message.params !== undefined && (message.params === null || typeof message.params !== "object")) {
        await reply(requestId(message?.id) ? message.id : null, null,
          new Error("Invalid Request"), -32600);
        continue;
      }
      if (message.id === undefined) continue;
      try {
        if (message.method === "initialize") await reply(message.id, {
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "lodestar", version: pluginVersion() },
        });
        else if (message.method === "ping") await reply(message.id, {});
        else if (message.method === "tools/list") await reply(message.id, { tools });
        else if (message.method === "tools/call"
            && tools.some(({ name }) => name === message.params?.name)) {
          const run = workToolCommand(message.params.name) ? executeWork : executeHandoff;
          const result = await run(
            `lodestar__${message.params.name}`,
            message.params.arguments ?? {},
            dataDir,
          );
          await reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result, isError: false });
        } else await reply(message.id, null, new Error(`Method not found: ${message.method}`), -32601);
      } catch (error) {
        if (outputFailure || error?.mcpOutput) throw error;
        await reply(message.id, null, error);
      }
    }
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code)
      ? error.code : "transport_error";
    const operation = outputFailure || error?.mcpOutput ? "response delivery" : "transport";
    process.exitCode = 1;
    process.stderr.write(`Lodestar MCP ${operation} failed (${code}). Restore the client transport. A completed write may have committed; reconcile its journal and exact original request before retrying.\n`);
    process.stdin.destroy();
  }
}
