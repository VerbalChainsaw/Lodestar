#!/usr/bin/env node
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_BOOTSTRAP } from "../../src/bootstrap.mjs";
import { COMMANDS, MUTATION_INPUTS, READ_OPERATIONS } from "../../src/cli-commands.mjs";
import { decodeUtf8, parseJsonText } from "../../src/json.mjs";
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
    description: "Return the installed Lodestar contract, command declarations, and structured mutation inputs.",
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
      ...(error?.envelope ? { data: error.envelope } : {}) } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replyToolResult(id, value, isError = false) {
  reply(id, { content: [{ type: "text", text: JSON.stringify(value) }],
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
  let parts = [], length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0, newline;
    while ((newline = bytes.indexOf(0x0a, start)) !== -1) {
      const tail = bytes.subarray(start, newline);
      if (tail.length) { parts.push(tail); length += tail.length; }
      let frame = Buffer.concat(parts, length);
      parts = []; length = 0;
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length) yield frame;
      start = newline + 1;
    }
    const tail = bytes.subarray(start);
    if (tail.length) { parts.push(tail); length += tail.length; }
  }
  if (length) yield Buffer.concat(parts, length);
}

export async function callNativeTool(name, input = {}) {
  validateToolInput(name, input);
  if (name === "lodestar_describe") return {
    contract: CONTRACT_VERSION,
    package_version: packageVersion(),
    commands: COMMANDS,
    mutation_inputs: MUTATION_OPERATIONS,
    mutation_request: MUTATION_REQUEST_SCHEMA,
    read_operations: READ_OPERATIONS,
    operating_guide: AGENT_BOOTSTRAP,
  };
  if (name === "lodestar_read") {
    const command = READ_COMMANDS[input.operation];
    if (!command) throw new Error(`Unknown read operation: ${input.operation}`);
    return await runInstalledLodestar([...command, ...(input.arguments ?? [])]);
  }
  if (name === "lodestar_mutate") {
    if (!Object.hasOwn(MUTATION_OPERATIONS, input.operation)) {
      throw new Error(`Unknown mutation operation: ${input.operation}`);
    }
    return await runInstalledLodestar(mutationCommand(input.operation, input.request), {
      input: `${JSON.stringify(input.request)}\n`,
    });
  }
  throw new Error(`Unknown native tool: ${name}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for await (const frame of messageFrames(process.stdin)) {
    let message;
    try {
      message = parseJsonText(decodeUtf8(frame, { resource: "mcp_message" }), {
        resource: "mcp_message",
      });
    } catch (error) {
      reply(null, null, error);
      continue;
    }
    try {
      validateMessage(message);
      if (message.id === undefined) continue;
      if (message.method === "initialize") reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "lodestar", version: packageVersion() },
      });
      else if (message.method === "ping") reply(message.id, {});
      else if (message.method === "tools/list") reply(message.id, { tools: NATIVE_TOOLS });
      else if (message.method === "tools/call") {
        const result = await callNativeTool(message.params?.name, message.params?.arguments ?? {});
        replyToolResult(message.id, result);
      } else reply(message.id, null, new Error(`Method not found: ${message.method}`));
    } catch (error) {
      const id = typeof message?.id === "string" || typeof message?.id === "number" ? message.id : null;
      // A valid tool invocation that fails in the core is an execution error.
      // Keep its correction basis and next actions in model-visible tool content.
      if (message?.method === "tools/call" && error?.envelope) replyToolResult(id, error.envelope, true);
      else reply(id, null, error);
    }
  }
}
