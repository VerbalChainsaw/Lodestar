import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectLocalSource, inspectLocalSourceSync, requiredSourceBundle } from "../src/bootstrap.mjs";
import { admittedTransaction, openWriteDatabase } from "../src/database.mjs";
import { errorResult, lodestarError } from "../src/errors.mjs";
import { prepareProjectRoots, validateProjectBindings } from "../src/project.mjs";
import { writeRecordSnapshot } from "../src/records.mjs";
import { allocateRevision } from "../src/revisions.mjs";
import { fixture } from "./helpers/contract.mjs";

async function corruptNumeric(database, id, pattern) {
  const db = await openWriteDatabase(database);
  try {
    admittedTransaction(db, () => {
      const row = db.prepare("SELECT content_json FROM records WHERE id=?").get(id);
      const content = row.content_json.replace(pattern, '"unsafe":9007199254740993');
      assert.notEqual(content, row.content_json, `fixture pattern was absent for ${id}`);
      db.prepare("UPDATE records SET content_json=? WHERE id=?").run(content, id);
    }, database);
  } finally { db.close(); }
}

test("required instruction dedup retains every identity and any required authority", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-required-union-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "AGENTS.md");
  await writeFile(file, "complete\n");
  const cache = new Map();
  const result = await requiredSourceBundle([
    { id: "configured:optional", locator: file, authority: "configured", required: false },
    { id: "native:required", locator: file, authority: "native", required: true },
  ], { cache });
  assert.equal(result.complete, true);
  assert.equal(result.sources.length, 1);
  assert.equal(cache.size, 1);
  assert.equal(result.sources[0].required, true);
  assert.equal(result.sources[0].authority, "native");
  assert.deepEqual(result.sources[0].ids, ["configured:optional", "native:required"]);
  assert.deepEqual(result.sources[0].authorities, ["configured", "native"]);
});

test("project binding validation detects a peer inserted after root preparation", async (t) => {
  const f = await fixture(t);
  await f.create("project:one", "project", { roots: [f.root] }, "project:one");
  const db = await openWriteDatabase(f.database);
  try {
    const prepared = prepareProjectRoots(db, { mode: "update", id: "project:one",
      set: { data: {} }, remove: [] });
    assert.throws(() => admittedTransaction(db, () => {
      const revision = allocateRevision(db);
      const timestamp = new Date().toISOString();
      writeRecordSnapshot(db, { id: "project:late", type: "project", name: "late",
        scope: "project:late", priority: 0, content: { state: "known", value: { roots: [f.root] } },
        aliases: [], links: [], sources: [], semantics: { lifecycle: "current", context_role: "orientation",
          basis: "asserted", applicability: { project: "project:late", checkout: null } } },
      { revision, createdAt: timestamp, updatedAt: timestamp });
      validateProjectBindings(db, "project:one", prepared);
    }, f.database), ({ code, identifiers }) => code === "project_binding_conflict"
      && identifiers.current_peers.includes("project:late"));
  } finally { db.close(); }
});

test("synchronous and asynchronous local source inspection agree on exact bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-source-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "evidence.txt");
  await writeFile(file, "raw\r\nbytes\n");
  const synchronous = inspectLocalSourceSync(file);
  const asynchronous = await inspectLocalSource(file);
  for (const field of ["path", "status", "sha256", "bytes", "encoding", "text"]) {
    assert.equal(synchronous[field], asynchronous[field], field);
  }
});

