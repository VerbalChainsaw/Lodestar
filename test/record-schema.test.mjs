import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import * as records from "../src/records.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-record-schema-"));
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const db = await openWriteDatabase(file);
  t.after(() => db.close());
  t.after(() => rm(directory, { recursive: true, force: true }));
  return db;
}

function request(db, requestId, id, input) {
  return {
    v: 5,
    request_id: requestId,
    write_basis: records.writeBasis(db, {
      projectScope: null,
      targets: [{ kind: "record", id }],
    }),
    input,
  };
}

test("record mutation schemas expose the accepted modes and required fields", () => {
  const put = records.PUT_INPUT_SCHEMA;
  const remove = records.DELETE_INPUT_SCHEMA;
  assert.equal(put.type, "object");
  assert.equal(put.additionalProperties, false);
  assert.deepEqual(put.oneOf.map((branch) => branch.properties.mode.const),
    ["create", "update", "replace"]);

  const [create, update, replace] = put.oneOf;
  assert.deepEqual(create.required, ["mode", "record"]);
  assert.deepEqual(create.properties.record.required,
    ["id", "kind", "name", "scope", "data", "aliases", "links", "sources"]);
  assert.deepEqual(update.required, ["mode", "id", "set", "remove"]);
  assert.equal(update.properties.set.properties.data.type, "object");
  assert.equal(update.properties.remove.items.type, "string");
  assert.deepEqual(replace.properties.record.required,
    ["id", "kind", "name", "scope", "data", "aliases", "links", "sources"]);

  assert.deepEqual(remove.required, ["id", "reason"]);
  assert.equal(remove.additionalProperties, false);
});

test("record schemas describe association and semantic metadata with runtime enums", () => {
  const record = records.PUT_INPUT_SCHEMA.oneOf[0].properties.record;
  assert.deepEqual(record.properties.availability.anyOf[0].enum,
    ["known", "known_empty", "unavailable", "unknown", "stale"]);
  assert.deepEqual(record.properties.links.items.required, ["relationship", "to_id"]);
  assert.deepEqual(record.properties.sources.items.required,
    ["origin", "freshness", "metadata"]);
  assert.deepEqual(record.properties.sources.items.properties.freshness.enum,
    ["current", "stale", "unknown"]);
  assert.deepEqual(record.properties.sources.items.properties.metadata.properties.inspection.enum,
    ["inspected", "not_inspected", "inspected_no_value", "unknown"]);
  assert.deepEqual(record.properties.semantics.anyOf[0].properties.lifecycle.enum,
    ["current", "unresolved", "historical", "superseded"]);
});

test("create applies scalar defaults while update and replace keep runtime guards", async (t) => {
  const db = await fixture(t);
  const created = records.putRecord(db, request(db, "schema:create", "fact:schema", {
    mode: "create",
    record: {
      id: "fact:schema",
      kind: "fact",
      name: "Schema fixture",
      scope: "global",
      data: { stable: true, remove_me: true },
      aliases: [],
      links: [],
      sources: [],
    },
  }));
  assert.deepEqual(created.data.aliases, []);
  assert.deepEqual(created.data.links, []);
  assert.deepEqual(created.data.sources, []);
  assert.equal(created.data.availability, "unknown");
  assert.equal(created.data.priority, 0);
  assert.equal(created.data.semantics.lifecycle, "current");

  assert.throws(() => records.putRecord(db,
    request(db, "schema:update-invalid", "fact:schema", {
      mode: "update", id: "fact:schema", set: { data: [] }, remove: [],
    })), ({ code }) => code === "invalid_mutation_contract");
  assert.throws(() => records.putRecord(db,
    request(db, "schema:replace-invalid", "fact:schema", {
      mode: "replace",
      record: {
        id: "fact:schema", kind: "fact", name: "Incomplete replacement",
        scope: "global", data: {},
      },
    })), ({ code }) => code === "invalid_mutation_contract");
  assert.throws(() => records.deleteRecord(db,
    request(db, "schema:delete-invalid", "fact:schema", {
      id: "fact:schema", reason: "retired", unsupported: true,
    })), ({ code }) => code === "invalid_mutation_contract");
});

test("update remove rejects non-string data keys before mutation", async (t) => {
  const db = await fixture(t);
  records.putRecord(db, request(db, "schema:key-create", "fact:key", {
    mode: "create",
    record: {
      id: "fact:key", kind: "fact", name: "Key fixture", scope: "global",
      data: { "42": "keep" }, aliases: [], links: [], sources: [],
    },
  }));
  assert.throws(() => records.putRecord(db,
    request(db, "schema:key-invalid", "fact:key", {
      mode: "update", id: "fact:key", set: {}, remove: [42],
    })), ({ code }) => code === "invalid_mutation_contract");
  assert.equal(records.normalizeRecord(records.getRecord(db, "fact:key")).data["42"], "keep");
});

test("update set preserves a JSON __proto__ data key", async (t) => {
  const db = await fixture(t);
  records.putRecord(db, request(db, "schema:proto-create", "fact:proto", {
    mode: "create",
    record: {
      id: "fact:proto", kind: "fact", name: "Proto fixture", scope: "global",
      data: {}, aliases: [], links: [], sources: [],
    },
  }));
  const data = JSON.parse('{"__proto__":{"preserved":true}}');
  const updated = records.putRecord(db,
    request(db, "schema:proto-update", "fact:proto", {
      mode: "update", id: "fact:proto", set: { data }, remove: [],
    }));
  assert.equal(Object.hasOwn(updated.data.data, "__proto__"), true);
  assert.deepEqual(updated.data.data.__proto__, { preserved: true });
});
