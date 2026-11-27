import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callNativeTool } from "../codex-plugin/scripts/lodestar-mcp.mjs";
import { canonicalStringify } from "../src/json.mjs";
import { buildReadArgs } from "../src/interface-client.mjs";
import { admittedTransaction, openReadDatabase, openWriteDatabase } from "../src/database.mjs";
import { resolveProjectScope } from "../src/project.mjs";
import { checkWorkEvidence } from "../src/work-evidence.mjs";
import { fixture } from "./helpers/contract.mjs";

const sha256 = (value) => createHash("sha256").update(canonicalStringify(value)).digest("hex");
const intent = { version: 1, brief: "Ship an evidence-backed result", user_reference: "Director request",
  requirements: [{ id: "R1", text: "Preserve the accepted behavior", acceptance: "Inspect the result and run the focused test" }],
  boundaries: ["Keep one database"], non_goals: ["No runtime control"] };

test("work evidence excludes superseded facts at their current revision while preserving historical inspection", async (t) => {
  for (const lifecycle of ["current", "historical", "superseded"]) {
    const f = await fixture(t);
    await f.create("project:lifecycle", "project", { roots: [f.root] }, "project:lifecycle");
    const proof = await f.create("knowledge:lifecycle-proof", "knowledge", { observation: "Scoped evidence" },
      "project:lifecycle", { lifecycle, context_role: "on_demand" });
    await f.create("knowledge:lifecycle-intent", "knowledge", { intent, acceptance: {
      intent_sha256: sha256(intent), blockers: [], results: [{ requirement_id: "R1", status: "passed",
        notes: "The referenced record supports this acceptance claim.",
        evidence: [{ id: "knowledge:lifecycle-proof", revision: proof.value.data.revision }] }],
    } }, "project:lifecycle");
    const bytes = await readFile(f.database);
    const db = await openReadDatabase(f.database);
    let result;
    try { result = checkWorkEvidence(db, resolveProjectScope(db, "project:lifecycle", f.root),
      "knowledge:lifecycle-intent"); }
    finally { db.close(); }
    assert.equal(result.complete, true, "readability is separate from acceptance readiness");
    assert.equal(result.ready_to_review, lifecycle === "current", `${lifecycle} evidence readiness`);
    assert.equal(result.delta.requirements[0].own_ready_to_review, lifecycle === "current");
    if (lifecycle !== "current") {
      const issue = result.issues.find(({ code }) => code === "evidence_retired");
      assert.ok(issue, `${lifecycle} evidence must explain why it cannot support current acceptance`);
      assert.equal(issue.evidence_id, "knowledge:lifecycle-proof");
      assert.match(issue.action, /replace|restore/i);
      assert.deepEqual(result.actual.requirements[0].current_evidence, []);
    }
    assert.equal((await f.cli(["get", "knowledge:lifecycle-proof", "--history"])).code, 0);
    assert.deepEqual(await readFile(f.database), bytes, "acceptance read preserves all stored bytes");
  }
});

async function setup(t, { intentValue = intent, results = null, evidenceScope = "project:intent" } = {}) {
  const f = await fixture(t);
  await f.create("project:intent", "project", { roots: [f.root] }, "project:intent");
  const proof = await f.create("knowledge:proof", "knowledge", { observation: "focused test output" }, evidenceScope);
  const evidence = [{ id: "knowledge:proof", revision: proof.value.data.revision,
    data_sha256: sha256(proof.value.data.data) }];
  const acceptance = { intent_sha256: sha256(intentValue),
    results: results ?? [{ requirement_id: "R1", status: "passed", evidence,
      notes: "This recorded output addresses R1's focused test." }], blockers: [] };
  await f.create("knowledge:intent", "knowledge", { intent: intentValue, acceptance }, "project:intent");
  const check = (extra = []) => f.cli(["work", "check", "knowledge:intent", "--cwd", f.root, ...extra]);
  const updateIntent = async (data) => f.cli(["put"], await f.request({ mode: "update", id: "knowledge:intent",
    set: { data }, remove: [] }, [{ kind: "record", id: "knowledge:intent" }], "project:intent"));
  return { ...f, check, updateIntent, evidence, acceptance };
}

