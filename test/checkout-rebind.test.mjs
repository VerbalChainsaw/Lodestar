import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openReadDatabase } from "../src/database.mjs";
import { fixture } from "./helpers/contract.mjs";

const id = "assessment:rebind";
const scope = "project:owner";
const success = (result) => {
  assert.equal(result.code, 0, JSON.stringify(result.value));
  return result.value.data;
};
function mergedBasis(...bases) {
  const targets = new Map();
  for (const basis of bases) for (const target of basis.targets) {
    const key = JSON.stringify([target.kind, target.id, target.scope, target.key]);
    if (targets.has(key)) assert.deepEqual(targets.get(key), target);
    targets.set(key, target);
  }
  return { ...bases.at(-1), targets: [...targets.values()] };
}
async function snapshot(f) {
  const db = await openReadDatabase(f.database);
  try {
    return JSON.stringify(Object.fromEntries(["metadata", "records", "aliases", "links", "sources"]
      .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()])));
  } finally { db.close(); }
}
async function setup(t) {
  const f = await fixture(t);
  const a = path.join(f.root, "original"), b = path.join(f.root, "recovery");
  await mkdir(a); await mkdir(b);
  await f.create(scope, "project", { roots: [a, b] }, scope);
  await f.create("note:related", "note", { keep: true }, scope);
  const source = path.join(f.root, "evidence.md");
  const bytes = Buffer.from("Observed content\n"); await writeFile(source, bytes);
  const start = success(await f.cli(["start", "--cwd", a]));
  const missing = (await f.cli(["get", id])).value.error.identifiers.write_basis;
  const record = { id, kind: "assessment", name: "Accepted work", scope, availability: "known",
    data: { keep: { nested: [1, "unchanged", null] }, outcome: "verified" },
    aliases: ["accepted-assessment"], links: [{ relationship: "evidence", to_id: "note:related" }],
    sources: [{ origin: "evidence", freshness: "current", metadata: {
      kind: "local_file", relation: "content_owner", inspection: "inspected",
      locator: { base: "absolute", path: source }, observed_at: new Date().toISOString(),
      fingerprint: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length },
    } }], semantics: { applicability: { project: scope, checkout: start.project.checkout_root },
      basis: "observed", lifecycle: "current", context_role: "orientation" } };
  success(await f.cli(["put"], { v: 5, request_id: "create-assessment",
    write_basis: mergedBasis(missing, start.write_basis), input: { mode: "create", record } }));
  const prior = success(await f.cli(["get", id]));
  const destination = success(await f.cli(["start", "--cwd", b]));
  const semantics = { ...prior.semantics,
    applicability: { ...prior.semantics.applicability, checkout: destination.project.checkout_root } };
  const request = { v: 5, request_id: "move-assessment",
    write_basis: mergedBasis(prior.write_basis, destination.write_basis),
    input: { mode: "update", id, set: { semantics }, remove: [] } };
  return { ...f, a, b, source, prior, destination, request };
}

for (const mode of ["update", "replace"]) {
  test(`${mode} rebind preserves data, associations, ID, before-image and exact replay`, async (t) => {
    const f = await setup(t);
    if (mode === "replace") f.request.input = { mode, record: {
      ...f.prior, semantics: f.request.input.set.semantics } };
    const beforeRaw = success(await f.cli(["get", "--raw", id]));
    const result = await f.cli(["put"], f.request);
    const moved = success(result);
    for (const key of ["id", "kind", "name", "scope", "availability", "priority", "data", "aliases", "links", "sources", "created_at"]) {
      assert.deepEqual(moved[key], f.prior[key], key);
    }
    assert.deepEqual(moved.semantics, mode === "update" ? f.request.input.set.semantics : f.request.input.record.semantics);
    assert.ok(moved.revision > f.prior.revision);
    const history = success(await f.cli(["get", "--history", id]));
    assert.equal(history.versions.length, 1);
    assert.deepEqual(history.versions[0].raw_record, beforeRaw.raw_record);
    assert.deepEqual(history.versions[0].raw_associations, beforeRaw.raw_associations);
    const saved = await snapshot(f);
    await writeFile(f.source, "Changed after accepted operation");
    await rmdir(f.b);
    const replay = await f.cli(["put"], f.request);
    assert.deepEqual(success(replay), moved);
    assert.equal(replay.value.request.replayed, true);
    assert.equal(await snapshot(f), saved, "exact replay does not append history or revisions");
    await mkdir(f.b);
    const a = success(await f.cli(["start", "--cwd", f.a]));
    const b = success(await f.cli(["start", "--cwd", f.b]));
    assert.equal(a.context.some((record) => record.id === id), false);
    assert.equal(b.context.some((record) => record.id === id), true);
  });
}

