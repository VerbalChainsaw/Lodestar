import path from "node:path";
import { lodestarError, wrapError } from "./errors.mjs";
import { inspectSchemaDefinitions, SCHEMA_VERSION, SCHEMA_V4_VERSION } from "./schema.mjs";
import { validateTimestamp } from "./validate.mjs";

const connectionFiles = new WeakMap();
const NATIVE_STORAGE_CODES = new Set(["ERR_SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_LOCKED",
  "SQLITE_CANTOPEN", "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_FULL", "SQLITE_READONLY",
  "SQLITE_IOERR", "EACCES", "EPERM", "ENOENT", "EEXIST", "EIO", "ENOSPC"]);
const SQLITE_NATIVE_CODE = /^(?:ERR_SQLITE_ERROR|SQLITE_[A-Z0-9_]{1,64})$/u;
const SQLITE_FAILURE_FAMILIES = [
  ["SQLITE_BUSY", 5], ["SQLITE_LOCKED", 6], ["SQLITE_READONLY", 8],
  ["SQLITE_IOERR", 10], ["SQLITE_CORRUPT", 11], ["SQLITE_FULL", 13],
  ["SQLITE_CANTOPEN", 14], ["SQLITE_NOTADB", 26],
];

// Filesystem strings need Windows' native representation only at the native
// boundary. SQLite's temporary names and non-string inputs retain their meaning.
export function nativeDatabasePath(file) {
  return process.platform === "win32" && typeof file === "string"
    && file !== "" && file !== ":memory:" ? path.toNamespacedPath(file) : file;
}

export function rememberDatabaseFile(db, file) {
  if (process.platform === "win32" && typeof file === "string" && file !== "" && file !== ":memory:") {
    connectionFiles.set(db, path.resolve(file));
  }
}

function ownDataProperty(value, key) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}

export function nativeStorageCode(error) {
  const code = ownDataProperty(error, "code");
  return typeof code === "string" && NATIVE_STORAGE_CODES.has(code) ? code : null;
}

export function databaseFile(db, file = null) {
  if (file !== null) return file;
  if (connectionFiles.has(db)) return connectionFiles.get(db);
  try { return db.location(); }
  catch { return null; } // Location failure must not replace the operation error.
}

function nativeSqliteFailure(error) {
  const rawCode = ownDataProperty(error, "code");
  const code = typeof rawCode === "string" && SQLITE_NATIVE_CODE.test(rawCode) ? rawCode : null;
  const rawErrorCode = ownDataProperty(error, "errcode");
  const errcode = Number.isInteger(rawErrorCode) && rawErrorCode >= 0 && rawErrorCode <= 0x7fffffff
    ? rawErrorCode : null;
  const primaryCode = errcode === null ? null : errcode & 0xff;
  const symbolic = SQLITE_FAILURE_FAMILIES.find(([name]) => code === name || code?.startsWith(`${name}_`));
  const numeric = SQLITE_FAILURE_FAMILIES.find(([, primary]) => primary === primaryCode);
  // A named family must agree with available valid numeric evidence. Unknown
  // families and malformed numbers cannot borrow a diagnosis from bit masking.
  let family = rawErrorCode !== undefined && errcode === null ? null
    : code === "ERR_SQLITE_ERROR" ? numeric?.[0] ?? null
      : symbolic && (primaryCode === null || primaryCode === symbolic[1]) ? symbolic[0] : null;
  // Journal-specific guidance also needs consistent extended evidence. A
  // different named READONLY extension cannot borrow the numeric journal subtype.
  if (family === "SQLITE_READONLY" && errcode !== null && errcode > 0xff) {
    const recoveryCode = code === "SQLITE_READONLY_ROLLBACK" ? 776
      : code === "SQLITE_READONLY_RECOVERY" ? 264 : null;
    const namedExtension = code !== "ERR_SQLITE_ERROR" && code !== "SQLITE_READONLY";
    if ((recoveryCode !== null && recoveryCode !== errcode) ||
      (namedExtension && [776, 264].includes(errcode) && recoveryCode !== errcode)) family = null;
  }
  return { code, errcode, family };
}

export function normalizeDatabaseBusyError(error, file = null) {
  const { family } = nativeSqliteFailure(error);
  if (family === "SQLITE_BUSY" || family === "SQLITE_LOCKED") {
    return lodestarError("database_busy", "The Lodestar database is busy.", {
      identifiers: { database: file }, action: "Wait for the other writer to finish and retry.", cause: error,
    });
  }
  return error;
}

