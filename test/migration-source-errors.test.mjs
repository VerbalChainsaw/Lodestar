import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";
import { migrationPreflight } from "../src/schema-migration.mjs";
import { runCli } from "../src/cli.mjs";

async function corruptSource(t, table, text) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-migration-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.db"), db = new DatabaseSync(file);
  db.exec(SCHEMA_V4_SQL);
  const metadata = db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)");
  for (const [key, value] of Object.entries({ schema_version: "4", created_at: "2026-09-06T09:00:00.000Z",
    database_instance_id: "a".repeat(64), database_revision: "9", database_epoch: "b".repeat(64) })) metadata.run(key, value);
  db.exec("PRAGMA ignore_check_constraints=ON");
  db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)").run("-h", "fact", "Preserved source", "global",
    table === "records" ? text : '{"state":"known","value":{"kept":true}}',
    "2026-09-06T09:00:00.000Z", "2026-09-06T09:00:00.000Z");
  if (table === "sources") db.prepare("INSERT INTO sources VALUES(?,?,?,?)").run("-h", "fixture:source", "current", text);
  db.close();
  return file;
}

for (const table of ["records", "sources"]) for (const text of ["{", '[1,', '{"a":1,"a":2}',
  ...(table === "records" ? ["null", "1", "[]"] : [])]) {
  test(`migration malformed ${table} JSON is source-specific and preserves bytes: ${text}`, async (t) => {
    const file = await corruptSource(t, table, text);
    const hash = async () => createHash("sha256").update(await readFile(file)).digest("hex");
    const before = await hash();
    const expected = (error) => {
      assert.equal(error.name, "LodestarError"); assert.equal(error.code, "invalid_database");
      assert.equal(error.identifiers.database, file); assert.equal(error.identifiers.table, table);
      assert.equal(error.identifiers.id, "-h");
      assert.equal(error.identifiers.field, table === "records" ? "content_json" : "metadata_json");
      assert.match(error.action, /preserve/iu); assert.match(error.action, /restore|source/iu);
      assert.deepEqual(error.identifiers.preflight_args, ["--db", file, "doctor", "--migration-preflight"]);
      return true;
    };
    await assert.rejects(migrationPreflight(file), expected);
    let stdout = "", stderr = "";
    const code = await runCli(["--db", file, "doctor", "--migration-preflight"], {
      stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } },
    });
    assert.equal(code, 4); assert.equal(stdout, "");
    const envelope = JSON.parse(stderr);
    assert.equal(envelope.operation, "doctor"); assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "invalid_database"); assert.equal(envelope.error.identifiers.id, "-h");
    assert.equal(await hash(), before);
  });
}
