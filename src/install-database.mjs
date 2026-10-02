import { randomUUID } from "node:crypto";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDatabase, openDiagnosticDatabase, readMetadata } from "./database.mjs";
import { diagnoseDatabase } from "./doctor.mjs";
import { createMigrationBackup, migrateDatabase, migrationPreflight } from "./schema-migration.mjs";
import { decodeUtf8, parseJsonText } from "./json.mjs";
import { lodestarError } from "./errors.mjs";

async function exists(file) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw lodestarError("invalid_path", "Installer input must be a plain file.", { identifiers: { path: file } }); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}
async function plainPath(file) {
  let current = path.resolve(file);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw lodestarError("invalid_path", "Installer paths cannot pass through symbolic links or junctions.", { identifiers: { path: current } }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function inspect(file) {
  const db = await openDiagnosticDatabase(file);
  try {
    const schema = readMetadata(db, file).schema_version;
    if (schema !== "5" && schema !== "4") throw lodestarError("unsupported_schema", "The selected store is incompatible with this installation.", {
      identifiers: { database: file, actual: schema, supported: [4, 5] },
      action: "Preserve this database and use its matching Lodestar release. Only inspected schema 4 can be explicitly migrated; schema 5 requires no migration.",
    });
    if (schema === "4") return { schema_version: 4 };
    const report = diagnoseDatabase(db, { database: file });
    if (!report.healthy) {
      const issue = report.issues?.[0] ?? report.checks?.issues?.[0];
      throw lodestarError(issue?.code ?? "database_unhealthy", issue?.message ?? "The selected store failed integrity and schema diagnosis.", {
        identifiers: { database: file, ...(issue?.identifiers ?? {}), issues: report.issues ?? report.checks },
        action: issue?.action ?? "Preserve this database. Inspect the reported doctor checks with the selected runtime and restore accepted evidence before installing.",
      });
    }
    return report;
  } finally { db.close(); }
}

// Explicit installer operation only. Launchers never call this helper.
export async function prepareInstallDatabase({ database, initialize = false, migrate = false,
  migrationRequestPath, backupPath, fault = null } = {}) {
  if (typeof database !== "string" || !path.isAbsolute(database) || database.includes("\0")) {
    throw lodestarError("invalid_path", "The selected database must be an absolute path.");
  }
  const file = path.resolve(database);
  await plainPath(file);
  for (const output of [migrationRequestPath, backupPath]) if (output) await plainPath(output);
  let created = false;
  if (!await exists(file)) {
    if (!initialize) throw lodestarError("database_not_found", "The selected installation database does not exist.", {
      identifiers: { database: file }, action: "Select an existing database or explicitly run Install to initialize its selected new store.",
    });
    created = (await initializeDatabase(file)).created;
  }
  const current = await inspect(file);
  let request, requestWasLoaded = false;
  if (migrationRequestPath && await exists(migrationRequestPath)) {
    request = parseJsonText(decodeUtf8(await readFile(migrationRequestPath)), { resource: "installer migration request" });
    requestWasLoaded = true;
    if (request?.v !== 5 || path.resolve(request?.preflight?.source?.path ?? "") !== file ||
      !backupPath || path.resolve(request?.backup?.path ?? "") !== path.resolve(backupPath)) {
      throw lodestarError("install_request_conflict", "The retained migration request belongs to another selection.", {
        identifiers: { database: file, request: migrationRequestPath }, action: "Preserve the saved request and backup; recover using the original database and exact migration selection.",
      });
    }
    if (!migrate) throw lodestarError("install_migration_pending", "A saved migration request requires explicit reconciliation.", {
      identifiers: { request: migrationRequestPath, database: file }, action: "Run the same installation with -MigrateDatabase to reconcile its exact saved request; application rollback does not roll back this database.",
    });
  }
  if (current.schema_version === 4 || request) {
    if (!migrate) throw lodestarError("unsupported_schema", "The selected store is schema 4 and requires explicit preserving migration.", {
      identifiers: { database: file, actual: 4, expected: 5 }, action: "Close every writer and run Install with -MigrateDatabase. The installer will restore-test an independent backup and retain its exact request before conversion.",
    });
    if (!migrationRequestPath || !backupPath || !path.isAbsolute(migrationRequestPath) || !path.isAbsolute(backupPath) ||
      path.resolve(backupPath) === file || path.resolve(migrationRequestPath) === file || path.resolve(backupPath) === path.resolve(migrationRequestPath)) {
      throw lodestarError("invalid_path", "Migration needs separate absolute request and backup destinations.");
    }
    if (!request) {
      const preflight = await migrationPreflight(file);
      let backup;
      if (await exists(backupPath)) {
        let prior;
        try { prior = await migrationPreflight(backupPath); } catch {
          throw lodestarError("migration_backup_conflict", "The retained backup is not an accepted schema4 image.", {
            identifiers: { backup: backupPath }, action: "Preserve the occupied backup and inspect it before proceeding. Use a fresh installation selection for a new independent backup.",
          });
        }
        if (prior.logical_digest !== preflight.logical_digest || prior.schema_fingerprint !== preflight.schema_fingerprint) {
          throw lodestarError("migration_backup_conflict", "The retained backup differs from the selected source preflight.", {
            identifiers: { backup: backupPath, database: file }, action: "Preserve source and backup. Reconcile the source change before choosing a fresh installation selection.",
          });
        }
        backup = { path: path.resolve(backupPath), logical_digest: prior.logical_digest, schema_fingerprint: prior.schema_fingerprint };
      } else backup = await createMigrationBackup(file, backupPath);
      if (fault === "AfterBackup") throw lodestarError("install_interrupted", "Interrupted after creating the verified backup, before saving a migration request.");
      request = { v: 5, request_id: `install:${randomUUID()}`, preflight, backup };
      await writeFile(migrationRequestPath, JSON.stringify(request, null, 2), { flag: "wx", mode: 0o600, flush: true });
    }
    if (fault === "AfterRequest") throw lodestarError("install_interrupted", "Interrupted after saving the exact migration request.");
    // A previous write may have produced complete bytes before its flush
    // failed. Reconfirm durability of that exact request before any conversion.
    if (requestWasLoaded) {
      const handle = await open(migrationRequestPath, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const result = await migrateDatabase(file, { request });
    if (fault === "AfterMigration") throw lodestarError("install_interrupted", "Interrupted after database conversion; reconcile the saved request before continuing.");
    return { ...await inspect(file), ...result, created, migration_request: migrationRequestPath, backup: backupPath };
  }
  return { ...current, created, migrated: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  try {
    const names = { "--db": "database", "--request": "migrationRequestPath", "--backup": "backupPath", "--fault": "fault" };
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === "--initialize") options.initialize = true;
      else if (arg === "--migrate") options.migrate = true;
      else if (names[arg] && process.argv[i + 1]) options[names[arg]] = process.argv[++i];
      else throw lodestarError("unknown_option", "Unknown installer database argument.", { identifiers: { argument: arg } });
    }
    const data = await prepareInstallDatabase(options);
    process.stdout.write(JSON.stringify({ v: 5, ok: true, operation: "install.database", revision: null,
      database_instance_id: data.database_instance_id ?? null, database_epoch: data.database_epoch ?? null, more: false, next: [], data }) + "\n");
  } catch (error) {
    const action = error.action ?? "Preserve the selected database, backup and saved request. Reconcile with the same Install selection before retrying; application recovery does not reverse database conversion.";
    process.stderr.write(JSON.stringify({ v: 5, ok: false, operation: "install.database", revision: null,
      database_instance_id: null, database_epoch: null, more: false, next: [],
      error: { code: error.code ?? "install_database_failed", message: error.message,
        identifiers: { ...(error.identifiers ?? {}), request: options.migrationRequestPath ?? null }, action } }) + "\n");
    process.exitCode = 1;
  }
}
