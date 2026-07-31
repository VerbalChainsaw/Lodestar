import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  initializeDatabase,
  openReadDatabase,
  openWriteDatabase,
} from "../src/database.mjs";
import {
  deleteRecord,
  getRecord,
  putRecord,
} from "../src/records.mjs";

async function databaseFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-records-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file, {
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  return file;
}

function project(overrides = {}) {
  return {
    id: "project:lodestar",
    type: "project",
    name: "Lodestar",
    scope: "global",
    content: {
      state: "known",
      value: { root: "/workspace/lodestar" },
    },
    aliases: ["lodestar project"],
    links: [],
    sources: [],
    ...overrides,
  };
}

function commands(overrides = {}) {
  return {
    id: "project:lodestar:commands",
    type: "command",
    name: "Lodestar commands",
    scope: "project:lodestar",
    content: {
      state: "known",
      value: { test: "npm test" },
    },
    aliases: ["lodestar commands"],
    links: [{
      relationship: "documents",
      to_id: "project:lodestar",
    }],
    sources: [{
      origin: "package.json",
      freshness: "current",
      metadata: {
        inspection: "inspected",
        inspected_at: "2026-07-30T10:00:00.000Z",
      },
    }],
    ...overrides,
  };
}

test("puts and retrieves complete structured records through IDs and aliases", async (t) => {
  const file = await databaseFixture(t);
  const db = await openWriteDatabase(file);
  putRecord(db, project(), {
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  const written = putRecord(db, commands(), {
    now: () => new Date("2026-07-30T10:02:00.000Z"),
  });
  assert.equal(written.id, "project:lodestar:commands");
  assert.equal(written.content.state, "known");
  assert.deepEqual(written.aliases, ["lodestar commands"]);
  assert.deepEqual(
    written.links.map(({ relationship, to_id: toId }) => [relationship, toId]),
    [["documents", "project:lodestar"]],
  );
  assert.equal(written.sources[0].metadata.inspection, "inspected");
  assert.deepEqual(getRecord(db, "lodestar commands"), written);
  assert.throws(
    () => getRecord(db, "Lodestar Commands"),
    ({ code }) => code === "record_not_found",
  );
  db.close();
});

test("replacement is atomic and replaces only owned outgoing metadata", async (t) => {
  const file = await databaseFixture(t);
  const db = await openWriteDatabase(file);
  putRecord(db, project(), {
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  putRecord(db, commands(), {
    now: () => new Date("2026-07-30T10:02:00.000Z"),
  });
  putRecord(db, project({
    id: "record:incoming",
    type: "note",
    name: "Incoming",
    aliases: [],
    links: [{
      relationship: "references",
      to_id: "project:lodestar:commands",
    }],
  }), {
    now: () => new Date("2026-07-30T10:03:00.000Z"),
  });

  const replaced = putRecord(db, commands({
    content: { state: "stale", value: { test: "npm test" } },
    aliases: [],
    links: [],
    sources: [],
  }), {
    now: () => new Date("2026-07-30T10:04:00.000Z"),
  });
  assert.equal(replaced.created_at, "2026-07-30T10:02:00.000Z");
  assert.equal(replaced.updated_at, "2026-07-30T10:04:00.000Z");
  assert.equal(replaced.content.state, "stale");
  assert.deepEqual(replaced.aliases, []);
  assert.deepEqual(replaced.links, []);
  assert.deepEqual(replaced.sources, []);
  assert.equal(
    db.prepare(
      "SELECT count(*) AS count FROM links WHERE to_id = ?",
    ).get(replaced.id).count,
    1,
  );
  db.close();
});

test("alias and missing-target conflicts roll back the whole put", async (t) => {
  const file = await databaseFixture(t);
  const db = await openWriteDatabase(file);
  putRecord(db, project(), {
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  assert.throws(
    () => putRecord(db, commands({ aliases: ["project:lodestar"] })),
    ({ code }) => code === "alias_conflict",
  );
  assert.throws(
    () => putRecord(db, project({
      id: "record:self-alias",
      aliases: ["record:self-alias"],
    })),
    ({ code }) => code === "alias_conflict",
  );
  assert.throws(
    () => putRecord(db, project({
      id: "\uD800",
      aliases: [],
    })),
    ({ code }) => code === "invalid_input",
  );
  assert.throws(
    () => putRecord(db, commands({
      links: [{ relationship: "related", to_id: "record:missing" }],
    })),
    ({ code }) => code === "link_target_not_found",
  );
  assert.equal(
    db.prepare(
      "SELECT count(*) AS count FROM records "
        + "WHERE id = 'project:lodestar:commands'",
    ).get().count,
    0,
  );
  db.close();
});

test("delete cascades aliases, sources, and incoming and outgoing links", async (t) => {
  const file = await databaseFixture(t);
  const db = await openWriteDatabase(file);
  putRecord(db, project(), {
    now: () => new Date("2026-07-30T10:01:00.000Z"),
  });
  putRecord(db, commands(), {
    now: () => new Date("2026-07-30T10:02:00.000Z"),
  });
  const result = deleteRecord(db, "lodestar project");
  assert.deepEqual(result, {
    id: "project:lodestar",
    deleted: {
      records: 1,
      aliases: 1,
      sources: 0,
      links: 1,
    },
  });
  assert.throws(
    () => getRecord(db, "project:lodestar"),
    ({ code }) => code === "record_not_found",
  );
  assert.deepEqual(getRecord(db, "project:lodestar:commands").links, []);
  db.close();

  const read = await openReadDatabase(file);
  assert.equal(
    read.prepare("PRAGMA foreign_key_check").all().length,
    0,
  );
  read.close();
});

test("keeps every required knowledge state distinct", async (t) => {
  const file = await databaseFixture(t);
  const db = await openWriteDatabase(file);
  const states = [
    "known",
    "known_empty",
    "unavailable",
    "unknown",
    "stale",
  ];
  for (const [index, state] of states.entries()) {
    putRecord(db, project({
      id: `state:${state}`,
      name: state,
      aliases: [],
      content: { state, value: index },
    }), {
      now: () => new Date(`2026-07-30T10:0${index}:00.000Z`),
    });
  }
  assert.deepEqual(
    states.map((state) => getRecord(db, `state:${state}`).content.state),
    states,
  );
  db.close();
});

test("reads fail closed when stored JSON bypasses schema checks", async (t) => {
  const file = await databaseFixture(t);
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA ignore_check_constraints = ON");
  raw.prepare(
    "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "record:corrupt",
    "note",
    "Corrupt",
    "global",
    '{"value":"missing state"}',
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
  );
  raw.close();

  const db = await openReadDatabase(file);
  assert.throws(
    () => getRecord(db, "record:corrupt"),
    ({ code }) => code === "database_integrity",
  );
  db.close();
});
