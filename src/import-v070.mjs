import { Buffer } from "node:buffer";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  beginImmediate,
  commit,
  databaseFileIsEmpty,
  openConnection,
  openDiagnosticDatabase,
  openWriteDatabase,
  reserveNewDatabase,
  rollback,
} from "./database.mjs";
import { diagnoseDatabase } from "./doctor.mjs";
import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { convertV070 } from "./legacy-v070/convert.mjs";
import {
  readV070Store,
  verifyLegacySourceUnchanged,
} from "./legacy-v070/read.mjs";
import { assertImportDestinationOutsideSource } from "./paths.mjs";
import { writeRecordSnapshot } from "./records.mjs";
import { createSchema, SCHEMA_VERSION } from "./schema.mjs";
import { LIMITS, validateTimestamp } from "./validate.mjs";

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertEmptyDestination(db, database) {
  const counts = {};
  for (const table of ["records", "aliases", "links", "sources"]) {
    counts[table] = Number(
      db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count,
    );
  }
  if (Object.values(counts).some((count) => count !== 0)) {
    throw lodestarError(
      "import_destination_not_empty",
      "Legacy import requires an empty Lodestar database.",
      {
        identifiers: { database, counts },
        action: "Choose a new database path or an initialized empty database.",
      },
    );
  }
}

function writeConvertedRecords(db, records, timestamp) {
  if (records.length > LIMITS.recordsMaximum) {
    throw lodestarError(
      "resource_limit",
      "The converted registry exceeds its record limit.",
      {
        identifiers: {
          records: records.length,
          maximum: LIMITS.recordsMaximum,
        },
      },
    );
  }
  for (const record of records) {
    writeRecordSnapshot(db, { ...record, links: [] }, {
      createdAt: timestamp,
      updatedAt: timestamp,
      enforceRecordLimit: false,
    });
  }
  const insertLink = db.prepare(
    "INSERT INTO links(from_id, relationship, to_id, created_at) "
      + "VALUES (?, ?, ?, ?)",
  );
  for (const record of records) {
    for (const link of record.links) {
      insertLink.run(record.id, link.relationship, link.to_id, timestamp);
    }
  }
}

function migrationReport({
  legacy,
  converted,
  database,
  dryRun,
  committed,
  validation,
}) {
  return {
    dry_run: dryRun,
    source: {
      path: legacy.source,
      format: "lodestar-v0.7-compatible",
      version_evidence: legacy.versionEvidence,
      generation: legacy.generation,
      integrity: legacy.integrity,
      fingerprint: legacy.snapshot.fingerprint,
      unchanged: true,
    },
    destination: {
      database,
      schema_version: SCHEMA_VERSION,
      committed,
    },
    imported: converted.counts,
    skipped: converted.report.skipped,
    unsupported: converted.report.unsupported,
    id_mappings: converted.report.id_mappings,
    reporting: converted.report.reporting,
    validation: {
      integrity_check: validation.checks.integrity,
      foreign_key_violations:
        validation.checks.foreign_key_violations,
      doctor_ok: validation.healthy,
    },
  };
}

function assertReportBound(report) {
  const bytes = Buffer.byteLength(canonicalStringify(report), "utf8");
  if (bytes > LIMITS.exportBytes) {
    throw lodestarError(
      "resource_limit",
      "The migration report exceeds its byte limit.",
      {
        identifiers: {
          resource: "migration_report",
          bytes,
          maximum: LIMITS.exportBytes,
        },
        action: "Reduce unsupported source data before importing.",
      },
    );
  }
}

