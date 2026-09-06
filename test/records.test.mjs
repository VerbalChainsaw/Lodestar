import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectLocalSourceSync } from "../src/bootstrap.mjs";

import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { getRecord, getRecordHistory, putRecord, writeBasis } from "../src/records.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-records-v5-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  return await openWriteDatabase(file);
}

function request(db, requestId, id, input) {
  return { v: 5, request_id: requestId,
    write_basis: writeBasis(db, { projectScope: "project:test",
      targets: [{ kind: "record", id }] }), input };
}

function record(id, overrides = {}) {
  return { id, kind: "fact", name: id, scope: "project:test",
    availability: "known", data: { command: "node --test", sibling: { exact: true } },
    aliases: [], links: [], sources: [], semantics: null, ...overrides };
}

test("targeted updates preserve unknown application members and replace nested values", async (t) => {
  const db = await fixture(t);
  putRecord(db, request(db, "create:one", "fact:one", {
    mode: "create", record: record("fact:one", {
      data: { command: "node --test", sibling: { exact: true },
        _lodestar: { application_owned: true } },
    }),
  }));
  const updated = putRecord(db, request(db, "update:one", "fact:one", {
    mode: "update", id: "fact:one",
    set: { data: { sibling: { replacement: true } } }, remove: [],
  }));
  assert.deepEqual(updated.data.data, {
    command: "node --test",
    sibling: { replacement: true },
    _lodestar: { application_owned: true },
  });
  assert.equal(getRecordHistory(db, "fact:one").versions.length, 1);
  db.close();
});

test("current file sources require exact locator and fingerprint metadata", async (t) => {
  const db = await fixture(t);
  const observed = inspectLocalSourceSync(fileURLToPath(new URL('../package.json', import.meta.url)));
  const source = { origin: "package.json", freshness: "current", metadata: {
    inspection: "inspected", kind: "package_manifest", relation: "content_owner",
    locator: { base: "absolute", path: observed.path },
    observed_at: observed.observed_at,
    fingerprint: { algorithm: "sha256", value: observed.sha256, bytes: observed.bytes },
    claim: "scripts.test was inspected", evidence_ref: null,
  } };
  const result = putRecord(db, request(db, "create:source", "fact:source", {
    mode: "create", record: record("fact:source", { sources: [source] }),
  }));
  assert.deepEqual(result.data.sources[0].metadata.fingerprint,
    source.metadata.fingerprint);
  assert.throws(() => putRecord(db, request(db, "create:bad-source", "fact:bad", {
    mode: "create", record: record("fact:bad", { sources: [{
      ...source, metadata: { ...source.metadata, fingerprint: undefined },
    }] }),
  })), ({ code }) => code === "invalid_input" || code === "invalid_json");
  assert.throws(() => getRecord(db, "fact:bad"), ({ code }) => code === "record_not_found");
  db.close();
});

test("unsafe integer input is rejected with its JSON pointer before persistence", async (t) => {
  const db = await fixture(t);
  assert.throws(() => putRecord(db, request(db, "create:number", "fact:number", {
    mode: "create", record: record("fact:number", { data: { unsafe: 9007199254740992 } }),
  })), ({ code, identifiers }) => code === "unsupported_numeric_value"
    && identifiers.pointer === "/record/data/unsafe");
  assert.throws(() => getRecord(db, "fact:number"), ({ code }) => code === "record_not_found");
  db.close();
});
