import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runManager } from "../src/manager.mjs";
import { runCli } from "../src/cli.mjs";
import { executeCli } from "../src/interface-client.mjs";
import { loadInterfaceConfig } from "../src/interface-config.mjs";
import { fixture } from "./helpers/contract.mjs";

const snapshot = (overrides = {}) => ({ kind: "ReadSnapshot", records: [], revision: 7,
  database_instance_id: "fixture-instance", database_epoch: "fixture-epoch",
  readAt: "2026-09-30T00:00:00.000Z", complete: true, recordErrors: [], advisories: [], ...overrides });
const damaged = (id = "--damaged literal id") => ({ code: "record_requires_source_correction",
  message: "Stored semantics cannot be decoded.", identifiers: { id },
  action: "Read the raw row and retained history before correcting the source." });

async function journey(answers, snapshots, database = "fixture-only") {
  let output = "";
  const calls = [], reads = [];
  const exitCode = await runManager({
    selection: { node: process.execPath, cli: "fixture-only", database },
    io: { stdout: { write(text) { output += text; } }, stdin: {} },
    ask: async () => answers.shift() ?? null,
    execute: async (_selected, invocation) => {
      calls.push(invocation);
      assert.equal(invocation.operation, "help", "diagnostic browsing dispatched an unexpected operation");
      return { kind: "EnvelopeSuccess", envelope: { data: { capability_version: 1, operations: [] } } };
    },
    loadPages: async (_selected, args) => {
      reads.push(args);
      assert.ok(snapshots.length, "unexpected library read");
      return snapshots.shift();
    },
  });
  assert.equal(exitCode, 0, output);
  assert.equal(snapshots.length, 0, "expected snapshots were not read");
  assert.deepEqual(calls.map(({ operation, effect }) => [operation, effect]), [["help", "read"]]);
  return { output, reads };
}

function argumentRows(output, label) {
  return output.split("\n").filter((line) => line.startsWith(`${label}: `))
    .map((line) => JSON.parse(line.slice(label.length + 2)));
}

test("partial Global library retains damaged literal ID, action, advisory and raw/history routes", async () => {
  const { output } = await journey(["2", "9"], [snapshot(), snapshot({ complete: false,
    recordErrors: [damaged()], advisories: ["One stored row failed semantic decoding."] })]);
  assert.match(output, /Record error --damaged literal id \[record_requires_source_correction\]/);
  assert.match(output, /Read the raw row and retained history before correcting the source/);
  assert.match(output, /Advisory: One stored row failed semantic decoding/);
  assert.deepEqual(argumentRows(output, "Raw read arguments"), [["--db", "fixture-only", "get", "--raw", "--", "--damaged literal id"]]);
  assert.deepEqual(argumentRows(output, "History read arguments"), [["--db", "fixture-only", "get", "--history", "--", "--damaged literal id"]]);
  assert.match(output, /Global knowledge.*no loaded matches in this partial read/);
  assert.doesNotMatch(output, /no recorded matches/);
});

test("library presents catalog diagnostics even when only catalog completeness is lost", async () => {
  const { output } = await journey(["2", "9"], [snapshot({ complete: false,
    recordErrors: [damaged("project:damaged")], advisories: ["Catalog decoding incomplete."] }), snapshot()]);
  assert.match(output, /project:damaged/);
  assert.match(output, /Catalog decoding incomplete/);
  assert.match(output, /Global knowledge.*no loaded matches in this partial read/);
  assert.doesNotMatch(output, /no recorded matches/);
});

test("oversized literal IDs have counted omitted routes and complete page recovery", async () => {
  const { output } = await journey(["2", "9"], [snapshot(), snapshot({ complete: false,
    recordErrors: [damaged(`note:${"z".repeat(8000)}`)] })]);
  assert.doesNotMatch(output, /z{500}/);
  assert.match(output, /2 literal read argument arrays omitted/);
  assert.match(output, /exact.*ID.*full read/i);
  assert.equal(argumentRows(output, "Raw read arguments").length, 0);
  assert.equal(argumentRows(output, "Full read arguments").length, 1);
});

