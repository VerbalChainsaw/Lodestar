import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import vm from "node:vm";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInstalledLodestar } from "../codex-plugin/scripts/lodestar-runtime.mjs";
import { canonicalStringify, JSON_INPUT_MAXIMUM_BYTES } from "../src/json.mjs";
import { fixture, temporaryDirectory } from "./helpers/contract.mjs";

const mcp = fileURLToPath(new URL("../codex-plugin/scripts/lodestar-mcp.mjs", import.meta.url));
const envelope = (operation = "get", ok = true) => ({ v: 5, operation, ok,
  more: false, next: [], revision: 1, database_instance_id: "store", database_epoch: "epoch",
  request: null, ...(ok ? { data: { id: "note:test" } } : { error: {
    code: "stale_revision", message: "The record changed.", action: "Get the current record.",
    identifiers: { id: "note:test" } } }) });
async function launch(t, source) {
  const root = await temporaryDirectory(t, "lodestar-mcp-boundary-");
  const entry = path.join(root, "child.mjs");
  await writeFile(entry, source);
  return { root, env: { ...process.env, LODESTAR_NODE: process.execPath, LODESTAR_ENTRY: entry } };
}
const emit = (stdout, stderr = "", code = 0) => `process.stdin.resume();
  process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(stdout)});
    process.stderr.write(${JSON.stringify(stderr)}); process.exitCode=${code}; });`;
for (const [name, stdout, stderr, code] of [
  ["unsupported success exit", JSON.stringify(envelope()), "", 9],
  ["contradictory channels", JSON.stringify(envelope()), JSON.stringify(envelope("get", false)), 0],
  ["malformed other channel", JSON.stringify(envelope()), '{"v":5,"ok":', 0],
  ["incomplete success", '{"v":5,"ok":true}', "", 0],
  ["operation mismatch", JSON.stringify(envelope("find")), "", 0],
]) test(`MCP production runner rejects ${name}`, async (t) => {
  const { env } = await launch(t, emit(stdout, stderr, code));
  await assert.rejects(runInstalledLodestar(["get", "note:test"], { env, operation: "get" }),
    (error) => error.toolResult?.ok === false && error.toolResult.write_outcome === "not_applicable"
      && typeof error.toolResult.error.action === "string");
});
test("MCP preserves ordinary warnings and diagnostic exit4", async (t) => {
  const { env } = await launch(t, emit("Warning: fixture\n" + JSON.stringify(envelope("doctor")), "Warning: note", 4));
  const result = await runInstalledLodestar(["doctor"], { env, operation: "doctor" });
  assert.equal(result.ok, true); assert.equal(result.operation, "doctor");
});
test("MCP preserves explicit rejection code, action and identifiers", async (t) => {
  const { env } = await launch(t, emit("", JSON.stringify(envelope("put", false)), 2));
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input: '{"request_id":"same"}', effect: "record_write" }),
    (error) => error.toolResult?.write_outcome === "rejected" && error.toolResult.error.code === "stale_revision"
      && error.toolResult.error.action === "Get the current record." && error.toolResult.error.identifiers.id === "note:test");
});
test("MCP contradictory write response stays unknown with exact replay guidance", async (t) => {
  const { env } = await launch(t, emit(JSON.stringify(envelope("put")), JSON.stringify(envelope("put", false)), 2));
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input: '{"request_id":"same"}',
    effect: "record_write", requestId: "same" }), (error) => error.toolResult?.write_outcome === "unknown"
      && error.toolResult.request_id === "same" && /identical|exact/i.test(error.toolResult.error.action));
});
for (const [name, response] of [
  ["missing receipt", envelope("put")],
  ["wrong store", { ...envelope("put"), request: { id: "same", replayed: false, committed_revision: 1 }, receipt_id: "mutation-receipt:wrong" }],
]) test(`MCP mutation success requires matching confirmation: ${name}`, async (t) => {
  const { env } = await launch(t, emit(JSON.stringify(response)));
  const input = JSON.stringify({ request_id: "same", write_basis: { database_instance_id: "expected", database_epoch: "epoch" } });
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input, effect: "record_write" }),
    error => error.toolResult?.write_outcome === "unknown" && error.toolResult.error.code === "invalid_confirmation");
});
test("MCP deadline closes only the owned process and keeps a dispatched write unknown", async (t) => {
  const { root, env } = await launch(t, `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify("PID_PLACEHOLDER")}, String(process.pid)); process.stdin.resume(); setTimeout(()=>{}, 10000);`);
  const pidFile = path.join(root, "pid");
  const entry = env.LODESTAR_ENTRY;
  await writeFile(entry, (await readFile(entry, "utf8")).replace(JSON.stringify("PID_PLACEHOLDER"), JSON.stringify(pidFile)));
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input: '{}', effect: "record_write", timeoutMs: 400 }),
    (error) => error.toolResult?.error.code === "timeout" && error.toolResult.write_outcome === "unknown");
  const pid = Number(await readFile(pidFile, "utf8"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Owned child remains alive after the deadline");
});
test("MCP output cap reports explicit uncertainty", async (t) => {
  const { env } = await launch(t, emit("x".repeat(2048)));
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input: '{}', effect: "record_write", maxOutputBytes: 1024 }),
    error => error.toolResult?.error.code === "output_limit" && error.toolResult.write_outcome === "unknown");
});
test("MCP refuses oversized mutation before dispatch and preserves input bytes", async (t) => {
  const { env } = await launch(t, emit(JSON.stringify(envelope("put"))));
  const input = JSON.stringify({ request_id: "same", text: "😀".repeat(JSON_INPUT_MAXIMUM_BYTES / 4) });
  const original = Buffer.from(input);
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input, effect: "record_write" }),
    error => error.toolResult?.error.code === "resource_limit" && error.toolResult.write_outcome === "not_dispatched");
  assert.deepEqual(Buffer.from(input), original);
});

