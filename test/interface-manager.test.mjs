import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admittedTransaction, openWriteDatabase } from "../src/database.mjs";
import { buildReadArgs, childEnvironment, executeCli, loadFindPages, parseCliResult,
  validContinuation } from "../src/interface-client.mjs";
import { loadInterfaceConfig, revalidateSelection } from "../src/interface-config.mjs";
import { editRequest, projectAssociations, projectIdentityMatches, runManager } from "../src/manager.mjs";
import { buildHumanRequest, buildOperatorRecord, combineReadBases } from "../src/operator-actions.mjs";
import { fixture } from "./helpers/contract.mjs";

const node = process.execPath;
const cli = fileURLToPath(new URL("../lodestar.mjs", import.meta.url));
async function selectionFor(f) {
  const loader = path.join(f.root, "Lodestar.Loader.exe");
  await writeFile(loader, "fixture executable placeholder");
  const configPath = path.join(f.root, "interfaces.json");
  await writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(),
    runtime: { node, cli, database: f.database }, loader }));
  return loadInterfaceConfig(configPath);
}
function terminal(answers) {
  let output = "";
  const io = { stdout: { isTTY: true, write: (text) => { output += text; } },
    stdin: { isTTY: true } };
  return { io, ask: async () => answers.shift() ?? null, output: () => output };
}

test("human action builders keep supplied attribution and observed basis", () => {
  const store = "a".repeat(64), epoch = "b".repeat(64);
  const project = { revision: 7, database_instance_id: store, database_epoch: epoch,
    data: { write_basis: { database_instance_id: store, database_epoch: epoch,
      project_scope: "project:test", checkout: "C:/test", targets: [
        { kind: "record", id: "project:test", expected_revision: 2 }] } } };
  const missing = { revision: 7, database_instance_id: store, database_epoch: epoch,
    error: { code: "record_not_found", identifiers: { write_basis: { database_instance_id: store, database_epoch: epoch,
      project_scope: null, checkout: null, targets: [
        { kind: "record", id: "note:new", expected_revision: null }] } } } };
  const basis = combineReadBases([project, missing]);
  assert.deepEqual(basis.targets, [
    { kind: "record", id: "project:test", expected_revision: 2 },
    { kind: "record", id: "note:new", expected_revision: null }]);
  const input = buildOperatorRecord("note", { id: "note:new", name: "Meeting",
    body: "Actual note", author: "Alex", scope: "project:test", checkout: "C:/test" });
  const request = buildHumanRequest("put", { mode: "create", record: input }, basis,
    "Alex", "ll-00000000-0000-4000-8000-000000000001");
  assert.deepEqual(request.actor, { id: "user:Alex", agent: "human", harness: "manager", session: null });
  assert.equal(request.write_basis, undefined);
  assert.deepEqual(request.preconditions[1], { target: { kind: "record", id: "note:new" },
    expected_revision: null });
  assert.equal(request.input.record.data.body, "Actual note");
  assert.throws(() => combineReadBases([project, { ...missing, revision: 8 }]), /changed|revision/i);
  assert.throws(() => buildHumanRequest("put", request.input, basis, " ", "id"), /author/i);
});

test("client parses stdout, stderr errors, warning lines and diagnostic exit four", () => {
  const envelope = { v: 5, ok: true, operation: "doctor", data: { healthy: false },
    revision: null, database_instance_id: null, database_epoch: null, more: false, next: [] };
  const success = parseCliResult({ stdout: JSON.stringify(envelope), stderr: "warning\n",
    exitCode: 4, elapsedMs: 1, operation: "doctor" });
  assert.equal(success.kind, "EnvelopeSuccess");
  const error = { v: 5, ok: false, operation: "get", error: { code: "record_not_found", message: "missing" },
    revision: null, database_instance_id: null, database_epoch: null, more: false, next: [] };
  const fromStderr = parseCliResult({ stdout: "", stderr: `node warning\n${JSON.stringify(error)}\n`,
    exitCode: 2, elapsedMs: 1, operation: "get" });
  assert.equal(fromStderr.kind, "EnvelopeError");
  assert.equal(parseCliResult({ stdout: "bad", stderr: JSON.stringify(error), exitCode: 2,
    elapsedMs: 1, operation: "get" }).kind, "EnvelopeError");
  assert.equal(parseCliResult({ stdout: "garbage", stderr: "", exitCode: 0,
    elapsedMs: 1, operation: "get" }).kind, "TransportError");
  assert.equal(parseCliResult({ stdout: JSON.stringify(envelope), stderr: "", exitCode: 0,
    elapsedMs: 1, operation: "doctor", effect: "record_write", overflow: true }).mayHaveCommitted, true);
  assert.equal(parseCliResult({ stdout: JSON.stringify(envelope), stderr: "", exitCode: 1,
    elapsedMs: 1, operation: "doctor" }).code, "inconsistent_exit");
  assert.equal(parseCliResult({ stdout: JSON.stringify({ ...envelope, next: "unsafe" }), stderr: "",
    exitCode: 0, elapsedMs: 1, operation: "doctor" }).code, "invalid_envelope");
});

test("client keeps a reported post-commit delivery failure uncertain for its write consumer", () => {
  const envelope = { v: 5, ok: false, operation: 'put', revision: 9,
    database_instance_id: 'store', database_epoch: 'epoch',
    request: { id: 'request-1' }, more: false, next: [],
    error: { code: 'response_delivery_failed', message: 'Mutation committed; response failed.',
      identifiers: { request_id: 'request-1', committed_revision: 9,
        receipt_id: 'mutation-receipt:one', phase: 'stdout_receipt' },
      action: 'Inspect the receipt before replay.' } };
  const result = parseCliResult({ stdout: '', stderr: JSON.stringify(envelope),
    exitCode: 5, elapsedMs: 1, operation: 'put', effect: 'record_write' });
  assert.equal(result.kind, 'TransportError');
  assert.equal(result.code, 'response_delivery_failed');
  assert.equal(result.mayHaveCommitted, true);
  assert.deepEqual(result.envelope, envelope);
  const incomplete = parseCliResult({ stdout: '', stderr: JSON.stringify({ ...envelope,
    request: null, error: { ...envelope.error, identifiers: {} } }),
    exitCode: 5, elapsedMs: 1, operation: 'put', effect: 'record_write' });
  assert.equal(incomplete.kind, 'TransportError');
  assert.equal(incomplete.mayHaveCommitted, true);
});