test("bounded library diagnostics count omitted rows and text with complete pinned read recovery", async () => {
  const errors = Array.from({ length: 10 }, (_, index) => ({ ...damaged(`note:damaged-${index}`),
    message: `Row ${index} ${"x".repeat(800)}`, action: `Read evidence ${"a".repeat(800)}` }));
  const { output } = await journey(["2", "9"], [snapshot(), snapshot({ complete: false,
    recordErrors: errors, advisories: Array.from({ length: 10 }, (_, index) => `Notice ${index}`) })]);
  assert.match(output, /2 more record errors omitted/);
  assert.match(output, /2 more advisories omitted/);
  assert.doesNotMatch(output, /note:damaged-8|Notice 8|x{500}|a{500}/);
  assert.match(output, /Diagnostic text is bounded/);
  assert.deepEqual(argumentRows(output, "Full read arguments"), [
    ["--db", "fixture-only", "find", "--output", "<new-file>", "--all", "--limit", "250", "--at-revision", "7"]]);
  assert.match(output, /--args-file/);
  assert.match(output, /next.*argument arrays.*revision/i);
});

test("Search shares complete diagnostic recovery while preserving literal query position", async () => {
  const { output } = await journey(["3", "--query literal", "9"], [snapshot({ complete: false,
    recordErrors: [damaged("9007199254740993")], advisories: ["No continuation was returned."] })]);
  assert.deepEqual(argumentRows(output, "Raw read arguments"), [["--db", "fixture-only", "get", "--raw", "--", "9007199254740993"]]);
  assert.deepEqual(argumentRows(output, "Full read arguments"), [["--db", "fixture-only", "find", "--output", "<new-file>",
    "--limit", "250", "--at-revision", "7", "--", "--query literal"]]);
  assert.match(output, /no loaded matches in this partial read/);
});

test("a partial refresh reports new causes before retaining the last complete library", async () => {
  const retained = { id: "note:retained", name: "Retained complete", kind: "knowledge", scope: "global" };
  const { output } = await journey(["2", "2", "2", "2", "9"], [snapshot(), snapshot({ records: [retained] }),
    snapshot({ revision: 8 }), snapshot({ revision: 8, complete: false,
      recordErrors: [damaged("note:new-damage")], advisories: ["New read is incomplete."] })]);
  assert.match(output, /note:new-damage/);
  assert.match(output, /New read is incomplete/);
  assert.match(output, /showing last complete snapshot from 2026-09-30T00:00:00.000Z/);
  assert.equal(output.split("note:retained").length - 1, 2);
  assert.ok(output.indexOf("note:new-damage") < output.indexOf("showing last complete snapshot"));
});

test("complete empty library retains its full absence claim", async () => {
  const { output } = await journey(["2", "9"], [snapshot(), snapshot()]);
  assert.match(output, /Global knowledge: no recorded matches/);
  assert.doesNotMatch(output, /partial|Record error|Full read arguments/);
});

test("partial empty project domain filters describe loaded evidence", async () => {
  const project = { id: "project:one", name: "One", kind: "project", scope: "project:one" };
  const { output } = await journey(["1", "1", "8", "11", "2", "9"], [snapshot({ records: [project] }),
    snapshot({ complete: false, advisories: ["Loaded records stopped at client bound."] })]);
  assert.match(output, /rejection records.*no loaded matches in this partial read/);
  assert.doesNotMatch(output, /rejection records: no recorded matches/);
});

test("project overview reports library incomplete when the catalog is partial", async () => {
  const project = { id: "project:one", name: "One", kind: "project", scope: "project:one" };
  const { output } = await journey(["1", "1", "1", "11", "2", "9"], [snapshot({ records: [project],
    complete: false, advisories: ["Catalog stopped at client bound."] }), snapshot()]);
  assert.match(output, /Current associated records loaded: 1; library complete: false/);
  assert.doesNotMatch(output, /library complete: true/);
});

test("mixed revisions never display damaged causes or records from rejected snapshots", async () => {
  const { output, reads } = await journey(["2", "9"], [snapshot(), snapshot({ revision: 8,
    complete: false, recordErrors: [damaged("note:mixed-revision")] }), snapshot({ revision: 9 }), snapshot({ revision: 9 })]);
  assert.equal(reads.length, 4);
  assert.deepEqual(reads[1].slice(-2), ["--at-revision", "7"]);
  assert.deepEqual(reads[3].slice(-2), ["--at-revision", "9"]);
  assert.doesNotMatch(output, /note:mixed-revision|Library is partial/);
  assert.match(output, /Global knowledge: no recorded matches/);
});

