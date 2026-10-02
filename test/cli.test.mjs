import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.mjs";
import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { lodestarError } from "../src/errors.mjs";
import { fixture } from "./helpers/contract.mjs";

function capture(input = "") {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: Readable.from([input]),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

async function invoke(args, input = "") {
  const result = capture(input);
  const exitCode = await runCli(args, result.io);
  return { exitCode, ...result.output() };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function inputRecord() {
  return {
    id: "record:cli",
    type: "note",
    name: "CLI record",
    scope: "global",
    content: { state: "known", value: "searchable phrase" },
    aliases: ["cli alias"],
    links: [],
    sources: [],
  };
}

test("every public command help path is JSON and side-effect free", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "missing", "lodestar.db");
  const commands = [
    "init",
    "put",
    "get",
    "find",
    "links",
    "delete",
    "doctor",
    "export",
    "start",
    "work",
    "handoff",
    "agents",
    "skills",
  ];
  for (const args of [["--help"], ["--version"]]) {
    const result = await invoke([...args, "--db", file]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  for (const command of commands) {
    const result = await invoke([
      command,
      "--help",
      "--db",
      file,
    ]);
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.data.command, command);
  }
  await assert.rejects(access(path.dirname(file)), { code: "ENOENT" });
});

test("help and version answer to both spellings", async (t) => {
  const file = path.join(await temporaryDirectory(t), "missing", "lodestar.db");
  // `lodestar version` and `lodestar help get` are the first things anyone types.
  // Answering only --version and --help taught the CLI was hostile before it had
  // answered anything, and an agent that meets unknown_command stops asking.
  for (const args of [["version"], ["--version"]]) {
    const result = await invoke([...args, "--db", file]);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, args.join(" "));
    assert.equal(output.data.name, "lodestar");
  }
  for (const args of [["help"], ["--help"]]) {
    const output = JSON.parse((await invoke([...args, "--db", file])).stdout);
    assert.equal(output.ok, true, args.join(" "));
    assert.ok(Array.isArray(output.data.commands) && output.data.commands.length > 0);
  }
  for (const args of [["help", "get"], ["get", "--help"]]) {
    const output = JSON.parse((await invoke([...args, "--db", file])).stdout);
    assert.equal(output.ok, true, args.join(" "));
    assert.equal(output.data.command, "get");
  }
  // A bad name is still a bad name, whichever way it is asked for.
  const bogus = await invoke(["help", "bogus", "--db", file]);
  assert.equal(JSON.parse(bogus.stderr).error.code, "unknown_command");
});

test("put rejects malformed UTF-8 instead of replacing bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await invoke(["init", "--db", file]);
  const result = capture();
  result.io.stdin = Readable.from([Buffer.from([0xff])]);
  const exitCode = await runCli(["put", "--db", file], result.io);
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(result.output().stderr).error.code, "invalid_utf8");
});

test("put rejects non-byte stream chunks instead of coercing them", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await invoke(["init", "--db", file]);
  const input = JSON.stringify({
    ...inputRecord(),
    id: "record:coerced",
    aliases: [],
  });
  const result = capture();
  result.io.stdin = Readable.from([
    Array.from(Buffer.from(input), (byte) => byte + 256),
  ]);

  const exitCode = await runCli(["put", "--db", file], result.io);
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(result.output().stderr).error.code, "invalid_input");
  const missing = await invoke(["get", "record:coerced", "--db", file]);
  assert.equal(missing.exitCode, 3);
});

test("put rejects prototype-spoofed byte chunks without persisting them", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await invoke(["init", "--db", file]);
  const input = Buffer.from(JSON.stringify({
    ...inputRecord(),
    id: "record:spoofed",
    aliases: [],
  }));
  const spoofed = Object.create(Uint8Array.prototype);
  Object.defineProperties(spoofed, {
    byteLength: { value: input.length },
    length: { value: input.length },
  });
  for (const [index, byte] of input.entries()) {
    spoofed[index] = byte + 256;
  }
  const result = capture();
  result.io.stdin = {
    async *[Symbol.asyncIterator]() {
      yield spoofed;
    },
  };

  const exitCode = await runCli(["put", "--db", file], result.io);
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(result.output().stderr).error.code, "invalid_input");
  const missing = await invoke(["get", "record:spoofed", "--db", file]);
  assert.equal(missing.exitCode, 3);
});

