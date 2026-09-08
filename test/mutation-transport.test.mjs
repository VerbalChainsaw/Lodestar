import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.mjs";
import { fixture } from "./helpers/contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MCP_SERVER = path.join(ROOT, "codex-plugin", "scripts", "lodestar-mcp.mjs");

async function rawCli(database, text) {
  let stdout = "", stderr = "";
  const code = await runCli(["put", "--db", database], {
    stdin: Readable.from([text]),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr, value: JSON.parse(stdout || stderr) };
}

function createRequest(writeBasis, id, requestId, value) {
  return {
    v: 5,
    request_id: requestId,
    write_basis: writeBasis,
    input: {
      mode: "create",
      record: {
        id,
        kind: "fact",
        name: id,
        scope: "global",
        availability: "known",
        data: { value },
        aliases: [],
        links: [],
        sources: [],
      },
    },
  };
}

test("CLI refuses duplicate contract keys and lossy decimals before persistence", async (t) => {
  const f = await fixture(t);
  const duplicateId = "fact:duplicate-contract";
  const duplicateBasis = (await f.cli(["get", duplicateId])).value.error.identifiers.write_basis;
  const duplicate = JSON.stringify(createRequest(
    duplicateBasis,
    duplicateId,
    "duplicate-contract",
    "kept",
  )).replace('{"v":5,', '{"v":4,"v":5,');
  const duplicateResult = await rawCli(f.database, duplicate);
  assert.equal(duplicateResult.code, 2);
  assert.equal(duplicateResult.value.error.code, "invalid_json");
  assert.equal((await f.cli(["get", duplicateId])).value.error.code, "record_not_found");

  const decimalId = "fact:lossy-decimal";
  const decimalBasis = (await f.cli(["get", decimalId])).value.error.identifiers.write_basis;
  const decimal = JSON.stringify(createRequest(
    decimalBasis,
    decimalId,
    "lossy-decimal",
    "DECIMAL_TOKEN",
  )).replace('"DECIMAL_TOKEN"', "1.0000000000000001");
  const decimalResult = await rawCli(f.database, decimal);
  assert.equal(decimalResult.code, 2);
  assert.equal(decimalResult.value.error.code, "unsupported_numeric_value");
  assert.equal((await f.cli(["get", decimalId])).value.error.code, "record_not_found");
});

test("MCP framing rejects invalid UTF-8, duplicate keys, lossy decimals, and undeclared controls", async (t) => {
  const f = await fixture(t);
  const requests = [];
  for (const [id, requestId, value] of [
    ["fact:mcp-utf8", "mcp-utf8", "INVALID_UTF8"],
    ["fact:mcp-duplicate", "mcp-duplicate", "kept"],
    ["fact:mcp-decimal", "mcp-decimal", "DECIMAL_TOKEN"],
  ]) {
    const basis = (await f.cli(["get", id])).value.error.identifiers.write_basis;
    requests.push(createRequest(basis, id, requestId, value));
  }

  const messages = requests.map((request, index) => JSON.stringify({
    jsonrpc: "2.0",
    id: index + 1,
    method: "tools/call",
    params: {
      name: "lodestar_mutate",
      arguments: { operation: "put", request },
    },
  }));
  messages[1] = messages[1].replace('{"v":5,', '{"v":4,"v":5,');
  messages[2] = messages[2].replace('"DECIMAL_TOKEN"', "1.0000000000000001");
  messages.push(JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    undeclared: true,
    params: { name: "lodestar_describe", arguments: {} },
  }));
  messages.push(JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "lodestar_describe", arguments: { undeclared: true } },
  }));
  messages.push("null");
  messages.push(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "lodestar_describe", arguments: {}, _meta: { progressToken: "client-progress" } } }));

  const invalidIndex = messages[0].indexOf("INVALID_UTF8");
  const invalidUtf8 = Buffer.concat([
    Buffer.from(messages[0].slice(0, invalidIndex)),
    Buffer.from([0xff]),
    Buffer.from(`${messages[0].slice(invalidIndex + "INVALID_UTF8".length)}\n`),
  ]);
  const input = Buffer.concat([
    invalidUtf8,
    ...messages.slice(1).map((message) => Buffer.from(`${message}\n`)),
  ]);

  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: f.root,
    env: {
      ...process.env,
      LODESTAR_NODE: process.execPath,
      LODESTAR_ENTRY: path.join(ROOT, "lodestar.mjs"),
      LODESTAR_DB: f.database,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(input);
  assert.equal(await completed, 0);
  assert.equal(stderr, "");

  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies.length, 7);
  assert.deepEqual(replies.map((reply) => reply.id), [null, null, null, 4, 5, null, 6]);
  const diagnostics = [
    /mcp_message is not valid UTF-8/u,
    /duplicate member names/u,
    /outside the supported numeric domain/u,
    /MCP message contains undeclared fields: undeclared/u,
    /lodestar_describe input contains undeclared fields: undeclared/u,
    /MCP message must be a JSON object/u,
  ];
  for (const [index, expected] of diagnostics.entries()) {
    assert.match(replies[index].error?.message ?? "", expected,
      `malformed frame ${index} must explain its actual refusal`);
  }
  assert.equal(replies[6].result.structuredContent.contract, 5);
  for (const id of ["fact:mcp-utf8", "fact:mcp-duplicate", "fact:mcp-decimal"]) {
    assert.equal((await f.cli(["get", id])).value.error.code, "record_not_found");
  }
});
