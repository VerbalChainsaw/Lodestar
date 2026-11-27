import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { executeCli, parseCliResult } from "../src/interface-client.mjs";
import { decodeUtf8, parseJsonText } from "../src/json.mjs";

const envelope = { v: 5, operation: "put", ok: true, more: false, next: [], revision: 7,
  database_instance_id: "store", database_epoch: "epoch", data: { note: "é界" } };
const valid = JSON.stringify(envelope);
const escaped = (text) => text.replace(/"([^"\\]+)"(?=\s*:)/gu,
  (_, key) => '"' + [...key].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("") + '"');
const malformedBytes = (text) => {
  const at = text.indexOf("é界");
  return Buffer.concat([Buffer.from(text.slice(0, at)), Buffer.from([0xC3, 0x28]), Buffer.from(text.slice(at + 2))]);
};
for (const [name, output] of [
  ["duplicate flags", valid.replace('"ok":true', '"ok":false,"ok":true')],
  ["nested duplicate", valid.replace('"note":"é界"', '"note":"old","note":"é界"')],
  ["rounded version", valid.replace('"v":5', '"v":5.0000000000000001')],
]) test("operator protocol rejects " + name + " as uncertain", () => {
  const result = parseCliResult({ stdout: output, stderr: "", operation: "put", effect: "record_write",
    exitCode: 0, elapsedMs: 1 });
  assert.equal(result.kind, "TransportError");
  assert.equal(result.mayHaveCommitted, true);
});
for (const [name, output] of [
  ["BOM duplicate", "\uFEFF" + valid.replace('"ok":true', '"ok":false,"ok":true')],
  ["escaped duplicate", escaped(valid.replace('"ok":true', '"ok":false,"ok":true'))],
  ["escaped malformed", '{"\\u0076":5,"\\u006f\\u006b":'],
]) test("operator mixed output rejects " + name, () => {
  const result = parseCliResult({ stdout: valid, stderr: output, operation: "put", effect: "record_write",
    exitCode: 0, elapsedMs: 1 });
  assert.equal(result.kind, "TransportError"); assert.equal(result.mayHaveCommitted, true);
});
test("operator protocol accepts escaped valid keys and warnings", () => {
  const result = parseCliResult({ stdout: escaped(valid), stderr: "ordinary warning", operation: "put",
    effect: "record_write", exitCode: 0, elapsedMs: 1 });
  assert.equal(result.kind, "EnvelopeSuccess"); assert.equal(result.envelope.data.note, "é界");
});
for (const stream of ["stdout", "stderr"]) test("operator execute keeps invalid UTF8 " + stream + " uncertain", async () => {
  const before = childProcess.spawn;
  const selection = { node: "synthetic-node", cli: "synthetic-cli", database: "synthetic-db" };
  childProcess.spawn = (executable, args, options) => {
    assert.equal(executable, selection.node);
    assert.deepEqual(args, ["synthetic-cli", "--db", "synthetic-db", "put"]);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    const child = new EventEmitter();
    child.pid = 1; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    queueMicrotask(() => { child[stream].emit("data", malformedBytes(valid)); child.emit("close", 0); });
    return child;
  };
  syncBuiltinESMExports();
  try {
    const result = await executeCli(selection, { operation: "put", args: ["put"], effect: "record_write" });
    assert.equal(result.kind, "TransportError"); assert.equal(result.code, "invalid_utf8");
    assert.equal(result.mayHaveCommitted, true);
  } finally { childProcess.spawn = before; syncBuiltinESMExports(); }
});

const managerSource = await readFile(new URL("../src/manager.mjs", import.meta.url), "utf8");
function journalRuntime(root) {
  const host = { path, readFile, Buffer, JSON, Error, Promise, decodeUtf8, parseJsonText,
    journalRoot: () => root, journalOperations: new Set(["put", "decision.set", "pending.drop"]),
    sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") };
  vm.createContext(host);
  const start = managerSource.indexOf("async function readJournal(");
  const end = managerSource.indexOf("async function ensureJournalContext(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(managerSource.slice(start, end), host);
  return host;
}
for (const variant of ["invalid request UTF8", "duplicate context outcome", "invalid context UTF8", "duplicate request version", "valid"]) {
  test("Manager journal admission " + variant + " preserves exact bytes", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "lodestar-manager-admission-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const name = "ll-00000000-0000-4000-8000-000000000001", folder = path.join(root, name);
    await mkdir(folder);
    const request = { v: 5, request_id: name, input: { mode: "update", id: "note:é界" },
      write_basis: { database_instance_id: "store", database_epoch: "epoch" } };
    let bytes = Buffer.from(JSON.stringify(request));
    if (variant === "invalid request UTF8") bytes = malformedBytes(bytes.toString("utf8"));
    if (variant === "duplicate request version") bytes = Buffer.from(bytes.toString("utf8").replace('"v":5', '"v":4,"v":5'));
    let context = JSON.stringify({ operation: "put", database_instance_id: "store", database_epoch: "epoch",
      runtime_fingerprint: "a".repeat(64), request_sha256: createHash("sha256").update(bytes).digest("hex"),
      prior_outcome_unknown: false, note: "é界" });
    if (variant === "duplicate context outcome") context = context.replace('"prior_outcome_unknown":false',
      '"prior_outcome_unknown":true,"prior_outcome_unknown":false');
    const contextBytes = variant === "invalid context UTF8" ? malformedBytes(context) : Buffer.from(context);
    await writeFile(path.join(folder, "request.json"), bytes); await writeFile(path.join(folder, "context.json"), contextBytes);
    const host = journalRuntime(root);
    if (variant === "valid") assert.equal((await host.readJournal({}, name)).request.input.id, "note:é界");
    else await assert.rejects(host.readJournal({}, name));
    assert.deepEqual(await readFile(path.join(folder, "request.json")), bytes);
    assert.deepEqual(await readFile(path.join(folder, "context.json")), contextBytes);
  });
}
