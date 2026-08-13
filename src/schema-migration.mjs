import { constants as fsConstants } from "node:fs";
import { copyFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { CONTINUITY_TABLES } from "./continuity-schema.mjs";
import { assertSupportedSchema, openConnection, transaction } from "./database.mjs";
import { readMetadata } from "./database-schema.mjs";
import { lodestarError } from "./errors.mjs";
import { createDatabaseInstanceId, inspectSchemaDefinitions,
  LEGACY_SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION, SCHEMA_VERSION } from "./schema.mjs";
import { validateTimestamp } from "./validate.mjs";

async function existingFile(file) {
  try {
    const info = await lstat(file);
    return !info.isSymbolicLink() && info.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertLegacySchema(db, file, metadata) {
  try { validateTimestamp(metadata.created_at, "metadata.created_at"); }
  catch (error) {
    throw lodestarError("invalid_database",
      "The schema-v1 database creation timestamp is invalid.", {
        identifiers: { database: file, created_at: metadata.created_at ?? null },
        action: "Run lodestar doctor and use a valid Lodestar database.", cause: error,
      });
  }
  const schema = inspectSchemaDefinitions(db, { version: LEGACY_SCHEMA_VERSION });
  if (!schema.matches) throw lodestarError("invalid_database",
    "The database schema does not match Lodestar schema version 1.", {
      identifiers: { database: file, missing: schema.missing,
        unexpected: schema.unexpected, mismatched: schema.mismatched },
      action: "Run lodestar doctor and use a valid Lodestar database.",
    });
}

function assertPreviousSchema(db, file, metadata) {
  try { validateTimestamp(metadata.created_at, "metadata.created_at"); }
  catch (error) {
    throw lodestarError("invalid_database",
      "The schema-v2 database creation timestamp is invalid.", {
        identifiers: { database: file, created_at: metadata.created_at ?? null },
        action: "Run lodestar doctor and use a valid Lodestar database.", cause: error,
      });
  }
  const schema = inspectSchemaDefinitions(db, { version: PREVIOUS_SCHEMA_VERSION });
  if (!schema.matches) throw lodestarError("invalid_database",
    "The database schema does not match Lodestar schema version 2.", {
      identifiers: { database: file, missing: schema.missing,
        unexpected: schema.unexpected, mismatched: schema.mismatched },
      action: "Run lodestar doctor and use a valid Lodestar database.",
    });
  const counts = Object.fromEntries(CONTINUITY_TABLES.map((table) => [table,
    Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)]));
  if (Object.values(counts).some((count) => count !== 0)) throw lodestarError(
    "migration_state_conflict",
    "Schema-v2 continuity state must be converted before Lodestar can remove its retired tables.", {
      identifiers: { database: file, counts },
      action: "Preserve this database and convert every nonempty continuity row before retrying.",
    });
}

function migrationBackupPath(file, version, now, backupId) {
  const timestamp = now().toISOString().replace(/[-:.]/gu, "");
  return `${file}.schema-v${version}-${timestamp}-${backupId()}.bak`;
}

export async function migrateDatabase(file, {
  now = () => new Date(), copy = copyFile,
  databaseInstanceId = createDatabaseInstanceId, backupId = randomUUID,
} = {}) {
  if (!await existingFile(file)) throw lodestarError("database_not_found",
    "The Lodestar database does not exist.", { identifiers: { database: file } });
  const probe = openConnection(file, { configureWrite: false });
  let metadata;
  try {
    metadata = readMetadata(probe, file);
    if (metadata.schema_version === String(SCHEMA_VERSION)) {
      assertSupportedSchema(probe, file);
      return { migrated: false, from_schema_version: SCHEMA_VERSION,
        schema_version: SCHEMA_VERSION, backup_path: null,
        database_instance_id: metadata.database_instance_id };
    }
    if (![LEGACY_SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION]
      .map(String).includes(metadata.schema_version)) {
      throw lodestarError("unsupported_schema",
        "The database schema version is not supported.", { identifiers: {
          database: file, expected: [LEGACY_SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION, SCHEMA_VERSION],
          actual: metadata.schema_version ?? null,
        } });
    }
    if (metadata.schema_version === String(LEGACY_SCHEMA_VERSION)) {
      assertLegacySchema(probe, file, metadata);
    } else {
      assertPreviousSchema(probe, file, metadata);
    }
  } finally { probe.close(); }

  const fromVersion = Number(metadata.schema_version);
  const backupPath = migrationBackupPath(file, fromVersion, now, backupId);
  try { await copy(file, backupPath, fsConstants.COPYFILE_EXCL); }
  catch (error) {
    throw lodestarError("migration_backup_failed",
      "Lodestar could not create the required schema-v1 backup.", {
        identifiers: { database: file, backup: backupPath },
        action: "Make the database directory writable and retry migration.", cause: error,
      });
  }

  const db = openConnection(file);
  let migrated = false, instanceId;
  try {
    transaction(db, () => {
      const current = readMetadata(db, file);
      if (current.schema_version === String(SCHEMA_VERSION)) {
        assertSupportedSchema(db, file);
        instanceId = current.database_instance_id;
        return;
      }
      if (![LEGACY_SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION]
        .map(String).includes(current.schema_version)) {
        throw lodestarError("unsupported_schema",
          "The database schema changed before migration could begin.",
          { identifiers: { database: file, actual: current.schema_version } });
      }
      if (current.schema_version === String(LEGACY_SCHEMA_VERSION)) {
        assertLegacySchema(db, file, current);
      } else {
        assertPreviousSchema(db, file, current);
        db.exec("DROP TABLE continuity_events; DROP TABLE continuity_transfers; "
          + "DROP TABLE continuity_packets; DROP TABLE continuity_lanes;");
      }
      instanceId = db.prepare("SELECT value FROM metadata WHERE key='database_instance_id'")
        .get()?.value ?? databaseInstanceId();
      if (!/^[0-9a-f]{64}$/u.test(instanceId)) throw lodestarError(
        "invalid_database", "The migration database instance ID is invalid.");
      const insert = db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)");
      insert.run("database_instance_id", instanceId);
      insert.run("database_revision", "0");
      db.prepare("UPDATE metadata SET value=? WHERE key='schema_version'")
        .run(String(SCHEMA_VERSION));
      migrated = true;
    }, file);
  } finally { db.close(); }

  const verified = openConnection(file, { readOnly: true });
  try { instanceId = assertSupportedSchema(verified, file).database_instance_id; }
  finally { verified.close(); }
  return { migrated, from_schema_version: migrated ? fromVersion : SCHEMA_VERSION,
    schema_version: SCHEMA_VERSION, backup_path: backupPath,
    database_instance_id: instanceId };
}
