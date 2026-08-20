import assert from "node:assert/strict";
import test from "node:test";

import {
  initializeConnection,
  openConnection,
} from "../src/database.mjs";
import {
  exportRegistry,
  findRecords,
  linkedRecords,
} from "../src/queries.mjs";
import { putRecord } from "../src/records.mjs";

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
  db.prepare("UPDATE records SET created_at = ? WHERE id = ?")
    .run("invalid", "r:target");

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
  assert.deepEqual(first.document.aliases, [{
    alias: "one",
    record_id: "r:one",
  }]);
  db.close();
});