test("Manager keeps the exact journal and reports receipt inspection after a committed write loses delivery", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create('knowledge:delivery', 'knowledge', { value: 1 });
  const term = terminal(['3', 'knowledge:delivery', '1', '5', 'Changed delivery', '', '',
    '{"value":2}', 'SAVE', '6', '2', '9']);
  let writeAttempts = 0;
  const execute = async (selected, invocation) => {
    const result = await executeCli(selected, invocation);
    if (invocation.operation !== 'put') return result;
    writeAttempts += 1;
    assert.equal(result.kind, 'EnvelopeSuccess');
    const success = result.envelope;
    const envelope = { v: 5, ok: false, operation: 'put', revision: success.revision,
      database_instance_id: success.database_instance_id,
      database_epoch: success.database_epoch, request: { id: success.request.id },
      more: false, next: [], error: { code: 'response_delivery_failed',
        message: 'The mutation committed, but response delivery failed.',
        identifiers: { request_id: success.request.id, committed_revision: success.revision,
          receipt_id: success.receipt_id,
          receipt_read_args: ['--db', selected.database, 'get', success.receipt_id] },
        action: 'Inspect the committed receipt before any replay.' } };
    return parseCliResult({ stdout: '', stderr: JSON.stringify(envelope), exitCode: 5,
      elapsedMs: 1, operation: 'put', effect: 'record_write' });
  };
  assert.equal(await runManager({ selection, ...term, execute }), 0, term.output());
  assert.match(term.output(), /CLI reports request .* committed at revision/);
  assert.match(term.output(), /Write outcome is uncertain/);
  assert.match(term.output(), /inspect its reported receipt and current record before any exact replay/);
  assert.equal((await f.cli(['get', 'knowledge:delivery'])).value.data.data.value, 2);
  const journal = (await readdir(path.join(f.root, 'pending')))[0];
  const response = JSON.parse(await readFile(path.join(f.root, 'pending', journal, 'response.json'), 'utf8'));
  assert.equal(response.error.code, 'response_delivery_failed');
  const recovery = terminal(['7', '1', 'REPLAY', '9']);
  assert.equal(await runManager({ selection, ...recovery, execute }), 0, recovery.output());
  assert.equal(writeAttempts, 1, 'a confirmed receipt must prevent another write dispatch');
  assert.match(recovery.output(), /receipt confirmed|already committed/i);
});

test("child environment does not inherit session, actor, Node or database overrides", () => {
  const env = childEnvironment({ CODEX_THREAD_ID: "x", CODEX_SESSION_ID: "x", CLAUDE_SESSION_ID: "x",
    OPENCODE_SESSION_ID: "x", CODEX_AGENT_NAME: "x", LODESTAR_AGENT: "x",
    LODESTAR_HARNESS: "x", LODESTAR_DB: "x", NODE_OPTIONS: "x", NODE_PATH: "x", SAFE: "yes" });
  assert.deepEqual(env, { SAFE: "yes" });
  assert.deepEqual(childEnvironment({ Node_Options: "danger", safe: "yes" }), { safe: "yes" });
});

test("generic read form uses exact bindings and leaves unknown writes descriptive", () => {
  const future = { id: "future.inspect", argv: ["future", "inspect"], effect: "read",
    parameters: [{ name: "id", binding: "positional", index: 0, required: true,
      schema: { type: "string", minLength: 1 } },
    { name: "limit", binding: "option", flag: "--limit", required: false,
      schema: { type: "integer", minimum: 1 } }], constraints: [], context: { project: false, actor: false } };
  assert.deepEqual(buildReadArgs(future, { id: "--leading", limit: 2 }),
    ["future", "inspect", "--limit", "2", "--", "--leading"]);
  assert.throws(() => buildReadArgs({ ...future, effect: "domain_write" }, { id: "x" }), /descriptive-only/);
  assert.throws(() => buildReadArgs({ ...future, parameters: null }, { id: "x" }), /descriptive-only/);
  assert.throws(() => buildReadArgs({ ...future, context: { project: true, actor: false } }, { id: "x" }),
    /project root/);
  for (const flag of ["--output", "--db", "--args-file", "--args-stdin"]) {
    const unsafe = { ...future, parameters: [...future.parameters,
      { name: "unsafe", binding: "option", flag, required: false, schema: { type: "string" } }] };
    assert.throws(() => buildReadArgs(unsafe, { id: "x" }), /descriptive-only|transport/i,
      `${flag} must be rejected even when its value is omitted`);
    assert.throws(() => buildReadArgs(unsafe, { id: "x", unsafe: "destination" }),
      /descriptive-only|transport/i);
  }
  assert.throws(() => buildReadArgs({ ...future, parameters: [...future.parameters,
    { name: "unsafe", binding: "flag", flag: "--human", schema: { type: "boolean" } }] },
  { id: "x" }), /descriptive-only|transport/i);
});

test("Manager generic bindings expose bounded decision and handoff reads", async (t) => {
  const f = await fixture(t);
  const operations = (await f.cli(["--help"])).value.data.operations;
  const operation = (id) => operations.find((entry) => entry.id === id);
  for (const id of ["decision.show", "handoff.status", "handoff.history"]) {
    assert.deepEqual(buildReadArgs(operation(id), { cwd: f.root }),
      [...id.split("."), "--cwd", f.root]);
    assert.deepEqual(buildReadArgs(operation(id), { cwd: f.root, limit: 1, offset: 0, at_revision: 1 }),
      [...id.split("."), "--cwd", f.root, "--limit", "1", "--offset", "0", "--at-revision", "1"]);
    assert.throws(() => buildReadArgs(operation(id), { cwd: f.root, unsupported: 1 }),
      /Unknown read parameter/, id);
  }
  assert.deepEqual(buildReadArgs(operation("work.status"), { cwd: f.root, limit: 1 }),
    ["work", "status", "--cwd", f.root, "--limit", "1"]);
});

test("built-in find rejects a transport flag supplied as an option value before dispatch", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const help = await f.cli(["--help"]);
  assert.equal(help.code, 0);
  const descriptor = help.value.data.operations.find(({ id }) => id === "find");
  const destination = path.join(f.root, "read-created.json");
  let dispatches = 0;
  const invoke = async (scope) => {
    const args = buildReadArgs(descriptor, { scope, query: destination });
    dispatches += 1;
    return executeCli(selection, { operation: "find", args });
  };
  for (const optionValue of ["--output", "--db", "--args-file", "--args-stdin", "--human", "-h", "-v"]) {
    await assert.rejects(invoke(optionValue), /option value|leading dash/i, optionValue);
    assert.equal(dispatches, 0, `${optionValue} must be rejected before CLI dispatch`);
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
  assert.deepEqual(buildReadArgs(descriptor, { query: "--leading", scope: "global" }),
    ["find", "--scope", "global", "--", "--leading"]);
});

test("config and continuation reject drift or foreign inputs", async (t) => {
  const f = await fixture(t);
  const selected = await selectionFor(f);
  await assert.rejects(loadInterfaceConfig(selected.configPath, { database: path.join(f.root, "other.db") }),
    { code: "interface_config_invalid" });
  const args = ["--all", "--limit", "2"];
  const next = { command: "find", args: ["--all", "--limit", "2", "--offset", "2", "--at-revision", "4"] };
  assert.equal(validContinuation(next, { args, operation: "find", revision: 4 }), true);
  assert.equal(validContinuation({ ...next, args: [...next.args, "--db", "other"] },
    { args, operation: "find", revision: 4 }), false);
  assert.equal(validContinuation({ ...next, args: [...next.args, "surprise"] },
    { args, operation: "find", revision: 4 }), false);
  await writeFile(selected.configPath, JSON.stringify({ v: 1, generation: randomUUID(),
    runtime: { node, cli, database: f.database }, loader: selected.loader }));
  await assert.rejects(revalidateSelection(selected), { code: "interface_config_changed" });
});