test("displayed recovery arrays use selected database and execute literal reads without changing it", async (t) => {
  const f = await fixture(t);
  await f.create("--literal-id", "knowledge", { text: "source" });
  const revision = (await f.cli(["get", "--", "--literal-id"])).value.revision;
  const before = await readFile(f.database);
  const { output } = await journey(["2", "9"], [snapshot({ revision }), snapshot({ revision, complete: false,
    recordErrors: [damaged("--literal-id")] })], f.database);
  for (const label of ["Raw read arguments", "History read arguments", "Full read arguments"]) {
    const [args] = argumentRows(output, label);
    assert.deepEqual(args.slice(0, 2), ["--db", f.database]);
    if (label === "Full read arguments") args[args.indexOf("<new-file>")] = path.join(f.root, "full-response.json");
    const argumentFile = path.join(f.root, `${label.split(" ")[0]}.json`);
    await writeFile(argumentFile, JSON.stringify(args));
    let response = "";
    assert.equal(await runCli(["--args-file", argumentFile], { stdin: Readable.from([]),
      stdout: { write: (text) => { response += text; } }, stderr: { write: (text) => { response += text; } } }), 0, response);
    const envelope = JSON.parse(response);
    assert.equal(envelope.ok, true);
    if (label === "Full read arguments") {
      const bytes = await readFile(envelope.data.output_file.path);
      assert.equal(bytes.length, envelope.data.output_file.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), envelope.data.output_file.sha256);
      assert.equal(JSON.parse(bytes).data.records[0].id, "--literal-id");
    }
  }
  assert.deepEqual(await readFile(f.database), before);
});

for (const [coreCode, committed] of [["database_commit_outcome_unknown", "unknown"],
  ["database_connection_cleanup_failed", true]]) {
  test(`Manager retains ${coreCode} action/certainty in saved exact request and Recovery`, async (t) => {
    const f = await fixture(t), loader = path.join(f.root, "loader.exe"), config = path.join(f.root, "interfaces.json");
    await writeFile(loader, "fixture executable placeholder");
    await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), loader,
      runtime: { node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), database: f.database } }));
    const selection = await loadInterfaceConfig(config);
    await f.create("knowledge:semantic-outcome", "knowledge", { value: 1 });
    let writes = 0, exactBytes, requestPath;
    const execute = async (selected, invocation) => {
      const result = await executeCli(selected, invocation);
      if (invocation.operation !== "put") return result;
      writes += 1;
      requestPath = invocation.args[invocation.args.indexOf("--file") + 1];
      exactBytes = await readFile(requestPath);
      assert.equal(result.kind, "EnvelopeSuccess");
      return { kind: "TransportError", code: coreCode, message: "Adapter retained uncertainty.",
        mayHaveCommitted: true, envelope: { v: 5, ok: false, operation: "put", revision: result.envelope.revision,
          database_instance_id: result.envelope.database_instance_id, database_epoch: result.envelope.database_epoch,
          request: result.envelope.request, more: false,
          error: { code: coreCode, message: "Original native outcome report failed.",
            identifiers: { committed, request_id: result.envelope.request.id },
            action: "Preserve the original request; inspect its receipt and current state before exact replay." },
          next: ["Reconcile the original request with the current record before another write."] } };
    };
    const run = async (answers) => {
      let output = "";
      assert.equal(await runManager({ selection, execute, io: { stdout: { write: (text) => { output += text; } }, stdin: {} },
        ask: async () => answers.shift() ?? null }), 0);
      return output;
    };
    const output = await run(["3", "knowledge:semantic-outcome", "1", "5", "Reviewed draft", "", "", '{"value":2}', "SAVE", "6", "2", "9"]);
    assert.match(output, new RegExp(`Lodestar ${coreCode}:`));
    assert.match(output, /Action: Preserve the original request/);
    assert.match(output, /Next: Reconcile the original request/);
    assert.match(output, new RegExp(`Reported commit certainty: ${committed}`));
    assert.match(output, /inspect.*receipt and current.*before any exact replay/i);
    assert.doesNotMatch(output, /write was not dispatched|Refresh before making a changed request/);
    const names = await readdir(path.join(f.root, "pending"));
    assert.equal(names.length, 1);
    const saved = JSON.parse(await readFile(path.join(f.root, "pending", names[0], "response.json"), "utf8"));
    assert.equal(saved.error.code, coreCode);
    const recovery = await run(["7", "1", "q", "9"]);
    assert.match(recovery, new RegExp(`Recorded commit certainty: ${committed}`));
    assert.match(recovery, /Action: Preserve the original request/);
    assert.match(recovery, /Next: Reconcile the original request/);
    assert.match(recovery, /inspect.*receipt and current.*before.*replay/i);
    assert.equal(writes, 1);
    assert.deepEqual(await readFile(requestPath), exactBytes);
    assert.equal(JSON.parse(exactBytes).input.set.name, "Reviewed draft");
    assert.equal((await f.cli(["get", "knowledge:semantic-outcome"])).value.data.data.value, 2);
  });
}

