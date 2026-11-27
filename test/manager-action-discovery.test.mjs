import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers/contract.mjs";
import { runManager } from "../src/manager.mjs";
import { executeCli, buildReadArgs } from "../src/interface-client.mjs";
import { loadInterfaceConfig } from "../src/interface-config.mjs";
import * as actions from "../src/operator-actions.mjs";

async function setup(t) {
  const f = await fixture(t), loader = path.join(f.root, "loader.exe");
  await writeFile(loader, "fixture placeholder");
  const config = path.join(f.root, "interfaces.json");
  await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), loader,
    runtime: { node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)), database: f.database } }));
  return { f, selection: await loadInterfaceConfig(config) };
}
function terminal(answers) {
  let output = "";
  return { io: { stdout: { write: (text) => { output += text; } }, stdin: {} },
    ask: async () => answers.shift() ?? null, output: () => output };
}

for (const [question, id, supplied] of [
  ["what remains", "work.check", { intent_record_id: "intent:missing" }],
  ["supporting evidence", "get", { id: "evidence:missing" }],
  ["why was this decision", "decision.show", { key: "choice:missing" }],
  ["previous research", "find", { query: "old research", kind: "research" }],
]) test(`question journey routes typed ${id}`, async (t) => {
  const { f, selection } = await setup(t);
  const help = await executeCli(selection, { operation: "help", args: ["--help"] });
  const descriptor = help.envelope.data.operations.find((op) => op.id === id);
  assert.ok(descriptor.questions.some((entry) => entry.toLowerCase().includes(question)));
  for (const field of ["purpose", "use", "scope", "limits", "recovery"]) assert.equal(typeof descriptor.guidance[field], "string");
  const values = { ...supplied, ...(descriptor.context.project ? { cwd: f.root } : {}) };
  const answers = ["f", question, "1", "yes", ...descriptor.parameters.map((param) => values[param.name] ?? ""), "2", "9"];
  const term = terminal(answers), calls = [];
  const execute = async (selected, invocation) => {
    if (invocation.operation === id) calls.push(invocation.args);
    return executeCli(selected, invocation);
  };
  await runManager({ selection, ...term, execute });
  assert.deepEqual(calls, [buildReadArgs(descriptor, values)], term.output());
  assert.match(term.output(), /unresolved|does not certify|no verified conclusion/i);
});

test("research review records observation separately and saves through guarded exact journal", async (t) => {
  const { f, selection } = await setup(t);
  const body = "Supplied research", hash = createHash("sha256").update(body).digest("hex");
  await f.create("research:old", "research", { body, source_reference: "https://example.invalid/paper",
    body_sha256: hash, claim: "Supplied claim", limitations: "Version dependent", acquisition: "operator_supplied" });
  const old = (await f.cli(["get", "research:old"])).value.data;
  const term = terminal(["3", "research:old", "1", "r", "2025-02-03", "v2", "Scope only; operator checked source", "Alex", "SAVE", "6", "2", "9"]);
  await runManager({ selection, ...term });
  const after = (await f.cli(["get", "research:old"])).value.data;
  assert.equal(after.data.reviewed_at, "2025-02-03");
  assert.equal(after.data.source_version, "v2");
  assert.equal(after.data.reviewed_by, "Alex");
  assert.equal(after.data.review_acquisition, "operator_attested");
  assert.equal(after.data.body_sha256, hash);
  assert.equal(after.data.source_reference, old.data.source_reference);
  assert.notEqual(after.updated_at, after.data.reviewed_at);
  assert.match(term.output(), /operator attestation/i);
  assert.match(term.output(), /https:\/\/example.invalid\/paper/);
});

test("research freshness validates actual date and remains optional", () => {
  assert.equal(typeof actions.researchReviewFields, "function");
  assert.throws(() => actions.researchReviewFields({ reviewed_at: "2025-02-30", reviewed_by: "Alex", review_qualifiers: "scope" }), /date/i);
  assert.throws(() => actions.researchReviewFields({ reviewed_at: "2025-02-03", reviewed_by: "", review_qualifiers: "scope" }), /author/i);
  assert.throws(() => actions.researchReviewFields({ reviewed_at: "2025-02-03", reviewed_by: "Alex", review_qualifiers: "scope", source_version: 0 }), /version/i);
  const record = actions.buildOperatorRecord("research", { id: "research:new", name: "Research", scope: "global",
    author: "Alex", source: "supplied locator", body: "body", claim: "claim", limitations: "limits" });
  assert.equal(record.data.reviewed_at, undefined);
  assert.equal(record.data.acquisition, "operator_supplied");
  const reviewed = actions.buildOperatorRecord("research", { id: "research:reviewed", name: "Research", scope: "global",
    author: "Alex", source: "supplied locator", body: "body", claim: "claim", limitations: "limits",
    reviewed_at: "2025-02-03", source_version: "v1", review_qualifiers: "API scope" });
  assert.equal(reviewed.data.reviewed_at, "2025-02-03");
  assert.equal(reviewed.data.reviewed_by, "Alex");
  assert.equal(reviewed.data.review_acquisition, "operator_attested");
  assert.equal(reviewed.data.body_sha256, record.data.body_sha256);
});

test("action finder leaves no match unresolved and opens existing Recovery inspection", async (t) => {
  const { selection } = await setup(t);
  const term = terminal(["f", "unmatched phrase x91", "f", "recovery", "9"]);
  let writes = 0;
  await runManager({ selection, ...term, execute: async (selected, invocation) => {
    if (invocation.effect && invocation.effect !== "read") writes += 1;
    return executeCli(selected, invocation);
  } });
  assert.match(term.output(), /No matching typed action.*unresolved/);
  assert.match(term.output(), /No saved mutation requests/);
  assert.equal(writes, 0);
});

test("invalid source observation blocks correction without dispatch", async (t) => {
  const { f, selection } = await setup(t);
  await f.create("research:date", "research", { body: "body", source_reference: "supplied", claim: "claim", limitations: "limits" });
  const before = (await f.cli(["get", "research:date"])).value.data;
  const term = terminal(["3", "research:date", "1", "r", "2025-02-30", "", "limits", "Alex", "6", "2", "9"]);
  let writes = 0;
  await runManager({ selection, ...term, execute: async (selected, invocation) => {
    if (invocation.effect && invocation.effect !== "read") writes += 1;
    return executeCli(selected, invocation);
  } });
  assert.match(term.output(), /Research review blocked.*actual calendar date/);
  assert.equal(writes, 0);
  assert.deepEqual((await f.cli(["get", "research:date"])).value.data, before);
});
