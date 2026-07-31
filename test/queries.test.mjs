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

test("find is bounded, filtered, and totally ordered by documented rank", () => {
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
  assert.throws(
    () => findRecords(db, "needle", { type: "t".repeat(65) }),
    ({ code, identifiers }) =>
      code === "resource_limit"
      && identifiers.field === "type"
      && identifiers.maximum === 64,
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