for (const [withEnvelope, retentionFails] of [[true, false], [false, false], [true, true]]) {
  test(`rejected replay preserves earlier uncertainty (${withEnvelope ? "semantic envelope" : "no envelope"}; retention ${retentionFails ? "fails" : "works"})`, async (t) => {
    const f = await fixture(t), loader = path.join(f.root, "loader.exe"), config = path.join(f.root, "interfaces.json");
    await writeFile(loader, "fixture executable placeholder");
    await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), loader,
      runtime: { node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), database: f.database } }));
    const selection = await loadInterfaceConfig(config);
    await f.create("knowledge:earlier-outcome", "knowledge", { value: 1 });
    let writes = 0, requestPath, exactBytes, originalEnvelope;
    const execute = async (selected, invocation) => {
      if (invocation.operation !== "put") return executeCli(selected, invocation);
      writes += 1;
      requestPath = invocation.args[invocation.args.indexOf("--file") + 1];
      const bytes = await readFile(requestPath);
      if (writes === 1) {
        exactBytes = bytes;
        const accepted = await executeCli(selected, invocation);
        assert.equal(accepted.kind, "EnvelopeSuccess");
        originalEnvelope = { ...accepted.envelope, ok: false,
          error: { code: "database_commit_outcome_unknown", message: "Native report unavailable.",
            identifiers: { committed: "unknown" }, action: "Inspect original receipt and current state." },
          next: ["Preserve the first uncertainty report."] };
        delete originalEnvelope.data;
        return { kind: "TransportError", code: withEnvelope ? "database_commit_outcome_unknown" : "lost_response",
          message: "Original response unavailable.", mayHaveCommitted: true,
          ...(withEnvelope ? { envelope: originalEnvelope } : {}) };
      }
      assert.deepEqual(bytes, exactBytes);
      return { kind: "EnvelopeError", envelope: { v: 5, ok: false, operation: "put",
        error: { code: "revision_conflict", message: "This replay was rejected.", identifiers: {}, action: "Inspect the conflict." },
        more: false, next: [] } };
    };
    const run = async (answers) => {
      let output = "";
      assert.equal(await runManager({ selection, execute, io: { stdout: { write: (text) => { output += text; } }, stdin: {} },
        ask: async () => answers.shift() ?? null }), 0);
      return output;
    };
    await run(["3", "knowledge:earlier-outcome", "1", "5", "Retained draft", "", "", '{"value":2}', "SAVE", "6", "2", "9"]);
    const afterCommit = (await f.cli(["get", "knowledge:earlier-outcome"])).value;
    if (retentionFails) {
      const folder = path.dirname(requestPath), responsePath = path.join(folder, "response.json");
      const responseBytes = await readFile(responsePath);
      await fs.rm(path.join(folder, "response.uncertainty.json")); // Existing pre-repair journal layout.
      const original = fs.writeFile;
      fs.writeFile = async (file, bytes, options) => {
        if (file === path.join(folder, "response.uncertainty.json")) {
          assert.equal(options?.flag, "wx");
          assert.equal(options?.flush, true);
          throw Object.assign(new Error("Injected first uncertainty flush failure"), { code: "EIO" });
        }
        return original(file, bytes, options);
      };
      syncBuiltinESMExports();
      t.after(() => { fs.writeFile = original; syncBuiltinESMExports(); });
      const recovery = await run(["7", "1", "REPLAY", "9"]);
      assert.match(recovery, /Replay blocked; prior uncertainty could not be retained/);
      assert.match(recovery, /Injected first uncertainty flush failure/);
      assert.equal(writes, 1);
      assert.deepEqual(await readFile(responsePath), responseBytes);
      assert.deepEqual(await readFile(requestPath), exactBytes);
      return;
    }
    const replay = await run(["7", "1", "REPLAY", "9"]);
    assert.match(replay, /This replay was rejected/);
    const recovery = await run(["7", "1", "q", "9"]);
    assert.match(recovery, /Earlier attempt.*(?:unknown|uncertain)/i);
    if (withEnvelope) {
      assert.match(recovery, /Earlier failure database_commit_outcome_unknown: Native report unavailable/);
      assert.match(recovery, /Action: Inspect original receipt and current state/);
      assert.match(recovery, /Next: Preserve the first uncertainty report/);
    } else assert.match(recovery, /Earlier failure lost_response: Original response unavailable/);
    assert.match(recovery, /latest.*(?:rejection|rejected).*does not.*(?:earlier|original)/i);
    assert.match(recovery, /receipt and current.*before.*replay/i);
    const folder = path.dirname(requestPath);
    const retained = await readFile(path.join(folder, "response.uncertainty.json"));
    if (withEnvelope) assert.deepEqual(retained, Buffer.from(`${JSON.stringify(originalEnvelope)}\n`));
    else assert.equal(JSON.parse(retained).mayHaveCommitted, true);
    assert.equal(JSON.parse(await readFile(path.join(folder, "response.json"))).error.code, "revision_conflict");
    assert.deepEqual(await readFile(requestPath), exactBytes);
    assert.equal(JSON.parse(exactBytes).input.set.name, "Retained draft");
    assert.equal((await f.cli(["get", "knowledge:earlier-outcome"])).value.revision, afterCommit.revision);
    assert.equal(writes, 2);
    assert.equal((await readdir(folder)).filter((name) => name.startsWith("response.")).length, 2);
  });
}