for (const fault of ["missing checkout", "old checkout", "missing mapping", "stale record", "stale mapping", "stale source", "cross-project", "foreign checkout", "deleted destination", "child path"]) {
  test(`rebind refuses ${fault} without changing any stored table`, async (t) => {
    const f = await setup(t);
    let code;
    if (fault === "missing checkout") { f.request.write_basis.checkout = null; code = "invalid_input"; }
    if (fault === "old checkout") { f.request.write_basis.checkout = f.prior.semantics.applicability.checkout; code = "invalid_input"; }
    if (fault === "deleted destination") { await rmdir(f.b); code = "invalid_input"; }
    if (fault === "child path") {
      const child = path.join(f.b, "child"); await mkdir(child);
      f.request.write_basis.checkout = child;
      f.request.input.set.semantics.applicability.checkout = child;
      code = "project_binding_conflict";
    }
    if (fault === "missing mapping") {
      f.request.write_basis.targets = f.request.write_basis.targets.filter((target) => target.id !== scope);
      code = "missing_precondition";
    }
    if (fault === "stale record" || fault === "stale mapping") {
      const target = fault === "stale record" ? id : scope;
      const read = success(await f.cli(["get", target]));
      success(await f.cli(["put"], { v: 5, request_id: "concurrent-change", write_basis: read.write_basis,
        input: { mode: "update", id: target, set: { name: "Concurrent edit" }, remove: [] } }));
      code = "revision_conflict";
    }
    if (fault === "stale source") { await writeFile(f.source, "New content"); code = "needs_reinspection"; }
    if (fault === "cross-project" || fault === "foreign checkout") {
      const foreign = path.join(f.root, "foreign"); await mkdir(foreign);
      await f.create("project:foreign", "project", { roots: [foreign] }, "project:foreign");
      const start = success(await f.cli(["start", "--cwd", foreign]));
      f.request.write_basis = mergedBasis(f.prior.write_basis, start.write_basis);
      f.request.input.set.semantics.applicability.checkout = start.project.checkout_root;
      if (fault === "cross-project") {
        f.request.input.set.semantics.applicability.project = "project:foreign";
        code = "invalid_input";
      } else {
        f.request.write_basis.project_scope = scope;
        code = "project_binding_conflict";
      }
    }
    const before = await snapshot(f);
    const result = await f.cli(["put"], f.request);
    assert.notEqual(result.code, 0);
    assert.equal(result.value.error.code, code, JSON.stringify(result.value));
    assert.equal(await snapshot(f), before, "rejection preserves records, receipt history, associations and revision");
  });
}

for (const fault of ["missing", "stale"]) {
  test(`rebind requires ${fault} member mapping beyond the canonical project row`, async (t) => {
    const f = await setup(t);
    const member = "project:member";
    await f.create(member, "project", { roots: [] }, member);
    const read = success(await f.cli(["get", member]));
    success(await f.cli(["put"], { v: 5, request_id: "bind-member",
      write_basis: mergedBasis(f.prior.write_basis, read.write_basis), input: { mode: "update", id: member,
        set: { data: { roots: [f.b], canonical_project_id: scope },
          links: [{ relationship: "canonical-project", to_id: scope }] }, remove: [] } }));
    const destination = success(await f.cli(["start", "--cwd", f.b]));
    f.request.write_basis = mergedBasis(f.prior.write_basis, destination.write_basis);
    if (fault === "missing") {
      f.request.write_basis.targets = f.request.write_basis.targets.filter((target) => target.id !== member);
    } else {
      const current = success(await f.cli(["get", member]));
      success(await f.cli(["put"], { v: 5, request_id: "change-member", write_basis: current.write_basis,
        input: { mode: "update", id: member, set: { name: "Changed mapping row" }, remove: [] } }));
    }
    const before = await snapshot(f);
    const result = await f.cli(["put"], f.request);
    assert.equal(result.value.error?.code, fault === "missing" ? "missing_precondition" : "revision_conflict", JSON.stringify(result.value));
    assert.equal(await snapshot(f), before);
  });
}

