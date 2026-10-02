import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { migrationPreflight } from "../src/schema-migration.mjs";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";
import { temporaryDirectory } from "./helpers/contract.mjs";

const timestamp = "2026-09-06T09:00:00.000Z";
const legacyContent = '{"state":"known","value":{"kept":true}}';
const damagedContent = '{"state":"known","value":{"bad":9007199254740993}}';
const currentContent = JSON.stringify({ state: "known", value: { kept: true }, _lodestar: {
  semantics: { lifecycle: "current", context_role: "on_demand", basis: "asserted",
    applicability: { project: "global", checkout: null } } } });
const validSource = JSON.stringify({ inspection: "inspected", kind: "external_observation",
  relation: "supporting_evidence", observed_at: timestamp, evidence_ref: "fixture:observation", claim: "Observed fixture" });

async function fixture(t, records, sources) {
  const root = await temporaryDirectory(t, "lodestar-migration-issue-index-");
  const file = path.join(root, "source.db"), db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA_V4_SQL);
    for (const [key, value] of Object.entries({ schema_version: "4", created_at: timestamp,
      database_instance_id: "a".repeat(64), database_revision: "9", database_epoch: "b".repeat(64) })) {
      db.prepare("INSERT INTO metadata VALUES(?,?)").run(key, value);
    }
    for (const [id, content] of records) db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)")
      .run(id, "fact", id, "global", content, timestamp, timestamp);
    for (const [id, origin, metadata] of sources) db.prepare("INSERT INTO sources VALUES(?,?,?,?)")
      .run(id, origin, "current", metadata);
  } finally { db.close(); }
  return file;
}

const accounting = (unchanged, semantic_metadata, source_metadata, source_correction) => ({
  unchanged, semantic_metadata, source_metadata, source_correction,
  proven_identity_binding: 0, ambiguous: 0, incompatible: 0,
});

test("empty numeric issue list preserves existing semantic and source-metadata selection", async (t) => {
  const file = await fixture(t, [["fact:legacy", legacyContent], ["fact:current", currentContent]],
    [["fact:legacy", "fixture:legacy", '{"legacy":true}'], ["fact:current", "fixture:current", validSource]]);
  const before = await readFile(file), report = await migrationPreflight(file);
  assert.deepEqual(report.numeric_issues, []);
  assert.deepEqual(report.accounting, accounting(1, 1, 1, 0));
  assert.deepEqual(await readFile(file), before);
});

test("delimiter-containing source pairs retain exact distinct issue identities", async (t) => {
  const file = await fixture(t, [["a", damagedContent], ["a:b", currentContent], ["a|b", currentContent]], [
    ["a:b", "c", '{"bad":9007199254740993}'], ["a|b", "c", '{"bad":9007199254740993}'],
    ["a", "b:c", '{"legacy":true}'], ["a", "b|c", '{"legacy":true}'],
    ["a|b", "already:current", validSource],
  ]);
  const before = await readFile(file), report = await migrationPreflight(file);
  assert.deepEqual(report.numeric_issues.map(({ table, id, origin }) => [table, id, origin]), [
    ["records", "a", null], ["sources", "a:b", "c"], ["sources", "a|b", "c"],
  ]);
  assert.deepEqual(report.accounting, accounting(3, 0, 2, 3));
  assert.deepEqual(await readFile(file), before);
});

test("source numeric issue does not suppress metadata conversion of its clean record", async (t) => {
  const file = await fixture(t, [["fact:one", legacyContent]],
    [["fact:one", "source:only", '{"bad":9007199254740993}']]);
  const before = await readFile(file), report = await migrationPreflight(file);
  assert.deepEqual(report.numeric_issues.map(({ table, id, origin }) => [table, id, origin]),
    [["sources", "fact:one", "source:only"]]);
  assert.deepEqual(report.accounting, accounting(0, 1, 0, 1));
  assert.deepEqual(await readFile(file), before);
});

test("damaged-row preflight avoids repeatedly searching its numeric issue list", async (t) => {
  const records = [], sources = [];
  for (let i = 0; i < 48; i += 1) {
    const id = `fact:${String(i).padStart(2, "0")}`;
    records.push([id, i % 2 === 0 ? damagedContent : legacyContent]);
    sources.push([id, "source:shared", i % 2 === 0 ? '{"legacy":true}' : '{"bad":9007199254740993}']);
  }
  const file = await fixture(t, records, sources), before = await readFile(file);
  const originalSome = Array.prototype.some;
  let issuePredicates = 0, report;
  Array.prototype.some = function (predicate, receiver) {
    const first = this[0];
    if (first && typeof first.pointer === "string" &&
      ((first.table === "records" && first.field === "content_json") ||
       (first.table === "sources" && first.field === "metadata_json"))) {
      return originalSome.call(this, (entry, index, entries) => {
        issuePredicates += 1; return predicate.call(receiver, entry, index, entries);
      });
    }
    return originalSome.call(this, predicate, receiver);
  };
  try { report = await migrationPreflight(file); }
  finally { Array.prototype.some = originalSome; }
  assert.equal(report.numeric_issues.length, 48);
  assert.deepEqual(report.accounting, accounting(24, 24, 24, 48));
  assert.deepEqual(await readFile(file), before);
  t.diagnostic(`Issue matching predicates: ${issuePredicates}; numeric issues: ${report.numeric_issues.length}`);
  assert.ok(issuePredicates <= report.numeric_issues.length,
    "row matching must index issue identities instead of rescanning the issue list for every record and source");
});
