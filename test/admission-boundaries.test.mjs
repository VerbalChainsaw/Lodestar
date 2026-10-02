import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { admittedTransaction, initializeDatabase, openConnection, openReadDatabase, openWriteDatabase } from "../src/database.mjs";
import { readStreamComplete, readTextFileComplete } from "../src/json.mjs";
import { parseCliResult } from "../src/interface-client.mjs";
import { fixture, temporaryDirectory } from "./helpers/contract.mjs";

const maximum = 16 * 1024 * 1024;
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const limited = (error) => {
  assert.equal(error.code, "resource_limit");
  assert.ok(error.identifiers.bytes > error.identifiers.maximum);
  assert.match(error.message, /byte limit/u);
  assert.match(error.action, /[Rr]educe/u);
  return true;
};
async function invoke(args, stdin) {
  let stdout = "", stderr = "";
  const code = await runCli(args, { stdin,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } } });
  return { code, value: JSON.parse(stdout || stderr) };
}

async function withClosedHandleFault(operation) {
  const probe = await open(new URL('../src/json.mjs', import.meta.url), 'r');
  const prototype = Object.getPrototypeOf(probe), originalStat = prototype.stat;
  await probe.close();
  const handles = new WeakSet();
  let closeCalls = 0, closedHandles = 0;
  prototype.stat = async function (...args) {
    const info = await originalStat.apply(this, args);
    if (!handles.has(this)) {
      handles.add(this);
      const close = this.close.bind(this);
      this.close = async () => {
        // Node's ReadStream also invokes FileHandle.close internally. Inject
        // only at this owner's explicit finally close, after the real close.
        const ownerClose = new Error().stack.split('\n')[2]?.includes('at readTextFileComplete (');
        if (!ownerClose) return close();
        closeCalls += 1;
        await close();
        if (this.fd === -1) closedHandles += 1;
        throw new Error('private injected close detail must not appear in output');
      };
    }
    return info;
  };
  try {
    return await operation(() => ({ closeCalls, closedHandles }));
  } finally { prototype.stat = originalStat; }
}

test('a post-close failure rejects complete input and prevents an actual mutation', async (t) => {
  const f = await fixture(t), id = 'fact:close-refused';
  const request = await f.request({ mode: 'create', record: { id, kind: 'fact', name: id,
    scope: 'global', availability: 'known', data: { value: 'must not commit' }, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id }]);
  const file = path.join(f.root, 'close-request.json');
  await writeFile(file, JSON.stringify(request));
  const databaseBefore = await digest(f.database), inputBefore = await digest(file);
  await withClosedHandleFault(async (observed) => {
    const result = await invoke(['--db', f.database, 'put', '--file', file], Readable.from([]));
    assert.notEqual(result.code, 0, 'input close failure must not admit a database mutation');
    assert.equal(result.value.error.code, 'input_unreadable');
    assert.equal(result.value.error.identifiers.cleanup.code, 'input_close_failed');
    assert.equal(result.value.error.identifiers.committed, false);
    assert.match(result.value.error.action, /No database mutation was dispatched/u);
    assert.equal(parseCliResult({ stdout: '', stderr: JSON.stringify(result.value),
      exitCode: result.code, elapsedMs: 0, operation: 'put', effect: 'record_write', dispatched: true }).kind, 'EnvelopeError');
    assert.doesNotMatch(JSON.stringify(result.value), /private injected/u);
    await assert.rejects(readTextFileComplete(file), (error) => {
      assert.equal(error.code, 'input_unreadable');
      assert.equal(error.identifiers.cleanup.code, 'input_close_failed');
      assert.equal(error.identifiers.committed, false);
      assert.match(error.action, /[Rr]etry|[Rr]estart/u);
      assert.doesNotMatch(error.message, /private injected/u);
      return true;
    });
    assert.deepEqual(observed(), { closeCalls: 2, closedHandles: 2 });
  });
  assert.equal(await digest(f.database), databaseBefore);
  assert.equal(await digest(file), inputBefore);
  assert.equal((await f.cli(['get', id])).value.error.code, 'record_not_found');
});

test('primary overflow remains visible with bounded secondary input-close failure', async (t) => {
  const root = await temporaryDirectory(t, 'lodestar-close-overflow-');
  const file = path.join(root, 'overflow.json');
  await writeFile(file, '123456789');
  await withClosedHandleFault(async (observed) => {
    await assert.rejects(readTextFileComplete(file, { maximum: 8 }), (error) => {
      limited(error);
      assert.equal(error.identifiers.cleanup.code, 'input_close_failed');
      assert.equal(error.identifiers.committed, false);
      assert.match(error.identifiers.cleanup.action, /No database mutation was dispatched/u);
      assert.match(error.identifiers.cleanup.action, /[Rr]etry|[Rr]estart/u);
      assert.doesNotMatch(JSON.stringify(error.identifiers), /private injected/u);
      return true;
    });
    assert.deepEqual(observed(), { closeCalls: 1, closedHandles: 1 });
  });
});