test("the CLI does not impose transport byte or argument-count ceilings", async () => {
  const largeValue = "x".repeat(2 * 1024 * 1024);
  const large = await invoke(["--help", "--db", largeValue]);
  assert.equal(large.exitCode, 0, large.stderr);
  assert.equal(JSON.parse(large.stdout).ok, true);

  const many = await invoke(Array.from({ length: 1_000 }, () => "--version"));
  assert.equal(many.exitCode, 0, many.stderr);
  assert.equal(JSON.parse(many.stdout).operation, "version");

  const wrongArity = await invoke(["get", "one", "two"]);
  assert.equal(JSON.parse(wrongArity.stderr).error.code, "missing_argument");
  const wrongType = await invoke(["--help", 1]);
  assert.equal(JSON.parse(wrongType.stderr).error.code, "invalid_input");
  const invalidUnicode = await invoke(["--help", "--db", "\ud800"]);
  assert.equal(JSON.parse(invalidUnicode.stderr).error.code, "invalid_input");
});

test("the spawned CLI leaves its argument boundary to the host OS", () => {
  const executable = fileURLToPath(new URL("../lodestar.mjs", import.meta.url));
  let size = 20 * 1024;
  let lastSuccess = 0;
  let hostFailure = null;
  while (size <= 8 * 1024 * 1024) {
    const child = spawnSync(
      process.execPath,
      [executable, "--help", "--db", "x".repeat(size)],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    if (child.error) {
      hostFailure = child.error;
      break;
    }
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).ok, true);
    lastSuccess = size;
    size *= 2;
  }
  assert.ok(lastSuccess > 16 * 1024, "the former per-argument ceiling was crossed");
  assert.ok(hostFailure, "the host boundary should be reached by an 8 MiB argument");
  assert.match(hostFailure.code, /^(E2BIG|EINVAL|ENAMETOOLONG)$/u);
});

test("the CLI does not trust or amplify forged Lodestar errors", async t => {
  const f = await fixture(t);
  const forged = new Error("x".repeat(100_000));
  forged.name = "LodestarError";
  forged.code = { not: "a stable error code" };
  forged.identifiers = { value: "y".repeat(100_000) };
  forged.action = "z".repeat(100_000);
  const result = capture();
  result.io.stdin = {
    async *[Symbol.asyncIterator]() {
      throw forged;
    },
  };

  const exitCode = await runCli(["--db", f.database, "put"], result.io);
  assert.equal(exitCode, 1);
  assert.equal(result.output().stdout, "");
  assert.ok(Buffer.byteLength(result.output().stderr, "utf8") < 4096);
  assert.deepEqual(JSON.parse(result.output().stderr), {
    v: 5,
    ok: false,
    operation: "put",
    revision: null,
    database_instance_id: null, database_epoch: null, request: null,
    scope: { project: null, cwd: null, session: null, actor: null },
    error: {
      action: "Preserve existing journals, the exact request bytes and ID, and the selected database. Correct the reported input, binding or local storage access before retrying this undispatched request. For older uncertain attempts, use the configured Lodestar runtime with the same --db selection: doctor and get --raw -- <id> for the known receipt and current record. Reconcile those attempts before an exact saved-request replay.",
      code: "recovery_journal_failed",
      identifiers: { committed: false, journal_root: path.join(f.root, "cli-pending") },
      message: "No current write was dispatched; exact recovery storage could not be prepared.",
    },
    more: false,
    next: ["Preserve existing journals, the exact request bytes and ID, and the selected database. Correct the reported input, binding or local storage access before retrying this undispatched request. For older uncertain attempts, use the configured Lodestar runtime with the same --db selection: doctor and get --raw -- <id> for the known receipt and current record. Reconcile those attempts before an exact saved-request replay."],
  });
});