test("runtime identity catches unbundled source edits and packaged manifest drift", async (t) => {
  const f = await fixture(t);
  const loader = path.join(f.root, "Lodestar.Loader.exe");
  await writeFile(loader, "fixture");
  const bare = path.join(f.root, "bare");
  await mkdir(path.join(bare, "src"), { recursive: true });
  const bareCli = path.join(bare, "lodestar.mjs"), module = path.join(bare, "src", "probe.mjs");
  await writeFile(bareCli, "import './src/probe.mjs';");
  await writeFile(module, "export const value = 1;");
  const bareConfig = path.join(f.root, "bare-interfaces.json");
  await writeFile(bareConfig, JSON.stringify({ v: 1, generation: randomUUID(),
    runtime: { node, cli: bareCli, database: f.database }, loader }));
  const initial = await loadInterfaceConfig(bareConfig);
  await writeFile(module, "export const value = 2;");
  await assert.rejects(revalidateSelection(initial), { code: "interface_config_changed" });

  const app = path.join(f.root, "app");
  const core = path.join(app, "core");
  await mkdir(path.join(core, "src"), { recursive: true });
  const bundledCli = path.join(core, "lodestar.mjs"), bundledModule = path.join(core, "src", "probe.mjs");
  await writeFile(bundledCli, "import './src/probe.mjs';");
  await writeFile(bundledModule, "export const value = 1;");
  const entry = async (file) => { const bytes = await readFile(file);
    return { path: path.relative(app, file).replaceAll("\\", "/"), bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }; };
  await writeFile(path.join(app, "bundle-manifest.json"), JSON.stringify({ v: 1,
    files: [await entry(bundledCli), await entry(bundledModule)] }));
  const bundleConfig = path.join(app, "bundle-interfaces.json");
  await writeFile(bundleConfig, JSON.stringify({ v: 1, generation: randomUUID(),
    runtime: { node, cli: "core/lodestar.mjs", database: f.database }, loader }));
  const bundled = await loadInterfaceConfig(bundleConfig);
  assert.ok(bundled.runtimeFingerprint);
  await writeFile(bundledModule, "export const value = 2;");
  await assert.rejects(revalidateSelection(bundled), { code: "interface_config_invalid" });
});

test("one-shot child and typed pagination use the fixture database", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  for (const id of ["knowledge:a", "knowledge:b", "knowledge:c"]) await f.create(id, "knowledge", { id });
  const result = await executeCli(selection, { operation: "find", args: ["find", "--all", "--limit", "2"] });
  assert.equal(result.kind, "EnvelopeSuccess", JSON.stringify(result));
  const all = await loadFindPages(selection, ["--all", "--limit", "2"]);
  assert.equal(all.kind, "ReadSnapshot", JSON.stringify(all));
  assert.equal(all.complete, true);
  assert.deepEqual(all.records.map(({ id }) => id), ["knowledge:a", "knowledge:b", "knowledge:c"]);
});

test("pagination respects record budgets within terminal and continuation pages", async () => {
  const page = (ids, more = false) => ({ kind: "EnvelopeSuccess", envelope: {
    revision: 3, database_instance_id: "a", database_epoch: "b",
    data: { records: ids.map((id) => ({ id })), record_errors: [] }, more,
    next: more ? [{ command: "find", args: ["--all", "--offset", "1", "--at-revision", "3"] }] : [],
  } });
  for (const pages of [[page(["a", "b"])], [page(["a"], true), page(["b", "c"]) ]]) {
    const maxRecords = pages.length;
    const result = await loadFindPages({}, ["--all"], { maxRecords, execute: async () => pages.shift() });
    assert.equal(result.records.length, maxRecords);
    assert.equal(result.complete, false);
    assert.match(result.advisories.join(" "), /client limit/);
    assert.equal(result.revision, 3);
  }
  const duplicate = await loadFindPages({}, ["--all"], { maxRecords: 1,
    execute: async () => page(["a", "b", "b"]) });
  assert.equal(duplicate.code, "repeated_record");
  assert.ok(duplicate.records.length <= 1);
});

test("pagination never merges pages after a concurrent write", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("knowledge:a", "knowledge", {});
  await f.create("knowledge:b", "knowledge", {});
  let calls = 0;
  const inject = async (selected, invocation) => {
    const result = await executeCli(selected, invocation);
    if (++calls === 1) await f.create("knowledge:c", "knowledge", {});
    return result;
  };
  const read = await loadFindPages(selection, ["--all", "--limit", "1"], { execute: inject });
  assert.equal(read.kind, "EnvelopeError");
  assert.equal(read.envelope.error.code, "read_revision_conflict");
  assert.equal(read.complete, false);
  assert.deepEqual(read.records.map(({ id }) => id), ["knowledge:a"]);
});

test("Manager restarts catalog and summary scans after revision drift", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const reads = [];
  const fakePages = async (_selected, args) => {
    reads.push(args);
    const revision = reads.length <= 2 ? (reads.length === 1 ? 1 : 2) : 2;
    return { kind: "ReadSnapshot", records: [], revision, database_instance_id: "same",
      database_epoch: "same", readAt: "2026-09-28T00:00:00.000Z", complete: true,
      recordErrors: [], advisories: [] };
  };
  const fakeExecute = async (_, { operation }) => ({ kind: "EnvelopeSuccess", envelope: {
    v: 5, ok: true, operation, data: { capability_version: 1, operations: [] } } });
  const term = terminal(["1", "1", "9"]);
  await runManager({ selection, ...term, execute: fakeExecute, loadPages: fakePages });
  assert.equal(reads.length, 4);
  assert.ok(reads[1].includes("1"));
  assert.ok(reads[3].includes("2"));
});

test("a query beginning with dashes round-trips through continuation", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("knowledge:one", "knowledge", { text: "--dash" });
  await f.create("knowledge:two", "knowledge", { text: "--dash" });
  const result = await loadFindPages(selection, ["--limit", "1", "--", "--dash"]);
  assert.equal(result.kind, "ReadSnapshot", JSON.stringify(result));
  assert.equal(result.complete, true);
  assert.deepEqual(result.records.map(({ id }) => id), ["knowledge:one", "knowledge:two"]);
});

test("Manager handles invalid choice, EOF, and exact Loader context argv", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const terminalOne = terminal(["bad", "6", "9"]);
  const launches = [];
  const code = await runManager({ selection, ...terminalOne, initialProject: "project:demo",
    launch: async (...args) => launches.push(args) });
  assert.equal(code, 0);
  assert.match(terminalOne.output(), /Invalid choice/);
  assert.deepEqual(launches, [[selection.loader,
    ["--interface-config", selection.configPath, "--project", "project:demo"]]]);
  const terminalTwo = terminal([]);
  assert.equal(await runManager({ selection, ...terminalTwo }), 0);
});