for (const content of ["matching", "different", "missing"]) {
  test(`checkout-relative source at B is ${content}`, async (t) => {
    const f = await setup(t);
    await writeFile(path.join(f.a, "evidence.md"), "Observed content\n");
    if (content !== "missing") await writeFile(path.join(f.b, "evidence.md"),
      content === "matching" ? "Observed content\n" : "Destination differs\n");
    const sources = structuredClone(f.prior.sources);
    sources[0].metadata.locator = { base: "checkout_root", path: "evidence.md" };
    success(await f.cli(["put"], { v: 5, request_id: "relative-owner", write_basis: f.prior.write_basis,
      input: { mode: "update", id, set: { sources }, remove: [] } }));
    const current = success(await f.cli(["get", id]));
    f.request.write_basis = mergedBasis(current.write_basis, f.destination.write_basis);
    const before = await snapshot(f);
    const result = await f.cli(["put"], f.request);
    if (content === "matching") assert.deepEqual(success(result).sources, sources);
    else {
      assert.equal(result.value.error?.code, "needs_reinspection", JSON.stringify(result.value));
      assert.equal(await snapshot(f), before);
    }
  });
}

test("pending promotion shares the rebind guard and settles atomically", async (t) => {
  const f = await setup(t);
  const pending = "pending:move";
  const missing = (await f.cli(["get", pending])).value.error.identifiers.write_basis;
  success(await f.cli(["pending", "add", "--cwd", f.b], { v: 5, request_id: "candidate",
    write_basis: mergedBasis(missing, f.destination.write_basis), input: { id: pending, text: "Reviewed move" } }));
  const candidate = success(await f.cli(["get", pending]));
  const request = { v: 5, request_id: "promote", write_basis: mergedBasis(candidate.write_basis, f.request.write_basis),
    input: { id: pending, destination: { operation: "put", input: f.request.input } } };
  await rmdir(f.b);
  const before = await snapshot(f);
  const refused = await f.cli(["pending", "promote", "--cwd", f.b], request);
  assert.equal(refused.value.error?.code, "invalid_input", JSON.stringify(refused.value));
  assert.equal(await snapshot(f), before, "failed promotion preserves candidate and destination");
  await mkdir(f.b);
  const result = success(await f.cli(["pending", "promote", "--cwd", f.b], request));
  assert.equal(result.record.semantics.lifecycle, "superseded");
  assert.equal(result.record.revision, result.promoted.revision);
  assert.equal(result.promoted.id, id);
  assert.equal(result.promoted.semantics.applicability.checkout, f.request.write_basis.checkout);
  assert.deepEqual(result.promoted.data, f.prior.data);
});

test("Windows checkout dialects use the shared path resolver", { skip: process.platform !== "win32" }, async (t) => {
  for (const prefix of ["/mnt/", "/", "/cygdrive/"]) {
    const f = await setup(t);
    const canonical = f.request.write_basis.checkout;
    const dialect = `${prefix}${canonical[0].toLowerCase()}${canonical.slice(2)}`;
    f.request.write_basis.checkout = dialect;
    f.request.input.set.semantics.applicability.checkout = dialect;
    const moved = success(await f.cli(["put"], f.request));
    assert.equal(moved.semantics.applicability.checkout, dialect);
    const orientation = success(await f.cli(["start", "--cwd", f.b]));
    assert.equal(orientation.context.some((record) => record.id === id), true);
  }
});