async function communicate(t, frames, env = process.env) {
  const child = spawn(process.execPath, [mcp], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const chunks = [], errors = [];
  child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => errors.push(chunk));
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code)); });
  child.stdin.on("error", () => {});
  for (const frame of frames) if (!child.stdin.write(frame)) await new Promise(resolve => child.stdin.once("drain", resolve));
  child.stdin.end();
  assert.equal(await done, 0, Buffer.concat(errors).toString("utf8"));
  return Buffer.concat(chunks).toString("utf8").trim().split("\n").map(JSON.parse);
}
const ping = '{"jsonrpc":"2.0","id":"after","method":"ping"}\n';
test("MCP rejects oversized frame incrementally and preserves the next message", async (t) => {
  const prefix = '{"jsonrpc":"2.0","id":"big","method":"tools/call","params":{"name":"lodestar_describe","_meta":{"padding":"';
  const responses = await communicate(t, [prefix, "é".repeat(JSON_INPUT_MAXIMUM_BYTES / 2), '"}}}\n', ping]);
  assert.equal(responses.length, 2);
  assert.ok(responses[0].error); assert.match(responses[0].error.message, /limit|maximum/i);
  assert.match(JSON.stringify(responses[0].error), /Reduce|smaller/i);
  assert.deepEqual(responses[1], { jsonrpc: "2.0", id: "after", result: {} });
});
test("MCP rejects unterminated oversized frame and invalid UTF8 explicitly", async (t) => {
  const responses = await communicate(t, [Buffer.from([0xc3, 0x28, 0x0a]), '"' + "x".repeat(JSON_INPUT_MAXIMUM_BYTES)]);
  assert.equal(responses.length, 2); assert.ok(responses.every(response => response.error));
});
test("MCP exposes uncertain mutation as model-visible tool error", async (t) => {
  const { env } = await launch(t, emit(JSON.stringify(envelope("put")), JSON.stringify(envelope("put", false)), 2));
  const responses = await communicate(t, [JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "lodestar_mutate", arguments: { operation: "put", request: { request_id: "same" } } } }) + "\n"], env);
  assert.equal(responses[0].result?.isError, true);
  assert.equal(responses[0].result.structuredContent.write_outcome, "unknown");
  assert.equal(responses[0].result.structuredContent.request_id, "same");
  assert.match(responses[0].result.content[0].text, /exact|identical/i);
});
test("real MCP guarded mutation and exact replay retain their original confirmation", async (t) => {
  const f = await fixture(t);
  const request = await f.request({ mode: "create", record: { id: "note:mcp-replay", kind: "note",
    name: "MCP exact replay", scope: "global", availability: "known", data: { text: "Unicode 😀" },
    aliases: [], links: [], sources: [] } }, [{ kind: "record", id: "note:mcp-replay" }]);
  const env = { ...process.env, LODESTAR_NODE: process.execPath,
    LODESTAR_ENTRY: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), LODESTAR_DB: f.database };
  const call = id => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "lodestar_mutate", arguments: { operation: "put", request } } }) + "\n";
  const [first, second] = await communicate(t, [call(1), call(2)], env);
  assert.equal(first.result.isError, false, JSON.stringify(first));
  assert.equal(second.result.isError, false, JSON.stringify(second));
  assert.equal(first.result.structuredContent.request.replayed, false);
  assert.equal(second.result.structuredContent.request.replayed, true);
  assert.equal(first.result.structuredContent.request.id, request.request_id);
  assert.equal(first.result.structuredContent.receipt_id, second.result.structuredContent.receipt_id);
  assert.equal(first.result.structuredContent.revision, second.result.structuredContent.revision);
  const row = await f.cli(["get", "note:mcp-replay"]);
  assert.equal(row.value.data.data.text, "Unicode 😀");
});
test("MCP accepts a frame at the byte boundary and rejects one extra byte without desynchronizing", async (t) => {
  const head = '{"jsonrpc":"2.0","id":"limit","method":"tools/call","params":{"name":"lodestar_describe","_meta":{"padding":"';
  const tail = '"}}}';
  const remaining = JSON_INPUT_MAXIMUM_BYTES - Buffer.byteLength(head + tail);
  const frame = head + "a".repeat(remaining) + tail;
  const responses = await communicate(t, [frame + "\n", frame + " \n", ping]);
  assert.equal(responses.length, 3);
  assert.equal(responses[0].result.structuredContent.contract, 5);
  assert.equal(responses[1].error.data.code, "resource_limit");
  assert.deepEqual(responses[2], { jsonrpc: "2.0", id: "after", result: {} });
});
test("MCP failed executable and cancelled operation report no dispatch", async (t) => {
  const { root, env } = await launch(t, emit(JSON.stringify(envelope("put"))));
  await assert.rejects(runInstalledLodestar(["put"], { env: { ...env, LODESTAR_NODE: path.join(root, "missing-node.exe") },
    operation: "put", input: '{}', effect: "record_write" }),
  error => error.toolResult?.error.code === "spawn_failed" && error.toolResult.write_outcome === "not_dispatched");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input: '{}', effect: "record_write", signal: controller.signal }),
    error => error.toolResult?.error.code === "cancelled" && error.toolResult.write_outcome === "not_dispatched");
});
const confirmation = (request, operation, data) => ({ ...envelope(operation), data,
  database_instance_id: request.write_basis.database_instance_id,
  database_epoch: request.write_basis.database_epoch,
  request: { id: request.request_id, replayed: false, committed_revision: 1 },
  receipt_id: `mutation-receipt:${createHash("sha256").update(canonicalStringify([
    request.write_basis.database_instance_id, request.write_basis.database_epoch, request.request_id,
  ])).digest("hex")}` });