test("Manager rejects non-TTY use before any data dispatch", async (t) => {
  const f = await fixture(t);
  const result = await f.cli(["manager"]);
  assert.equal(result.code, 2);
  assert.equal(result.value.error.code, "interactive_terminal_required");
  assert.match(result.value.error.message, /interactive terminal/);
});

test("Manager reports unexpected prompt failure but treats abort and EOF as deliberate exits", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const failed = terminal([]);
  const code = await runManager({ selection, io: failed.io,
    ask: async () => { throw new Error('private prompt marker'); } });
  assert.notEqual(code, 0);
  assert.match(failed.output(), /input|terminal|prompt/i);
  assert.match(failed.output(), /failed|unavailable|error/i);
  assert.doesNotMatch(failed.output(), /private prompt marker/);
  const aborted = terminal([]);
  const abort = new Error('cancelled'); abort.name = 'AbortError';
  let answers = 0;
  assert.equal(await runManager({ selection, io: aborted.io,
    ask: async () => { if (answers++ === 0) throw abort; return null; } }), 0);
  assert.match(aborted.output(), /Interrupted/);
  const eof = terminal([]);
  assert.equal(await runManager({ selection, ...eof }), 0);
});

test("Manager prompt failure at SAVE does not commit or silently cancel the reviewed draft", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create('knowledge:draft', 'knowledge', { value: 1 });
  const answers = ['3', 'knowledge:draft', '1', '5', 'Changed draft', '', '', '{"value":2}'];
  const term = terminal([]);
  const code = await runManager({ selection, io: term.io,
    ask: async (question) => {
      if (question.startsWith('Type SAVE')) throw new Error('private prompt marker');
      return answers.shift() ?? null;
    } });
  assert.notEqual(code, 0);
  assert.match(term.output(), /input|terminal|prompt/i);
  assert.match(term.output(), /draft|review/i);
  assert.doesNotMatch(term.output(), /Draft cancelled|private prompt marker/);
  assert.equal((await f.cli(['get', 'knowledge:draft'])).value.data.data.value, 1);
  await assert.rejects(readdir(path.join(f.root, 'pending')), { code: 'ENOENT' });
});

test("partial Manager search shows bounded row correction and coverage alongside loaded matches", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const term = terminal(['3', 'needle', '2', '9']);
  const code = await runManager({ selection, ...term, loadPages: async () => ({
    kind: 'ReadSnapshot', complete: false,
    records: [{ id: 'knowledge:loaded', name: 'Loaded match', kind: 'knowledge' }],
    recordErrors: [{ code: 'record_requires_source_correction', message: 'Malformed row',
      identifiers: { id: 'knowledge:damaged' }, action: 'Inspect raw row.' }],
    advisories: ['More pages may contain matches.'],
  }) });
  assert.equal(code, 0, term.output());
  assert.match(term.output(), /loaded matches/i);
  assert.match(term.output(), /knowledge:loaded/);
  assert.match(term.output(), /knowledge:damaged/);
  assert.match(term.output(), /record_requires_source_correction/);
  assert.match(term.output(), /Inspect raw row/);
  assert.match(term.output(), /More pages may contain matches/);
  assert.doesNotMatch(term.output(), /no recorded matches/);
});

test("complete empty Manager search may report no recorded matches", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const term = terminal(['3', 'needle', '9']);
  assert.equal(await runManager({ selection, ...term, loadPages: async () => ({
    kind: 'ReadSnapshot', complete: true, records: [], recordErrors: [], advisories: [],
  }) }), 0);
  assert.match(term.output(), /no recorded matches/);
});

test("partial Manager search caps visible diagnostics and reports omissions", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const term = terminal(['3', 'needle', '9']);
  const recordErrors = Array.from({ length: 10 }, (_, index) => ({
    code: 'record_requires_source_correction', message: `Row ${index} ${'x'.repeat(800)}`,
    identifiers: { id: `knowledge:damaged-${index}` }, action: 'Inspect raw row.',
  }));
  const advisories = Array.from({ length: 10 }, (_, index) => `Notice ${index}`);
  assert.equal(await runManager({ selection, ...term, loadPages: async () => ({
    kind: 'ReadSnapshot', complete: false, records: [], recordErrors, advisories,
  }) }), 0);
  assert.match(term.output(), /2 more record errors omitted/);
  assert.match(term.output(), /2 more advisories omitted/);
  assert.doesNotMatch(term.output(), /knowledge:damaged-8|Notice 8/);
  assert.doesNotMatch(term.output(), /x{500}/);
  assert.match(term.output(), /no loaded matches in this partial read/);
});

test("Manager shows contract correction action, next steps and reusable basis", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const basis = { database_revision: 3, target: { id: "knowledge:missing", state: "absent" } };
  const execute = async (_, { operation }) => operation === "help"
    ? { kind: "EnvelopeSuccess", envelope: { data: { capability_version: 1, operations: [] } } }
    : { kind: "EnvelopeError", envelope: { error: { code: "record_not_found", message: "Record missing.",
      action: "Run find and inspect the repository.", identifiers: { write_basis: basis, id: "knowledge:missing" } },
      next: ["Run find and inspect the repository.", "Use this basis for a reviewed create."] } };
  const term = terminal(["9"]);
  await runManager({ selection, ...term, initialProject: "knowledge:missing", execute });
  assert.match(term.output(), /Action: Run find and inspect the repository/);
  assert.match(term.output(), /Next: Use this basis for a reviewed create/);
  assert.match(term.output(), /"write_basis"/);
  assert.match(term.output(), /"database_revision": 3/);
});

test("project identity accepts recorded alias membership and blocks reassigned or missing roots", async (t) => {
  assert.equal(projectIdentityMatches({ id: "project:old", data: { canonical_project_id: "project:new" } },
    { id: "project:new", historical_scopes: ["project:old"] }), true);
  assert.equal(projectIdentityMatches({ id: "project:old", data: {} },
    { id: "project:other", historical_scopes: [] }), false);
  assert.equal(projectIdentityMatches({ id: "project:old", data: {} }, null), false);
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const launches = [];
  const term = terminal(["10", "12", "6", "9"]);
  const fake = async (_, { operation }) => ({ kind: "EnvelopeSuccess", envelope: { v: 5, ok: true,
    operation, data: operation === "help" ? { capability_version: 1, operations: [] }
      : operation === "get" ? { id: "project:old", kind: "project", data: {} }
        : { project: { id: "project:other", historical_scopes: [] } } } });
  await runManager({ selection, ...term, initialProject: "project:old", initialCwd: f.root,
    execute: fake, launch: async (...args) => launches.push(args) });
  assert.deepEqual(launches, []);
  assert.match(term.output(), /Stale selection/);
  assert.match(term.output(), /Context launch blocked/);
});