test('malformed JSON with input-close failure is refused before parse or mutation', async (t) => {
  const f = await fixture(t), file = path.join(f.root, 'malformed-close.json');
  await writeFile(file, '{malformed');
  const before = await digest(f.database);
  await withClosedHandleFault(async (observed) => {
    const result = await invoke(['--db', f.database, 'put', '--file', file], Readable.from([]));
    assert.notEqual(result.code, 0);
    assert.equal(result.value.error.code, 'input_unreadable');
    assert.equal(result.value.error.identifiers.cleanup.code, 'input_close_failed');
    assert.equal(result.value.error.identifiers.committed, false);
    assert.deepEqual(observed(), { closeCalls: 1, closedHandles: 1 });
  });
  assert.equal(await digest(f.database), before);
});

test('primary invalid UTF-8 retains its encoding action when file close also fails', async (t) => {
  const root = await temporaryDirectory(t, 'lodestar-close-utf8-');
  const file = path.join(root, 'invalid.json');
  await writeFile(file, Buffer.from([0xC3, 0x28]));
  await withClosedHandleFault(async (observed) => {
    await assert.rejects(readTextFileComplete(file), (error) => {
      assert.equal(error.code, 'invalid_utf8');
      assert.match(error.action, /Encode.*UTF-8/u);
      assert.equal(error.identifiers.cleanup.code, 'input_close_failed');
      assert.equal(error.identifiers.committed, false);
      assert.match(error.identifiers.cleanup.action, /No database mutation was dispatched/u);
      return true;
    });
    assert.deepEqual(observed(), { closeCalls: 1, closedHandles: 1 });
  });
});

test("bounded readers preserve exact UTF-8 bytes at the limit and reject overflow", async (t) => {
  const root = await temporaryDirectory(t, "lodestar-admission-bytes-");
  const file = path.join(root, "input.json");
  await writeFile(file, '"é😀"'); // 8 bytes, including the quotes.
  assert.equal(await readTextFileComplete(file, { maximum: 8 }), '"é😀"');
  const source = await digest(file);
  await assert.rejects(readTextFileComplete(file, { maximum: 7 }), limited);
  assert.equal(await digest(file), source);
  assert.equal(await readStreamComplete(Readable.from(['"é', '\uD83D', '\uDE00"']), { maximum: 8 }), '"é😀"');
  await assert.rejects(readStreamComplete(Readable.from([Buffer.from('"é😀"')]), { maximum: 7 }), limited);
  await writeFile(file, "\uFEFF{}");
  assert.equal(await readTextFileComplete(file, { maximum: 5 }), "\uFEFF{}");
  await assert.rejects(readTextFileComplete(file, { maximum: 4 }), limited);
});

test("stdin overflow stops consumption without reading the remaining request", async () => {
  let chunksRead = 0, closed = false;
  const stream = { async *[Symbol.asyncIterator]() {
    try {
      chunksRead += 1; yield Buffer.from("12345678");
      chunksRead += 1; yield Buffer.from("9");
      chunksRead += 1; throw new Error("must not consume overflow tail");
    } finally { closed = true; }
  } };
  await assert.rejects(readStreamComplete(stream, { maximum: 8, resource: "mutation_request" }), limited);
  assert.equal(chunksRead, 2);
  assert.equal(closed, true);
});

test("a file growing after the early size check is still bounded by the actual read", async (t) => {
  const root = await temporaryDirectory(t, "lodestar-admission-growing-");
  const file = path.join(root, "growing.json");
  await writeFile(file, "12345678");
  const probe = await open(file, "r"), prototype = Object.getPrototypeOf(probe);
  const stat = prototype.stat;
  await probe.close();
  let grew = false;
  prototype.stat = async function (...args) {
    const info = await stat.apply(this, args);
    if (!grew) { grew = true; await writeFile(file, "123456789"); }
    return info;
  };
  try {
    await assert.rejects(readTextFileComplete(file, { maximum: 8 }), limited);
    assert.equal(grew, true);
  } finally { prototype.stat = stat; }
  assert.equal(await readFile(file, "utf8"), "123456789");
});

