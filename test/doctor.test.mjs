import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  initializeDatabase,
  openDiagnosticDatabase,
} from "../src/database.mjs";
import { diagnoseDatabase } from "../src/doctor.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-doctor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file, {
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  return file;
}

test("doctor reports a healthy schema without writing", async (t) => {
  const file = await fixture(t);
  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.equal(report.healthy, true);
  assert.deepEqual(report.checks, {
    integrity: "ok",
    foreign_key_violations: 0,
    expected_tables: true,
    expected_indexes: true,
    expected_definitions: true,
  });
});

test("doctor detects foreign-key and schema-shape problems", async (t) => {
  const file = await fixture(t);
  const raw = new DatabaseSync(file, {
    enableForeignKeyConstraints: false,
  });
  raw.exec("CREATE TABLE unexpected(value TEXT) STRICT");
  raw.prepare(
    "INSERT INTO aliases(alias, record_id) VALUES (?, ?)",
  ).run("orphan", "record:missing");
  raw.close();

  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.equal(report.healthy, false);
  assert.equal(report.checks.expected_tables, false);
  assert.equal(report.checks.foreign_key_violations, 1);
  assert.ok(report.issues.some(({ code }) => code === "schema_tables_invalid"));
  assert.ok(report.issues.some(({ code }) => code === "foreign_key_violation"));
});

test("doctor detects altered DDL even when object names still match", async (t) => {
  const file = await fixture(t);
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX aliases_record_id");
  raw.exec("CREATE INDEX aliases_record_id ON aliases(alias)");
  raw.close();

  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.equal(report.checks.expected_indexes, true);
  assert.equal(report.checks.expected_definitions, false);
  assert.ok(
    report.issues.some(({ code }) => code === "schema_definitions_invalid"),
  );
});

test("doctor reports objects whose names only resemble SQLite internals", async (t) => {
  const file = await fixture(t);
  const raw = new DatabaseSync(file);
  raw.exec(
    "CREATE TRIGGER sqlitehidden AFTER UPDATE ON records "
      + "BEGIN SELECT 1; END",
  );
  raw.close();

  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.equal(report.healthy, false);
  assert.equal(report.checks.expected_definitions, false);
  assert.ok(
    report.issues.some(
      ({ code, identifiers }) =>
        code === "schema_definitions_invalid"
        && identifiers.unexpected.includes("sqlitehidden"),
    ),
  );
});

test("doctor reports forged objects inside SQLite's reserved namespace", async (t) => {
  const file = await fixture(t);
  const raw = new DatabaseSync(file);
  raw.enableDefensive(false);
  raw.exec(
    "CREATE TRIGGER schema_probe AFTER UPDATE ON records "
      + "BEGIN SELECT 1; END",
  );
  raw.exec(
    "PRAGMA writable_schema = ON; "
      + "UPDATE sqlite_schema SET name = 'sqlite_hidden', "
      + "sql = replace(sql, 'schema_probe', 'sqlite_hidden') "
      + "WHERE type = 'trigger' AND name = 'schema_probe'; "
      + "PRAGMA writable_schema = OFF",
  );
  raw.close();

  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.equal(report.healthy, false);
  assert.equal(report.checks.expected_definitions, false);
  assert.ok(
    report.issues.some(
      ({ code, identifiers }) =>
        code === "schema_definitions_invalid"
        && identifiers.unexpected.includes("sqlite_hidden"),
    ),
  );
});

test("doctor detects invalid knowledge and source states inserted around checks", async (t) => {
  const file = await fixture(t);
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA ignore_check_constraints = ON");
  raw.prepare(
    "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "record:invalid",
    "note",
    "Invalid",
    "global",
    '{"value":"state is absent"}',
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
  );
  raw.prepare(
    "INSERT INTO sources VALUES (?, ?, ?, ?)",
  ).run(
    "record:invalid",
    "fixture",
    "invented",
    "{}",
  );
  raw.close();

  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.ok(
    report.issues.some(({ code }) => code === "record_content_invalid"),
  );
  assert.ok(
    report.issues.some(({ code }) => code === "source_metadata_invalid"),
  );
});

test("doctor reports incompatible columns without querying through them", async (t) => {
  const file = await fixture(t);
  const raw = new DatabaseSync(file);
  raw.exec("ALTER TABLE records RENAME COLUMN content_json TO payload_json");
  raw.close();

  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.equal(report.healthy, false);
  assert.ok(
    report.issues.some(({ code }) => code === "schema_columns_invalid"),
  );
  assert.ok(
    report.issues.some(({ code }) => code === "schema_definitions_invalid"),
  );
});

test("doctor serializes invalid metadata and detects ownership limits", async (t) => {
  const file = await fixture(t);
  const raw = new DatabaseSync(file);
  raw.prepare(
    "UPDATE metadata SET value = ? WHERE key = 'schema_version'",
  ).run("future");
  raw.prepare(
    "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "record:many-aliases",
    "note",
    "Many aliases",
    "global",
    '{"state":"known"}',
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
  );
  const insertAlias = raw.prepare(
    "INSERT INTO aliases(alias, record_id) VALUES (?, ?)",
  );
  for (let index = 0; index < 65; index += 1) {
    insertAlias.run(`alias:${String(index).padStart(2, "0")}`, "record:many-aliases");
  }
  raw.close();

  const db = await openDiagnosticDatabase(file);
  const report = diagnoseDatabase(db, { database: file });
  db.close();
  assert.equal(report.healthy, false);
  assert.equal(report.schema_version, "future");
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.ok(report.issues.some(({ code }) => code === "unsupported_schema"));
  assert.ok(
    report.issues.some(({ code }) => code === "owned_row_limit_exceeded"),
  );
});