test("work check reads a stable complete mapping without writing and exposes its contract", async (t) => {
  const f = await setup(t);
  const bytes = await readFile(f.database);
  const first = await f.check();
  assert.equal(first.code, 0, JSON.stringify(first.value));
  assert.equal(first.value.operation, "work.check");
  assert.equal(first.value.data.ready_to_review, true);
  assert.equal(first.value.data.complete, true);
  assert.deepEqual(first.value.data.issues, []);
  assert.equal(first.value.data.continuation, null, "older flat records remain valid");
  assert.deepEqual(first.value.data.plan.root_ids, ["R1"]);
  assert.equal(first.value.data.plan.requirements[0].parent_id, null);
  assert.equal(first.value.data.delta.requirements[0].status, "reported_complete_with_current_evidence");
  assert.match(first.value.data.notice, /supplied|recorded/i);
  assert.deepEqual(first.value.data.write_basis.targets.map(({ id }) => id).sort(),
    ["knowledge:intent", "knowledge:proof", "project:intent"].sort());
  const second = await f.check(["--at-revision", String(first.value.revision)]);
  assert.deepEqual(second.value, first.value);
  assert.deepEqual(await readFile(f.database), bytes);

  const help = (await f.cli(["--help"])).value.data.operations;
  const native = (await callNativeTool("lodestar_describe")).operations;
  for (const operations of [help, native]) {
    const entry = operations.find(({ id }) => id === "work.check");
    assert.equal(entry.effect, "read");
    assert.deepEqual(entry.argv, ["work", "check"]);
    assert.ok(entry.parameters.some(({ name }) => name === "intent_record_id"));
    assert.equal(entry.cli_inputs.command_values.some(({ flag }) => flag === "--limit"), false);
    assert.deepEqual(entry.cli_inputs.remaining_positionals, { min: 1, max: 1, type: "string" });
    assert.match(JSON.stringify(entry), /intent-evidence\.md/);
    assert.ok(entry.record_schema.properties.intent.properties.requirements.items.properties.parent_id);
    assert.ok(entry.record_schema.properties.continuation.properties.active_requirement_ids);
    assert.deepEqual(buildReadArgs(entry, { intent_record_id: "knowledge:intent", cwd: f.root }),
      ["work", "check", "--cwd", f.root, "knowledge:intent"]);
  }
  assert.equal((await f.cli(["work", "status", "--cwd", f.root, "--limit", "1"])).code, 0);
  assert.equal((await f.check(["--limit", "1"])).value.error.code, "unknown_option");
  assert.equal((await f.check(["--file", "request.json"])).value.error.code, "unknown_option");
  assert.equal((await f.cli(["work", "check", "--cwd", f.root])).value.error.code, "missing_argument");
  assert.equal((await f.check(["--at-revision", String(first.value.revision - 1)])).value.error.code,
    "read_revision_conflict");
});

test("work check reports missing and stale supplied results with next actions", async (t) => {
  const f = await setup(t);
  let result = await f.updateIntent({ acceptance: { ...f.acceptance, results: [] } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  let checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "missing_result"));
  assert.ok(checked.next.some((step) => /R1/.test(step)));
  assert.ok((await f.check()).value.next.some((step) => /R1/.test(step)));

  result = await f.updateIntent({ acceptance: { ...f.acceptance, intent_sha256: "0".repeat(64) } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "intent_hash_mismatch"));
  assert.equal(checked.delta.requirements[0].status, "stale_intent");
  assert.equal(checked.delta.requirements[0].subtree_ready_to_review, false);

  result = await f.updateIntent({ acceptance: { ...f.acceptance,
    results: [{ ...f.acceptance.results[0], evidence: [{ ...f.evidence[0], revision: 1 }] }] } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "evidence_revision_stale"));
  assert.equal(checked.delta.requirements[0].status, "reported_complete_needs_evidence");

  result = await f.updateIntent({ acceptance: { ...f.acceptance,
    results: [{ ...f.acceptance.results[0], evidence: [{ ...f.evidence[0], data_sha256: "0".repeat(64) }] }] } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "evidence_hash_mismatch"));

  result = await f.updateIntent({ acceptance: { ...f.acceptance,
    results: [{ ...f.acceptance.results[0], status: "unverified" }] } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "result_not_passed"));
});

