import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { admittedTransaction, openReadDatabase, openWriteDatabase } from "../src/database.mjs";
import { resolveProject, resolveProjectScope } from "../src/project.mjs";
import { fixture } from "./helpers/contract.mjs";

async function snapshot(f) {
  const db = await openReadDatabase(f.database);
  try { return JSON.stringify({ records: db.prepare("SELECT * FROM records ORDER BY id").all(),
    links: db.prepare("SELECT * FROM links ORDER BY from_id,to_id,relationship").all(),
    aliases: db.prepare("SELECT * FROM aliases ORDER BY record_id,alias").all(),
    sources: db.prepare("SELECT * FROM sources ORDER BY record_id,origin").all(),
    metadata: db.prepare("SELECT * FROM metadata ORDER BY key").all() }); }
  finally { db.close(); }
}
async function refused(f, request, command = "put") {
  const before = await snapshot(f);
  const result = await f.cli([command], request);
  assert.notEqual(result.code, 0, "a mismatched basis must not commit");
  assert.equal(result.value.error.code, "invalid_input", JSON.stringify(result.value));
  assert.match(result.value.error.action, /read|basis/i);
  assert.equal(await snapshot(f), before, "no target, receipt, history or revision changes");
}

test("shared ordinary admission covers kinds, extension kinds and global source configuration", async (t) => {
  const f = await fixture(t);
  for (const kind of ["fact", "note", "knowledge", "config", "tool", "skill", "custom-evidence"]) {
    const id = `${kind}:matrix`;
    await f.create(id, kind, { value: "preserve" }, "project:owner");
    for (const basis of ["project:elsewhere", null]) {
      await refused(f, await f.request({ mode: "update", id,
        set: { data: { value: "changed" } }, remove: [] }, [{ kind: "record", id }], basis));
      await refused(f, await f.request({ id, reason: "mismatched" },
        [{ kind: "record", id }], basis), "delete");
    }
    const current = (await f.cli(["get", id])).value.data;
    const changed = await f.cli(["put"], { v: 5, request_id: `own-${kind}`,
      write_basis: current.write_basis, input: { mode: "update", id,
        set: { data: { value: "reviewed" } }, remove: [] } });
    assert.equal(changed.code, 0, `${kind}: ${JSON.stringify(changed.value)}`);
  }
  const id = "config:lodestar:sources";
  await f.create(id, "config", { instruction_sources: [], catalog_sources: [], skill_source_roots: [] });
  await refused(f, await f.request({ mode: "update", id, set: { name: "wrong basis" }, remove: [] },
    [{ kind: "record", id }], "project:elsewhere"));
  await refused(f, await f.request({ id, reason: "wrong basis" },
    [{ kind: "record", id }], "project:elsewhere"), "delete");
  const current = (await f.cli(["get", id])).value.data;
  assert.equal(current.write_basis.project_scope, "global");
  const updated = await f.cli(["put"], { v: 5, request_id: "global-config-own",
    write_basis: { ...current.write_basis, project_scope: null },
    input: { mode: "update", id, set: { name: "Reviewed" }, remove: [] } });
  assert.equal(updated.code, 0, JSON.stringify(updated.value));
  const fresh = (await f.cli(["get", id])).value.data;
  const removed = await f.cli(["delete"], { v: 5, request_id: "global-config-retire",
    write_basis: fresh.write_basis, input: { id, reason: "reviewed retirement" } });
  assert.equal(removed.code, 0, JSON.stringify(removed.value));
});
for (const scope of ["project:elsewhere", null]) {
  test(`retirement checks ordinary applicability with ${scope ?? "null"} basis`, async (t) => {
    const f = await fixture(t);
    await f.create("note:target", "note", { body: "preserve" }, "project:owner");
    await refused(f, await f.request({ id: "note:target", reason: "mismatch" },
      [{ kind: "record", id: "note:target" }], scope), "delete");
  });
}
for (const mode of ["update", "replace"]) {
  test(`${mode} checks the original target before a proposed applicability change`, async (t) => {
    const f = await fixture(t);
    const created = await f.create("note:target", "note", { body: "preserve" }, "project:owner");
    const semantics = { ...created.value.data.semantics,
      applicability: { project: "project:elsewhere", checkout: null } };
    const input = mode === "update"
      ? { mode, id: "note:target", set: { data: { body: "changed" }, semantics }, remove: [] }
      : { mode, record: { ...created.value.data, data: { body: "changed" }, semantics } };
    await refused(f, await f.request(input, [{ kind: "record", id: "note:target" }], "project:elsewhere"));
  });
}
test("a retargeted null absence basis cannot update a scoped target", async (t) => {
  const f = await fixture(t);
  const target = (await f.create("note:target", "note", { body: "preserve" }, "project:owner")).value.data;
  const absent = (await f.cli(["get", "note:absent"])).value.error.identifiers.write_basis;
  assert.equal(absent.project_scope, null);
  await refused(f, { v: 5, request_id: "null-retarget", write_basis: { ...absent,
    targets: [{ kind: "record", id: target.id, expected_revision: target.revision }] },
    input: { mode: "update", id: target.id, set: { data: { body: "changed" } }, remove: [] } });
});
test("global retirement and exact replay retain the legitimate null basis", async (t) => {
  const f = await fixture(t);
  await f.create("note:global", "note", { body: "global" });
  const request = await f.request({ id: "note:global", reason: "finished" },
    [{ kind: "record", id: "note:global" }]);
  const result = await f.cli(["delete"], request);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  const after = await snapshot(f);
  assert.equal((await f.cli(["delete"], request)).code, 0);
  assert.equal(await snapshot(f), after);
});
test("project registration from its own pre-registration basis yields a usable edit basis", async (t) => {
  const f = await fixture(t);
  const start = (await f.cli(["start", "--cwd", f.root])).value.data;
  const missing = (await f.cli(["get", "project:registered"])).value.error.identifiers.write_basis;
  const body = { v: 5, request_id: "register-own", write_basis: { ...start.write_basis,
    targets: [...start.write_basis.targets, ...missing.targets] }, input: { mode: "create", record: {
    id: "project:registered", kind: "project", name: "Registered", scope: "project:registered",
    availability: "known", data: { roots: [f.root] }, aliases: [], links: [], sources: [] } } };
  const result = await f.cli(["put"], body);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  const current = (await f.cli(["get", "project:registered"])).value.data;
  assert.equal(current.write_basis.project_scope, "project:registered");
  const edit = await f.cli(["put"], { v: 5, request_id: "edit-registered",
    write_basis: current.write_basis, input: { mode: "update", id: current.id,
      set: { name: "Updated" }, remove: [] } });
  assert.equal(edit.code, 0, JSON.stringify(edit.value));
});
test("legacy registration applicability does not strand the project edit basis", async (t) => {
  const f = await fixture(t);
  const scope = (await f.cli(["start", "--cwd", f.root])).value.scope.project;
  await f.create("project:registered", "project", { roots: [f.root] }, scope);
  const current = (await f.cli(["get", "project:registered"])).value.data;
  assert.equal(current.write_basis.project_scope, "project:registered");
  assert.equal((await f.cli(["put"], { v: 5, request_id: "edit-legacy-project",
    write_basis: current.write_basis, input: { mode: "update", id: current.id,
      set: { name: "Legacy corrected" }, remove: [] } })).code, 0);
});
test("distinct canonical IDs cannot collapse to the same admitted project scope", async (t) => {
  const f = await fixture(t);
  await f.create("victim", "project", { roots: [f.root] }, "project:victim");
  const other = path.join(f.root, "other"); await mkdir(other);
  const before = await snapshot(f);
  const request = await f.request({ mode: "create", record: { id: "project:victim", kind: "project",
    name: "Distinct", scope: "project:victim", availability: "known", data: { roots: [other] },
    aliases: [], links: [], sources: [] } }, [{ kind: "record", id: "project:victim" }]);
  const result = await f.cli(["put"], request);
  assert.equal(result.value.error?.code, "project_binding_conflict", JSON.stringify(result.value));
  assert.equal(await snapshot(f), before);
});
test("ambiguous legacy project identity is rejected on scope and checkout resolution", async (t) => {
  const f = await fixture(t);
  await f.create("victim", "project", { roots: [f.root] }, "project:victim");
  const other = path.join(f.root, "other"); await mkdir(other);
  await f.create("project:other", "project", { roots: [other] }, "project:other");
  const writer = await openWriteDatabase(f.database);
  try { admittedTransaction(writer, () => writer.prepare("UPDATE records SET id=? WHERE id=?")
    .run("project:victim", "project:other")); } finally { writer.close(); }
  const db = await openReadDatabase(f.database);
  try {
    assert.throws(() => resolveProjectScope(db, "project:victim"), { code: "project_binding_conflict" });
    assert.throws(() => resolveProject(db, other), { code: "project_binding_conflict" });
  } finally { db.close(); }
  const alias = await f.cli(["get", "--raw", "--", "project:victim"]);
  const canonical = await f.cli(["get", "--raw", "--", "victim"]);
  assert.equal(alias.code, 0, "raw inspection must remain available for an ambiguous mapping");
  assert.equal(canonical.code, 0);
  const repaired = await f.cli(["put"], { v: 5, request_id: "repair-legacy-collision",
    write_basis: { ...alias.value.data.write_basis, project_scope: null,
      targets: [...alias.value.data.write_basis.targets, ...canonical.value.data.write_basis.targets] },
    input: { mode: "update", id: "project:victim", set: { data: { canonical_project_id: "victim" },
      links: [{ relationship: "canonical-project", to_id: "victim" }] }, remove: [] } });
  assert.equal(repaired.code, 0, JSON.stringify(repaired.value));
  assert.equal((await f.cli(["start", "--cwd", other])).value.scope.project, "project:victim");
});

