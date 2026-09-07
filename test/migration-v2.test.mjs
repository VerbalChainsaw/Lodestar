import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeDatabase, openReadDatabase } from "../src/database.mjs";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";

test("ordinary reads and init refuse schema 4 without converting it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-v4-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lodestar.db");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_V4_SQL);
  const insert = db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)");
  insert.run("schema_version", "4");
  insert.run("created_at", "2026-09-06T10:00:00.000Z");
  insert.run("database_instance_id", "a".repeat(64));
  insert.run("database_revision", "0");
  db.close();
  const before = await readFile(file);
  await assert.rejects(openReadDatabase(file), ({ code }) => code === "unsupported_schema");
  await assert.rejects(initializeDatabase(file), ({ code }) => code === "unsupported_schema");
  assert.deepEqual(await readFile(file), before);
});