test("the CLI derives its envelope and exit from one error snapshot", async () => {
  const changing = lodestarError(
    "invalid_input",
    "The injected input is invalid.",
  );
  let reads = 0;
  Object.defineProperty(changing, "code", {
    get() {
      reads += 1;
      return reads === 1 ? "invalid_input" : "database_write_failed";
    },
  });
  const result = capture();
  result.io.stdin = {
    async *[Symbol.asyncIterator]() {
      throw changing;
    },
  };

  const exitCode = await runCli(["put"], result.io);
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(result.output().stderr).error.code, "invalid_input");
  assert.equal(reads, 1);
});

test("the CLI always normalizes unreadable genuine error diagnostics", async () => {
  const injected = lodestarError(
    "invalid_input",
    "The injected input is invalid.",
  );
  const revocable = Proxy.revocable({ field: "stdin" }, {});
  injected.identifiers = revocable.proxy;
  revocable.revoke();
  const result = capture();
  result.io.stdin = {
    async *[Symbol.asyncIterator]() {
      throw injected;
    },
  };

  const exitCode = await runCli(["put"], result.io);
  assert.equal(exitCode, 2);
  assert.equal(result.output().stdout, "");
  assert.deepEqual(JSON.parse(result.output().stderr), {
    v: 5,
    ok: false,
    operation: "put",
    revision: null,
    database_instance_id: null, database_epoch: null, request: null,
    scope: { project: null, cwd: null, session: null, actor: null },
    error: {
      action: "Correct the reported input using lodestar <command> --help for its arguments and request schema, then run the command with the corrected input.",
      code: "invalid_input",
      identifiers: {},
      message: "The injected input is invalid.",
    },
    more: false,
    next: ["Correct the reported input using lodestar <command> --help for its arguments and request schema, then run the command with the corrected input."],
  });
});

test('ordinary reads and writes never initialize, convert, or replace an absent or unrelated store', async (t) => {
  const root = await temporaryDirectory(t), file = path.join(root, 'missing', 'lodestar.db');
  for (const command of [['start'], ['get', 'missing'], ['find', 'needle'], ['export'], ['put']]) {
    const result = await invoke([...command, '--db', file], '{}');
    assert.notEqual(result.exitCode, 0);
  }
  await assert.rejects(access(path.dirname(file)), { code: 'ENOENT' });
  const foreign = path.join(root, 'foreign.db');
  await writeFile(foreign, 'not a database');
  const before = await readFile(foreign);
  assert.notEqual((await invoke(['init', '--db', foreign])).exitCode, 0);
  assert.deepEqual(await readFile(foreign), before);
});

test('CLI returns reusable absence bases and preserves explicit request identity through put/delete/history', async (t) => {
  const f = await fixture(t);
  const missing = await f.cli(['get', 'fact:cli']);
  assert.equal(missing.value.error.code, 'record_not_found');
  const basis = missing.value.error.identifiers.write_basis;
  assert.equal(basis.targets[0].expected_revision, null);
  const input = { mode: 'create', record: { id: 'fact:cli', kind: 'fact', name: 'CLI fact', scope: 'global',
    availability: 'known', data: { content: 'complete text' }, aliases: ['cli fact'], links: [], sources: [] } };
  const request = { v: 5, request_id: 'cli-create', write_basis: basis, input };
  const put = await f.cli(['put'], request);
  assert.equal(put.code, 0, JSON.stringify(put.value));
  assert.equal(put.value.request.replayed, false);
  assert.equal((await f.cli(['put'], request)).value.request.replayed, true);
  const get = await f.cli(['get', 'cli fact']);
  assert.equal(get.value.data.data.content, 'complete text');
  const retired = await f.cli(['delete'], { v: 5, request_id: 'retire', write_basis: get.value.data.write_basis,
    input: { id: 'fact:cli', reason: 'Superseded by new evidence' } });
  assert.equal(retired.code, 0, JSON.stringify(retired.value));
  assert.equal((await f.cli(['get', 'fact:cli'])).value.data.semantics.lifecycle, 'historical');
  assert.equal((await f.cli(['find', 'complete text'])).value.data.records.length, 0);
  assert.ok((await f.cli(['find', 'complete text', '--history'])).value.data.records.some(({ id }) => id === 'fact:cli'));
});

