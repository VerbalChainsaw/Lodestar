import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { parseCliResult } from "../src/interface-client.mjs";
import { loadInterfaceConfig } from "../src/interface-config.mjs";
import { runManager } from "../src/manager.mjs";
import { fixture } from "./helpers/contract.mjs";

async function journey(t, answers, { id = "--help", initialProject = null } = {}) {
  const f = await fixture(t);
  await f.create("knowledge:target", "knowledge", { body: "linked proof" });
  const created = await f.request({ mode: "create", record: { id, kind: "knowledge", name: id,
    scope: "global", availability: "known", data: { body: "literal record" },
    aliases: [], links: [{ relationship: "requires", to_id: "knowledge:target" }], sources: [] } },
  [{ kind: "record", id }]);
  assert.equal((await f.cli(["put"], created)).code, 0);
  const loader = path.join(f.root, "Loader.exe");
  await writeFile(loader, "fixture");
  const configPath = path.join(f.root, "interfaces.json");
  await writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(), runtime: {
    node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), database: f.database }, loader }));
  const selection = await loadInterfaceConfig(configPath);
  const before = await f.cli(["get", "--", id]);
  let output = "";
  const calls = [];
  const execute = async (_selection, invocation) => {
    let stdout = "", stderr = "";
    const exitCode = await runCli(["--db", f.database, ...invocation.args], {
      stdin: Readable.from([]), stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } } });
    const result = parseCliResult({ stdout, stderr, exitCode, operation: invocation.operation,
      args: invocation.args, elapsedMs: 1, effect: invocation.effect });
    calls.push({ invocation, result });
    return result;
  };
  assert.equal(await runManager({ selection, initialProject, execute,
    io: { stdout: { write: (text) => { output += text; }, isTTY: true }, stdin: { isTTY: true } },
    ask: async () => answers.shift() ?? null }), 0);
  const after = await f.cli(["get", "--", id]);
  return { f, calls, output, beforeRevision: before.value.revision, afterRevision: after.value.revision };
}

test("Manager detail, links, history, raw and saved refresh preserve a flag-like ID", async (t) => {
  const { f, calls, output } = await journey(t,
    ["2", "1", "2", "3", "4", "5", "Updated", "", "", "", "SAVE", "6", "q", "9"]);
  const reads = calls.filter(({ invocation }) => ["get", "links"].includes(invocation.operation));
  assert.ok(reads.length >= 6, output);
  assert.ok(reads.every(({ result }) => result.kind === "EnvelopeSuccess"), output);
  const history = reads.find(({ invocation }) => invocation.args.includes("--history"));
  const raw = reads.find(({ invocation }) => invocation.args.includes("--raw"));
  const links = reads.find(({ invocation }) => invocation.operation === "links");
  assert.equal(history?.result.envelope.data.id, "--help");
  assert.ok(Array.isArray(history?.result.envelope.data.versions));
  assert.equal(raw?.result.envelope.data.raw_record.id, "--help");
  assert.match(JSON.stringify(links?.result.envelope.data), /knowledge:target/u);
  const current = await f.cli(["get", "--", "--help"]);
  assert.equal(current.value.data.name, "Updated");
  assert.match(output, /Saved --help at revision/u);
});
test("Manager selected exact context preserves an accepted flag-like ID", async (t) => {
  const { calls } = await journey(t, ["9"], { initialProject: "--help" });
  const selected = calls.find(({ invocation }) => invocation.operation === "get");
  assert.equal(selected.result.kind, "EnvelopeSuccess");
  assert.equal(selected.result.envelope.data.id, "--help");
});
for (const query of ["--all", "-h", "-v"]) test(`Manager Search treats ${query} as literal text`, async (t) => {
  const { calls } = await journey(t, ["3", query, "q", "9"], { id: `knowledge:${query}` });
  const found = calls.find(({ invocation }) => invocation.operation === "find");
  assert.equal(found.result.kind, "EnvelopeSuccess");
  assert.equal(found.result.envelope.data.query, query);
  assert.equal(found.result.envelope.data.all, false);
  assert.deepEqual(found.result.envelope.data.records.map(({ id }) => id), [`knowledge:${query}`]);
});

