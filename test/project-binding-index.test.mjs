import assert from "node:assert/strict";
import test from "node:test";
import { openWriteDatabase } from "../src/database.mjs";
import { prepareProjectRoots, validateProjectBindings } from "../src/project.mjs";
import { fixture } from "./helpers/contract.mjs";

test("project-binding peer checks use ordered covering-index keys", async (t) => {
  const f = await fixture(t);
  await f.create("project:index", "project", { roots: [f.root] }, "project:index");
  await f.create("unrelated:payload", "knowledge", { text: "x".repeat(65536) });
  const db = await openWriteDatabase(f.database);
  try {
    const prepare = db.prepare.bind(db);
    const prepared = prepareProjectRoots(db, { mode: "update", id: "project:index" });
    const queries = [];
    t.mock.method(db, "prepare", (sql) => { queries.push(sql); return prepare(sql); });
    validateProjectBindings(db, "project:index", prepared);
    const legacy = "SELECT id FROM records WHERE type='project' AND id<>? ORDER BY id";
    const lookup = queries.find((sql) => sql.replace(" INDEXED BY records_scope_type_id", "") === legacy);
    assert.ok(lookup);
    // Use an absent ID to include the stored project; the unrelated payload remains excluded.
    assert.deepEqual(prepare(lookup).all("project:not-found"), prepare(legacy).all("project:not-found"));
    const plan = prepare("EXPLAIN QUERY PLAN " + lookup).all("project:index").map(({ detail }) => detail);
    assert.ok(plan.some((detail) => detail.includes("COVERING INDEX records_scope_type_id")), plan.join("; "));
    assert.ok(!plan.includes("SCAN records"), plan.join("; "));
  } finally { db.close(); }
});
