#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { COMMANDS, MUTATION_INPUTS } from "../../src/cli-commands.mjs";
import { MUTATION_REQUEST_SCHEMA } from "../../src/records.mjs";
import { CONTRACT_VERSION } from "../../src/schema.mjs";
import {
  mutationCommand, packageVersion, runInstalledLodestar,
} from "./lodestar-runtime.mjs";

const READ_COMMANDS = Object.freeze({
  start: ["start"], get: ["get"], find: ["find"], links: ["links"],
  doctor: ["doctor"], export: ["export"],
  "work.status": ["work", "status"], "work.history": ["work", "history"],
  "handoff.status": ["handoff", "status"], "handoff.history": ["handoff", "history"],
  "decision.show": ["decision", "show"], "decision.status": ["decision", "status"],
  "pending.list": ["pending", "list"],
  "skills.verify": ["skills", "verify"], "agents.status": ["agents", "status"],
  "agents.verify": ["agents", "verify"], "agents.template": ["agents", "template"],
});
const MUTATION_OPERATIONS = Object.freeze({
  put: MUTATION_REQUEST_SCHEMA.properties.input,
  delete: MUTATION_REQUEST_SCHEMA.properties.input,
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

export async function callNativeTool(name, input = {}) {
  if (name === "lodestar_describe") return {
    contract: CONTRACT_VERSION,
    package_version: packageVersion(),
    commands: COMMANDS,
    mutation_inputs: MUTATION_OPERATIONS,
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
    return await runInstalledLodestar(mutationCommand(input.operation), {
      input: `${JSON.stringify(input.request)}\n`,
    });
  }
  throw new Error(`Unknown native tool: ${name}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    try {
      if (message.method === "initialize") reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "lodestar", version: packageVersion() },
      });
      else if (message.method === "ping") reply(message.id, {});
      else if (message.method === "tools/list") reply(message.id, { tools: NATIVE_TOOLS });
      else if (message.method === "tools/call") {
        const result = await callNativeTool(message.params?.name, message.params?.arguments ?? {});
        reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result, isError: false });
      } else reply(message.id, null, new Error(`Method not found: ${message.method}`));
    } catch (error) { reply(message.id, null, error); }
  }
}