for (const [operation, input, wrongData] of [
  ["put", { mode: "update", id: "note:expected" }, { id: "note:other" }],
  ["put", { mode: "create", record: { id: "note:expected" } }, { id: "note:other" }],
  ["delete", { id: "note:expected", reason: "Retire" }, { id: "note:other", retired: true, reason: "Retire" }],
  ["work.report", { id: "work:expected" }, { changed: true, record: { id: "work:other" } }],
  ["handoff.checkpoint", { id: "handoff:expected" }, { changed: false, record: { id: "handoff:other" } }],
  ["pending.drop", { id: "pending:expected" }, { settled: true, record: { id: "pending:other" } }],
  ["decision.set", { key: "expected" }, { changed: true, record: { data: { key: "other" } } }],
  ["decision.set", { key: "expected" }, { changed: false, current: { key: "other" } }],
  ["work.expire", { targets: ["work:expected"] }, { results: [{ changed: true, record: { id: "work:other" } }] }],
]) test(`MCP confirmation rejects wrong ${operation} target ${input.mode ?? wrongData.changed ?? "record"}`, async (t) => {
  const request = { request_id: "same", write_basis: { database_instance_id: "store", database_epoch: "epoch" }, input };
  const { env } = await launch(t, emit(JSON.stringify(confirmation(request, operation, wrongData))));
  await assert.rejects(runInstalledLodestar(operation.split("."), { env, operation, input: JSON.stringify(request) }),
    error => error.toolResult?.write_outcome === "unknown" && error.toolResult.error.code === "invalid_confirmation");
});
test("MCP error naming another request retains uncertainty and actual recovery identifiers", async (t) => {
  const reported = { ...envelope("put", false), request: { id: "other" },
    error: { ...envelope("put", false).error, identifiers: { request_id: "other", id: "note:expected" } } };
  const { env } = await launch(t, emit("", JSON.stringify(reported), 2));
  const input = JSON.stringify({ request_id: "same", write_basis: { database_instance_id: "store", database_epoch: "epoch" } });
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input }),
    error => error.toolResult?.write_outcome === "unknown" && error.toolResult.error.code === "invalid_confirmation"
      && error.toolResult.error.identifiers.request_id === "other" && /Get the current record/.test(error.toolResult.error.action));
});
test("MCP malformed success request metadata fails explicitly after dispatch", async (t) => {
  const { env } = await launch(t, emit(JSON.stringify(envelope("put"))));
  await assert.rejects(runInstalledLodestar(["put"], { env, operation: "put", input: '{"request_id":"same","write_basis":{}}' }),
    error => error.toolResult?.write_outcome === "unknown" && error.toolResult.error.code === "invalid_confirmation");
});
test("MCP response writer waits for its output callback before another request", async () => {
  const source = await readFile(mcp, "utf8");
  const start = source.indexOf("function reply("), end = source.indexOf("function plainObject(", start);
  assert.ok(start >= 0 && end > start);
  let release, complete = false;
  const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { release = callback; } });
  const context = { process: { stdout: sink }, JSON, Error, Promise };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const pending = context.reply("slow", {});
  assert.equal(typeof pending?.then, "function", "Output completion must be observable by the request loop");
  pending.then(() => { complete = true; });
  await Promise.resolve(); assert.equal(complete, false);
  release(); await pending; assert.equal(complete, true); sink.destroy();
});
test("MCP closed output reports bounded recovery guidance instead of an unhandled crash", async (t) => {
  const child = spawn(process.execPath, [mcp], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdout.destroy();
  const errors = []; child.stderr.on("data", chunk => errors.push(chunk));
  child.stdin.on("error", () => {});
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code)); });
  child.stdin.end(ping);
  assert.equal(await done, 1);
  const message = Buffer.concat(errors).toString("utf8");
  assert.match(message, /Lodestar MCP response delivery failed/);
  assert.match(message, /original request.*receipt.*exact replay/);
  assert.ok(message.length < 1024); assert.doesNotMatch(message, /Unhandled 'error'|node:events/);
});
test("real MCP store conflict is an actionable rejection of this attempt with no write", async (t) => {
  const f = await fixture(t);
  const request = await f.request({ mode: "create", record: { id: "note:conflict", kind: "note", name: "Conflict",
    scope: "global", availability: "known", data: {}, aliases: [], links: [], sources: [] } }, [{ kind: "record", id: "note:conflict" }]);
  request.database_instance_id = "a".repeat(64);
  const bytes = await readFile(f.database);
  const env = { ...process.env, LODESTAR_NODE: process.execPath,
    LODESTAR_ENTRY: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), LODESTAR_DB: f.database };
  await assert.rejects(runInstalledLodestar(["put"], { input: JSON.stringify(request), env }),
    error => error.toolResult?.write_outcome === "rejected" && error.toolResult.error.code === "database_instance_conflict"
      && error.toolResult.error.identifiers.expected === request.database_instance_id && !!error.toolResult.error.action);
  assert.deepEqual(await readFile(f.database), bytes);
});
test("MCP unknown outcome offers an exact receipt read without writing", async (t) => {
  const request = { request_id: "same", write_basis: { database_instance_id: "store", database_epoch: "epoch" },
    input: { mode: "update", id: "note:expected" } };
  const { env } = await launch(t, emit("", "", 2));
  await assert.rejects(runInstalledLodestar(["put"], { env, input: JSON.stringify(request) }), error => {
    assert.equal(error.toolResult.write_outcome, "unknown");
    assert.deepEqual(error.toolResult.recovery_reads, [{ tool: "lodestar_read", arguments: { operation: "get",
      arguments: [confirmation(request, "put", {}).receipt_id] } }]);
    return true;
  });
});
for (const [operation, input, data] of [
  ["delete", { id: "note:expected", reason: "Retire" }, { id: "note:expected", retired: true, reason: "Retire", changed: false }],
  ["decision.set", { key: "expected" }, { changed: false, current: { key: "expected" } }],
  ["decision.inject", {}, { changed: true, record: { data: { key: "lodestar:agent-decision-presentation" } } }],
  ["work.expire", { targets: ["work:A", "work:B"] }, { results: [{ changed: true, record: { id: "work:B" } }, { changed: false, record: { id: "work:A" } }] }],
  ["pending.promote", { id: "pending:expected", destination: { operation: "put", input: { mode: "create", record: { id: "note:expected" } } } },
    { settled: true, record: { id: "pending:expected" }, promoted: { id: "note:expected" } }],
]) test(`MCP confirmation preserves legitimate ${operation} result`, async (t) => {
  const request = { request_id: "same", write_basis: { database_instance_id: "store", database_epoch: "epoch" }, input };
  const { env } = await launch(t, emit(JSON.stringify(confirmation(request, operation, data))));
  const result = await runInstalledLodestar(operation.split("."), { env, input: JSON.stringify(request) });
  assert.deepEqual(result.data, data); assert.equal(result.request.replayed, false);
});
test("MCP incomplete promotion result is unknown and cannot throw a blind TypeError", async (t) => {
  const request = { request_id: "same", write_basis: { database_instance_id: "store", database_epoch: "epoch" },
    input: { id: "pending:expected", destination: { operation: "put", input: { mode: "create", record: { id: "note:expected" } } } } };
  const { env } = await launch(t, emit(JSON.stringify(confirmation(request, "pending.promote",
    { settled: true, record: { id: "pending:expected" }, promoted: null }))));
  await assert.rejects(runInstalledLodestar(["pending", "promote"], { env, input: JSON.stringify(request) }),
    error => error.toolResult?.write_outcome === "unknown" && error.toolResult.error.code === "invalid_confirmation");
});
test("signal termination cannot turn a buffered write error into a settled rejection", async (t) => {
  const { env } = await launch(t, `process.stdin.resume(); process.stdin.on('end',()=>{
    process.stdout.write(${JSON.stringify(JSON.stringify(envelope("put", false)))},()=>process.kill(process.pid, 'SIGKILL'));
  });`);
  await assert.rejects(runInstalledLodestar(["put"], { env, input: '{"request_id":"same"}' }),
    error => error.toolResult?.write_outcome === "unknown" && error.toolResult.error.code === "inconsistent_exit");
});
