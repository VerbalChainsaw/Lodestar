import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openWriteDatabase } from "../src/database.mjs";
import { putRecord, writeBasis } from "../src/records.mjs";
import { fixture } from "./helpers/contract.mjs";

// Independent persisted-state oracle: no Lodestar export, normalization,
// receipt reader or revision helper participates in these observations.
function inventory(db) {
  return Object.fromEntries([
    ["metadata", "key"], ["records", "id"], ["aliases", "alias"],
    ["links", "from_id,relationship,to_id"], ["sources", "record_id,origin"],
  ].map(([table, order]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
}

function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    return inventory(db);
  } finally { db.close(); }
}

test("real receipt-stage SQLITE_FULL rolls back the entire guarded put and leaves its exact request reusable", async (t) => {
  const f = await fixture(t);
  await f.create("fact:existing-peer", "fact", { preserved: "accepted state" });
  const before = inspect(f.database);
  const beforeBytes = await readFile(f.database);
  const revisionBefore = Number(before.metadata.find(({ key }) => key === "database_revision").value);
  const id = "fact:capacity";
  const writer = await openWriteDatabase(f.database);
  let request;
  const writes = [];
  const originalPrepare = writer.prepare.bind(writer);
  try {
    request = { v: 5,
      // Identifiers have no product size ceiling. The ordinary fact is small;
      // this valid identifier makes its persisted receipt exceed the page cap.
      request_id: "request:receipt-capacity:" + "x".repeat(256 * 1024),
      write_basis: writeBasis(writer, { targets: [{ kind: "record", id }] }),
      input: { mode: "create", record: { id, kind: "fact", name: "Capacity probe",
        scope: "global", availability: "known", data: { preserved: "all or nothing" },
        aliases: ["capacity alias"], links: [{ relationship: "requires", to_id: "fact:existing-peer" }],
        sources: [{ origin: "fixture:capacity", freshness: "unknown", metadata: {
          inspection: "not_inspected", kind: "external_observation", relation: "supporting_evidence",
          observed_at: "2026-09-30T00:00:00.000Z", evidence_ref: "fixture:capacity" } }] } } };
    const pages = originalPrepare("PRAGMA page_count").get().page_count;
    assert.equal(originalPrepare(`PRAGMA max_page_count=${pages + 16}`).get().max_page_count, pages + 16);
    // Pass through every actual SQLite operation. Observe precisely which
    // insertion succeeded and which native insertion produced SQLITE_FULL.
    writer.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (sql.startsWith("INSERT INTO records(")) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          try {
            const result = run(...args);
            writes.push({ id: args[0], kind: args[1], outcome: "written" });
            return result;
          } catch (error) {
            writes.push({ id: args[0], kind: args[1], outcome: "failed", errcode: error.errcode });
            throw error;
          }
        };
      }
      return statement;
    };
    assert.throws(() => putRecord(writer, request), (error) => {
      assert.equal(error.code, "database_storage_full");
      assert.equal(error.cause?.errcode, 13, "failure must come from native SQLite capacity");
      assert.equal(error.identifiers.database, f.database);
      return true;
    });
    assert.equal(writes.find(({ id: writtenId }) => writtenId === id)?.outcome, "written",
      "the domain row must have actually written before receipt failure");
    assert.equal(writes.at(-1)?.kind, "mutation-receipt");
    assert.equal(writes.at(-1)?.outcome, "failed");
    assert.equal(writes.at(-1)?.errcode, 13);
    assert.equal(writer.isTransaction, false);
    writer.prepare = originalPrepare;
    assert.deepEqual(inventory(writer), before, "no partial domain, revision, receipt or association survives");
    t.diagnostic(JSON.stringify({ domain_write: "completed before failure", failed_owner: "mutation-receipt",
      native_errcode: 13, reserved_extra_pages: 16 }));
  } finally { writer.prepare = originalPrepare; writer.close(); }
  assert.deepEqual(inspect(f.database), before, "reopening independently preserves every accepted table row");
  assert.deepEqual(await readFile(f.database), beforeBytes);

  const retryWriter = await openWriteDatabase(f.database);
  let accepted, replay;
  try {
    retryWriter.exec("PRAGMA max_page_count=2147483646");
    accepted = putRecord(retryWriter, request);
    replay = putRecord(retryWriter, request);
  } finally { retryWriter.close(); }
  assert.equal(accepted.request.replayed, false);
  assert.equal(replay.request.replayed, true);
  assert.equal(replay.receipt_id, accepted.receipt_id);
  assert.equal(replay.revision, accepted.revision);
  const after = inspect(f.database);
  assert.equal(Number(after.metadata.find(({ key }) => key === "database_revision").value), revisionBefore + 1);
  assert.equal(after.records.filter((row) => row.id === id).length, 1);
  assert.equal(after.records.filter((row) => row.id === accepted.receipt_id).length, 1);
  assert.equal(after.records.length, before.records.length + 2);
  assert.deepEqual(after.aliases.map((row) => ({ ...row })), [{ alias: "capacity alias", record_id: id }]);
  assert.deepEqual(after.links.map(({ from_id, relationship, to_id }) => ({ from_id, relationship, to_id })),
    [{ from_id: id, relationship: "requires", to_id: "fact:existing-peer" }]);
  assert.equal(after.sources.length, 1);
  assert.equal(after.sources[0].record_id, id);
});