async function convertInsideTransaction({
  db,
  database,
  legacy,
  converted,
  timestamp,
  create,
  dryRun,
}) {
  beginImmediate(db, database);
  try {
    if (create) createSchema(db, { createdAt: timestamp });
    else assertEmptyDestination(db, database);
    writeConvertedRecords(db, converted.records, timestamp);
    const validation = diagnoseDatabase(db, { database });
    if (!validation.healthy) {
      throw lodestarError(
        "import_validation_failed",
        "The converted database failed validation before commit.",
        {
          identifiers: {
            database,
            issues: validation.issues,
            committed: false,
          },
          action: "Review the migration report and source integrity.",
        },
      );
    }
    await verifyLegacySourceUnchanged(legacy.snapshot);
    const report = migrationReport({
      legacy,
      converted,
      database,
      dryRun,
      committed: !dryRun,
      validation,
    });
    assertReportBound(report);
    if (dryRun) rollback(db);
    else {
      try {
        commit(db, database);
      } catch (error) {
        if (db.isTransaction === true) {
          rollback(db);
          throw error;
        }
        throw lodestarError(
          "import_commit_outcome_unknown",
          "SQLite did not confirm the legacy import commit outcome.",
          {
            identifiers: {
              database,
              committed: "unknown",
            },
            action:
              "Preserve both stores and run lodestar doctor on the destination.",
            cause: error,
          },
        );
      }
    }
    return report;
  } catch (error) {
    rollback(db);
    throw error?.name === "LodestarError"
      ? error
      : lodestarError(
        "database_write_failed",
        "SQLite could not write the converted legacy records.",
        {
          identifiers: { database, committed: false },
          action: "Check the destination filesystem and retry the import.",
          cause: error,
        },
      );
  }
}

export async function importV070({
  sourcePath,
  database,
  dryRun = false,
  now = () => new Date(),
}) {
  if (!sourcePath) {
    throw lodestarError(
      "missing_argument",
      "Legacy import requires a v0.7 source path.",
      { identifiers: { argument: "source" } },
    );
  }
  const legacy = await readV070Store(sourcePath);
  await assertImportDestinationOutsideSource({
    source: legacy.source,
    database,
  });
  const timestamp = now().toISOString();
  validateTimestamp(timestamp, "imported_at");
  const converted = convertV070(legacy);

  if (dryRun) {
    const db = openConnection(":memory:");
    try {
      return await convertInsideTransaction({
        db,
        database,
        legacy,
        converted,
        timestamp,
        create: true,
        dryRun: true,
      });
    } finally {
      db.close();
    }
  }

  const existed = await pathExists(database);
  const resumableEmptyFile = existed
    ? await databaseFileIsEmpty(database)
    : false;
  let db;
  let committed = false;
  try {
    if (!existed) {
      await mkdir(path.dirname(database), { recursive: true });
      await assertImportDestinationOutsideSource({
        source: legacy.source,
        database,
      });
      await reserveNewDatabase(database);
    }
    db = existed
      ? resumableEmptyFile
        ? openConnection(database)
        : await openWriteDatabase(database)
      : openConnection(database);
    const report = await convertInsideTransaction({
      db,
      database,
      legacy,
      converted,
      timestamp,
      create: !existed || resumableEmptyFile,
      dryRun: false,
    });
    committed = true;
    db.close();
    db = null;

    const diagnostic = await openDiagnosticDatabase(database);
    let validation;
    try {
      validation = diagnoseDatabase(diagnostic, { database });
    } finally {
      diagnostic.close();
    }
    if (!validation.healthy) {
      throw lodestarError(
        "import_validation_failed",
        "The committed import failed its read-only validation.",
        {
          identifiers: {
            database,
            committed: true,
            issues: validation.issues,
          },
          action: "Preserve both stores and inspect the destination.",
        },
      );
    }
    return {
      ...report,
      validation: {
        integrity_check: validation.checks.integrity,
        foreign_key_violations:
          validation.checks.foreign_key_violations,
        doctor_ok: validation.healthy,
      },
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The import error remains authoritative.
    }
    throw error?.name === "LodestarError"
      ? error
      : lodestarError(
        "database_write_failed",
        "Lodestar could not write the imported database.",
        {
          identifiers: { database, committed },
          action: "Check the destination filesystem and retry.",
          cause: error,
        },
      );
  }
}