test("association requires one explicit owner and exposes shared scopes as ambiguous", () => {
  const projects = [
    { id: "project:one", kind: "project", scope: "global", semantics: { applicability: { project: "shared" } } },
    { id: "project:two", kind: "project", scope: "global", semantics: { applicability: { project: "shared" } } },
  ];
  const records = [
    { id: "knowledge:shared", kind: "knowledge", scope: "shared", semantics: { applicability: { project: null } } },
    { id: "knowledge:global", kind: "knowledge", scope: "global", semantics: { applicability: { project: null } } },
    { id: "knowledge:inferred", kind: "knowledge", scope: "project:one", semantics: { applicability: { project: null } } },
  ];
  const grouped = projectAssociations(projects, records);
  assert.deepEqual(grouped.assigned.get("project:one"), []);
  assert.deepEqual(grouped.assigned.get("project:two"), []);
  assert.deepEqual(grouped.global.map(({ id }) => id), ["knowledge:global"]);
  assert.deepEqual(grouped.unassigned.map(({ record, candidateProjects }) =>
    [record.id, candidateProjects]), [
    ["knowledge:shared", ["project:one", "project:two"]],
    ["knowledge:inferred", []],
  ]);
  const explicit = projectAssociations([{ ...projects[0], semantics: { applicability: { project: "one-scope" } } }],
    [{ id: "knowledge:explicit", kind: "knowledge", scope: "global",
      semantics: { applicability: { project: "one-scope" } } }]);
  assert.deepEqual(explicit.assigned.get("project:one").map(({ id }) => id), ["knowledge:explicit"]);
});

test("project domain menus expose public history with fresh root checks and read advisories", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const project = { id: "project:domain", kind: "project", name: "Domain", scope: "project:domain",
    data: { roots: [f.root] }, semantics: { applicability: { project: "project:domain" } },
    updated_at: "2026-01-01" };
  const library = (catalog) => ({ kind: "ReadSnapshot", records: catalog ? [project] : [],
    recordErrors: [], complete: true, revision: 1, database_instance_id: "fixture",
    database_epoch: "fixture", readAt: "now" });
  const called = [];
  let starts = 0;
  const execute = async (_, { operation, args }) => {
    called.push([operation, args]);
    if (operation === "start") starts += 1;
    return { kind: "EnvelopeSuccess", envelope: { operation,
      data: operation === "get" ? project : operation === "start"
        ? { project: { id: project.id, scope: project.scope, historical_scopes: [] } }
          : operation === "help" ? { capability_version: 1, operations: [] }
            : { records: [], record_errors: [{ identifiers: { id: "bad" } }], complete: false,
              more: true, next: ["Correct malformed domain evidence."] },
      more: true, next: ["More pages may be available."] } };
  };
  const term = terminal(["4", "2", "3", "5", "2", "3", "6", "1", "2",
    "7", "1", "2", "12", "9"]);
  await runManager({ selection, ...term, initialProject: project.id, initialCwd: f.root,
    execute, loadPages: async (_, args) => library(args.includes("--kind")) });
  assert.deepEqual(called.filter(([operation]) => ["work.history", "handoff.history",
    "decision.show", "pending.list"].includes(operation)).map(([operation, args]) => [operation, args]), [
    ["work.history", ["work", "history", "--cwd", f.root]],
    ["handoff.history", ["handoff", "history", "--cwd", f.root]],
    ["decision.show", ["decision", "show", "--cwd", f.root]],
    ["pending.list", ["pending", "list", "--cwd", f.root]],
  ]);
  assert.equal(starts, 6, "each domain view must re-resolve the selected root");
  assert.match(term.output(), /Domain read is partial/);
  assert.match(term.output(), /More domain records exist/);
  assert.match(term.output(), /Correct malformed domain evidence/);
});

test("project domain menu blocks a root reassigned after opening the project", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const project = { id: "project:domain", kind: "project", name: "Domain", scope: "project:domain",
    data: { roots: [f.root] }, semantics: { applicability: { project: "project:domain" } } };
  let starts = 0;
  const called = [];
  const execute = async (_, { operation }) => {
    called.push(operation);
    if (operation === "start") starts += 1;
    return { kind: "EnvelopeSuccess", envelope: { operation, data: operation === "get" ? project
      : operation === "start" ? { project: { id: starts < 3 ? project.id : "project:other",
        historical_scopes: [] } } : { capability_version: 1, operations: [] } } };
  };
  const launches = [];
  const term = terminal(["4", "1", "3", "9", "12", "6", "9"]);
  await runManager({ selection, ...term, initialProject: project.id, initialCwd: f.root,
    execute, loadPages: async (_, args) => ({ kind: "ReadSnapshot", records: args.includes("--kind") ? [project] : [],
      recordErrors: [], complete: true, revision: 1, database_instance_id: "fixture",
      database_epoch: "fixture", readAt: "now" }), launch: async (...args) => launches.push(args) });
  assert.match(term.output(), /root no longer resolves to the selected project/);
  assert.match(term.output(), /Context launch blocked/);
  assert.equal(called.includes("work.status"), false);
  assert.deepEqual(launches, []);
});

test("damaged project stays in catalog with raw and history correction evidence", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("project:damaged", "project", { roots: [f.root] }, "global");
  const db = await openWriteDatabase(f.database);
  try {
    const row = db.prepare("SELECT content_json FROM records WHERE id=?").get("project:damaged");
    const stored = JSON.parse(row.content_json);
    delete stored._lodestar.semantics;
    admittedTransaction(db, () => db.prepare("UPDATE records SET content_json=? WHERE id=?")
      .run(JSON.stringify(stored), "project:damaged"));
  } finally { db.close(); }
  const term = terminal(["1", "1", "1", "2", "9"]);
  await runManager({ selection, ...term });
  assert.match(term.output(), /project:damaged \| NEEDS CORRECTION/);
  assert.match(term.output(), /raw_record/);
});

test("Manager saves a shallow edit through a journal and replays the exact request", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("knowledge:edit", "knowledge", { value: 1 });
  const answers = ["3", "knowledge:edit", "1", "5", "Renamed edit", "", "", '{"value":2}',
    "SAVE", "6", "2", "8"];
  const term = terminal(answers);
  assert.equal(await runManager({ selection, ...term }), 0, term.output());
  const after = await f.cli(["get", "knowledge:edit"]);
  assert.equal(after.value.data.data.value, 2, term.output());
  const names = await readdir(path.join(f.root, "pending"));
  assert.equal(names.length, 1);
  const folder = path.join(f.root, "pending", names[0]);
  const request = JSON.parse(await readFile(path.join(folder, "request.json"), "utf8"));
  assert.deepEqual(request.input, { mode: "update", id: "knowledge:edit",
    set: { name: "Renamed edit", data: { value: 2 } }, remove: [] });
  assert.match(term.output(), /Renamed edit \(knowledge:edit\)/,
    "the detail loop should display the refreshed record after Save");
  const firstRevision = after.value.revision;
  const recoveryTerm = terminal(["7", "1", "REPLAY", "9"]);
  assert.equal(await runManager({ selection, ...recoveryTerm }), 0, recoveryTerm.output());
  assert.equal((await f.cli(["get", "knowledge:edit"])).value.revision, firstRevision);
});

