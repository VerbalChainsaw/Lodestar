import assert from "node:assert/strict";
import test from "node:test";

import {
  initializeConnection,
  openConnection,
  admittedTransaction,
} from "../src/database.mjs";
import {
  exportRegistry,
  findRecords,
  linkedRecords,
} from "../src/queries.mjs";
import { putRecord as writeCurrentRecord, writeRecordSnapshot, writeBasis } from "../src/records.mjs";
import { allocateRevision } from "../src/revisions.mjs";
import { CONTRACT_VERSION } from "../src/schema.mjs";

let requestSequence = 0;
function putRecord(db, value, options = {}) {
  if (value.type === "startup-snapshot") return admittedTransaction(db, () => {
    const revision = allocateRevision(db), timestamp = new Date().toISOString();
    writeRecordSnapshot(db, value, { revision, createdAt: timestamp, updatedAt: timestamp });
  }); // A historical fixture, never a production generic write.
  const exists = db.prepare("SELECT id FROM records WHERE id=?").get(value.id);
  return writeCurrentRecord(db, { v: CONTRACT_VERSION, request_id: `query-${++requestSequence}`,
    write_basis: writeBasis(db, { projectScope: value.scope, targets: [{ kind: "record", id: value.id }] }),
    input: { mode: exists ? "replace" : "create", record: { id: value.id, kind: value.type,
      name: value.name, scope: value.scope, availability: value.content.state, data: value.content.value,
      aliases: value.aliases, links: value.links, sources: value.sources } } }, options);
}

function memoryDatabase() {
  const db = openConnection(":memory:");
  initializeConnection(db, {
    createdAt: "2026-07-30T10:00:00.000Z",
  });
  return db;
}

function record(id, {
  name = id,
  scope = "global",
  type = "note",
  value = id,
  aliases = [],
  links = [],
} = {}) {
  return {
    id,
    type,
    name,
    scope,
    content: { state: "known", value },
    aliases,
    links,
    sources: [],
  };
}

test("find accepts an explicit safe-integer page size and preserves deterministic rank", () => {
  const db = memoryDatabase();
  const now = () => new Date("2026-07-30T10:00:00.000Z");
  for (const value of [
    record("r:substring", { value: "needle appears here" }),
    record("r:prefix-needle", { name: "Other" }),
    record("r:name", { name: "Needle" }),
    record("r:alias", { aliases: ["needle"] }),
    record("r:other-scope", {
      scope: "project:other",
      aliases: ["needle elsewhere"],
    }),
  ]) {
    putRecord(db, value, { now });
  }

  const result = findRecords(db, "needle", {
    scope: "global",
    limit: 3,
  });
  assert.deepEqual(
    result.records.map(({ id }) => id),
    ["r:alias", "r:name", "r:prefix-needle"],
  );
  assert.equal(result.truncated, true);
  assert.equal(result.records.length, 3);

  assert.deepEqual(
    findRecords(db, "needle", {
      scope: "project:other",
      type: "note",
    }).records.map(({ id }) => id),
    ["r:other-scope"],
  );
  assert.throws(
    () => findRecords(db, "needle", { limit: "1e2" }),
    ({ code }) => code === "invalid_input",
  );
  assert.deepEqual(
    findRecords(db, "needle", { type: "t".repeat(65) }).records,
    [],
  );
  db.close();
});

test("links reports deterministic one-hop incoming and outgoing peers", () => {
  const db = memoryDatabase();
  const now = () => new Date("2026-07-30T10:00:00.000Z");
  putRecord(db, record("r:root", { aliases: ["root"] }), { now });
  putRecord(db, record("r:out", {
    links: [{ relationship: "points_to", to_id: "r:root" }],
  }), { now });
  putRecord(db, record("r:root", {
    aliases: ["root"],
    links: [{ relationship: "documents", to_id: "r:out" }],
  }), { now });

  const result = linkedRecords(db, "root");
  assert.deepEqual(
    result.links.map(({ direction, relationship, peer }) => [
      direction,
      relationship,
      peer.id,
    ]),
    [
      ["outgoing", "documents", "r:out"],
      ["incoming", "points_to", "r:out"],
    ],
  );
  assert.equal(result.truncated, false);
  db.close();
});

test("summary reads reject invalid record creation timestamps", () => {
  const db = memoryDatabase();
  const now = () => new Date("2026-07-30T10:00:00.000Z");
  putRecord(db, record("r:target"), { now });
  putRecord(db, record("r:owner", {
    links: [{ relationship: "points_to", to_id: "r:target" }],
  }), { now });
  db.exec("PRAGMA ignore_check_constraints = ON");
  admittedTransaction(db, () => db.prepare("UPDATE records SET created_at = ? WHERE id = ?")
    .run("invalid", "r:target"));

  assert.throws(
    () => findRecords(db, "r:target"),
    ({ code }) => code === "database_integrity",
  );
  assert.throws(
    () => linkedRecords(db, "r:owner"),
    ({ code }) => code === "database_integrity",
  );
  db.close();
});

test("export is canonical, complete, and free of volatile export metadata", () => {
  const db = memoryDatabase();
  putRecord(db, record("r:one", { aliases: ["one"] }), {
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  const first = exportRegistry(db);
  const second = exportRegistry(db);
  assert.deepEqual(first, second);
  assert.equal(first.document.exported_at, undefined);
  assert.equal(first.document.database, undefined);
  assert.deepEqual(first.document.aliases.map((row) => ({ ...row })), [{
    alias: "one",
    record_id: "r:one",
  }]);
  db.close();
});

test("default find omits reserved startup-snapshot cache records", () => {
  const db = memoryDatabase();
  putRecord(db, record("r:real", { value: "needle in a real note" }), {});
  putRecord(db, {
    id: "startup-snapshot:probe",
    type: "startup-snapshot",
    name: "Snapshot",
    scope: "global",
    content: { state: "known", value: { needle: "needle in a cached projection" } },
    aliases: [],
    links: [],
    sources: [],
  }, {});
  const records = findRecords(db, "needle").records.map(({ id }) => id);
  assert.deepEqual(records, ["r:real"]);
  const explicit = findRecords(db, "needle", { type: "startup-snapshot" })
    .records.map(({ id }) => id);
  assert.deepEqual(explicit, ["startup-snapshot:probe"]);
  db.close();
});

test("find paginates with limit and offset and reports the next page", () => {
  const db = memoryDatabase();
  for (let index = 0; index < 5; index += 1) {
    putRecord(db, record(`r:${index}`, { value: `shared needle ${index}` }), {});
  }
  const first = findRecords(db, "needle", { limit: 2, offset: 0 });
  assert.deepEqual(first.records.map(({ id }) => id), ["r:0", "r:1"]);
  assert.equal(first.truncated, true);
  const second = findRecords(db, "needle", { limit: 2, offset: 2 });
  assert.deepEqual(second.records.map(({ id }) => id), ["r:2", "r:3"]);
  assert.equal(second.truncated, true);
  const third = findRecords(db, "needle", { limit: 2, offset: 4 });
  assert.deepEqual(third.records.map(({ id }) => id), ["r:4"]);
  assert.equal(third.truncated, false);
  assert.throws(
    () => findRecords(db, "needle", { offset: 1 }),
    ({ code }) => code === "invalid_input",
  );
  db.close();
});