for (const transport of ["file", "stdin"]) test(`oversized valid mutation ${transport} is rejected before any database write`, async (t) => {
  const f = await fixture(t);
  const id = `fact:oversized-${transport}`;
  const request = await f.request({ mode: "create", record: { id, kind: "fact", name: id,
    scope: "global", availability: "known", data: { value: "unchanged" }, aliases: [], links: [], sources: [] } },
  [{ kind: "record", id }]);
  const json = Buffer.from(JSON.stringify(request));
  const body = Buffer.concat([json, Buffer.alloc(maximum + 1 - json.length, 0x20)]);
  const file = path.join(f.root, "oversized.json");
  await writeFile(file, body);
  const beforeDatabase = await digest(f.database), beforeRequest = await digest(file);
  const result = await invoke(["--db", f.database, "put", ...(transport === "file" ? ["--file", file] : [])],
    transport === "file" ? Readable.from([]) : Readable.from([body.subarray(0, maximum), body.subarray(maximum)]));
  assert.equal(result.code, 2);
  assert.equal(result.value.error.code, "resource_limit");
  assert.equal(result.value.error.identifiers.maximum, maximum);
  assert.equal(result.value.error.identifiers.resource, "put_input");
  assert.equal(await digest(f.database), beforeDatabase);
  assert.equal(await digest(file), beforeRequest);
  assert.equal((await f.cli(["get", id])).value.error.code, "record_not_found");
  const accepted = body.subarray(0, maximum), boundedFile = path.join(f.root, "bounded.json");
  await writeFile(boundedFile, accepted);
  const atLimit = await invoke(["--db", f.database, "put", ...(transport === "file" ? ["--file", boundedFile] : [])],
    transport === "file" ? Readable.from([]) : Readable.from([accepted]));
  assert.equal(atLimit.code, 0, JSON.stringify(atLimit.value));
  assert.equal((await f.cli(["get", id])).value.data.data.value, "unchanged");
  assert.equal(await digest(file), beforeRequest);
});

test("a 50MiB file fails before JSON parsing in a one-shot CLI process", async (t) => {
  const root = await temporaryDirectory(t, "lodestar-admission-process-");
  const file = path.join(root, "giant.json"), database = path.join(root, "absent.db");
  await writeFile(file, Buffer.alloc(50 * 1024 * 1024, 0x78));
  const result = spawnSync(process.execPath, ["lodestar.mjs", "--db", database, "put", "--file", file],
    { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 2, result.stderr);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, "resource_limit");
  assert.equal(error.identifiers.maximum, maximum);
  assert.equal(error.identifiers.bytes, 50 * 1024 * 1024);
});

test("argument JSON transport uses the same file and stdin resource boundary", async (t) => {
  const root = await temporaryDirectory(t, "lodestar-admission-argv-");
  const body = Buffer.alloc(maximum + 1, 0x78), file = path.join(root, "args.json");
  await writeFile(file, body);
  for (const args of [["--args-file", file], ["--args-stdin"]]) {
    const result = await invoke(args, Readable.from([body]));
    assert.equal(result.code, 2);
    assert.equal(result.value.error.code, "resource_limit");
    assert.equal(result.value.error.identifiers.resource, "command_arguments");
  }
});

test("a valid file body remains supported when argv arrives through stdin", async (t) => {
  const f = await fixture(t), id = "fact:args-stdin-body-file";
  const request = await f.request({ mode: "create", record: { id, kind: "fact", name: id,
    scope: "global", availability: "known", data: { value: "é😀" }, aliases: [], links: [], sources: [] } }, [{ kind: "record", id }]);
  const file = path.join(f.root, "request.json");
  await writeFile(file, JSON.stringify(request));
  const result = await invoke(["--args-stdin"], Readable.from([JSON.stringify(["--db", f.database, "put", "--file", file])]));
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal((await f.cli(["get", id])).value.data.data.value, "é😀");
});

test("unadmitted DML is blocked both by trusted_schema OFF and the UDF fallback with ON", async () => {
  const db = openConnection(":memory:");
  try {
    // This is the same schema-creation path used by init.
    const { initializeConnection } = await import("../src/database.mjs");
    initializeConnection(db, { createdAt: "2026-09-30T00:00:00.000Z" });
    assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
    assert.throws(() => db.exec("UPDATE metadata SET value='bad' WHERE key='schema_version'"), /unsafe use of lodestar_write_contract/u);
    db.exec("PRAGMA trusted_schema = ON");
    assert.equal(db.prepare("SELECT lodestar_write_contract() AS contract").get().contract, 0);
    db.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(() => db.exec("UPDATE metadata SET value='bad' WHERE key='schema_version'"), /lodestar_write_contract_required/u);
    } finally { db.exec("ROLLBACK"); }
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, "5");
    admittedTransaction(db, () => {
      assert.equal(db.prepare("SELECT lodestar_write_contract() AS contract").get().contract, 5);
      db.exec("UPDATE metadata SET value=value WHERE key='schema_version'");
    });
    assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
  } finally { db.close(); }
});

test("DDL remains a trusted internal capability and external file readers can inspect records", async (t) => {
  const root = await temporaryDirectory(t, "lodestar-admission-ddl-");
  const file = path.join(root, "state.db");
  assert.equal((await initializeDatabase(file)).created, true);
  const external = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(external.prepare("SELECT count(*) n FROM records").get().n, 0);
    assert.ok(external.prepare("SELECT sql FROM sqlite_schema WHERE name='records'").get().sql.includes("CREATE TABLE"));
  } finally { external.close(); }
  const owned = await openWriteDatabase(file);
  try { admittedTransaction(owned, () => owned.exec("DROP TABLE records")); }
  finally { owned.close(); }
  await assert.rejects(openReadDatabase(file), ({ code }) => code === "invalid_database");
});