test("lost save response keeps the exact journal for one idempotent replay", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("knowledge:uncertain", "knowledge", { value: 1 });
  let writes = 0;
  const requestBytes = [];
  const uncertain = async (selected, invocation) => {
    if (invocation.operation !== "put") return executeCli(selected, invocation);
    writes += 1;
    requestBytes.push(await readFile(invocation.args[invocation.args.indexOf("--file") + 1], "utf8"));
    const real = await executeCli(selected, invocation);
    if (writes === 1) {
      assert.equal(real.kind, "EnvelopeSuccess");
      return { kind: "TransportError", code: "lost_response", message: "Response lost after dispatch",
        mayHaveCommitted: true };
    }
    return real;
  };
  const edit = terminal(["3", "knowledge:uncertain", "1", "5", "", "", "", '{"value":2}',
    "SAVE", "6", "2", "9"]);
  await runManager({ selection, ...edit, execute: uncertain });
  assert.match(edit.output(), /remains in/);
  assert.match(edit.output(), /Write outcome is uncertain/);
  assert.match(edit.output(), /exact saved request in Recovery/);
  assert.match(edit.output(), /Saved request ll-[0-9a-f-]+ at /);
  const after = await f.cli(["get", "knowledge:uncertain"]);
  const replay = terminal(["7", "1", "REPLAY", "9"]);
  await runManager({ selection, ...replay, execute: uncertain });
  assert.equal(writes, 2);
  assert.equal(requestBytes[0], requestBytes[1]);
  assert.equal((await f.cli(["get", "knowledge:uncertain"])).value.revision, after.value.revision);
});

test("recovery refuses changed journal bytes before dispatching any put", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("knowledge:pending-bytes", "knowledge", { value: 1 });
  let puts = 0;
  const uncertain = async (selected, invocation) => {
    if (invocation.operation !== "put") return executeCli(selected, invocation);
    puts += 1;
    return { kind: "TransportError", code: "lost_response", message: "No response", mayHaveCommitted: true };
  };
  const edit = terminal(["3", "knowledge:pending-bytes", "1", "5", "", "", "",
    '{"value":2}', "SAVE", "6", "2", "9"]);
  await runManager({ selection, ...edit, execute: uncertain });
  assert.equal(puts, 1);
  const [name] = await readdir(path.join(f.root, "pending"));
  const file = path.join(f.root, "pending", name, "request.json");
  const originalText = await readFile(file, "utf8");
  const contextFile = path.join(f.root, "pending", name, "context.json");
  const originalContext = JSON.parse(await readFile(contextFile, "utf8"));
  assert.equal(originalContext.request_sha256, createHash("sha256").update(Buffer.from(originalText)).digest("hex"));
  const altered = JSON.parse(originalText);
  altered.input.set.data.value = 3;
  const alteredText = `${JSON.stringify(altered)}\n`;
  const duringReview = terminal(["7", "1", "REPLAY", "9"]);
  const answer = duringReview.ask;
  duringReview.ask = async (question) => {
    if (question.startsWith("Type REPLAY")) await writeFile(file, alteredText);
    return answer(question);
  };
  await runManager({ selection, ...duringReview, execute: uncertain });
  assert.match(duringReview.output(), /Replay blocked: saved request bytes changed during review/);
  assert.equal(puts, 1);
  const recovery = terminal(["7", "1", "REPLAY", "9"]);
  await runManager({ selection: await loadInterfaceConfig(selection.configPath), ...recovery, execute: uncertain });
  assert.match(recovery.output(), /manual repair|Replay blocked/);
  assert.equal(puts, 1, "altered bytes must not reach the CLI");
  await writeFile(file, originalText);
  for (const field of ["request_sha256", "runtime_fingerprint"]) {
    const incomplete = { ...originalContext };
    delete incomplete[field];
    await writeFile(contextFile, `${JSON.stringify(incomplete)}\n`);
    const missing = terminal(["7", "1", "REPLAY", "9"]);
    await runManager({ selection: await loadInterfaceConfig(selection.configPath), ...missing, execute: uncertain });
    assert.match(missing.output(), /Saved request needs manual repair/);
    assert.equal(puts, 1, `${field} is required before replay`);
  }
  assert.equal((await f.cli(["get", "knowledge:pending-bytes"])).value.data.data.value, 1);
});

test("recovery binds journals to their original source fingerprint across restart", async (t) => {
  const f = await fixture(t);
  await f.create("knowledge:source-drift", "knowledge", { value: 1 });
  const loader = path.join(f.root, "Lodestar.Loader.exe");
  const bare = path.join(f.root, "bare");
  await mkdir(path.join(bare, "src"), { recursive: true });
  await writeFile(loader, "fixture");
  const bareCli = path.join(bare, "lodestar.mjs"), module = path.join(bare, "src", "probe.mjs");
  await writeFile(bareCli, "import './src/probe.mjs';");
  await writeFile(module, "export const value = 1;");
  const configPath = path.join(f.root, "interfaces.json");
  await writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(),
    runtime: { node, cli: bareCli, database: f.database }, loader }));
  const selection = await loadInterfaceConfig(configPath);
  let puts = 0;
  const uncertain = async (selected, invocation) => {
    if (invocation.operation === "put") {
      puts += 1;
      return { kind: "TransportError", code: "lost_response", message: "No response", mayHaveCommitted: true };
    }
    return executeCli({ ...selected, cli }, invocation);
  };
  const edit = terminal(["3", "knowledge:source-drift", "1", "5", "", "", "",
    '{"value":2}', "SAVE", "6", "2", "9"]);
  await runManager({ selection, ...edit, execute: uncertain });
  assert.equal(puts, 1);
  const [name] = await readdir(path.join(f.root, "pending"));
  const context = JSON.parse(await readFile(path.join(f.root, "pending", name, "context.json"), "utf8"));
  assert.equal(context.runtime_fingerprint, selection.runtimeFingerprint);
  await writeFile(module, "export const value = 2;");
  const restarted = await loadInterfaceConfig(configPath);
  assert.notEqual(restarted.runtimeFingerprint, selection.runtimeFingerprint);
  const recovery = terminal(["7", "1", "REPLAY", "9"]);
  await runManager({ selection: restarted, ...recovery, execute: uncertain });
  assert.match(recovery.output(), /Replay blocked:.*runtime|Replay blocked:.*configuration/);
  assert.equal(puts, 1, "source drift must block replay before dispatch");
});

