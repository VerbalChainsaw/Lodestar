#!/usr/bin/env node
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_BOOTSTRAP } from "../../src/bootstrap.mjs";
import { COMMANDS, capabilityOperations, MUTATION_INPUTS, READ_OPERATIONS } from "../../src/cli-commands.mjs";
import { lodestarError } from "../../src/errors.mjs";
import { decodeUtf8, JSON_INPUT_MAXIMUM_BYTES, parseJsonText } from "../../src/json.mjs";
import { MUTATION_REQUEST_SCHEMA, PUT_INPUT_SCHEMA, DELETE_INPUT_SCHEMA } from "../../src/records.mjs";
import { CONTRACT_VERSION } from "../../src/schema.mjs";
import {
  mutationCommand, packageVersion, runInstalledLodestar,
} from "./lodestar-runtime.mjs";

const READ_COMMANDS = READ_OPERATIONS;
const MUTATION_OPERATIONS = Object.freeze({
  put: PUT_INPUT_SCHEMA,
  delete: DELETE_INPUT_SCHEMA,
  ...MUTATION_INPUTS,
});

for (const command of Object.values(READ_COMMANDS)) {
  if (!Object.hasOwn(COMMANDS, command[0])) throw new Error(`Unknown shared command: ${command[0]}`);
}

function requestSchema(inputSchema) {
  return {
    ...MUTATION_REQUEST_SCHEMA,
    properties: { ...MUTATION_REQUEST_SCHEMA.properties, input: inputSchema },
  };
}

export const NATIVE_TOOLS = Object.freeze([
  {
    name: "lodestar_describe",
    description: "Return versioned operation descriptors, complete CLI inputs, safe form bindings, and structured mutation inputs.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "lodestar_read",
    description: "Run one current read-only Lodestar command through the installed one-shot package.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["operation"],
      properties: {
        operation: { type: "string", enum: Object.keys(READ_COMMANDS) },
        arguments: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "lodestar_mutate",
    description: "Apply one guarded contract-5 update using a read result's write_basis. Retry a lost response with the exact same request.",
    inputSchema: {
      type: "object",
      oneOf: Object.entries(MUTATION_OPERATIONS).map(([operation, schema]) => ({
        type: "object", additionalProperties: false, required: ["operation", "request"],
        properties: {
          operation: { const: operation },
          request: requestSchema(schema),
        },
      })),
    },
  },
]);

function reply(id, result, error) {
  const message = error
    ? { jsonrpc: "2.0", id, error: { code: -32000,
      message: error instanceof Error ? error.message : String(error),
      ...(error?.envelope ? { data: error.envelope } : error?.code ? { data: {
        code: error.code, action: error.action, identifiers: error.identifiers } } : {}) } }
    : { jsonrpc: "2.0", id, result };
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (failure) => {
      if (failure) { failure.mcpOutput = true; reject(failure); }
      else resolve();
    });
  });
}

function replyToolResult(id, value, isError = false) {
  return reply(id, { content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value, isError });
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactFields(value, allowed, resource) {
  if (!plainObject(value)) throw new Error(`${resource} must be a JSON object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${resource} contains undeclared fields: ${unknown.sort().join(", ")}.`);
}

function validateToolInput(name, input) {
  if (name === "lodestar_describe") {
    exactFields(input, [], "lodestar_describe input");
    return;
  }
  if (name === "lodestar_read") {
    exactFields(input, ["operation", "arguments"], "lodestar_read input");
    if (typeof input.operation !== "string") throw new Error("lodestar_read requires an operation.");
    if (input.arguments !== undefined
      && (!Array.isArray(input.arguments) || input.arguments.some((value) => typeof value !== "string"))) {
      throw new Error("lodestar_read arguments must be an array of strings.");
    }
    return;
  }
  if (name === "lodestar_mutate") {
    exactFields(input, ["operation", "request"], "lodestar_mutate input");
    if (typeof input.operation !== "string" || !Object.hasOwn(input, "request")) {
      throw new Error("lodestar_mutate requires operation and request.");
    }
  }
}

function validateMessage(message) {
  exactFields(message, ["jsonrpc", "id", "method", "params"], "MCP message");
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    throw new Error("MCP messages require jsonrpc 2.0 and a method.");
  }
  if (Object.hasOwn(message, "id") && typeof message.id !== "string" && typeof message.id !== "number") {
    throw new Error("MCP request IDs must be strings or numbers.");
  }
  if (message.params !== undefined && !plainObject(message.params)) {
    throw new Error("MCP params must be a JSON object.");
  }
  if (message.method === "tools/call") {
    // _meta is standard MCP request metadata (including progressToken), not a
    // Lodestar mutation control. Accept it without treating it as actor authority.
    exactFields(message.params, ["name", "arguments", "_meta"], "tools/call params");
    if (message.params._meta !== undefined && !plainObject(message.params._meta)) {
      throw new Error("MCP request metadata must be a JSON object.");
    }
    if (typeof message.params.name !== "string") throw new Error("tools/call requires a tool name.");
    if (message.params.arguments !== undefined && !plainObject(message.params.arguments)) {
      throw new Error("tools/call arguments must be a JSON object.");
    }
  }
}