test("work check projects a requirement tree and recorded continuation without claiming fresh verification", async (t) => {
  const tree = { ...intent, requirements: [intent.requirements[0],
    { id: "R2", parent_id: "R1", text: "Document the observed result", acceptance: "Review the evidence record" }] };
  const f = await setup(t, { intentValue: tree });
  const continuation = { active_requirement_ids: ["R2"], next_action: "Review R2 evidence" };
  const acceptance = { intent_sha256: sha256(tree), results: [
    f.acceptance.results[0],
    { requirement_id: "R2", status: "unverified", evidence: [], notes: "Awaiting review" },
  ], blockers: [] };
  assert.equal((await f.updateIntent({ intent: tree, acceptance, continuation })).code, 0);
  const bytes = await readFile(f.database);
  const first = await f.check();
  assert.equal(first.code, 0, JSON.stringify(first.value));
  const data = first.value.data;
  assert.equal(data.ready_to_review, false);
  assert.equal(data.plan.intent_sha256, sha256(tree));
  assert.equal(data.plan.brief, tree.brief);
  assert.equal(data.plan.user_reference, tree.user_reference);
  assert.deepEqual(data.plan.boundaries, tree.boundaries);
  assert.deepEqual(data.plan.root_ids, ["R1"]);
  assert.deepEqual(data.plan.requirements.map(({ id, parent_id, child_ids }) =>
    ({ id, parent_id, child_ids })), [
    { id: "R1", parent_id: null, child_ids: ["R2"] },
    { id: "R2", parent_id: "R1", child_ids: [] },
  ]);
  assert.deepEqual(data.continuation, continuation);
  assert.equal(data.actual.requirements[0].supplied_status, "passed");
  assert.equal(data.actual.requirements[1].supplied_status, "unverified");
  assert.equal(data.delta.requirements[0].status, "awaiting_descendants");
  assert.equal(data.delta.requirements[0].own_ready_to_review, true);
  assert.equal(data.delta.requirements[0].subtree_ready_to_review, false);
  assert.equal(data.delta.requirements[1].status, "unverified");
  const second = await f.check(["--at-revision", String(first.value.revision)]);
  assert.deepEqual(second.value, first.value);
  assert.deepEqual(await readFile(f.database), bytes);
  const accepted = { ...acceptance, results: [acceptance.results[0],
    { requirement_id: "R2", status: "passed", evidence: f.evidence,
      notes: "This recorded observation supports R2's review." }] };
  assert.equal((await f.updateIntent({ intent: tree, acceptance: accepted, continuation })).code, 0);
  const completed = (await f.check()).value.data;
  assert.equal(completed.ready_to_review, true);
  assert.equal(completed.delta.requirements[0].status, "reported_complete_with_current_evidence");
  assert.equal(completed.delta.requirements[0].subtree_ready_to_review, true);
});

test("work check rejects missing, self-referential and cyclic parents and unknown active IDs", async (t) => {
  const f = await setup(t);
  const invalidParents = [
    [{ ...intent.requirements[0], parent_id: "missing" }],
    [{ ...intent.requirements[0], parent_id: "R1" }],
    [{ ...intent.requirements[0], parent_id: "R2" },
      { id: "R2", parent_id: "R1", text: "Second", acceptance: "Inspect" }],
  ];
  for (const requirements of invalidParents) {
    const value = { ...intent, requirements };
    assert.equal((await f.updateIntent({ intent: value, acceptance: { ...f.acceptance,
      intent_sha256: sha256(value) } })).code, 0);
    const checked = await f.check();
    assert.equal(checked.value.error.code, "invalid_intent_contract");
    assert.match(checked.value.error.identifiers.pointer, /parent_id$/);
  }
  for (const continuation of [
    { active_requirement_ids: ["missing"], next_action: "Inspect" },
    { active_requirement_ids: ["R1", "R1"], next_action: "Inspect" },
    { active_requirement_ids: ["R1"], next_action: " " },
  ]) {
    assert.equal((await f.updateIntent({ intent, acceptance: f.acceptance, continuation })).code, 0);
    const checked = await f.check();
    assert.equal(checked.value.error.code, "invalid_intent_contract");
    assert.equal(checked.value.error.identifiers.pointer, "/data/continuation");
  }
});