test("recovery blocks a repackaged core with the same config generation", async (t) => {
  const f = await fixture(t);
  await f.create("knowledge:bundle-drift", "knowledge", { value: 1 });
  const loader = path.join(f.root, "Lodestar.Loader.exe");
  const app = path.join(f.root, "app");
  const core = path.join(app, "core");
  await mkdir(path.join(core, "src"), { recursive: true });
  await writeFile(loader, "fixture");
  const bundledCli = path.join(core, "lodestar.mjs"), module = path.join(core, "src", "probe.mjs");
  await writeFile(bundledCli, "import './src/probe.mjs';");
  await writeFile(module, "export const value = 1;");
  const manifestPath = path.join(app, "bundle-manifest.json");
  const writeManifest = async () => {
    const files = await Promise.all([bundledCli, module].map(async (file) => {
      const bytes = await readFile(file);
      return { path: path.relative(app, file).replaceAll("\\", "/"), bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") };
    }));
    await writeFile(manifestPath, JSON.stringify({ v: 1, files }));
  };
  await writeManifest();
  const configPath = path.join(app, "interfaces.json");
  await writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(),
    runtime: { node, cli: bundledCli, database: f.database }, loader }));
  const selection = await loadInterfaceConfig(configPath);
  let puts = 0;
  const uncertain = async (selected, invocation) => {
    if (invocation.operation === "put") {
      puts += 1;
      return { kind: "TransportError", code: "lost_response", message: "No response", mayHaveCommitted: true };
    }
    return executeCli({ ...selected, cli }, invocation);
  };
  const edit = terminal(["3", "knowledge:bundle-drift", "1", "5", "", "", "",
    '{"value":2}', "SAVE", "6", "2", "9"]);
  await runManager({ selection, ...edit, execute: uncertain });
  assert.equal(puts, 1);
  await writeFile(module, "export const value = 2;");
  await writeManifest();
  const restarted = await loadInterfaceConfig(configPath);
  assert.notEqual(restarted.runtimeFingerprint, selection.runtimeFingerprint);
  const recovery = terminal(["7", "1", "REPLAY", "9"]);
  await runManager({ selection: restarted, ...recovery, execute: uncertain });
  assert.match(recovery.output(), /Replay blocked:.*runtime|Replay blocked:.*configuration/);
  assert.equal(puts, 1);
});

test("ordinary edit refuses protected project fields and emits explicit data removals", () => {
  const record = { id: "knowledge:x", kind: "knowledge", name: "X", availability: "known",
    priority: 1, data: { a: 1, b: { nested: true } }, semantics: {}, sources: [], write_basis: {} };
  const request = editRequest(record, { data: { a: 2 } }, "ll-test");
  assert.deepEqual(request.input.set, { data: { a: 2 } });
  assert.deepEqual(request.input.remove, ["b"]);
  assert.throws(() => editRequest({ ...record, kind: "project", data: { roots: ["C:/one"], notes: "old" } },
    { data: { roots: ["C:/two"], notes: "new" } }, "ll-test"), /protected/);
  assert.throws(() => editRequest({ ...record, kind: "work" }, { name: "new" }, "ll-test"), /domain command/);
  for (const key of ["catalog_new", "name", "source_fingerprint"]) {
    assert.throws(() => editRequest({ ...record, kind: "project", data: {} },
      { data: { [key]: null } }, "ll-test"), /protected/);
    assert.throws(() => editRequest({ ...record, kind: "project", data: { [key]: null } },
      { data: {} }, "ll-test"), /protected/);
  }
});

test("Manager creates the first project from an empty store and cancels before dispatch", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const cancelled = terminal(["8", "q", "9"]);
  await runManager({ selection, ...cancelled });
  assert.equal((await f.cli(["find", "--all", "--kind", "project"])).value.data.records.length, 0);
  const created = terminal(["8", "Alex", "First Project", f.root, "SAVE", "9"]);
  await runManager({ selection, ...created });
  const project = await f.cli(["get", "project:first-project"]);
  assert.equal(project.code, 0, created.output());
  assert.equal(project.value.data.data.roots.length, 1);
  assert.match(created.output(), /Saved project:first-project at revision/);
  const [journal] = await readdir(path.join(f.root, "pending"));
  const request = JSON.parse(await readFile(path.join(f.root, "pending", journal, "request.json")));
  assert.deepEqual(request.actor, { id: "user:Alex", agent: "human", harness: "manager", session: null });
  assert.equal(request.project_scope, null);
  assert.ok(request.preconditions.some(({ target, expected_revision }) =>
    target.id === "project:first-project" && expected_revision === null));
});

test("Manager creates a project note and refreshes the project list", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const term = terminal(["1", "1", "10", "1", "Alex", "Meeting", "Actual note", "SAVE",
    "2", "3", "12", "2", "9"]);
  await runManager({ selection, ...term });
  const found = await f.cli(["find", "--all", "--kind", "note"]);
  assert.equal(found.value.data.records.length, 1, term.output());
  assert.equal(found.value.data.records[0].data.body, "Actual note");
  assert.match(term.output(), /Project records refreshed at revision/);
  assert.match(term.output(), /Current associated records[\s\S]*note:/);
});

test("human action review requires separate typed SAVE", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const term = terminal(["1", "1", "10", "1", "Alex", "Unsaved", "Draft body", "q",
    "6", "12", "2", "9"]);
  await runManager({ selection, ...term });
  assert.match(term.output(), /Review exact put request/);
  assert.match(term.output(), /Draft cancelled/);
  assert.equal((await f.cli(["find", "--all", "--kind", "note"])).value.data.records.length, 0);
  await assert.rejects(readdir(path.join(f.root, "pending")), { code: "ENOENT" });
});

test("Manager labels supplied research and records a rejection without claiming a fetch", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const term = terminal(["1", "1", "10", "2", "Alex", "Research", "Paper supplied by Alex",
    ">", "First line", "", "  second line  ", ".", "Claim supplied by Alex", "Not verified externally", "SAVE",
    "10", "3", "Alex", "Rejected shortcut", "Shortcut", ">", "Breaks", "project safety", ".", "SAVE",
    "12", "2", "9"]);
  await runManager({ selection, ...term });
  const research = (await f.cli(["find", "--all", "--kind", "research"])).value.data.records;
  const rejection = (await f.cli(["find", "--all", "--kind", "rejection"])).value.data.records;
  assert.equal(research.length, 1, term.output());
  assert.equal(rejection.length, 1, term.output());
  assert.equal(research[0].data.source_reference, "Paper supplied by Alex");
  assert.equal(research[0].data.acquisition, "operator_supplied");
  assert.equal(research[0].data.body, "First line\n\n  second line  ");
  assert.equal(research[0].data.body_sha256,
    createHash("sha256").update("First line\n\n  second line  ").digest("hex"));
  assert.deepEqual(research[0].sources, []);
  assert.equal(research[0].semantics.context_role, "orientation");
  assert.equal(rejection[0].data.subject, "Shortcut");
  assert.equal(rejection[0].data.reason, "Breaks\nproject safety");
  assert.equal(rejection[0].data.verdict, "rejected");
  assert.equal(rejection[0].semantics.context_role, "orientation");
});