// Metadata reads and connection/transaction operations share this native error
// policy so storage recovery failures never masquerade as missing metadata.
export function sqliteError(error, file, {
  fallbackCode = "database_error",
  fallbackMessage = "SQLite could not complete the database operation.",
  fallbackAction = "Run lodestar doctor for a structured diagnosis.",
} = {}) {
  const busyError = normalizeDatabaseBusyError(error, file);
  if (busyError !== error) return busyError;
  const { code, errcode, family } = nativeSqliteFailure(error);
  if (family === "SQLITE_CORRUPT" || family === "SQLITE_NOTADB") {
    return lodestarError("database_integrity", "The database is corrupt or is not a SQLite database.", {
      identifiers: { database: file },
      action: "Run lodestar doctor and restore an external backup if needed.", cause: error,
    });
  }
  const identifiers = { database: file,
    storage_directory: typeof file === "string" && file !== ":memory:"
      ? path.dirname(path.resolve(file)) : null,
    sqlite_errcode: errcode };
  if (family === "SQLITE_CANTOPEN") {
    return lodestarError("database_open_failed", "SQLite could not open the selected database path.", {
      identifiers: { ...identifiers, native_code: nativeStorageCode(error) },
      action: "Preserve the selected database, adjacent journals and exact request. Check the selected path, parent-directory access and filename support in the configured runtime; reinspect the preserved file before reconciling and retrying the request.",
      cause: error,
    });
  }
  if (family === "SQLITE_FULL") {
    return lodestarError("database_storage_full", "SQLite reached a storage or database page limit.", {
      identifiers,
      action: "Preserve the database, journals and exact request. Check free space on the reported storage and any SQLite page limit; resolve capacity, then reconcile the original request before retrying.",
      cause: error,
    });
  }
  const rollbackRecovery = errcode === 776 || code === "SQLITE_READONLY_ROLLBACK";
  const walRecovery = errcode === 264 || code === "SQLITE_READONLY_RECOVERY";
  if (family === "SQLITE_READONLY" && (rollbackRecovery || walRecovery)) {
    return lodestarError("database_recovery_required", "SQLite needs writes to recover the interrupted database.", {
      identifiers: { ...identifiers, journal: typeof file === "string" && file !== ":memory:"
        ? `${file}${rollbackRecovery ? "-journal" : "-wal"}` : null },
      action: "Pause writers and preserve the database, adjacent journals and exact request together. Arrange explicit SQLite recovery on writable local storage before ordinary read-only inspection; reconcile the original request before retrying. Do not delete journals.",
      cause: error,
    });
  }
  if (family === "SQLITE_READONLY") {
    return lodestarError("database_read_only", "SQLite could not write to the selected database storage.", {
      identifiers,
      action: "Preserve the database, journals and exact request. For an intended write, check database and directory permissions and storage read-only status; reconcile the original request before retrying.",
      cause: error,
    });
  }
  if (family === "SQLITE_IOERR") {
    return lodestarError("database_io_failed", "SQLite encountered a storage I/O failure.", {
      identifiers,
      action: "Preserve the database, journals and exact request. Check the reported storage's free space, permissions and device health; reconcile the original request before retrying and use a preserved backup for recovery if needed.",
      cause: error,
    });
  }
  const nativeCode = nativeStorageCode(error);
  return wrapError(error, fallbackCode, fallbackMessage, {
    identifiers: { database: file, ...(nativeCode ? { native_code: nativeCode } : {}) }, action: fallbackAction,
  });
}

export function readMetadata(db, file = null) {
  file = databaseFile(db, file);
  try {
    const rows = db.prepare(
      "SELECT key, value FROM metadata "
        + "WHERE key IN ("
        + "'schema_version', 'created_at', 'database_instance_id', "
        + "'database_epoch', 'database_revision'"
        + ") ORDER BY key",
    ).all();
    return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  } catch (error) {
    throw sqliteError(error, file, {
      fallbackCode: "invalid_database",
      fallbackMessage: "The file does not contain Lodestar metadata.",
      fallbackAction: "Choose a Lodestar database or write the first record to a new path.",
    });
  }
}

export function schemaVersionGuidance(file, actual) {
  const identifiers = { database: file, expected: SCHEMA_VERSION, actual: actual ?? null };
  if (actual === String(SCHEMA_V4_VERSION)) {
    const preflight_args = ["--db", file, "doctor", "--migration-preflight"];
    return { identifiers: { ...identifiers, preflight_args },
      action: `Preserve the selected database at ${file} and pause its writers. Run lodestar with the exact arguments ${JSON.stringify(preflight_args)} for read-only schema-4 migration preflight, then follow README.md#storage-and-recovery to create a separate restore-tested backup and explicitly convert it.` };
  }
  if (actual === String(SCHEMA_VERSION)) {
    return { identifiers,
      action: `Preserve the selected database at ${file}. This store already uses current schema ${SCHEMA_VERSION}; inspect it with lodestar using ${JSON.stringify(["--db", file, "doctor"])}. Migration preflight applies only to schema ${SCHEMA_V4_VERSION}.` };
  }
  return { identifiers,
    action: `Preserve the selected database at ${file} and its adjacent journals. Use the matching Lodestar release that supports its schema ${actual ?? "(unrecognized)"} to inspect and recover a separate copy; this release converts only inspected schema ${SCHEMA_V4_VERSION} and does not downgrade newer stores.` };
}

export function assertSupportedSchema(db, file = null) {
  const metadata = readMetadata(db, file);
  if (metadata.schema_version !== String(SCHEMA_VERSION)) {
    throw lodestarError(
      "unsupported_schema",
      "The database schema version is not supported.",
      schemaVersionGuidance(file, metadata.schema_version),
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
  if (!/^[0-9a-f]{64}$/u.test(metadata.database_epoch ?? "")) {
    throw lodestarError(
      "invalid_database",
      "The database recovery epoch is invalid.",
      {
        identifiers: {
          database: file,
          database_epoch: metadata.database_epoch ?? null,
        },
        action: "Run lodestar doctor and use a valid Lodestar database.",
      },
    );
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(metadata.database_revision ?? "")) {
    throw lodestarError(
      "invalid_database",
      "The database revision is invalid.",
      {
        identifiers: {
          database: file,
          database_revision: metadata.database_revision ?? null,
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