test("ordinary canonical-member updates and retirement preserve their historical origin", async (t) => {
  const f = await fixture(t);
  await f.create("project:old", "project", { roots: [f.root] }, "project:old");
  await f.create("project:new", "project", { roots: [] }, "project:new");
  await f.create("note:member", "note", { value: 1 }, "project:old");
  const mapping = await f.request({ mode: "update", id: "project:old",
    set: { data: { canonical_project_id: "project:new" },
      links: [{ relationship: "canonical-project", to_id: "project:new" }] }, remove: [] },
  [{ kind: "record", id: "project:old" }, { kind: "record", id: "project:new" }], "project:old");
  assert.equal((await f.cli(["put"], mapping)).code, 0);
  const record = (await f.cli(["get", "note:member"])).value.data;
  assert.equal(record.write_basis.project_scope, "project:new");
  assert.equal((await f.cli(["put"], { v: 5, request_id: "update-member", write_basis: record.write_basis,
    input: { mode: "update", id: record.id, set: { data: { value: 2 } }, remove: [] } })).code, 0);
  const fresh = (await f.cli(["get", record.id])).value.data;
  assert.equal(fresh.scope, "project:old");
  assert.equal(fresh.semantics.applicability.project, "project:old");
  assert.equal((await f.cli(["delete"], { v: 5, request_id: "retire-member",
    write_basis: fresh.write_basis, input: { id: record.id, reason: "finished" } })).code, 0);
});