test("startup isolates an unrelated corrupt project and reports the exact incomplete record", async (t) => {
  const f = await fixture(t);
  await f.create("project:good", "project", { roots: [f.root] }, "project:good");
  await f.create("fact:good", "fact", { answer: 42 }, "project:good",
    { context_role: "orientation", lifecycle: "current", subject: "answer" });
  await f.create("project:bad", "project", { roots: [path.join(f.root, "elsewhere")], unsafe: "safe" }, "project:bad");
  await corruptNumeric(f.database, "project:bad", /"unsafe":"safe"/u);
  const start = await f.cli(["start", "--cwd", f.root, "--session", "isolation"]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.equal(start.value.data.project.id, "project:good");
  assert.equal(start.value.data.context.some(({ id }) => id === "fact:good"), true);
  assert.equal(start.value.data.complete, false);
  assert.deepEqual(start.value.data.record_errors.map(({ code, identifiers }) =>
    [code, identifiers.id]), [["record_requires_source_correction", "project:bad"]]);
});

test("a corrupt decision event is isolated on reads and prevents a false absent-head write", async (t) => {
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const actor = { id: "agent:decision", agent: "agent", session: "decision", harness: "test" };
  const targets = [{ kind: "record", id: "project:test" },
    { kind: "decision", scope: "project:test", key: "choice" }];
  const initial = await f.request({ key: "choice", value: "A", reason: "initial", status: "accepted" },
    targets, "project:test", actor);
  const written = await f.cli(["decision", "set", "--cwd", f.root], initial);
  assert.equal(written.code, 0, JSON.stringify(written.value));
  await corruptNumeric(f.database, written.value.data.record.id, /"reason":"initial"/u);
  const shown = await f.cli(["decision", "show", "choice", "--cwd", f.root]);
  assert.equal(shown.code, 0, JSON.stringify(shown.value));
  assert.equal(shown.value.data.complete, false);
  assert.equal(shown.value.data.record_errors[0].identifiers.id, written.value.data.record.id);
  const update = { ...initial, request_id: "decision-corrupt-update",
    input: { key: "choice", value: "B", reason: "changed", status: "accepted" } };
  const refused = await f.cli(["decision", "set", "--cwd", f.root], update);
  assert.equal(refused.code, 4);
  assert.equal(refused.value.error.code, "record_requires_source_correction");
});

test("input and collision refusals have stable exit classes and DB/project error context", async (t) => {
  assert.equal(errorResult(lodestarError("identity_required", "identity")).exitCode, 2);
  assert.equal(errorResult(lodestarError("direction_required", "direction")).exitCode, 2);
  assert.equal(errorResult(lodestarError("reserved_record_type", "reserved")).exitCode, 2);
  assert.equal(errorResult(lodestarError("record_collision", "collision")).exitCode, 3);
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const actor = { id: "agent:context", agent: "agent", session: "context", harness: "test" };
  const targets = [{ kind: "record", id: "project:test" },
    { kind: "decision", scope: "project:test", key: "boundary" }];
  const initial = await f.request({ key: "boundary", value: "A", reason: "directed", status: "accepted",
    direction: { kind: "user", attribution: "asserted", reference: "task:1", instruction: "Choose A." } },
  targets, "project:test", actor);
  assert.equal((await f.cli(["decision", "set", "--cwd", f.root], initial)).code, 0);
  const request = await f.request({ key: "boundary", value: "B", reason: "changed", status: "accepted" },
    targets, "project:test", actor);
  const result = await f.cli(["decision", "set", "--cwd", f.root], request);
  assert.equal(result.code, 2);
  assert.equal(result.value.error.code, "direction_required");
  assert.equal(result.value.revision, 2);
  assert.match(result.value.database_instance_id, /^[0-9a-f]{64}$/u);
  assert.match(result.value.database_epoch, /^[0-9a-f]{64}$/u);
  assert.equal(result.value.scope.project, "project:test");
  assert.equal(result.value.scope.cwd, f.root.replaceAll("\\", "/"));
});

test("get derives project binding preconditions from semantic applicability", async (t) => {
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  await f.create("global:applicable", "fact", { answer: true }, "global",
    { context_role: "on_demand", lifecycle: "current",
      applicability: { project: "project:test", checkout: f.root } });
  const result = await f.cli(["get", "global:applicable"]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.data.write_basis.project_scope, "project:test");
  assert.equal(result.value.data.write_basis.targets.some(({ kind, id }) =>
    kind === "record" && id === "project:test"), true);
});

test("doctor exposes exact recovery preflight through the shared CLI command", async (t) => {
  const f = await fixture(t);
  const accepted = path.join(f.root, "accepted.db");
  await copyFile(f.database, accepted);
  const result = await f.cli(["doctor", "--recovery-preflight", "--source", accepted]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.data.v, 5);
  assert.equal(result.value.data.accounting.exact, true);
  assert.equal(result.value.data.recovered.logical_digest,
    result.value.data.accepted_source.logical_digest);
});

test("find and links continuations are structured and revision pinned", async (t) => {
  const f = await fixture(t);
  for (const id of ["peer:1", "peer:2"]) await f.create(id, "fact", { needle: id });
  const basis = await f.request({ mode: "create", record: { id: "source:links", kind: "fact",
    name: "source", scope: "global", availability: "known", data: { needle: "source" }, aliases: [],
    links: [{ relationship: "depends-on", to_id: "peer:1" },
      { relationship: "depends-on", to_id: "peer:2" }], sources: [] } },
  [{ kind: "record", id: "source:links" }]);
  assert.equal((await f.cli(["put"], basis)).code, 0);
  const found = await f.cli(["find", "needle", "--limit", "1"]);
  assert.deepEqual(found.value.next[0].command, "find");
  assert.ok(found.value.next[0].args.includes("--at-revision"));
  const first = await f.cli(["links", "source:links", "--limit", "1"]);
  assert.equal(first.value.more, true);
  assert.equal(first.value.next[0].command, "links");
  const second = await f.cli(first.value.next[0].args.toSpliced(0, 0, "links"));
  assert.equal(second.code, 0, JSON.stringify(second.value));
  assert.notEqual(second.value.data.links[0].to_id, first.value.data.links[0].to_id);
});