test('find page continuation pins the database revision and retains search filters', async (t) => {
  const f = await fixture(t);
  for (const id of ['fact:1', 'fact:2', 'fact:3']) await f.create(id, 'fact', { query: 'needle' }, 'project:one');
  const first = await f.cli(['find', 'needle', '--scope', 'project:one', '--kind', 'fact', '--limit', '1']);
  assert.equal(first.value.more, true);
  assert.equal(first.value.next[0].command, 'find');
  assert.ok(first.value.next[0].args.includes('--scope'));
  assert.ok(first.value.next[0].args.includes('--kind'));
  const second = await f.cli(['find', 'needle', '--scope', 'project:one', '--kind', 'fact', '--limit', '1', '--offset', '1', '--at-revision', String(first.value.revision)]);
  assert.equal(second.code, 0);
  assert.notEqual(second.value.data.records[0].id, first.value.data.records[0].id);
  await f.create('fact:other', 'fact', { unrelated: true });
  const stale = await f.cli(['find', 'needle', '--limit', '1', '--offset', '2', '--at-revision', String(first.value.revision)]);
  assert.equal(stale.value.error.code, 'read_revision_conflict');
});

test('the CLI delivers required source bytes beyond the former output ceiling', { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  const content = 'x'.repeat(80 * 1024 * 1024 + 1);
  await writeFile(path.join(f.root, 'AGENTS.md'), content);
  const result = await f.cli(['start', '--cwd', f.root]);
  assert.equal(result.code, 0);
  const source = result.value.data.required.find(({ path: file }) => file === path.join(f.root, 'AGENTS.md'));
  assert.equal(source.text.length, content.length);
  assert.equal(source.sha256, createHash('sha256').update(content).digest('hex'));
});

test('an occupied --output path fails with a typed conflict and preserves the file', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'occupied.json');
  await writeFile(target, '{"keep":true}');
  const result = await invoke(['version', '--output', target], '{}');
  assert.equal(result.exitCode, 3);
  assert.equal(JSON.parse(result.stderr).error.code, 'output_conflict');
  assert.equal(await readFile(target, 'utf8'), '{"keep":true}');
});

test('a committed put retains its request, receipt and verified output after stdout receipt failure', async (t) => {
  const f = await fixture(t);
  const id = 'knowledge:receipt-lost';
  const body = await f.request({ mode: 'create', record: { id, kind: 'knowledge', name: id,
    scope: 'global', availability: 'known', data: { value: 1 }, aliases: [], links: [],
    sources: [] } }, [{ kind: 'record', id }]);
  const target = path.join(f.root, 'response.json');
  const captured = capture(JSON.stringify(body));
  captured.io.stdout.write = () => { throw new Error('receipt stream unavailable'); };
  const code = await runCli(['--db', f.database, '--output', target, 'put'], captured.io);
  const error = JSON.parse(captured.output().stderr);
  const stored = await f.cli(['get', id]);
  const outputBytes = await readFile(target);
  const saved = JSON.parse(outputBytes.toString('utf8'));
  assert.equal(stored.value.data.id, id);
  assert.notEqual(code, 0);
  assert.equal(error.error.code, 'response_delivery_failed');
  assert.equal(error.error.identifiers.request_id, body.request_id);
  assert.equal(error.error.identifiers.committed_revision, saved.revision);
  assert.equal(error.error.identifiers.receipt_id, saved.receipt_id);
  assert.deepEqual(error.error.identifiers.receipt_read_args,
    ['--db', f.database, 'get', saved.receipt_id]);
  assert.equal((await f.cli(['get', saved.receipt_id])).value.data.id, saved.receipt_id);
  assert.equal(error.error.identifiers.output_file.path, target);
  assert.equal(error.error.identifiers.output_file.bytes, outputBytes.length);
  assert.equal(error.error.identifiers.output_file.sha256,
    createHash('sha256').update(outputBytes).digest('hex'));
  assert.match(error.error.action, /inspect|verify/i);
  assert.doesNotMatch(error.error.action, /^Retry the command\./);
});