test("AND terms filter mixed records before paging and preserve the exact independent match sequence", async (t) => {
  const f = await fixture(t);
  for (const [id, body, aliases] of [
    ["knowledge:00-none", "unrelated meadow", []],
    ["knowledge:01-one-term", "CAFÉ meadow", []],
    ["knowledge:02-match", "river cafe\u0301", []],
    ["knowledge:03-one-term", "river meadow", []],
    ["knowledge:04-alias-match", "café meadow", ["RIVER"]],
    ["knowledge:05-none", "unrelated hill", []],
    ["knowledge:06-match", "river CAFÉ", []],
    ["knowledge:07-none", "unrelated forest", []],
  ]) {
    const request = await f.request({ mode: "create", record: { id, kind: "knowledge", name: id,
      scope: "global", availability: "known", data: { body }, aliases, links: [], sources: [] } },
    [{ kind: "record", id }]);
    assert.equal((await f.cli(["put"], request)).code, 0);
  }
  const before = inspect(f.database), bytes = await readFile(f.database);
  // Expected IDs come from explicit fixture meaning, independent of production
  // find/export/filter helpers and their implementations.
  const expected = ["knowledge:02-match", "knowledge:04-alias-match", "knowledge:06-match"];
  for (const limit of [1, 2]) {
    let args = ["--match", "terms", "--explain", "--kind", "knowledge", "--scope", "global",
      "--limit", String(limit), "RIVER CAFÉ"];
    const actual = [];
    for (let page = 0; page < expected.length; page += 1) {
      const result = await f.cli(["find", ...args]);
      assert.equal(result.code, 0, JSON.stringify(result.value));
      const ids = result.value.data.records.map(({ id }) => id);
      assert.deepEqual(ids, expected.slice(actual.length, actual.length + limit),
        "page selection must follow AND filtering, including nonmatches before and between matches");
      actual.push(...ids);
      assert.equal(result.value.more, actual.length < expected.length);
      if (!result.value.more) break;
      args = result.value.next[0].args;
      for (const flag of ["--match", "--kind", "--scope", "--limit", "--at-revision"]) assert.ok(args.includes(flag));
      assert.equal(args[args.indexOf("--match") + 1], "terms");
    }
    assert.deepEqual(actual, expected, "every independently declared match appears once with no paging holes");
  }
  assert.deepEqual(inspect(f.database), before);
  assert.deepEqual(await readFile(f.database), bytes);
});
