import { lstat, mkdir, open as openFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { lodestarError, wrapError } from "./errors.mjs";
import { createSchema, inspectSchemaDefinitions, SCHEMA_VERSION } from "./schema.mjs";
import { validateTimestamp } from "./validate.mjs";

export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

function sqliteError(error, file) {
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
    return lodestarError(
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
    return lodestarError(
      "database_integrity",
      "The database is corrupt or is not a SQLite database.",
      {
        identifiers: { database: file },
        action: "Run lodestar doctor and restore an external backup if needed.",
        cause: error,
      },
    );
  }
  return wrapError(
    error,
    "database_error",
    "SQLite could not complete the database operation.",
    {
      identifiers: { database: file },
      action: "Run lodestar doctor for a structured diagnosis.",
    },
  );
}

async function existingFile(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw lodestarError(
        "invalid_database",
        "The database path must name a regular file, not a symlink.",
        {
          identifiers: { database: file },
          action: "Choose a regular database file path.",
        },
      );
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function databaseFileIsEmpty(file) {
  const info = await lstat(file);
  return !info.isSymbolicLink() && info.isFile() && info.size === 0;
}

function configureWriter(db, file) {
  db.exec("PRAGMA synchronous = FULL");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = DELETE");
}

export function openConnection(
  file,
  {
    readOnly = false,
    configureWrite = true,
  } = {},
) {
  let db;
  try {
    db = new DatabaseSync(file, {
      readOnly,
      timeout: DATABASE_BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    if (typeof db.enableDefensive === "function") {
      db.enableDefensive(true);
    }
    db.exec("PRAGMA trusted_schema = OFF");
    db.exec("PRAGMA temp_store = MEMORY");
    if (readOnly) {
      db.exec("PRAGMA query_only = ON");
    } else if (configureWrite) configureWriter(db, file);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // The original open error is authoritative.
    }
    throw sqliteError(error, file);
  }
}

export function beginImmediate(db, file = null) {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw sqliteError(error, file);
  }
}

export function commit(db, file = null) {
  try {
    db.exec("COMMIT");
  } catch (error) {
    throw sqliteError(error, file);
  }
}

export function rollback(db) {
  if (typeof db.isTransaction === "boolean" && !db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the operation failure. Doctor will diagnose a rollback failure.
  }
}

export function transaction(db, operation, file = null) {
  if (
    typeof operation !== "function"
    || operation.constructor?.name === "AsyncFunction"
  ) {
    throw lodestarError(
      "invalid_transaction",
      "SQLite transactions require a synchronous callback.",
    );
  }
  beginImmediate(db, file);
  let result;
  try {
    result = operation();
    if (result && typeof result.then === "function") {
      throw lodestarError(
        "invalid_transaction",
        "Synchronous SQLite transactions cannot accept an async callback.",
      );
    }
  } catch (error) {
    rollback(db);
    throw error?.name === "LodestarError" ? error : sqliteError(error, file);
  }
  try {
    commit(db, file);
  } catch (error) {
    if (db.isTransaction === true) {
      rollback(db);
      throw error;
    }
    throw lodestarError(
      "database_commit_outcome_unknown",
      "SQLite did not confirm the transaction commit outcome.",
      {
        identifiers: {
          database: file,
          committed: "unknown",
        },
        action:
          "Do not retry blindly; inspect the database read-only or run lodestar doctor.",
        cause: error,
      },
    );
  }
  return result;
}

export function readMetadata(db, file = null) {
  try {
    const rows = db.prepare(
      "SELECT key, substr(value, 1, 4097) AS value, "
        + "length(CAST(value AS BLOB)) AS bytes FROM metadata "
        + "WHERE key IN ('schema_version', 'created_at') ORDER BY key",
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
    const mapped = sqliteError(error, file);
    if (
      mapped.code === "database_busy"
      || mapped.code === "database_integrity"
    ) {
      throw mapped;
    }
    throw lodestarError(
      "invalid_database",
      "The file does not contain Lodestar metadata.",
      {
        identifiers: { database: file },
        action: "Choose a Lodestar database or run lodestar init on a new path.",
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
  const schema = inspectSchemaDefinitions(db);
  if (!schema.matches) {
    throw lodestarError(
      "invalid_database",
      "The database schema does not match Lodestar schema version 1.",
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

export async function openReadDatabase(file) {
  if (!await existingFile(file)) {
    throw lodestarError(
      "database_not_found",
      "The Lodestar database does not exist.",
      {
        identifiers: { database: file },
        action: "Run lodestar init before reading records.",
      },
    );
  }
  const db = openConnection(file, { readOnly: true });
  try {
    assertSupportedSchema(db, file);
    return db;
  } catch (error) {
    db.close();
    throw error?.name === "LodestarError"
      ? error
      : sqliteError(error, file);
  }
}

export async function openDiagnosticDatabase(file) {
  if (!await existingFile(file)) {
    throw lodestarError(
      "database_not_found",
      "The Lodestar database does not exist.",
      {
        identifiers: { database: file },
        action: "Run lodestar init before running diagnostics.",
      },
    );
  }
  const db = openConnection(file, { readOnly: true });
  try {
    db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    return db;
  } catch (error) {
    db.close();
    throw sqliteError(error, file);
  }
}

export async function openWriteDatabase(file) {
  if (!await existingFile(file)) {
    throw lodestarError(
      "database_not_found",
      "The Lodestar database does not exist.",
      {
        identifiers: { database: file },
        action: "Run lodestar init before writing records.",
      },
    );
  }
  const db = openConnection(file, { configureWrite: false });
  try {
    assertSupportedSchema(db, file);
    configureWriter(db, file);
    return db;
  } catch (error) {
    db.close();
    throw error?.name === "LodestarError"
      ? error
      : sqliteError(error, file);
  }
}

export async function reserveNewDatabase(file) {
  let handle;
  try {
    handle = await openFile(file, "wx", 0o600);
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "EEXIST") {
      throw lodestarError(
        "database_conflict",
        "Another file appeared at the new database path.",
        {
          identifiers: { database: file },
          action: "Inspect the reported path and retry without overwriting it.",
          cause: error,
        },
      );
    }
    throw wrapError(
      error,
      "database_write_failed",
      "Lodestar could not reserve the new database file.",
      {
        identifiers: { database: file },
        action: "Check the destination directory and retry.",
      },
    );
  }
}

export function initializeConnection(db, { createdAt, database = null }) {
  validateTimestamp(createdAt, "created_at");
  return transaction(db, () => createSchema(db, { createdAt }), database);
}

export async function initializeDatabase(
  file,
  {
    now = () => new Date(),
  } = {},
) {
  let resumableEmptyFile = false;
  if (await existingFile(file)) {
    try {
      const db = await openReadDatabase(file);
      const metadata = readMetadata(db, file);
      db.close();
      return {
        database: file,
        schema_version: SCHEMA_VERSION,
        created: false,
        created_at: metadata.created_at,
      };
    } catch (error) {
      if (!await databaseFileIsEmpty(file)) throw error;
      resumableEmptyFile = true;
    }
  }

  const createdAt = now().toISOString();
  let db;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    if (!resumableEmptyFile) {
      await reserveNewDatabase(file);
    }
    db = openConnection(file);
    initializeConnection(db, { createdAt, database: file });
    db.close();
    db = null;
    return {
      database: file,
      schema_version: SCHEMA_VERSION,
      created: true,
      created_at: createdAt,
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Cleanup still runs against the exact new target.
    }
    const commitOutcomeUnknown =
      error?.code === "database_commit_outcome_unknown";
    if (commitOutcomeUnknown) throw error;
    let existing;
    try {
      existing = await openReadDatabase(file);
      const metadata = readMetadata(existing, file);
      return {
        database: file,
        schema_version: SCHEMA_VERSION,
        created: false,
        created_at: metadata.created_at,
      };
    } catch {
      // Preserve the initialization error when no concurrent creator won.
    } finally {
      existing?.close();
    }
    throw error?.name === "LodestarError"
      ? error
      : wrapError(
        error,
        "database_write_failed",
        "Lodestar could not initialize the database.",
        {
          identifiers: { database: file },
          action: "Check the destination directory and retry.",
        },
      );
  }
}
