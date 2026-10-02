import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { openReadDatabase } from "../src/database.mjs";
import { canonicalStringify } from "../src/json.mjs";
import { resolveProjectScope } from "../src/project.mjs";
import { checkWorkEvidence } from "../src/work-evidence.mjs";
import { fixture } from "./helpers/contract.mjs";

async function setup(t, count, failedLeaf = false) {
  const f = await fixture(t);
  await f.create("project:scale", "project", { roots: [f.root] }, "project:scale");
  const proof = await f.create("knowledge:scale-proof", "knowledge", { observation: "A common proof for each requirement" }, "project:scale");
  const intent = { version: 1, brief: "Flat linked requirements", user_reference: "Mechanism test",
    boundaries: ["Keep coherent mappings"], non_goals: [], requirements: Array.from({ length: count }, (_, i) => ({
      id: `R${i}`, text: `Outcome ${i}`, acceptance: `Inspect proof ${i}`, ...(i ? { parent_id: `R${i - 1}` } : {}) })) };
  await f.create("knowledge:scale-intent", "knowledge", { intent, acceptance: {
    intent_sha256: crypto.createHash("sha256").update(canonicalStringify(intent)).digest("hex"), blockers: [],
    results: intent.requirements.map(({ id }, i) => ({ requirement_id: id,
      status: failedLeaf && i === count - 1 ? "failed" : "passed", notes: "Common proof exercises linked readiness",
      evidence: [{ id: "knowledge:scale-proof", revision: proof.value.data.revision }] })) } }, "project:scale");
  return f;
}
test("public work check resolves deep flat ancestry without recursive stack failure or writes", async (t) => {
  const f = await setup(t, 6000);
  const bytes = await readFile(f.database);
  const result = await f.cli(["work", "check", "knowledge:scale-intent", "--cwd", f.root]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.data.ready_to_review, true);
  assert.equal(result.value.data.delta.requirements.length, 6000);
  assert.ok(result.value.data.delta.requirements.every(row => row.subtree_ready_to_review));
  assert.deepEqual(await readFile(f.database), bytes);
});
test("failed leaf propagates to every ancestor regardless of result order", async (t) => {
  const f = await setup(t, 30, true);
  const result = await f.cli(["work", "check", "knowledge:scale-intent", "--cwd", f.root]);
  assert.equal(result.code, 0);
  assert.equal(result.value.data.delta.requirements.at(-1).status, "failed");
  assert.ok(result.value.data.delta.requirements.slice(0, -1).every(row => row.status === "awaiting_descendants"));
});
test("one projection hashes shared current evidence once and never caches across checks", async (t) => {
  const f = await setup(t, 40);
  const db = await openReadDatabase(f.database);
  const original = crypto.createHash;
  let bodyHashCalls = 0;
  crypto.createHash = (...args) => {
    const hash = original(...args), update = hash.update;
    hash.update = function (data, ...other) {
      if (data === canonicalStringify({ observation: "A common proof for each requirement" })) bodyHashCalls += 1;
      return update.call(this, data, ...other);
    };
    return hash;
  };
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 2; i += 1) {
      const result = checkWorkEvidence(db, resolveProjectScope(db, "project:scale", f.root), "knowledge:scale-intent");
      assert.equal(result.ready_to_review, true);
      assert.equal(bodyHashCalls, i + 1, "Exact evidence body hashed once per coherent projection");
    }
  } finally { crypto.createHash = original; syncBuiltinESMExports(); db.close(); }
});
