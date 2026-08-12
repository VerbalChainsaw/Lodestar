import { lodestarError } from "./errors.mjs";
import { inspectSchemaDefinitions, SCHEMA_VERSION } from "./schema.mjs";
import { validateTimestamp } from "./validate.mjs";

export function readMetadata(db, file = null) {
  try {
    const rows = db.prepare(
      "SELECT key, substr(value, 1, 4097) AS value, "
        + "length(CAST(value AS BLOB)) AS bytes FROM metadata "
        + "WHERE key IN ("
        + "'schema_version', 'created_at', 'database_instance_id'"
        + ") ORDER BY key",
    ).all();
    if (rows.some(({ bytes }) => Number(bytes) > 4096)) {
      throw lodestarError(
        "invalid_database",
        "Required Lodestar metadata exceeds its storage limit.",
        {
          identifiers: { database: file },
          action: "Run lodestar doctor and use a valid Lodestar database.",
        },
      );
    }
    return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  } catch (error) {
    if (error?.name === "LodestarError") throw error;
    const code = String(error?.code ?? "");
    const primaryCode = Number.isInteger(error?.errcode)
      ? error.errcode & 0xff
      : null;
    if (
      code.includes("SQLITE_BUSY")
      || code.includes("SQLITE_LOCKED")
      || primaryCode === 5
      || primaryCode === 6
    ) {
      throw lodestarError(
        "database_busy",
        "The Lodestar database is busy.",
        {
          identifiers: { database: file },
          action: "Wait for the other writer to finish and retry.",
          cause: error,
        },
      );
    }
    if (
      code.includes("SQLITE_CORRUPT")
      || code.includes("SQLITE_NOTADB")
      || primaryCode === 11
      || primaryCode === 26
    ) {
      throw lodestarError(
        "database_integrity",
        "The database is corrupt or is not a SQLite database.",
        {
          identifiers: { database: file },
          action: "Run lodestar doctor and restore an external backup if needed.",
          cause: error,
        },
      );
    }
    throw lodestarError(
      "invalid_database",
      "The file does not contain Lodestar metadata.",
      {
        identifiers: { database: file },
        action:
          "Choose a Lodestar database or write the first record to a new path.",
        cause: error,
      },
    );
  }
}

export function assertSupportedSchema(db, file = null) {
  const metadata = readMetadata(db, file);
  if (metadata.schema_version !== String(SCHEMA_VERSION)) {
    throw lodestarError(
      "unsupported_schema",
      "The database schema version is not supported.",
      {
        identifiers: {
          database: file,
          expected: SCHEMA_VERSION,
          actual: metadata.schema_version ?? null,
        },
        action: "Use a database created by this Lodestar version.",
      },
    );
  }
  try {
    validateTimestamp(metadata.created_at, "metadata.created_at");
  } catch (error) {
    throw lodestarError(
      "invalid_database",
      "The database creation timestamp is invalid.",
      {
        identifiers: {
          database: file,
          created_at: metadata.created_at ?? null,
        },
        action: "Run lodestar doctor and use a valid Lodestar database.",
        cause: error,
      },
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(metadata.database_instance_id ?? "")) {
    throw lodestarError(
      "invalid_database",
      "The database instance ID is invalid.",
      {
        identifiers: {
          database: file,
          database_instance_id: metadata.database_instance_id ?? null,
        },
        action: "Run lodestar doctor and use a valid Lodestar database.",
      },
    );
  }
  const schema = inspectSchemaDefinitions(db);
  if (!schema.matches) {
    throw lodestarError(
      "invalid_database",
      `The database schema does not match Lodestar schema version ${SCHEMA_VERSION}.`,
      {
        identifiers: {
          database: file,
          missing: schema.missing,
          unexpected: schema.unexpected,
          mismatched: schema.mismatched,
        },
        action: "Run lodestar doctor and use a valid Lodestar database.",
      },
    );
  }
  return metadata;
}
