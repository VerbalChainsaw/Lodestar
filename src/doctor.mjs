import {
  EXPECTED_COLUMNS,
  inspectSchemaDefinitions,
  SCHEMA_INDEXES,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
} from "./schema.mjs";
import { CONTINUITY_TABLES } from "./continuity-schema.mjs";
import { boundedDiagnosticValue } from "./diagnostics.mjs";
import { storedSemanticIssues } from "./stored-semantics.mjs";
import { LIMITS, validateTimestamp } from "./validate.mjs";

const MAX_ISSUES = 100;

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
  let omittedIssues = 0;
  const add = (code, message, identifiers = {}, action = undefined) => {
    if (issues.length >= MAX_ISSUES) {
      omittedIssues += 1;
      return false;
    }
    issues.push({
      code,
      message,
      identifiers: boundedDiagnosticValue(identifiers, {
        maximumBytes: 4096,
      }),
      ...(action ? { action } : {}),
    });
    return true;
  };

  let integrity = [];
  try {
    integrity = db.prepare("PRAGMA integrity_check(100)").all()
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
        continuity_lanes: null,
        continuity_packets: null,
        continuity_events: null,
        continuity_transfers: null,
      },
      checks: {
        integrity: "failed",
        foreign_key_violations: null,
        expected_tables: false,
        expected_indexes: false,
        expected_definitions: false,
      },
      issues,
      issues_truncated: omittedIssues > 0,
      omitted_issues: omittedIssues,
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
      "SELECT key, substr(value, 1, 4097) AS value, "
        + "length(CAST(value AS BLOB)) AS bytes FROM metadata "
      + "WHERE key IN ("
      + "'schema_version', 'created_at', 'database_instance_id'"
      + ") ORDER BY key",
    ).all();
    const metadata = Object.fromEntries(
      metadataRows.map(({ key, value }) => [key, value]),
    );
    const schemaValue = metadata.schema_version ?? null;
    schemaVersion = schemaValue === String(SCHEMA_VERSION)
      ? SCHEMA_VERSION
      : boundedDiagnosticValue(schemaValue, { maximumBytes: 1024 });
    databaseCreatedAt = boundedDiagnosticValue(
      metadata.created_at ?? null,
      { maximumBytes: 1024 },
    );
    databaseInstanceId = boundedDiagnosticValue(
      metadata.database_instance_id ?? null,
      { maximumBytes: 1024 },
    );
    for (const row of metadataRows) {
      if (Number(row.bytes) > 4096) {
        add(
          "metadata_value_invalid",
          "A required metadata value exceeds its byte limit.",
          { key: row.key, bytes: Number(row.bytes), maximum: 4096 },
        );
      }
    }
    if (schemaValue !== String(SCHEMA_VERSION)) {
      add(
        "unsupported_schema",
        "The database schema version is not supported.",
        {
          expected: SCHEMA_VERSION,
          actual: boundedDiagnosticValue(schemaValue, {
            maximumBytes: 1024,
          }),
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
      "SELECT * FROM pragma_foreign_key_check LIMIT 101",
    ).all();
    for (const row of foreignKeyRows.slice(0, 100)) {
      add(
        "foreign_key_violation",
        "A row references a missing parent record.",
        { table: row.table, rowid: row.rowid, parent: row.parent },
      );
    }
    if (foreignKeyRows.length > 100) omittedIssues += 1;
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
    "continuity_lanes",
    "continuity_packets",
    "continuity_events",
    "continuity_transfers",
  ]) {
    if (!tables.includes(table)) {
      counts[table] = null;
      continue;
    }
    counts[table] = Number(
      db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count,
    );
  }
  if (counts.records !== null && counts.records > LIMITS.recordsMaximum) {
    add(
      "record_limit_exceeded",
      "The registry exceeds its supported record limit.",
      {
        count: counts.records,
        maximum: LIMITS.recordsMaximum,
      },
    );
  }
  const ownershipLimits = [
    ["aliases", "record_id", LIMITS.aliasesPerRecord, "alias"],
    ["links", "from_id", LIMITS.linksPerRecord, "outgoing link"],
    ["sources", "record_id", LIMITS.sourcesPerRecord, "source"],
  ];
  for (const [table, ownerColumn, maximum, resource] of ownershipLimits) {
    if (!validColumns[table]) continue;
    const groups = db.prepare(
      `SELECT ${ownerColumn} AS owner, count(*) AS count FROM ${table} `
        + `GROUP BY ${ownerColumn} HAVING count(*) > ? `
        + `ORDER BY ${ownerColumn} LIMIT 101`,
    ).all(maximum);
    for (const row of groups.slice(0, 100)) {
      add(
        "owned_row_limit_exceeded",
        `A record exceeds its ${resource} limit.`,
        {
          resource,
          record_id: row.owner,
          count: Number(row.count),
          maximum,
        },
      );
    }
    if (groups.length > 100) omittedIssues += 1;
  }

  for (const issue of storedSemanticIssues(db, validColumns)) {
    if (!add(issue.code, issue.message, issue.identifiers)) break;
  }

  if (validColumns.aliases && validColumns.records) {
    const collisions = db.prepare(
      "SELECT a.alias, a.record_id, r.id AS conflicting_id "
        + "FROM aliases a JOIN records r ON r.id = a.alias "
        + "ORDER BY a.alias LIMIT 101",
    ).all();
    for (const row of collisions.slice(0, 100)) {
      add(
        "identifier_alias_ambiguity",
        "An alias is identical to a record ID.",
        row,
      );
    }
    if (collisions.length > 100) omittedIssues += 1;
  }

  const continuityChecks = [
    {
      code: "continuity_active_packet_invalid",
      message: "A lane active packet is missing or belongs to another lane.",
      sql: "SELECT l.lane_id, l.active_packet_id AS related_id "
        + "FROM continuity_lanes l LEFT JOIN continuity_packets p "
        + "ON p.lane_id = l.lane_id AND p.packet_id = l.active_packet_id "
        + "WHERE l.active_packet_id IS NOT NULL AND p.packet_id IS NULL",
    },
    {
      code: "continuity_predecessor_invalid",
      message: "A packet predecessor is missing or crosses lanes.",
      sql: "SELECT p.lane_id, p.predecessor_packet_id AS related_id "
        + "FROM continuity_packets p LEFT JOIN continuity_packets prior "
        + "ON prior.lane_id = p.lane_id "
        + "AND prior.packet_id = p.predecessor_packet_id "
        + "WHERE p.predecessor_packet_id IS NOT NULL "
        + "AND prior.packet_id IS NULL",
    },
    {
      code: "continuity_absorption_invalid",
      message: "An absorbed event packet is missing or crosses lanes.",
      sql: "SELECT e.lane_id, e.absorbed_packet_id AS related_id "
        + "FROM continuity_events e LEFT JOIN continuity_packets p "
        + "ON p.lane_id = e.lane_id AND p.packet_id = e.absorbed_packet_id "
        + "WHERE e.absorbed_packet_id IS NOT NULL AND p.packet_id IS NULL",
    },
    {
      code: "continuity_transfer_packet_invalid",
      message: "A transfer packet is missing or crosses lanes.",
      sql: "SELECT t.lane_id, t.packet_id AS related_id "
        + "FROM continuity_transfers t LEFT JOIN continuity_packets p "
        + "ON p.lane_id = t.lane_id AND p.packet_id = t.packet_id "
        + "WHERE p.packet_id IS NULL",
    },
  ];
  if (CONTINUITY_TABLES.every((table) => validColumns[table])) {
    for (const check of continuityChecks) {
      const rows = db.prepare(`${check.sql} LIMIT 101`).all();
      for (const row of rows.slice(0, 100)) {
        add(check.code, check.message, row);
      }
      if (rows.length > 100) omittedIssues += 1;
    }
  }

  return {
    healthy: issues.length === 0 && omittedIssues === 0,
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
    },
    issues,
    issues_truncated: omittedIssues > 0,
    omitted_issues: omittedIssues,
  };
}