test('a committed put retains receipt recovery when stdout was its only response channel', async (t) => {
  const f = await fixture(t);
  const id = 'knowledge:stdout-lost';
  const body = await f.request({ mode: 'create', record: { id, kind: 'knowledge', name: id,
    scope: 'global', availability: 'known', data: { value: 1 }, aliases: [], links: [],
    sources: [] } }, [{ kind: 'record', id }]);
  const captured = capture(JSON.stringify(body));
  captured.io.stdout.write = () => { throw new Error('private stdout marker'); };
  const code = await runCli(['--db', f.database, 'put'], captured.io);
  const failure = JSON.parse(captured.output().stderr);
  assert.equal(code, 5);
  assert.equal(failure.error.code, 'response_delivery_failed');
  assert.equal(failure.error.identifiers.request_id, body.request_id);
  assert.ok(Number.isSafeInteger(failure.error.identifiers.committed_revision));
  assert.equal(failure.error.identifiers.output_file, undefined);
  assert.equal((await f.cli(failure.error.identifiers.receipt_read_args.slice(2))).code, 0);
  assert.equal((await f.cli(['get', id])).value.data.id, id);
  assert.doesNotMatch(captured.output().stderr, /private stdout marker/);
});

test('asynchronous stdout failure after commit is observed before runCli returns', async (t) => {
  const f = await fixture(t);
  const id = 'knowledge:async-stdout';
  const body = await f.request({ mode: 'create', record: { id, kind: 'knowledge', name: id,
    scope: 'global', availability: 'known', data: { value: 1 }, aliases: [], links: [],
    sources: [] } }, [{ kind: 'record', id }]);
  const captured = capture(JSON.stringify(body));
  captured.io.stdout = new Writable({ write(_chunk, _encoding, callback) {
    setImmediate(() => callback(new Error('private async stdout marker')));
  } });
  const code = await runCli(['--db', f.database, 'put'], captured.io);
  const failure = JSON.parse(captured.output().stderr);
  assert.equal(code, 5);
  assert.equal(failure.error.code, 'response_delivery_failed');
  assert.equal(failure.error.identifiers.request_id, body.request_id);
  assert.equal((await f.cli(['get', id])).value.data.id, id);
  assert.doesNotMatch(captured.output().stderr, /private async stdout marker/);
});

