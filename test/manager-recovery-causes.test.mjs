import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { executeCli, parseCliResult } from "../src/interface-client.mjs";
import { loadInterfaceConfig } from "../src/interface-config.mjs";
import { runManager } from "../src/manager.mjs";
import { fixture } from "./helpers/contract.mjs";

function terminal(answers) {
  let output = "";
  return { io: { stdout: { write: (text) => { output += text; } }, stdin: {} },
    ask: async () => answers.shift() ?? null, output: () => output };
}

async function committedAttempt(t) {
  const f = await fixture(t);
  const loader = path.join(f.root, "Lodestar.Loader.exe");
  await fs.writeFile(loader, "fixture placeholder");
  const configPath = path.join(f.root, "interfaces.json");
  await fs.writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(),
    runtime: { node: process.execPath,
      cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), database: f.database }, loader }));
  const selection = await loadInterfaceConfig(configPath);
  await f.create("knowledge:recovery-cause", "knowledge", { value: 1 });
  let puts = 0;
  const execute = async (selected, invocation) => {
    const result = await executeCli(selected, invocation);
    if (invocation.operation !== "put") return result;
    puts += 1;
    assert.equal(result.kind, "EnvelopeSuccess");
    const confirmed = result.envelope;
    const envelope = { v: 5, ok: false, operation: "put", revision: confirmed.revision,
      database_instance_id: confirmed.database_instance_id, database_epoch: confirmed.database_epoch,
      request: { id: confirmed.request.id }, more: false, next: [],
      error: { code: "response_delivery_failed", message: "Committed but delivery failed.",
        identifiers: { request_id: confirmed.request.id, committed_revision: confirmed.revision,
          receipt_id: confirmed.receipt_id }, action: "Inspect the original receipt before any replay." } };
    return parseCliResult({ stdout: "", stderr: JSON.stringify(envelope), exitCode: 5,
      elapsedMs: 1, operation: "put", effect: "record_write" });
  };
  const edit = terminal(["3", "knowledge:recovery-cause", "1", "5", "", "", "",
    '{"value":2}', "SAVE", "6", "2", "9"]);
  assert.equal(await runManager({ selection, ...edit, execute }), 0, edit.output());
  assert.equal(puts, 1);
  const [name] = await fs.readdir(path.join(f.root, "pending"));
  const folder = path.join(f.root, "pending", name);
  const requestBytes = await fs.readFile(path.join(folder, "request.json"));
  const contextBytes = await fs.readFile(path.join(folder, "context.json"));
  const databaseBytes = await fs.readFile(f.database);
  const verifyUnchanged = async () => {
    assert.deepEqual(await fs.readFile(path.join(folder, "request.json")), requestBytes);
    assert.deepEqual(await fs.readFile(path.join(folder, "context.json")), contextBytes);
    assert.deepEqual(await fs.readFile(f.database), databaseBytes);
    const db = new DatabaseSync(f.database, { readOnly: true });
    try {
      const record = db.prepare("SELECT content_json FROM records WHERE id=?")
        .get("knowledge:recovery-cause");
      assert.equal(JSON.parse(record.content_json).value.value, 2);
    } finally { db.close(); }
  };
  return { f, selection, folder, verifyUnchanged };
}

for (const code of ["invalid_utf8", "invalid_json", "ENOENT", "EACCES"]) {
  test(`Recovery exposes saved-response ${code} without replay or journal changes`, async (t) => {
    const saved = await committedAttempt(t);
    const responseFile = path.join(saved.folder, "response.json");
    const originalRead = fs.readFile;
    if (code === "invalid_utf8") await fs.writeFile(responseFile, Buffer.from([0xc3]));
    if (code === "invalid_json") await fs.writeFile(responseFile, '{"ok":');
    if (code === "ENOENT") await fs.rm(responseFile);
    const responseBytes = code === "ENOENT" ? null : await originalRead(responseFile);
    if (code === "EACCES") {
      fs.readFile = async (file, ...args) => {
        if (String(file) === responseFile) throw Object.assign(
          new Error("The saved response cannot be opened by the current user."), { code: "EACCES" });
        return originalRead(file, ...args);
      };
      syncBuiltinESMExports();
    }
    try {
      let puts = 0;
      const recovery = terminal(["7", "1", "", "9"]);
      const execute = (selected, invocation) => {
        if (invocation.operation === "put") puts += 1;
        return executeCli(selected, invocation);
      };
      assert.equal(await runManager({ selection: saved.selection, ...recovery, execute }), 0, recovery.output());
      assert.match(recovery.output(), new RegExp(`Saved response.*${code}`));
      assert.match(recovery.output(), /Action:.*(?:original receipt|current record)/i);
      assert.ok(recovery.output().includes(responseFile));
      assert.equal(puts, 0, "Reading recovery must never resend the saved write.");
      await saved.verifyUnchanged();
      if (responseBytes === null) await assert.rejects(fs.stat(responseFile), { code: "ENOENT" });
      else assert.deepEqual(await originalRead(responseFile), responseBytes,
        "Recovery must preserve the exact missing, denied or malformed response evidence.");
    } finally {
      fs.readFile = originalRead;
      syncBuiltinESMExports();
    }
  });
}

test("Recovery preserves an actual failed receipt read code and action", async (t) => {
  const saved = await committedAttempt(t);
  let failedRead = null, puts = 0;
  const execute = async (selected, invocation) => {
    if (invocation.operation === "put") puts += 1;
    if (invocation.operation === "get" && invocation.args.some((arg) => arg.startsWith("mutation-receipt:"))) {
      // Execute the real CLI against an absent fixture database, representing
      // an unavailable configured store at the read boundary.
      failedRead = await executeCli({ ...selected, database: path.join(saved.f.root, "unavailable.db") }, invocation);
      assert.equal(failedRead.kind, "EnvelopeError");
      return failedRead;
    }
    return executeCli(selected, invocation);
  };
  const recovery = terminal(["7", "1", "", "9"]);
  assert.equal(await runManager({ selection: saved.selection, ...recovery, execute }), 0, recovery.output());
  assert.ok(failedRead, "The actual Recovery receipt branch must run.");
  assert.ok(recovery.output().includes(failedRead.envelope.error.code), recovery.output());
  assert.equal(typeof failedRead.envelope.error.action, "string");
  assert.ok(recovery.output().includes(failedRead.envelope.error.action), recovery.output());
  assert.match(recovery.output(), /Receipt read did not confirm/);
  assert.equal(puts, 0);
  await saved.verifyUnchanged();
});

test("Recovery names a thrown receipt-read failure and gives exact read arguments", async (t) => {
  const saved = await committedAttempt(t);
  let puts = 0;
  const execute = (selected, invocation) => {
    if (invocation.operation === "put") puts += 1;
    if (invocation.operation === "get" && invocation.args.some((arg) => arg.startsWith("mutation-receipt:"))) {
      throw Object.assign(new Error("Owned receipt reader failed."), { code: "EIO" });
    }
    return executeCli(selected, invocation);
  };
  const recovery = terminal(["7", "1", "", "9"]);
  assert.equal(await runManager({ selection: saved.selection, ...recovery, execute }), 0, recovery.output());
  assert.match(recovery.output(), /Receipt read failed.*EIO.*Owned receipt reader failed/);
  assert.match(recovery.output(), /Receipt read arguments:/);
  assert.match(recovery.output(), /mutation-receipt:/);
  assert.match(recovery.output(), /Action:.*(?:preserve|inspect)/i);
  assert.equal(puts, 0);
  await saved.verifyUnchanged();
});