test("Manager sets a user-directed decision and retires pending with dedicated commands", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const pending = await f.request({ id: "pending:one", text: "Review later" },
    [{ kind: "record", id: "pending:one" }, { kind: "record", id: "project:test" }],
    "project:test", { id: "agent:fixture", agent: "agent", harness: "test", session: "fixture" });
  assert.equal((await f.cli(["pending", "add", "--cwd", f.root], pending)).code, 0);
  const term = terminal(["1", "1", "10", "4", "Alex", "db:choice", "SQLite",
    "Local state", "Director instruction", "Use SQLite", "SAVE",
    "10", "5", "Alex", "pending:one", "No longer needed", "SAVE", "12", "2", "9"]);
  await runManager({ selection, ...term });
  const decision = await f.cli(["decision", "show", "db:choice", "--cwd", f.root]);
  assert.equal(decision.value.data.facts[0]?.value, "SQLite", term.output());
  assert.equal(decision.value.data.facts[0]?.direction?.reference, "Director instruction");
  const listed = await f.cli(["pending", "list", "--cwd", f.root]);
  assert.equal(listed.value.data.count, 0, term.output());
  const retired = await f.cli(["get", "pending:one"]);
  assert.equal(retired.value.data.semantics.lifecycle, "historical");
  const contexts = await Promise.all((await readdir(path.join(f.root, "pending"))).map(async (name) =>
    JSON.parse(await readFile(path.join(f.root, "pending", name, "context.json")))));
  assert.deepEqual(contexts.map(({ operation }) => operation).sort(), ["decision.set", "pending.drop"]);
});

test("human note action keeps a conflicting request for exact replay", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const bytes = [];
  const observed = async (selected, invocation) => {
    if (invocation.operation === "put") bytes.push(await readFile(
      invocation.args[invocation.args.indexOf("--file") + 1], "utf8"));
    return executeCli(selected, invocation);
  };
  const term = terminal(["1", "1", "10", "1", "Alex", "Conflicted note", "Content",
    "SAVE", "6", "12", "2", "9"]);
  const answer = term.ask;
  term.ask = async (question) => {
    if (question.startsWith("Type SAVE")) {
      const update = await f.request({ mode: "update", id: "project:test",
        set: { data: { local_note: "concurrent" } }, remove: [] },
      [{ kind: "record", id: "project:test" }], "project:test");
      assert.equal((await f.cli(["put"], update)).code, 0);
    }
    return answer(question);
  };
  await runManager({ selection, ...term, execute: observed });
  assert.match(term.output(), /revision_conflict/);
  assert.equal((await f.cli(["find", "--all", "--kind", "note"])).value.data.records.length, 0);
  const [name] = await readdir(path.join(f.root, "pending"));
  const saved = await readFile(path.join(f.root, "pending", name, "request.json"), "utf8");
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], saved);
  const replay = terminal(["7", "1", "REPLAY", "9"]);
  await runManager({ selection, ...replay, execute: observed });
  assert.equal(bytes.length, 2);
  assert.equal(bytes[1], saved);
});

test("lost decision response replays the same human request and revision", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const bytes = [];
  const uncertain = async (selected, invocation) => {
    if (invocation.operation !== "decision.set") return executeCli(selected, invocation);
    bytes.push(await readFile(invocation.args[invocation.args.indexOf("--file") + 1], "utf8"));
    const actual = await executeCli(selected, invocation);
    if (bytes.length === 1) {
      assert.equal(actual.kind, "EnvelopeSuccess", JSON.stringify(actual));
      return { kind: "TransportError", code: "lost_response", message: "Response lost",
        mayHaveCommitted: true };
    }
    return actual;
  };
  const term = terminal(["1", "1", "10", "4", "Alex", "db:choice", "SQLite", "Local state",
    "Director instruction", "Use SQLite", "SAVE", "6", "12", "2", "9"]);
  await runManager({ selection, ...term, execute: uncertain });
  assert.match(term.output(), /Write outcome is uncertain/);
  const first = await f.cli(["decision", "show", "db:choice", "--cwd", f.root]);
  assert.equal(first.value.data.facts[0]?.value, "SQLite");
  const replay = terminal(["7", "1", "REPLAY", "9"]);
  await runManager({ selection, ...replay, execute: uncertain });
  assert.equal(bytes.length, 2, replay.output());
  assert.equal(bytes[0], bytes[1]);
  const after = await f.cli(["decision", "show", "db:choice", "--cwd", f.root]);
  assert.equal(after.value.revision, first.value.revision);
});

test("Recovery treats incomplete journal evidence as an unknown write outcome", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  const folder = path.join(f.root, "pending", `ll-${randomUUID()}`);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "request.json"), '{"incomplete":true}\n');
  let writes = 0;
  const execute = async (selected, invocation) => {
    if (invocation.effect && invocation.effect !== "read") writes += 1;
    return executeCli(selected, invocation);
  };
  const term = terminal(["7", "1", "9"]);
  await runManager({ selection, ...term, execute });
  assert.match(term.output(), /outcome.*unknown/i);
  assert.doesNotMatch(term.output(), /no write was dispatched/);
  assert.equal(await readFile(path.join(folder, "request.json"), "utf8"), '{"incomplete":true}\n');
  assert.equal(writes, 0);
});

test("Recovery preserves unknown outcome after a real committed lost response and journal context loss", async (t) => {
  const f = await fixture(t);
  const selection = await selectionFor(f);
  await f.create("knowledge:missing-context", "knowledge", { value: 1 });
  let writes = 0, requestPath, exactBytes;
  const uncertain = async (selected, invocation) => {
    if (invocation.operation !== "put") return executeCli(selected, invocation);
    writes += 1;
    requestPath = invocation.args[invocation.args.indexOf("--file") + 1];
    exactBytes = await readFile(requestPath);
    const accepted = await executeCli(selected, invocation);
    assert.equal(accepted.kind, "EnvelopeSuccess");
    return { kind: "TransportError", code: "lost_response", message: "Response lost after committed dispatch",
      mayHaveCommitted: true };
  };
  const edit = terminal(["3", "knowledge:missing-context", "1", "5", "", "", "", '{"value":2}',
    "SAVE", "6", "2", "9"]);
  await runManager({ selection, ...edit, execute: uncertain });
  assert.equal(writes, 1);
  const afterCommit = await f.cli(["get", "knowledge:missing-context"]);
  assert.equal(afterCommit.value.data.data.value, 2);
  const folder = path.dirname(requestPath);
  await rm(path.join(folder, "context.json"));
  const filesBefore = await readdir(folder);
  const recovery = terminal(["7", "1", "9"]);
  await runManager({ selection, ...recovery, execute: uncertain });
  assert.match(recovery.output(), /outcome.*unknown/i);
  assert.match(recovery.output(), /preserve|receipt|current record/i);
  assert.doesNotMatch(recovery.output(), /no write was dispatched/);
  assert.equal(writes, 1);
  assert.deepEqual(await readFile(requestPath), exactBytes);
  assert.deepEqual(await readdir(folder), filesBefore);
  const current = await f.cli(["get", "knowledge:missing-context"]);
  assert.equal(current.value.revision, afterCommit.value.revision);
  assert.equal(current.value.data.data.value, 2);
});