test('asynchronous stderr failure preserves the CLI failure status without an unhandled stream error', async () => {
  const stderr = new Writable({ write(_chunk, _encoding, callback) {
    setImmediate(() => callback(new Error('private async stderr marker')));
  } });
  const code = await runCli(['unknown-command'], {
    stdin: Readable.from([]), stdout: { write() {} }, stderr,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(code, 2);
});

for (const failedStage of ['writeFile', 'sync']) {
  test(`a committed put identifies ${failedStage} response delivery failure without claiming a complete file`, async (t) => {
    const f = await fixture(t);
    const id = `knowledge:output-${failedStage}`;
    const body = await f.request({ mode: 'create', record: { id, kind: 'knowledge', name: id,
      scope: 'global', availability: 'known', data: { value: 1 }, aliases: [], links: [],
      sources: [] } }, [{ kind: 'record', id }]);
    const target = path.join(f.root, 'response.json');
    const probe = await open(path.join(f.root, 'probe'), 'wx');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype[failedStage];
    prototype[failedStage] = async function (...args) {
      const own = await this.stat();
      const output = await stat(target);
      const isOutput = own.ino === output.ino && own.dev === output.dev;
      if (isOutput && this.fd !== undefined && args[0]?.includes?.('"operation":"put"')) {
        throw new Error('injected output failure');
      }
      if (isOutput && failedStage === 'sync') throw new Error('injected output sync failure');
      return original.apply(this, args);
    };
    const captured = capture(JSON.stringify(body));
    let code;
    try { code = await runCli(['--db', f.database, '--output', target, 'put'], captured.io); }
    finally { prototype[failedStage] = original; }
    const error = JSON.parse(captured.output().stderr);
    const stored = await f.cli(['get', id]);
    assert.equal(stored.value.data.id, id);
    assert.notEqual(code, 0);
    assert.equal(error.error.code, 'response_delivery_failed');
    assert.equal(error.error.identifiers.request_id, body.request_id);
    assert.equal(error.error.identifiers.committed_revision, stored.value.revision);
    assert.equal(error.error.identifiers.output_file, undefined);
    assert.match(error.error.action, /inspect|receipt/i);
    assert.doesNotMatch(error.error.action, /^Retry the command\./);
  });
}

test('a committed put retains its recovery envelope when output close reports failure', async (t) => {
  const f = await fixture(t);
  const id = 'knowledge:output-close';
  const body = await f.request({ mode: 'create', record: { id, kind: 'knowledge', name: id,
    scope: 'global', availability: 'known', data: { value: 1 }, aliases: [], links: [],
    sources: [] } }, [{ kind: 'record', id }]);
  const target = path.join(f.root, 'response.json');
  const probe = await open(path.join(f.root, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWriteFile = prototype.writeFile;
  let outputHandle;
  prototype.writeFile = async function (...args) {
    if (!outputHandle) {
      outputHandle = this;
      const originalClose = this.close;
      this.close = async function (...closeArgs) {
        await originalClose.apply(this, closeArgs);
        throw new Error('injected output close failure');
      };
    }
    return originalWriteFile.apply(this, args);
  };
  const captured = capture(JSON.stringify(body));
  let code;
  let thrown;
  try { code = await runCli(['--db', f.database, '--output', target, 'put'], captured.io); }
  catch (error) { thrown = error; }
  finally { prototype.writeFile = originalWriteFile; }
  const stored = await f.cli(['get', id]);
  assert.equal(stored.value.data.id, id);
  assert.ifError(thrown);
  assert.notEqual(code, 0);
  const failure = JSON.parse(captured.output().stderr);
  assert.equal(failure.error.code, 'response_delivery_failed');
  assert.equal(failure.error.identifiers.request_id, body.request_id);
  assert.equal(failure.error.identifiers.committed_revision, stored.value.revision);
  assert.equal(failure.error.identifiers.output_file, undefined);
});

test('limited reads signal more at the envelope level', async (t) => {
  const f = await fixture(t);
  const actor = { id: 'agent:one', agent: 'agent', session: 'one', harness: 'test' };
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  for (const id of ['pending:a', 'pending:b']) {
    const body = await f.request({ id, text: `candidate ${id}` },
      [{ kind: 'record', id }, { kind: 'record', id: 'project:test' }], 'project:test', actor);
    assert.equal((await f.cli(['pending', 'add', '--cwd', f.root], body)).code, 0);
  }
  const full = await f.cli(['pending', 'list', '--cwd', f.root]);
  assert.equal(full.code, 0, JSON.stringify(full.value));
  assert.equal(full.value.more, false);
  assert.equal(full.value.data.records.length, 2);
  const limited = await f.cli(['pending', 'list', '--cwd', f.root, '--limit', '1']);
  assert.equal(limited.code, 0, JSON.stringify(limited.value));
  assert.equal(limited.value.more, true);
  assert.equal(limited.value.data.records.length, 1);
});
