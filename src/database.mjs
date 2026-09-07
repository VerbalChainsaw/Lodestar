import {
  lstat,
  mkdir,
  open as openFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { lodestarError, wrapError } from "./errors.mjs";
import {
  assertSupportedSchema,
  readMetadata,
} from "./database-schema.mjs";
import {
  createDatabaseInstanceId,
  createSchema,
  SCHEMA_VERSION,
} from "./schema.mjs";
import { validateTimestamp } from "./validate.mjs";

export const DATABASE_BUSY_TIMEOUT_MS = 0;

const connectionState = new WeakMap();

function stateFor(db) {
  const state = connectionState.get(db);
  if (!state) {
    throw lodestarError(
      "invalid_transaction",
      "The SQLite connection is not owned by Lodestar.",
    );
  }
  return state;
}

function ownDataProperty(value, key) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeDatabaseBusyError(error, file = null) {
  const rawCode = ownDataProperty(error, "code");
  const code = typeof rawCode === "string" ? rawCode : "";
  const rawErrorCode = ownDataProperty(error, "errcode");
  const primaryCode = Number.isInteger(rawErrorCode)
    ? rawErrorCode & 0xff
    : null;
  const nativeSqliteError = code === "ERR_SQLITE_ERROR"
    || code.startsWith("SQLITE_");
  if (
    nativeSqliteError
    && (
      code.includes("SQLITE_BUSY")
      || code.includes("SQLITE_LOCKED")
      || primaryCode === 5
      || primaryCode === 6
    )
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
  return error;
}

function sqliteError(error, file) {
  const busyError = normalizeDatabaseBusyError(error, file);
  if (busyError !== error) return busyError;
  const code = String(error?.code ?? "");
  const primaryCode = Number.isInteger(error?.errcode)
    ? error.errcode & 0xff
    : null;
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
    const state = { admission: 0, revision: null };
    connectionState.set(db, state);
    if (!readOnly) {
      db.function("lodestar_write_contract", {}, () =>
        state.admission > 0 ? SCHEMA_VERSION : 0);
    }
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
  if (db.isTransaction === true) {
    const nested = operation();
    if (nested && typeof nested.then === "function") {
      throw lodestarError(
        "invalid_transaction",
        "Synchronous SQLite transactions cannot accept an async callback.",
      );
    }
    return nested;
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
  stateFor(db).revision = null;
  return result;
}

export function admittedTransaction(db, operation, file = null) {
  const state = stateFor(db);
  if (db.isTransaction === true && state.admission < 1) {
    throw lodestarError(
      "invalid_transaction",
      "A write admission cannot begin inside an unadmitted transaction.",
    );
  }
  const outerAdmission = state.admission === 0;
  if (outerAdmission) db.exec("PRAGMA trusted_schema = ON");
  state.admission += 1;
  try {
    return transaction(db, operation, file);
  } finally {
    state.admission -= 1;
    if (outerAdmission) {
      state.revision = null;
      db.exec("PRAGMA trusted_schema = OFF");
    }
  }
}

export function transactionRevision(db) {
  return stateFor(db).revision;
}

export function setTransactionRevision(db, revision) {
  const state = stateFor(db);
  if (db.isTransaction !== true || state.admission < 1) {
    throw lodestarError(
      "invalid_transaction",
      "Database revisions can be allocated only by an admitted transaction.",
    );
  }
  if (state.revision !== null && state.revision !== revision) {
    throw lodestarError(
      "invalid_transaction",
      "An accepted mutation can allocate only one database revision.",
    );
  }
  state.revision = revision;
}

export { readMetadata } from "./database-schema.mjs";

export { assertSupportedSchema } from "./database-schema.mjs";

export async function migrateDatabase(
  file,
  options = {},
) {
  const migration = await import("./schema-migration.mjs");
  return await migration.migrateDatabase(file, options);
}

export async function openReadDatabase(file) {
  if (!await existingFile(file)) {
    throw lodestarError(
      "database_not_found",
      "The Lodestar database does not exist.",
      {
        identifiers: { database: file },
        action:
          "Run lodestar init to create a new store, or select an existing database with --db.",
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
        action:
          "Run lodestar init to create a new store, or select an existing database with --db.",
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
        action:
          "Run lodestar init to create a new store, or select an existing database with --db.",
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

export function initializeConnection(
  db,
  {
    createdAt,
    database = null,
    databaseInstanceId = createDatabaseInstanceId(),
  },
) {
  validateTimestamp(createdAt, "created_at");
  return admittedTransaction(
    db,
    () => createSchema(db, { createdAt, databaseInstanceId }),
    database,
  );
}

export async function initializeDatabase(
  file,
  {
    now = () => new Date(),
  } = {},
) {
  let resumableEmptyFile = false;
  if (await existingFile(file)) {
    let existing;
    try {
      existing = openConnection(file, { readOnly: true });
      assertSupportedSchema(existing, file);
      const metadata = readMetadata(existing, file);
      return {
        database: file,
        schema_version: SCHEMA_VERSION,
        created: false,
        created_at: metadata.created_at,
        database_instance_id: metadata.database_instance_id,
      };
    } catch (error) {
      if (!await databaseFileIsEmpty(file)) throw error;
      resumableEmptyFile = true;
    } finally {
      existing?.close();
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
    const databaseInstanceId = createDatabaseInstanceId();
    initializeConnection(db, {
      createdAt,
      database: file,
      databaseInstanceId,
    });
    db.close();
    db = null;
    return {
      database: file,
      schema_version: SCHEMA_VERSION,
      created: true,
      created_at: createdAt,
      database_instance_id: databaseInstanceId,
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
        database_instance_id: metadata.database_instance_id,
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