test("work check blocks stale, missing, retired, and out-of-scope evidence", async (t) => {
  const f = await setup(t);
  const update = await f.cli(["put"], await f.request({ mode: "update", id: "knowledge:proof",
    set: { data: { observation: "later result contradicts the earlier observation" } }, remove: [] },
  [{ kind: "record", id: "knowledge:proof" }], "project:intent"));
  assert.equal(update.code, 0, JSON.stringify(update.value));
  let checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false, "a changed evidence record needs a new supplied result");
  assert.ok(checked.issues.some(({ code }) => code === "evidence_revision_stale"));
  const history = (await f.cli(["get", "knowledge:proof", "--history"])).value.data;
  assert.match(JSON.stringify(history.versions), /focused test output/,
    "the earlier evidence remains available for inspection, without counting as current acceptance");

  const retired = await f.cli(["delete"], await f.request({ id: "knowledge:proof", reason: "Superseded" },
    [{ kind: "record", id: "knowledge:proof" }], "project:intent"));
  assert.equal(retired.code, 0, JSON.stringify(retired.value));
  checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "evidence_retired"));

  const missing = await f.updateIntent({ acceptance: { ...f.acceptance,
    results: [{ ...f.acceptance.results[0], evidence: [{ id: "knowledge:missing", revision: 99 }] }] } });
  assert.equal(missing.code, 0, JSON.stringify(missing.value));
  checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "evidence_missing"));
  assert.ok(checked.write_basis.targets.some(({ id, expected_revision: revision }) =>
    id === "knowledge:missing" && revision === null));

  const other = await setup(t, { evidenceScope: "global" });
  checked = (await other.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "evidence_out_of_scope"));
});

test("work check rejects malformed requirements and mappings, and surfaces blockers", async (t) => {
  const f = await setup(t);
  const invalid = [
    { ...intent, requirements: [] },
    { ...intent, requirements: [intent.requirements[0], intent.requirements[0]] },
    { ...intent, requirements: [{ id: "R1", text: "", acceptance: "test" }] },
  ];
  for (const value of invalid) {
    assert.equal((await f.updateIntent({ intent: value, acceptance: { ...f.acceptance,
      intent_sha256: sha256(value) } })).code, 0);
    assert.equal((await f.check()).value.error.code, "invalid_intent_contract");
  }
  assert.equal((await f.updateIntent({ intent, acceptance: { ...f.acceptance,
    results: [f.acceptance.results[0], f.acceptance.results[0]] } })).code, 0);
  assert.equal((await f.check()).value.error.code, "invalid_intent_contract");
  assert.equal((await f.updateIntent({ intent, acceptance: { ...f.acceptance,
    results: [{ ...f.acceptance.results[0], evidence: [{}] }] } })).code, 0);
  assert.equal((await f.check()).value.error.code, "invalid_intent_contract");
  assert.equal((await f.updateIntent({ intent, acceptance: { ...f.acceptance,
    blockers: ["Need operator review"] } })).code, 0);
  const checked = (await f.check()).value.data;
  assert.equal(checked.ready_to_review, false);
  assert.ok(checked.issues.some(({ code }) => code === "unresolved_blocker"));
});

test("work check keeps unreadable evidence visible as incomplete", async (t) => {
  const f = await setup(t);
  const db = await openWriteDatabase(f.database);
  try {
    admittedTransaction(db, () => {
      const row = db.prepare("SELECT content_json FROM records WHERE id=?").get("knowledge:proof");
      const damaged = row.content_json.replace('"observation":"focused test output"',
        '"observation":9007199254740993');
      assert.notEqual(damaged, row.content_json);
      db.prepare("UPDATE records SET content_json=? WHERE id=?").run(damaged, "knowledge:proof");
    }, f.database);
  } finally { db.close(); }
  const result = await f.check();
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.data.ready_to_review, false);
  assert.equal(result.value.data.complete, false);
  assert.equal(result.value.data.record_errors[0].id, "knowledge:proof");
  assert.ok(result.value.data.issues.some(({ code }) => code === "evidence_unreadable"));
  assert.ok(result.value.next.some((action) => /knowledge:proof/.test(action)));
});
