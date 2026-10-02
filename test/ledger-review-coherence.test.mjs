import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inspectLocalSourceSync } from "../src/bootstrap.mjs";
import { admittedTransaction, openWriteDatabase } from "../src/database.mjs";
import { preparePutEvidence, putRecord } from "../src/records.mjs";
import { fixture } from "./helpers/contract.mjs";

test("source-root inspection and binding revision come from one observed record", async (t) => {
  const f = await fixture(t);
  const id = "config:lodestar:sources", otherRoot = path.join(f.root, "other");
  await mkdir(otherRoot);
  const config = await f.create(id, "config", { skill_source_roots: [{ id: "source", locator: f.root }] });
  const sourcePath = path.join(f.root, "source.json"); await writeFile(sourcePath, '{}');
  const observed = inspectLocalSourceSync(sourcePath);
  const input = { mode: "create", record: { id: "fact:owner", kind: "fact", name: "Owner", scope: "global",
    data: {}, aliases: [], links: [], sources: [{ origin: "source", freshness: "current", metadata: {
      inspection: "inspected", kind: "local_file", relation: "content_owner",
      locator: { base: "source_root", source_id: "source", path: "source.json" }, observed_at: observed.observed_at,
      fingerprint: { algorithm: "sha256", value: observed.sha256, bytes: observed.bytes } } }] } };
  const request = await f.request(input, [{ kind: "record", id: input.record.id }, { kind: "record", id }]);
  const change = await f.request({ mode: "update", id,
    set: { data: { skill_source_roots: [{ id: "source", locator: otherRoot }] } }, remove: [] }, [{ kind: "record", id }]);
  const db = await openWriteDatabase(f.database), writer = await openWriteDatabase(f.database);
  const originalPrepare = db.prepare.bind(db); let switched = false;
  db.prepare = (sql, ...args) => {
    const statement = originalPrepare(sql, ...args);
    if (!sql.endsWith("FROM records WHERE id = ?")) return statement;
    return { get: (...values) => {
      const row = statement.get(...values);
      if (values[0] === id && !switched) {
        switched = true;
        const committed = putRecord(writer, change);
        assert.ok(committed.revision > config.value.data.revision);
      }
      return row;
    } };
  };
  try {
    const evidence = preparePutEvidence(db, input, request);
    assert.equal(switched, true, "actual concurrent SQLite commit occurred at the read barrier");
    assert.equal(evidence.sourceBindings[0].expected_revision, config.value.data.revision,
      "a newer revision must not brand inspection of the old root");
    assert.equal(evidence.sourceEvidence.length, 1);
  } finally { db.close(); writer.close(); }
});
test("broken project members are visible as record errors instead of silent omission", async (t) => {
  const f = await fixture(t);
  await f.create("project:main", "project", { roots: [f.root] }, "project:main");
  await f.create("project:broken", "project", { roots: [] }, "project:broken");
  const writer = await openWriteDatabase(f.database);
  try { admittedTransaction(writer, () => writer.prepare(
    "UPDATE records SET content_json=json_set(content_json,'$.value.canonical_project_id',?) WHERE id=?")
    .run("project:missing", "project:broken")); } finally { writer.close(); }
  const result = await f.cli(["start", "--cwd", f.root]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  const error = result.value.data.record_errors.find((entry) => entry.identifiers?.id === "project:broken");
  assert.ok(error, "the catalog's damaged member must have visible coverage");
  assert.equal(error.code, "project_conflict");
  assert.match(error.action, /inspect|correct|read/i);
});