for (const id of ["--help", "--all", "-h", "-v", "knowledge:ordinary"])
  test(`Manager direct read modes preserve ${id} without advancing revision`, async (t) => {
    const { calls, output, beforeRevision, afterRevision } = await journey(t,
      ["2", "1", "2", "3", "4", "6", "q", "9"], { id });
    const reads = calls.filter(({ invocation }) => ["get", "links"].includes(invocation.operation));
    assert.ok(reads.length >= 4, output);
    assert.ok(reads.every(({ result }) => result.kind === "EnvelopeSuccess"), output);
    assert.equal(reads.find(({ invocation }) => invocation.args.includes("--history"))
      ?.result.envelope.data.id, id);
    assert.equal(reads.find(({ invocation }) => invocation.args.includes("--raw"))
      ?.result.envelope.data.raw_record.id, id);
    assert.match(JSON.stringify(reads.find(({ invocation }) => invocation.operation === "links")
      ?.result.envelope.data), /knowledge:target/u);
    assert.equal(afterRevision, beforeRevision);
  });

for (const key of ["--help", "--all", "-h", "-v", "ordinary-key"])
  test(`Manager decision prerequisite preserves ${key} through declined review`, async (t) => {
    // Only the external Git discovery boundary is constrained: this disposable
    // root is not a repository. CLI parser, store reads and Manager remain real.
    const f = await fixture(t);
    const originalSpawnSync = childProcess.spawnSync;
    t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      if (command !== "git") return originalSpawnSync(command, args, options);
      assert.equal(args[0], "-C");
      assert.equal(path.resolve(args[1]).toLowerCase(), path.resolve(f.root).toLowerCase());
      assert.deepEqual(args.slice(2), ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
      assert.equal(options.windowsHide, true);
      return { status: 128, stdout: "", stderr: "fatal: not a git repository", signal: null };
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await f.create("project:literal", "project", { roots: [f.root] }, "project:literal");
    const configPath = path.join(f.root, "interfaces.json");
    await writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(), runtime: {
      node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), database: f.database } }));
    const selection = await loadInterfaceConfig(configPath, { requireLoader: false });
    const before = await f.cli(["get", "--", "project:literal"]);
    const calls = [];
    const execute = async (_selection, invocation) => {
      const actual = await f.cli(invocation.args);
      const result = parseCliResult({ stdout: actual.code === 0 ? JSON.stringify(actual.value) : "",
        stderr: actual.code === 0 ? "" : JSON.stringify(actual.value), exitCode: actual.code,
        operation: invocation.operation, args: invocation.args, elapsedMs: 1, effect: invocation.effect });
      calls.push({ invocation, result });
      return result;
    };
    const answers = ["1", "1", "10", "4", "Alex", key, "Value", "Reason", "user:reference",
      "Use this decision", "q", "6", "11", "2", "9"];
    let output = "";
    assert.equal(await runManager({ selection, execute,
      io: { stdout: { write: text => { output += text; }, isTTY: true }, stdin: { isTTY: true } },
      ask: async () => answers.shift() ?? null }), 0);
    const shown = calls.find(({ invocation }) => invocation.operation === "decision.show");
    assert.equal(shown?.result.kind, "EnvelopeSuccess", output);
    assert.ok(shown.result.envelope.data.write_basis.targets.some(target =>
      target.kind === "decision" && target.key === key && target.scope === "project:literal"));
    assert.equal(shown.result.envelope.revision, before.value.revision);
    assert.equal(shown.result.envelope.data.write_basis.project_scope, "project:literal");
    assert.equal(path.resolve(shown.result.envelope.data.write_basis.checkout), path.resolve(f.root));
    assert.ok(shown.result.envelope.data.write_basis.targets.length > 0);
    assert.match(output, /Review exact decision.set request/);
    assert.match(output, /Draft cancelled/);
    assert.ok(calls.every(({ invocation }) => !invocation.effect || invocation.effect === "read"));
    assert.equal((await f.cli(["get", "--", "project:literal"])).value.revision, before.value.revision);
  });
