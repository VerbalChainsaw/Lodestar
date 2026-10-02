import {
  lstat,
  mkdir,
  open as openFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { errorPayload, lodestarError, wrapError } from "./errors.mjs";
import {
  assertSupportedSchema,
  databaseFile,
  nativeDatabasePath,
  readMetadata,
  rememberDatabaseFile,
  sqliteError,
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

export { normalizeDatabaseBusyError } from "./database-schema.mjs";

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
    db = new DatabaseSync(nativeDatabasePath(file), {
      readOnly,
      timeout: DATABASE_BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    rememberDatabaseFile(db, file);
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
  file = databaseFile(db, file);
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw sqliteError(error, file);
  }
}

export function commit(db, file = null) {
  file = databaseFile(db, file);
  try {
    db.exec("COMMIT");
  } catch (error) {
    throw sqliteError(error, file);
  }
}

function cleanupFailure(db, file, phase, cleanupError, primaryError, committed) {
  const failure = lodestarError(
    phase === "rollback" ? "database_rollback_failed" : "database_connection_cleanup_failed",
    phase === "rollback" ? "SQLite did not confirm transaction rollback."
      : "SQLite could not confirm the owned connection's safe configuration.",
    {
      identifiers: {
        database: databaseFile(db, file), phase, committed,
        transaction_active: typeof db.isTransaction === "boolean" ? db.isTransaction : null,
        primary: primaryError ? errorPayload(sqliteError(primaryError, file)) : null,
        cleanup: errorPayload(sqliteError(cleanupError, file)),
      },
      action: "Discard or close this owned connection and reopen for read-only diagnosis. Preserve the exact request; reconcile its receipt and current records before any replay or new write.",
      cause: new AggregateError(primaryError ? [primaryError, cleanupError] : [cleanupError],
        "SQLite connection cleanup failed."),
    },
  );
  stateFor(db).failure = failure;
  return failure;
}

export function rollback(db, file = null, primaryError = null) {
  if (typeof db.isTransaction === "boolean" && !db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch (error) {
    throw cleanupFailure(db, file, "rollback", error, primaryError, "unknown");
  }
}

export function transaction(db, operation, file = null) {
  file = databaseFile(db, file);
  const state = stateFor(db);
  if (state.failure) throw state.failure;
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
      try { Promise.resolve(nested).catch(() => {}); } catch { /* hostile thenable */ }
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
      try { Promise.resolve(result).catch(() => {}); } catch { /* hostile thenable */ }
      throw lodestarError(
        "invalid_transaction",
        "Synchronous SQLite transactions cannot accept an async callback.",
      );
    }
  } catch (error) {
    rollback(db, file, error);
    throw error?.name === "LodestarError" ? error : sqliteError(error, file);
  }
  try {
    commit(db, file);
  } catch (error) {
    if (db.isTransaction === true) {
      rollback(db, file, error);
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
  if (state.failure) throw state.failure;
  if (db.isTransaction === true && state.admission < 1) {
    throw lodestarError(
      "invalid_transaction",
      "A write admission cannot begin inside an unadmitted transaction.",
    );
  }
  const outerAdmission = state.admission === 0;
  if (outerAdmission) {
    try { db.exec("PRAGMA trusted_schema = ON"); }
    catch (error) { throw cleanupFailure(db, file, "trusted_schema_admission", error, null, false); }
  }
  state.admission += 1;
  let result, failure, failed = false;
  try {
    result = transaction(db, operation, file);
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    state.admission -= 1;
    if (outerAdmission) {
      state.revision = null;
      try {
        db.exec("PRAGMA trusted_schema = OFF");
      } catch (error) {
        const committed = failed ? errorPayload(failure).identifiers.committed ?? false : true;
        throw cleanupFailure(db, file, "trusted_schema_reset", error, failure, committed);
      }
    }
  }
  if (failed) throw failure;
  return result;
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
    const requiresReconciliation = error?.code === "database_commit_outcome_unknown"
      || error?.code === "database_rollback_failed"
      || error?.code === "database_connection_cleanup_failed";
    if (requiresReconciliation) throw error;
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
