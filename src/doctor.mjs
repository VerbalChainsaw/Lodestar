import {
  EXPECTED_COLUMNS,
  inspectSchemaDefinitions,
  SCHEMA_INDEXES,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
} from "./schema.mjs";
import { diagnoseDecisions } from "./decision.mjs";
import { diagnoseHandoff } from "./continuity.mjs";
import { storedSemanticIssues } from "./stored-semantics.mjs";
import { validateTimestamp } from "./validate.mjs";

function orderedNames(db, type) {
  return db.prepare(
    "SELECT name FROM sqlite_schema "
      + "WHERE type = ? "
      + "AND lower(substr(name, 1, 7)) <> 'sqlite_' ORDER BY name",
  ).all(type).map(({ name }) => name);
}

function same(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function diagnoseDatabase(db, { database = null } = {}) {
  const issues = [];
  const add = (code, message, identifiers = {}, action = undefined) => {
    issues.push({
      code,
      message,
      identifiers,
      ...(action ? { action } : {}),
    });
  };

  let integrity = [];
  try {
    integrity = db.prepare("PRAGMA integrity_check").all()
      .map((row) => Object.values(row)[0]);
    for (const result of integrity) {
      if (result !== "ok") {
        add(
          "integrity_error",
          "SQLite reported a structural integrity error.",
          { result },
          "Restore an external backup; doctor does not repair corruption.",
        );
      }
    }
  } catch (error) {
    add("integrity_check_failed", "SQLite integrity checking failed.", {
      reason: error.code ?? error.message,
    });
  }
  const integrityOk = integrity.length === 1 && integrity[0] === "ok";
  if (!integrityOk) {
    return {
      healthy: false,
      database,
      schema_version: null,
      database_created_at: null,
      database_instance_id: null,
      counts: {
        records: null,
        links: null,
        aliases: null,
        sources: null,
      },
      checks: {
        integrity: "failed",
        foreign_key_violations: null,
        expected_tables: false,
        expected_indexes: false,
        expected_definitions: false,
      },
      issues,
    };
  }

  const tables = orderedNames(db, "table");
  if (!same(tables, SCHEMA_TABLES)) {
    add(
      "schema_tables_invalid",
      `The database table set does not match schema version ${SCHEMA_VERSION}.`,
      { expected: SCHEMA_TABLES, actual: tables },
    );
  }
  const indexes = orderedNames(db, "index");
  if (!same(indexes, SCHEMA_INDEXES)) {
    add(
      "schema_indexes_invalid",
      `The database index set does not match schema version ${SCHEMA_VERSION}.`,
      { expected: SCHEMA_INDEXES, actual: indexes },
    );
  }
  const definitions = inspectSchemaDefinitions(db);
  if (!definitions.matches) {
    add(
      "schema_definitions_invalid",
      `The database DDL does not match schema version ${SCHEMA_VERSION}.`,
      {
        missing: definitions.missing,
        unexpected: definitions.unexpected,
        mismatched: definitions.mismatched,
      },
    );
  }

  const validColumns = {};
  for (const table of SCHEMA_TABLES) {
    if (!tables.includes(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      .map(({ name }) => name);
    validColumns[table] = same(columns, EXPECTED_COLUMNS[table]);
    if (!validColumns[table]) {
      add(
        "schema_columns_invalid",
        "A database table has unexpected columns.",
        { table, expected: EXPECTED_COLUMNS[table], actual: columns },
      );
    }
  }

  let schemaVersion = null;
  let databaseCreatedAt = null;
  let databaseInstanceId = null;
  if (validColumns.metadata) {
    const metadataRows = db.prepare(
      "SELECT key, value FROM metadata "
      + "WHERE key IN ("
      + "'schema_version', 'created_at', 'database_instance_id'"
      + ") ORDER BY key",
    ).all();
    const metadata = Object.fromEntries(
      metadataRows.map(({ key, value }) => [key, value]),
    );
    const schemaValue = metadata.schema_version ?? null;
    schemaVersion = schemaValue === String(SCHEMA_VERSION) ? SCHEMA_VERSION : schemaValue;
    databaseCreatedAt = metadata.created_at ?? null;
    databaseInstanceId = metadata.database_instance_id ?? null;
    if (schemaValue !== String(SCHEMA_VERSION)) {
      add(
        "unsupported_schema",
        "The database schema version is not supported.",
        {
          expected: SCHEMA_VERSION,
          actual: schemaValue,
        },
      );
    }
    try {
      validateTimestamp(metadata.created_at ?? null, "metadata.created_at");
    } catch {
      add(
        "metadata_timestamp_invalid",
        "The database creation timestamp is invalid.",
        { created_at: databaseCreatedAt },
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(metadata.database_instance_id ?? "")) {
      add(
        "database_instance_id_invalid",
        "The database instance ID is invalid.",
        { database_instance_id: databaseInstanceId },
      );
    }
  }

  let foreignKeyRows = [];
  try {
    foreignKeyRows = db.prepare(
      "SELECT * FROM pragma_foreign_key_check",
    ).all();
    for (const row of foreignKeyRows) {
      add(
        "foreign_key_violation",
        "A row references a missing parent record.",
        { table: row.table, rowid: row.rowid, parent: row.parent },
      );
    }

  } catch (error) {
    add("foreign_key_check_failed", "Foreign-key checking failed.", {
      reason: error.code ?? error.message,
    });
  }

  const counts = {};
  for (const table of [
    "records",
    "links",
    "aliases",
    "sources",
  ]) {
    if (!tables.includes(table)) {
      counts[table] = null;
      continue;
    }
    counts[table] = Number(
      db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count,
    );
  }

  for (const issue of storedSemanticIssues(db, validColumns)) {
    add(issue.code, issue.message, issue.identifiers);
  }

  const decisions = validColumns.records ? diagnoseDecisions(db)
    : { events: null, invalid: [], healthy: false };
  if (validColumns.records) {
    for (const id of decisions.invalid) {
      add("decision_event_invalid", "A decision event is invalid.", { id });
    }
  }
  const handoff = validColumns.records ? diagnoseHandoff(db)
    : { records: null, invalid: [], healthy: false };
  if (validColumns.records) {
    for (const id of handoff.invalid) {
      add("handoff_record_invalid", "A continuity record is invalid.", { id });
    }
  }

  if (validColumns.aliases && validColumns.records) {
    const collisions = db.prepare(
      "SELECT a.alias, a.record_id, r.id AS conflicting_id "
        + "FROM aliases a JOIN records r ON r.id = a.alias "
        + "ORDER BY a.alias",
    ).all();
    for (const row of collisions) {
      add(
        "identifier_alias_ambiguity",
        "An alias is identical to a record ID.",
        row,
      );
    }
  }

  return {
    healthy: issues.length === 0,
    database,
    schema_version: schemaVersion,
    database_created_at: databaseCreatedAt,
    database_instance_id: databaseInstanceId,
    counts,
    checks: {
      integrity: integrity.length === 1 && integrity[0] === "ok"
        ? "ok"
        : "failed",
      foreign_key_violations: foreignKeyRows.length,
      expected_tables: same(tables, SCHEMA_TABLES),
      expected_indexes: same(indexes, SCHEMA_INDEXES),
      expected_definitions: definitions.matches,
      decisions,
      handoff,
    },
    issues,
  };
}
