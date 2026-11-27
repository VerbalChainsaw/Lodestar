import {
  EXPECTED_COLUMNS,
  inspectSchemaDefinitions,
  SCHEMA_INDEXES,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
} from "./schema.mjs";
import { boundedDiagnosticValue } from "./diagnostics.mjs";
import { diagnoseDecisions } from "./decision.mjs";
import { diagnoseHandoff } from "./continuity.mjs";
import { storedSemanticIssues } from "./stored-semantics.mjs";
import { validateTimestamp } from "./validate.mjs";
import { schemaVersionGuidance } from "./database-schema.mjs";
export { migrationPreflight } from "./schema-migration.mjs";

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

export function diagnoseDatabase(db, { database = null, quick = false } = {}) {
  const issues = [];
  let coldSummary = null;
  // Reporting is bounded independently of validation. Every finding still
  // contributes to health and exact counts, even after sample storage fills.
  const maximumBytes = 256 * 1024;
  const issueCounts = Object.create(null);
  let issueCount = 0, normalCount = 0, sampleBytes = 2, detailsTruncated = 0;
  const size = value => Buffer.byteLength(JSON.stringify(value), "utf8");
  const project = (value, limit) => size(value) <= limit ? value
    : boundedDiagnosticValue(value, {maximumBytes: limit});
  const keep = issue => {
    const selected = project(issue, 8192);
    if (selected !== issue) detailsTruncated += 1;
    const bytes = size(selected) + 1;
    if (sampleBytes + bytes <= 128 * 1024) {
      issues.push(selected);
      sampleBytes += bytes;
    }
  };
  const finish = report => {
    const reporting = {maximum_bytes: maximumBytes, issue_count: issueCount,
      issue_counts: issueCounts, issues_omitted: normalCount - issues.length,
      issue_details_truncated: detailsTruncated, fields_truncated: [], lists: {}};
    // Preserve existing arrays for ordinary reports. Large lists retain exact
    // totals outside their samples; no consumer may mistake a sample for all IDs.
    for (const group of ["decisions", "handoff"]) {
      const check = report.checks[group];
      if (!check) continue;
      for (const [key, values] of Object.entries(check)) {
        if (!Array.isArray(values) || size(values) <= 8192) continue;
        const samples = [];
        let used = 2, clipped = 0;
        for (const value of values) {
          const sample = project(value, 1024), bytes = size(sample) + 1;
          if (used + bytes > 8192) break;
          samples.push(sample); used += bytes;
          if (sample !== value) clipped += 1;
        }
        check[key] = samples;
        reporting.lists[`checks.${group}.${key}`] = {total: values.length,
          returned: samples.length, omitted: values.length - samples.length,
          details_truncated: clipped};
      }
    }
    for (const [key, value] of Object.entries(report)) {
      if (key === "issues") continue;
      const selected = project(value, key === "checks" ? 48 * 1024 : 4096);
      if (selected !== value) reporting.fields_truncated.push(key);
      report[key] = selected;
    }
    if (coldSummary) {
      const selected = project(coldSummary, 8192);
      if (selected !== coldSummary) reporting.issue_details_truncated += 1;
      // Reserve a separately bounded cold summary even if earlier errors filled
      // the ordinary sample budget. Its count is the full validation count.
      report.issues = [...issues, selected];
    }
    report.reporting = reporting;
    return report;
  };
  const add = (code, message, identifiers = {}, action = undefined) => {
    issueCount += 1;
    issueCounts[code] = (issueCounts[code] ?? 0) + 1;
    // Cold receipts share a validation prerequisite. Report its full count
    // without repeating thousands of identical restore messages over MCP.
    // This remains an issue: complete=false and healthy=null/false below.
    if (code === "archive_restore_required") {
      if (!coldSummary) {
        coldSummary = {code, message: "Historical receipts require explicit cold-archive access; their validation is incomplete.",
          identifiers: {count: 0, sample_receipt_ids: [], receipt_ids_omitted: 0,
            manifest_samples: [], manifest_samples_truncated: false, required_restore_bytes_max: 0},
          ...(action ? {action} : {})};

      }
      const summary = coldSummary.identifiers;
      summary.count += 1;
      if (typeof identifiers.id === "string" && summary.sample_receipt_ids.length < 5) summary.sample_receipt_ids.push(identifiers.id);
      summary.receipt_ids_omitted = summary.count - summary.sample_receipt_ids.length;
      if (typeof identifiers.manifest === "string" && !summary.manifest_samples.includes(identifiers.manifest)) {
        if (summary.manifest_samples.length < 5) summary.manifest_samples.push(identifiers.manifest);
        else summary.manifest_samples_truncated = true;
      }
      if (Number.isSafeInteger(identifiers.required_bytes)) summary.required_restore_bytes_max = Math.max(summary.required_restore_bytes_max, identifiers.required_bytes);
      return;
    }
    normalCount += 1;
    keep({
      code,
      message,
      identifiers,
      ...(action ? { action } : {}),
    });
  };

  let integrity = [];
  if (!quick) try {
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
  if (!quick && !integrityOk) {
    return finish({
      healthy: false,
      database,
      schema_version: null,
      database_created_at: null,
      database_instance_id: null,
      database_epoch: null,
      database_revision: null,
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
    });
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
  let actualStorageVersion = SCHEMA_VERSION;
  try { const value = Number(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value);
    if ([4,5,SCHEMA_VERSION].includes(value)) actualStorageVersion=value;
  } catch { /* The existing metadata checks below report malformed storage. */ }
  const definitions = inspectSchemaDefinitions(db, {version: actualStorageVersion});
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
  let databaseEpoch = null;
  let databaseRevision = null;
  if (validColumns.metadata) {
    const metadataRows = db.prepare(
      "SELECT key, value FROM metadata "
      + "WHERE key IN ("
      + "'schema_version', 'created_at', 'database_instance_id', "
      + "'database_epoch', 'database_revision'"
      + ") ORDER BY key",
    ).all();
    const metadata = Object.fromEntries(
      metadataRows.map(({ key, value }) => [key, value]),
    );
    const schemaValue = metadata.schema_version ?? null;
    schemaVersion = ["5",String(SCHEMA_VERSION)].includes(schemaValue) ? Number(schemaValue) : schemaValue;
    databaseCreatedAt = metadata.created_at ?? null;
    databaseInstanceId = metadata.database_instance_id ?? null;
    databaseEpoch = metadata.database_epoch ?? null;
    databaseRevision = metadata.database_revision ?? null;
    if (!["5",String(SCHEMA_VERSION)].includes(schemaValue)) {
      const guidance = schemaVersionGuidance(database, schemaValue);
      add(
        "unsupported_schema",
        "The database schema version is not supported.",
        guidance.identifiers,
        guidance.action,
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
    if (!/^[0-9a-f]{64}$/u.test(metadata.database_epoch ?? "")) {
      add("database_epoch_invalid", "The database recovery epoch is invalid.",
        { database_epoch: databaseEpoch });
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(metadata.database_revision ?? "")
      || !Number.isSafeInteger(Number(metadata.database_revision))) {
      add("database_revision_invalid", "The database revision is invalid.",
        { database_revision: databaseRevision });
    }
  }

  if (quick) return finish({
    mode: "quick",
    complete: false,
    healthy: issueCount === 0 ? null : false,
    quick_check_passed: issueCount === 0,
    database,
    schema_version: schemaVersion,
    database_created_at: databaseCreatedAt,
    database_instance_id: databaseInstanceId,
    database_epoch: databaseEpoch,
    database_revision: databaseRevision === null ? null : Number(databaseRevision),
    counts: { records: null, links: null, aliases: null, sources: null },
    checks: {
      integrity: "not_run",
      foreign_key_violations: null,
      expected_tables: same(tables, SCHEMA_TABLES),
      expected_indexes: same(indexes, SCHEMA_INDEXES),
      expected_definitions: definitions.matches,
    },
    not_run: ["integrity", "foreign_keys", "record_counts", "stored_semantics",
      "decisions", "handoff", "alias_collisions"],
    action: "Run the same doctor command without --quick for full integrity and stored-data validation; allow time proportional to the database size.",
    issues,
  });

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
    add(issue.code, issue.message, issue.identifiers, issue.action);
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

  return finish({
    complete: coldSummary === null,
    healthy: normalCount > 0 ? false : coldSummary ? null : true,
    database,
    schema_version: schemaVersion,
    database_created_at: databaseCreatedAt,
    database_instance_id: databaseInstanceId,
    database_epoch: databaseEpoch,
    database_revision: databaseRevision === null ? null : Number(databaseRevision),
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
  });
}