test("read errors preserve their correction action without claiming uncertain write dispatch", async () => {
  let output = "";
  assert.equal(await runManager({ selection: { node: process.execPath, cli: "fixture-only", database: "fixture-only" },
    io: { stdout: { write: (text) => { output += text; } }, stdin: {} }, ask: async () => "9",
    execute: async (_selection, invocation) => {
      assert.equal(invocation.operation, "help");
      assert.equal(invocation.effect, "read");
      return { kind: "EnvelopeError", envelope: { error: { code: "database_commit_outcome_unknown",
        message: "Read failed.", identifiers: { committed: "unknown" }, action: "Inspect the read source." }, next: [] } };
    } }), 0);
  assert.match(output, /Action: Inspect the read source/);
  assert.doesNotMatch(output, /Write outcome is uncertain|Reported commit certainty|saved request/);
});

async function retainedFixture(t) {
  const f = await fixture(t), loader = path.join(f.root, "loader.exe"), config = path.join(f.root, "interfaces.json");
  await writeFile(loader, "fixture executable placeholder");
  await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), loader,
    runtime: { node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), database: f.database } }));
  const selection = await loadInterfaceConfig(config);
  await f.create("knowledge:retained-admission", "knowledge", { value: 1 });
  const state = { writes: 0, replayHook: null };
  const execute = async (selected, invocation) => {
    if (invocation.operation !== "put") return executeCli(selected, invocation);
    state.writes += 1;
    state.requestPath = invocation.args[invocation.args.indexOf("--file") + 1];
    if (state.writes > 1 && state.replayHook) await state.replayHook();
    const accepted = await executeCli(selected, invocation);
    assert.equal(accepted.kind, "EnvelopeSuccess");
    const envelope = { ...accepted.envelope, ok: false,
      error: { code: "database_commit_outcome_unknown", message: "Original retained report.",
        identifiers: { committed: "unknown", request_id: accepted.envelope.request.id },
        action: "Inspect original request and receipt." }, next: [] };
    delete envelope.data;
    return { kind: "TransportError", code: "database_commit_outcome_unknown", message: "Adapter retained uncertainty.",
      mayHaveCommitted: true, envelope };
  };
  const run = async (answers) => {
    let output = "";
    assert.equal(await runManager({ selection, execute,
      io: { stdout: { write: (text) => { output += text; } }, stdin: {} }, ask: async () => answers.shift() ?? null }), 0);
    return output;
  };
  await run(["3", "knowledge:retained-admission", "1", "5", "Protected draft", "", "", '{"value":2}', "SAVE", "6", "2", "9"]);
  const folder = path.dirname(state.requestPath), retainedPath = path.join(folder, "response.uncertainty.json");
  const report = JSON.parse(await readFile(retainedPath));
  return { f, state, run, report, retainedPath, responsePath: path.join(folder, "response.json"),
    requestBytes: await readFile(state.requestPath), contextBytes: await readFile(path.join(folder, "context.json")) };
}