async function* messageFrames(stream) {
  let parts = [], length = 0, overflow = false;
  const append = (tail) => {
    if (overflow || !tail.length) return null;
    length += tail.length;
    if (length > JSON_INPUT_MAXIMUM_BYTES) {
      overflow = true; parts = [];
      return lodestarError("resource_limit", "MCP message exceeds the supported UTF-8 byte limit; no tool was dispatched.", {
        identifiers: { resource: "mcp_message", bytes: length, maximum: JSON_INPUT_MAXIMUM_BYTES },
        action: "Reduce the message to 16 MiB or less, including metadata. The rejected frame is discarded through its newline; resend a complete smaller request.",
      });
    }
    // Copy only admitted bytes, so a small tail cannot retain a large input chunk.
    parts.push(Buffer.from(tail));
    return null;
  };
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0, newline;
    while ((newline = bytes.indexOf(0x0a, start)) !== -1) {
      const tail = bytes.subarray(start, newline);
      const error = append(tail);
      if (error) yield { error };
      if (!overflow) {
        let frame = Buffer.concat(parts, length);
        if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
        if (frame.length) yield { bytes: frame };
      }
      parts = []; length = 0; overflow = false;
      start = newline + 1;
    }
    const tail = bytes.subarray(start);
    const error = append(tail);
    if (error) yield { error };
  }
  if (!overflow && length) yield { bytes: Buffer.concat(parts, length) };
}

export async function callNativeTool(name, input = {}) {
  validateToolInput(name, input);
  if (name === "lodestar_describe") return {
    contract: CONTRACT_VERSION,
    package_version: packageVersion(),
    capability_version: 1,
    operations: capabilityOperations({ put: PUT_INPUT_SCHEMA, delete: DELETE_INPUT_SCHEMA,
      mutationRequest: MUTATION_REQUEST_SCHEMA }),
    commands: COMMANDS,
    mutation_inputs: MUTATION_OPERATIONS,
    mutation_request: MUTATION_REQUEST_SCHEMA,
    read_operations: READ_OPERATIONS,
    operating_guide: AGENT_BOOTSTRAP,
  };
  if (name === "lodestar_read") {
    const command = READ_COMMANDS[input.operation];
    if (!command) throw new Error(`Unknown read operation: ${input.operation}`);
    return await runInstalledLodestar([...command, ...(input.arguments ?? [])], { operation: input.operation, effect: "read" });
  }
  if (name === "lodestar_mutate") {
    if (!Object.hasOwn(MUTATION_OPERATIONS, input.operation)) {
      throw new Error(`Unknown mutation operation: ${input.operation}`);
    }
    return await runInstalledLodestar(mutationCommand(input.operation, input.request), {
      input: `${JSON.stringify(input.request)}\n`,
      operation: input.operation, effect: ["put", "delete"].includes(input.operation) ? "record_write" : "domain_write",
      requestId: input.request?.request_id,
    });
  }
  throw new Error(`Unknown native tool: ${name}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The write callback rejects the awaited response; retain an error listener
  // until the process ends so its subsequent stream event cannot crash the host.
  let outputFailure = false;
  process.stdout.on("error", () => { outputFailure = true; });
  try {
    for await (const frame of messageFrames(process.stdin)) {
      if (frame.error) { await reply(null, null, frame.error); continue; }
      let message;
      try {
        message = parseJsonText(decodeUtf8(frame.bytes, { resource: "mcp_message" }), {
          resource: "mcp_message", maximum: JSON_INPUT_MAXIMUM_BYTES,
        });
      } catch (error) {
        await reply(null, null, error);
        continue;
      }
      try {
        validateMessage(message);
        if (message.id === undefined) continue;
        if (message.method === "initialize") await reply(message.id, {
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "lodestar", version: packageVersion() },
        });
        else if (message.method === "ping") await reply(message.id, {});
        else if (message.method === "tools/list") await reply(message.id, { tools: NATIVE_TOOLS });
        else if (message.method === "tools/call") {
          const result = await callNativeTool(message.params?.name, message.params?.arguments ?? {});
          await replyToolResult(message.id, result);
        } else await reply(message.id, null, new Error(`Method not found: ${message.method}`));
      } catch (error) {
        const id = typeof message?.id === "string" || typeof message?.id === "number" ? message.id : null;
        // A valid tool invocation that fails in the core is an execution error.
        // Keep its correction basis and next actions in model-visible tool content.
        if (message?.method === "tools/call" && (error?.toolResult || error?.envelope)) await replyToolResult(id, error.toolResult ?? error.envelope, true);
        else await reply(id, null, error);
      }
    }
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? error.code : "transport_error";
    const operation = outputFailure || error?.mcpOutput ? "response delivery" : "transport";
    process.exitCode = 1;
    process.stderr.write(`Lodestar MCP ${operation} failed (${code}). Restore the client transport. A completed write may have committed; preserve the original request, reconcile its receipt and current records, then use exact replay.\n`);
    process.stdin.destroy();
  }
}