for (const [name, change] of [
  ["version", (report) => ({ ...report, v: 999 })],
  ["operation", (report) => ({ ...report, operation: "decision.set" })],
  ["store", (report) => ({ ...report, database_instance_id: "foreign-store" })],
  ["epoch", (report) => ({ ...report, database_epoch: "foreign-epoch" })],
  ["request", (report) => ({ ...report, request: { id: "foreign-request" } })],
  ["top request id", (report) => ({ ...report, request_id: "foreign-top-request" })],
  ["identifier request", (report) => ({ ...report, error: { ...report.error,
    identifiers: { committed: true, request_id: "foreign-request" } } })],
  ["error shape", (report) => ({ ...report, error: { identifiers: { committed: true } } })],
  ["unsupported marker", () => ({ kind: "foreign-format", mayHaveCommitted: true, code: "foreign" })],
  ["truncated JSON", () => null],
]) test(`retained admission rejects contradictory ${name} before showing an earlier attempt or replaying`, async (t) => {
  const x = await retainedFixture(t);
  const foreign = change(x.report);
  if (foreign?.error) foreign.error.action = "Foreign report recovery action.";
  const foreignBytes = Buffer.from(name === "truncated JSON" ? '{"v":5,' : `${JSON.stringify(foreign)}\n`);
  await writeFile(x.retainedPath, foreignBytes);
  const output = await x.run(["7", "1", "REPLAY", "9"]);
  assert.match(output, /Retained uncertainty evidence could not be verified/);
  assert.ok(output.includes(x.retainedPath), "error must identify the exact rejected retained file");
  assert.match(output, /Action: Preserve.*inspect.*original.*receipt.*current/i);
  assert.doesNotMatch(output, /Earlier attempt commit certainty|Foreign report recovery action/);
  assert.equal(x.state.writes, 1);
  assert.deepEqual(await readFile(x.retainedPath), foreignBytes);
  assert.deepEqual(await readFile(x.state.requestPath), x.requestBytes);
  assert.deepEqual(await readFile(path.join(path.dirname(x.state.requestPath), "context.json")), x.contextBytes);
});

test("legitimate core unknown with absent or null identity stays unresolved in retained Recovery", async (t) => {
  const x = await retainedFixture(t);
  const unknown = { v: 5, ok: false, operation: "put", more: false, next: [],
    revision: null, database_instance_id: null, request: null,
    error: { code: "database_commit_outcome_unknown", message: "Core identity was unavailable.",
      identifiers: { committed: "unknown" }, action: "Inspect original receipt and current state." } };
  const bytes = Buffer.from(`${JSON.stringify(unknown)}\n`);
  await writeFile(x.retainedPath, bytes);
  const output = await x.run(["7", "1", "q", "9"]);
  assert.match(output, /Earlier attempt commit certainty: unknown/);
  assert.match(output, /Core identity was unavailable/);
  assert.doesNotMatch(output, /could not be verified|Receipt confirmed|already committed/);
  assert.deepEqual(await readFile(x.retainedPath), bytes);
  assert.equal(x.state.writes, 1);
});

test("legacy no-envelope retained marker is described as folder-local unresolved provenance", async (t) => {
  const x = await retainedFixture(t);
  const bytes = Buffer.from(`${JSON.stringify({ kind: "TransportError", code: "lost_response",
    message: "No original envelope.", mayHaveCommitted: true })}\n`);
  await writeFile(x.retainedPath, bytes);
  const output = await x.run(["7", "1", "q", "9"]);
  assert.match(output, /folder-local.*(?:identity|request).*unknown/i);
  assert.doesNotMatch(output, /Receipt confirmed|already committed/);
  assert.deepEqual(await readFile(x.retainedPath), bytes);
});

test("EEXIST retention rechecks the existing first slot against this exact journal before latest replacement", async (t) => {
  const x = await retainedFixture(t), before = await readFile(x.responsePath);
  const foreign = { ...x.report, request: { id: "foreign-after-inspection" },
    error: { ...x.report.error, identifiers: { committed: true, request_id: "foreign-after-inspection" } } };
  const foreignBytes = Buffer.from(`${JSON.stringify(foreign)}\n`);
  x.state.replayHook = () => writeFile(x.retainedPath, foreignBytes);
  const output = await x.run(["7", "1", "REPLAY", "9"]);
  assert.match(output, /Response could not be journaled/);
  assert.ok(output.includes(x.retainedPath));
  assert.match(output, /request.*(?:mismatch|contradict|conflict)/i);
  assert.match(output, /Action: Preserve.*original.*receipt.*current/i);
  assert.equal(x.state.writes, 2);
  assert.deepEqual(await readFile(x.responsePath), before);
  assert.deepEqual(await readFile(x.retainedPath), foreignBytes);
  assert.deepEqual(await readFile(x.state.requestPath), x.requestBytes);
});
