import { createHash } from "node:crypto";
import { lstat, mkdtemp, open as openFile, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { backup as sqliteBackup } from "node:sqlite";

import { admittedTransaction, assertSupportedSchema, openConnection,
  beginImmediate, readMetadata, rollback } from "./database.mjs";
import { decorateError, errorPayload, lodestarError, wrapError } from "./errors.mjs";
import { nativeDatabasePath, nativeStorageCode, schemaVersionGuidance, sqliteError } from "./database-schema.mjs";
import { assertJsonNumericDomain, canonicalStringify } from "./json.mjs";
import { contentData, parseStoredContent, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision } from "./revisions.mjs";
import { CONTRACT_VERSION, createDatabaseInstanceId, inspectSchemaDefinitions,
  SCHEMA_V4_VERSION, WRITE_FENCE_SQL } from "./schema.mjs";
import { validateIdentifier, validateSourceMetadata, validateTimestamp } from "./validate.mjs";

const TABLE_COLUMNS = Object.freeze({
  metadata: ["key", "value"],
  records: ["id", "type", "name", "scope", "content_json", "created_at", "updated_at"],
  aliases: ["alias", "record_id"],
  links: ["from_id", "relationship", "to_id", "created_at"],
  sources: ["record_id", "origin", "freshness", "metadata_json"],
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function rowsBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const id = row[key];
    const entries = grouped.get(id) ?? [];
    entries.push(row);
    grouped.set(id, entries);
  }
  return grouped;
}

function rawInventory(db) {
  return Object.fromEntries(Object.entries(TABLE_COLUMNS).map(([table, columns]) => [
    table,
    db.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${columns.join(",")}`).all(),
  ]));
}

function schemaFingerprint(db) {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema "
    + "WHERE type IN ('table','index','trigger','view') ORDER BY type,name").all();
  return sha256(canonicalStringify(rows));
}

function invalidMigrationJson(error, file, table, row, field) {
  throw lodestarError("invalid_database", "The preserved migration source contains malformed or ambiguous stored JSON.", {
    identifiers: { database: file, table, id: row.id ?? row.record_id,
      origin: row.origin ?? null, field,
      preflight_args: ["--db", file, "doctor", "--migration-preflight"] },
    action: "Preserve the original database. Inspect the named row and field with matching schema4 tools; restore valid JSON from an accepted backup or source before rerunning migration preflight on a separate copy.",
    cause: error,
  });
}

function migrationJson(file, table, row, field) {
  try {
    const value = JSON.parse(row[field]);
    if (table === "records" && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new TypeError("Stored record content requires an object container.");
    }
    return value;
  }
  catch (error) { invalidMigrationJson(error, file, table, row, field); }
}

function numericIssues(inventory, file) {
  const issues = [];
  for (const [table, rows, jsonField] of [
    ["records", inventory.records, "content_json"],
    ["sources", inventory.sources, "metadata_json"],
  ]) for (const row of rows) {
    try { assertJsonNumericDomain(row[jsonField]); }
    catch (error) {
      if (error?.code !== "unsupported_numeric_value") invalidMigrationJson(error, file, table, row, jsonField);
      issues.push({ table, id: row.id ?? row.record_id, origin: row.origin ?? null,
        field: jsonField, pointer: error.identifiers?.pointer ?? "",
        value: error.identifiers?.value ?? null });
    }
  }
  return issues;
}

function legacyChanges(inventory, issues, file) {
  const recordIssues = new Set(), sourceIssues = new Map();
  for (const issue of issues) {
    if (issue.table === "records") recordIssues.add(issue.id);
    else if (issue.table === "sources") {
      // Keep both identity components: IDs and origins can contain delimiters.
      const origins = sourceIssues.get(issue.id) ?? new Set();
      origins.add(issue.origin);
      sourceIssues.set(issue.id, origins);
    }
  }
  const records = inventory.records.filter((row) => !recordIssues.has(row.id)
    && !migrationJson(file, "records", row, "content_json")._lodestar?.semantics);
  const sources = inventory.sources.filter((row) => {
    if (sourceIssues.get(row.record_id)?.has(row.origin)) return false;
    const metadata = migrationJson(file, "sources", row, "metadata_json");
    try { validateSourceMetadata(metadata); return false; }
    catch { return true; }
  });
  return { records, sources };
}

function inspectV4Connection(db, file = null) {
  const metadata = readMetadata(db, file);
  if (metadata.schema_version !== String(SCHEMA_V4_VERSION)) {
    const guidance = schemaVersionGuidance(file, metadata.schema_version);
    throw lodestarError("unsupported_schema", "Only the inspected schema-4 store can be converted.", {
      identifiers: { ...guidance.identifiers, expected: SCHEMA_V4_VERSION },
      action: guidance.action,
    });
  }
  if (!/^[0-9a-f]{64}$/u.test(metadata.database_instance_id ?? "")) {
    throw lodestarError("invalid_database", "Schema 4 is missing its valid database instance ID.", {
      identifiers: { database: file, database_instance_id: metadata.database_instance_id ?? null },
    });
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(metadata.database_revision ?? "")) {
    throw lodestarError("invalid_database", "Schema 4 is missing its valid database revision.", {
      identifiers: { database: file, database_revision: metadata.database_revision ?? null },
    });
  }
  validateTimestamp(metadata.created_at, "metadata.created_at");
  const schema = inspectSchemaDefinitions(db, { version: SCHEMA_V4_VERSION });
  if (!schema.matches) throw lodestarError("invalid_database",
    "The source does not match the inspected schema-4 definition.", {
      identifiers: { database: file, missing: schema.missing,
        unexpected: schema.unexpected, mismatched: schema.mismatched },
      action: "Preserve the store and resolve its exact schema before migration.",
    });
  const inventory = rawInventory(db);
  const issues = numericIssues(inventory, file);
  const changes = legacyChanges(inventory, issues, file);
  return {
    schema_version: SCHEMA_V4_VERSION,
    database_instance_id: metadata.database_instance_id,
    database_epoch: metadata.database_epoch ?? null,
    database_revision: Number(metadata.database_revision),
    created_at: metadata.created_at,
    schema_fingerprint: schemaFingerprint(db),
    logical_digest: sha256(canonicalStringify(inventory)),
    inventory: Object.fromEntries(Object.entries(inventory)
      .map(([table, rows]) => [table, rows.length])),
    numeric_issues: issues,
    accounting: { unchanged: inventory.records.length - changes.records.length, semantic_metadata: changes.records.length,
      source_metadata: changes.sources.length,
      source_correction: issues.length, proven_identity_binding: 0,
      ambiguous: 0, incompatible: 0 },
  };
}

export async function migrationPreflight(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    throw wrapError(error, "database_not_found", "The Lodestar database does not exist.", {
      identifiers: { database: file },
    });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw lodestarError("invalid_database", "The database path must be a regular file.", {
      identifiers: { database: file },
    });
  }
  const db = openConnection(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const result = { v: CONTRACT_VERSION, source: { path: path.resolve(file), bytes: info.size,
      modified_at: info.mtime.toISOString() }, ...inspectV4Connection(db, file) };
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}

export async function createMigrationBackup(file, destination) {
  let source, staging, snapshot, restored, input, output;
  let destinationCreated = false, bytesWritten = 0;
  let phase = "staging_creation", failureFile = destination;
  try {
    // SQLite's backup API replaces an existing target. Keep that API inside an
    // owned sibling directory; copy through a newly reserved destination handle.
    const parent = path.dirname(path.resolve(destination));
    const nativeStaging = await mkdtemp(nativeDatabasePath(path.join(parent, ".lodestar-backup-")));
    staging = path.join(parent, path.basename(nativeStaging));
    snapshot = path.join(staging, "snapshot.db");
    phase = "source_open"; failureFile = file;
    source = openConnection(file, { readOnly: true });
    phase = "snapshot_creation"; failureFile = snapshot;
    await sqliteBackup(source, nativeDatabasePath(snapshot));
    source.close();
    source = null;
    phase = "snapshot_verification";
    restored = await migrationPreflight(snapshot);
    phase = "destination_copy";
    input = await openFile(snapshot, "r");
    failureFile = destination;
    output = await openFile(destination, "wx", 0o600);
    destinationCreated = true;
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const written = await output.write(buffer, offset, bytesRead - offset, null);
        if (written.bytesWritten === 0) throw new Error("The backup copy made no write progress.");
        offset += written.bytesWritten;
        bytesWritten += written.bytesWritten;
      }
    }
    if (bytesWritten !== restored.source.bytes) throw new Error("The backup copy size does not match its verified snapshot.");
    phase = "destination_flush";
    await output.sync();
    phase = "destination_close";
    await output.close(); output = null;
    await input.close(); input = null;
    phase = "destination_verification";
    const copied = await migrationPreflight(destination);
    if (copied.logical_digest !== restored.logical_digest
      || copied.schema_fingerprint !== restored.schema_fingerprint) {
      throw new Error("The completed backup does not restore to its verified snapshot.");
    }
  }
  catch (error) {
    const failure = { phase, cause: errorPayload(sqliteError(error, failureFile)) };
    if (!destinationCreated && nativeStorageCode(error) === "EEXIST") {
      throw lodestarError("migration_backup_conflict", "The backup destination already exists.", {
        identifiers: { database: file, backup: destination, ...failure },
        action: "Preserve the existing destination and choose a fresh backup path.", cause: error,
      });
    }
    if (destinationCreated) {
      throw lodestarError("migration_backup_failed", "The new backup was not accepted; its destination is preserved.", {
        identifiers: { database: file, backup: destination, destination_created: true,
          backup_accepted: false, bytes_written: bytesWritten, ...failure },
        action: "Preserve the unaccepted backup at the reported path. Inspect the reported failure phase and cause using the configured runtime before choosing a fresh destination and retrying; do not migrate using this output.",
        cause: error,
      });
    }
    throw decorateError(wrapError(error, "migration_backup_failed",
      "Lodestar could not create the migration backup.", {
        identifiers: { database: file, backup: destination },
        action: "Preserve the selected source and inspect the reported failure phase and cause. Resolve the selected path or storage failure before choosing a fresh backup destination and retrying migration preparation.",
      }), failure);
  } finally {
    source?.close();
    await output?.close().catch(() => {});
    await input?.close().catch(() => {});
    // Never remove the requested destination, even after a failed copy/flush.
    if (snapshot) await unlink(snapshot).catch(() => {});
    if (staging) await rmdir(staging).catch(() => {});
  }
  return { path: path.resolve(destination), logical_digest: restored.logical_digest,
    schema_fingerprint: restored.schema_fingerprint };
}

function validateMigrationRequest(value) {
  const invalid = (field, requirement) => {
    throw lodestarError("invalid_mutation_contract", `Migration ${field} ${requirement}.`, {
      identifiers: { field },
      action: "Preserve the source database. Correct the named migration request field using complete doctor --migration-preflight data and a separate restore-tested backup; do not replace missing evidence with guessed values.",
    });
  };
  const plain = (object) => object !== null && typeof object === "object"
    && Object.getPrototypeOf(object) === Object.prototype;
  const hash = (text) => typeof text === "string" && /^[0-9a-f]{64}$/u.test(text);
  if (!plain(value)) invalid("request", "must be a JSON object");
  if (value.v !== CONTRACT_VERSION) invalid("v", "must be contract version 5");
  try { validateIdentifier(value.request_id, "request_id"); }
  catch { invalid("request_id", "must be a valid nonempty identifier"); }
  if (!plain(value.preflight)) invalid("preflight", "must contain the complete source preflight object");
  if (!plain(value.backup)) invalid("backup", "must contain independent restore-tested backup evidence");
  const { preflight, backup } = value;
  if (preflight.v !== CONTRACT_VERSION) invalid("preflight.v", "must be contract version 5");
  if (preflight.schema_version !== SCHEMA_V4_VERSION) invalid("preflight.schema_version", "must identify schema 4");
  if (!hash(preflight.database_instance_id)) invalid("preflight.database_instance_id", "must be the observed 64-character lowercase hexadecimal instance ID");
  if (preflight.database_epoch !== null && !hash(preflight.database_epoch)) {
    invalid("preflight.database_epoch", "must be the observed epoch or null for a source without one");
  }
  if (!Number.isSafeInteger(preflight.database_revision) || preflight.database_revision < 0) {
    invalid("preflight.database_revision", "must be the observed nonnegative safe integer revision");
  }
  for (const [name, evidence] of [["preflight", preflight], ["backup", backup]]) {
    for (const field of ["schema_fingerprint", "logical_digest"]) {
      if (!hash(evidence[field])) invalid(`${name}.${field}`, "must be a 64-character lowercase hexadecimal digest");
    }
  }
  if (typeof backup.path !== "string" || backup.path.length === 0 || /[\u0000\uD800-\uDFFF]/u.test(backup.path)) {
    invalid("backup.path", "must be a nonempty Unicode path without NUL");
  }
  for (const field of ["logical_digest", "schema_fingerprint"]) {
    if (backup[field] !== preflight[field]) {
      throw lodestarError("migration_source_conflict", "The backup does not match the migration preflight.", {
        identifiers: { field, preflight_digest: preflight[field], backup_digest: backup[field] },
        action: "Preserve the source. Create a fresh preflight and separate restore-tested backup with matching schema fingerprint and logical digest.",
      });
    }
  }
  canonicalStringify(value);
  return value;
}

function provenanceId(request) {
  return `migration-source:${sha256(canonicalStringify([
    request.request_id, request.preflight.schema_fingerprint,
  ]))}`;
}

export async function migrateDatabase(file, { request, now = () => new Date() } = {}) {
  const accepted = validateMigrationRequest(request);
  const db = openConnection(file, { configureWrite: false });
  try {
    const existingMetadata = readMetadata(db, file);
    const id = provenanceId(accepted);
    if (existingMetadata.schema_version === String(CONTRACT_VERSION)) {
      const row = db.prepare("SELECT type,content_json FROM records WHERE id=?").get(id);
      if (!row || row.type !== "migration-source") {
        throw lodestarError("migration_source_conflict",
          "This current store has no matching migration provenance.", {
            identifiers: { database: file, request_id: accepted.request_id,
              provenance_id: id },
            action: "Use the preflight and request that converted this exact store.",
          });
      }
      const provenance = contentData(parseStoredContent(row.content_json, { id }));
      if (provenance.request_sha256 !== sha256(canonicalStringify(accepted))) {
        throw lodestarError("request_conflict",
          "The migration request ID was reused with different evidence.", {
            identifiers: { request_id: accepted.request_id, provenance_id: id },
          });
      }
      return { ...provenance.result, replayed: true };
    }
    try {
      const [sourcePath, backupPath, sourceInfo, backupInfo] = await Promise.all([
        realpath(file), realpath(accepted.backup.path), stat(file, { bigint: true }),
        stat(accepted.backup.path, { bigint: true }),
      ]);
      if (sourcePath === backupPath || (sourceInfo.ino !== 0n &&
        sourceInfo.dev === backupInfo.dev && sourceInfo.ino === backupInfo.ino)) {
        throw lodestarError("migration_source_conflict", "The claimed backup is the migration source itself.", {
          identifiers: { database: file, backup: accepted.backup.path },
          action: "Create and restore-test a separate independent backup file, then prepare a new migration request from that evidence.",
        });
      }
      if (sourceInfo.ino === 0n || backupInfo.ino === 0n) {
        throw lodestarError("migration_source_conflict", "Filesystem identity could not prove an independent backup.", {
          identifiers: { database: file, backup: accepted.backup.path },
          action: "Create and restore-test a separate backup on a local filesystem that exposes file identity, then prepare the migration request again.",
        });
      }
    } catch (error) {
      throw wrapError(error, "migration_source_conflict", "The backup's independent file identity could not be inspected.", {
        identifiers: { database: file, backup: accepted.backup.path ?? null, cause_code: error.code ?? null },
        action: "Preserve the source. Create and restore-test a separate independent backup in a readable local path before migration.",
      });
    }
    let restoredBackup;
    try {
      restoredBackup = await migrationPreflight(accepted.backup.path);
    } catch (error) {
      throw lodestarError("migration_source_conflict",
        "The backup could not be opened or restore-tested.", {
          identifiers: { backup: accepted.backup.path ?? null,
            cause: typeof error?.message === "string" ? error.message.slice(0, 200) : null },
          action: "Create and restore-test a fresh backup from the preflight source.",
        });
    }
    for (const field of ["logical_digest", "schema_fingerprint"]) {
      if (restoredBackup[field] !== accepted.backup[field]) {
        throw lodestarError("migration_source_conflict",
          "The backup on disk does not match the supplied backup evidence.", {
            identifiers: { backup: accepted.backup.path, field,
              expected_digest: accepted.backup[field], actual_digest: restoredBackup[field] },
            action: "Preserve the source. Create a fresh preflight and separate restore-tested backup with matching schema fingerprint and logical digest.",
          });
      }
    }
    return admittedTransaction(db, () => {
      const actual = inspectV4Connection(db, file);
      const expected = accepted.preflight;
      for (const key of ["schema_version", "database_instance_id", "database_epoch",
        "database_revision", "schema_fingerprint", "logical_digest"]) {
        if ((actual[key] ?? null) !== (expected[key] ?? null)) {
          throw lodestarError("migration_source_conflict",
            "The migration source changed after preflight.", {
              identifiers: { field: key, expected: expected[key] ?? null,
                actual: actual[key] ?? null, fresh_preflight_required: true },
              action: "Create a fresh preflight and matching restore-tested backup.",
            });
        }
      }
      const timestamp = now().toISOString();
      validateTimestamp(timestamp, "timestamp");
      const revision = allocateRevision(db);
      const original = rawInventory(db);
      const changes = legacyChanges(original, actual.numeric_issues, file);
      const affected = new Set([...changes.records.map(({ id }) => id), ...changes.sources.map(({ record_id }) => record_id)]);
      const aliasesByRecord = rowsBy(original.aliases, "record_id");
      const linksByRecord = rowsBy(original.links, "from_id");
      const sourcesByRecord = rowsBy(original.sources, "record_id");
      const beforeImages = original.records.filter(({ id }) => affected.has(id)).map((row) => ({ raw_record: row,
        raw_associations: { aliases: aliasesByRecord.get(row.id) ?? [],
          links: linksByRecord.get(row.id) ?? [],
          sources: sourcesByRecord.get(row.id) ?? [] } }));
      const originalRecordsById = new Map(beforeImages.map(({ raw_record }) => [raw_record.id, raw_record]));
      const changedSourcesByRecord = new Map();
      for (const source of changes.sources) {
        const origins = changedSourcesByRecord.get(source.record_id) ?? new Map();
        origins.set(source.origin, source);
        changedSourcesByRecord.set(source.record_id, origins);
      }
      const epoch = createDatabaseInstanceId();
      const update = db.prepare("UPDATE metadata SET value=? WHERE key=?");
      update.run(String(CONTRACT_VERSION), "schema_version");
      db.prepare("INSERT INTO metadata(key,value) VALUES('database_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(epoch);
      db.exec(WRITE_FENCE_SQL);
      for (const row of changes.records) {
        const content = JSON.parse(row.content_json), metadata = content._lodestar ?? {};
        const historical = row.type === "startup-snapshot" || row.type === "mutation-receipt"
          || row.type === "migration-source" || row.type === "decision-event" || row.type === "work-event"
          || row.type.startsWith("handoff-");
        content._lodestar = { priority: 0, revision, ...metadata, semantics: {
          lifecycle: historical ? "historical" : row.type === "pending" ? "unresolved" : "current",
          context_role: "on_demand", basis: "legacy_unverified", applicability: { project: row.scope, checkout: null } } };
        db.prepare("UPDATE records SET content_json=? WHERE id=?").run(canonicalStringify(content), row.id);
      }
      for (const row of changes.sources) {
        const metadata = { inspection: "inspected", kind: "external_observation", relation: "supporting_evidence",
          observed_at: timestamp, evidence_ref: `${id}#source:${row.record_id}:${row.origin}`,
          claim: "Migration inspected the preserved legacy source row. Its original claim and observation remain unverified; inspect the before-image and current source before relying on them." };
        db.prepare("UPDATE sources SET metadata_json=? WHERE record_id=? AND origin=?")
          .run(validateSourceMetadata(metadata), row.record_id, row.origin);
      }
      const result = { migrated: true, from_schema_version: SCHEMA_V4_VERSION,
        schema_version: CONTRACT_VERSION, database_instance_id: actual.database_instance_id,
        database_epoch: epoch, revision, provenance_id: id,
        backup: accepted.backup, accounting: actual.accounting };
      writeRecordSnapshot(db, { id, type: "migration-source",
        name: `Schema 4 migration ${accepted.request_id}`, scope: "global",
        content: { state: "known", value: { request_id: accepted.request_id,
          request_sha256: sha256(canonicalStringify(accepted)), source: expected,
          backup: accepted.backup, before_images: beforeImages, destination: {
            database_instance_id: actual.database_instance_id,
            database_epoch: epoch, contract: CONTRACT_VERSION, revision }, result } },
        aliases: [], links: [], sources: [] },
      { createdAt: timestamp, updatedAt: timestamp, revision });
      const schema = inspectSchemaDefinitions(db);
      const foreignKeys = db.prepare("SELECT * FROM pragma_foreign_key_check").all();
      const after = rawInventory(db);
      const restored = { ...after, metadata: original.metadata,
        records: after.records.filter((row) => row.id !== id).map((row) => originalRecordsById.get(row.id) ?? row),
        sources: after.sources.map((row) => changedSourcesByRecord.get(row.record_id)?.get(row.origin) ?? row) };
      if (canonicalStringify(restored) !== canonicalStringify(original)) throw lodestarError("database_integrity", "Migration before-images do not reconstruct the exact source rows.");
      const counts = Object.fromEntries(["records", "aliases", "links", "sources"]
        .map((table) => [table,
          Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)]));
      if (!schema.matches || foreignKeys.length > 0
        || counts.records !== actual.inventory.records + 1
        || counts.aliases !== actual.inventory.aliases
        || counts.links !== actual.inventory.links
        || counts.sources !== actual.inventory.sources) {
        throw lodestarError("database_integrity",
          "The migrated schema or preservation accounting is invalid.", {
            identifiers: { schema, foreign_keys: foreignKeys, expected: actual.inventory,
              actual: counts },
            action: "The transaction was rolled back; refresh the preflight before retrying.",
          });
      }
      return { ...result, replayed: false };
    }, file);
  } finally { db.close(); }
}

function inspectCurrentImage(file) {
  const db = openConnection(file, { readOnly: true });
  try {
    db.exec("BEGIN"); assertSupportedSchema(db, file);
    const rows = rawInventory(db), metadata = readMetadata(db, file);
    const result = { path: path.resolve(file), database_instance_id: metadata.database_instance_id,
      database_epoch: metadata.database_epoch, revision: Number(metadata.database_revision),
      logical_digest: sha256(canonicalStringify(rows)),
      inventory: Object.fromEntries(Object.entries(rows).map(([table, entries]) => [table, entries.length])) };
    db.exec("COMMIT"); return result;
  } finally { db.close(); }
}

export async function recoveryPreflight(file, acceptedSource) {
  const recoveredPath = await realpath(file), sourcePath = await realpath(acceptedSource);
  if (recoveredPath === sourcePath) throw lodestarError("invalid_input", "Recovery needs a separate authoritative image containing all known accepted state.");
  const recovered = inspectCurrentImage(file), accepted_source = inspectCurrentImage(acceptedSource);
  if (recovered.logical_digest !== accepted_source.logical_digest) throw lodestarError("recovery_accounting_conflict",
    "The recovered image does not contain the exact accepted records, receipts, events and associations.", {
      identifiers: { recovered, accepted_source },
      action: "Reconstruct and account for all known accepted state before promoting recovery; keep writers paused.",
    });
  return { v: CONTRACT_VERSION, recovered, accepted_source, accounting: { exact: true, ...recovered.inventory } };
}

function validateRecoveryRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || value.v !== CONTRACT_VERSION) {
    throw lodestarError("invalid_mutation_contract",
      "Recovery promotion requires a contract-5 request.");
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !["v", "request_id", "database_instance_id",
    "database_epoch", "reason", "recovery"].includes(key));
  if (unknown.length) throw lodestarError("invalid_input",
    "The recovery request contains unsupported fields.", {
      identifiers: { unsupported: unknown.sort() },
    });
  validateIdentifier(value.request_id, "request_id");
  validateIdentifier(value.reason, "reason");
  if (!/^[0-9a-f]{64}$/u.test(value.database_instance_id ?? "")
    || !/^[0-9a-f]{64}$/u.test(value.database_epoch ?? "")) {
    throw lodestarError("invalid_mutation_contract",
      "Recovery promotion requires the observed database instance and epoch.");
  }
  if (!value.recovery || value.recovery.v !== CONTRACT_VERSION
    || typeof value.recovery.accepted_source?.path !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.recovery.recovered?.logical_digest ?? "")
    || value.recovery.recovered.logical_digest !== value.recovery.accepted_source.logical_digest
    || value.recovery.accounting?.exact !== true) {
    throw lodestarError("invalid_mutation_contract",
      "Recovery promotion requires complete recovery evidence.");
  }
  canonicalStringify(value);
  return value;
}

function recoveryProvenanceId(request) {
  return `migration-source:${sha256(canonicalStringify([
    "recovery-epoch", request.database_instance_id, request.database_epoch,
    request.request_id,
  ]))}`;
}

export async function promoteRecoveredDatabase(file, {
  request,
  now = () => new Date(),
} = {}) {
  const accepted = validateRecoveryRequest(request);
  const requestHash = sha256(canonicalStringify(accepted));
  const id = recoveryProvenanceId(accepted);
  const db = openConnection(file, { configureWrite: false });
  let acceptedDb;
  try {
    assertSupportedSchema(db, file);
    const replay = () => {
      const row = db.prepare("SELECT type,content_json FROM records WHERE id=?").get(id);
      if (!row) return null;
      if (row.type !== "migration-source") {
        throw lodestarError("database_integrity",
          "The recovery provenance ID is owned by another record type.", {
            identifiers: { id, type: row.type },
          });
      }
      const provenance = contentData(parseStoredContent(row.content_json, { id }));
      if (provenance.request_sha256 !== requestHash) {
        throw lodestarError("request_conflict",
          "The recovery request ID was reused with different evidence.", {
            identifiers: { request_id: accepted.request_id, provenance_id: id },
          });
      }
      return { ...provenance.result, replayed: true };
    };
    const metadata = readMetadata(db, file);
    if (metadata.database_instance_id !== accepted.database_instance_id) {
      throw lodestarError("database_instance_conflict",
        "The recovered image belongs to another database instance.", {
          identifiers: { expected: accepted.database_instance_id,
            actual: metadata.database_instance_id },
        });
    }
    if (metadata.database_epoch !== accepted.database_epoch) {
      const result = replay();
      if (result) return result;
      throw lodestarError("database_epoch_conflict",
        "The recovered image epoch changed before promotion.", {
          identifiers: { expected: accepted.database_epoch,
            actual: metadata.database_epoch, request_id: accepted.request_id },
      });
    }
    // Reserve both database images. A read transaction alone cannot prevent a
    // concurrent accepted-source writer from committing after accounting.
    acceptedDb = openConnection(accepted.recovery.accepted_source.path, { configureWrite: false });
    beginImmediate(acceptedDb, accepted.recovery.accepted_source.path);
    return admittedTransaction(db, () => {
      assertSupportedSchema(db, file);
      assertSupportedSchema(acceptedDb, accepted.recovery.accepted_source.path);
      const acceptedDigest = sha256(canonicalStringify(rawInventory(acceptedDb)));
      if (acceptedDigest !== accepted.recovery.accepted_source.logical_digest) {
        throw lodestarError("recovery_accounting_conflict", "The locked images do not match the complete accepted recovery evidence.");
      }
      const recoveredDigest = sha256(canonicalStringify(rawInventory(db)));
      if (acceptedDigest !== recoveredDigest) {
        throw lodestarError("recovery_accounting_conflict", "The locked images do not match the complete accepted recovery evidence.");
      }
      const current = readMetadata(db, file);
      if (current.database_instance_id !== accepted.database_instance_id
        || current.database_epoch !== accepted.database_epoch) {
        throw lodestarError("database_epoch_conflict",
          "The recovered image changed before the promotion lock was acquired.", {
            identifiers: { expected_instance: accepted.database_instance_id,
              actual_instance: current.database_instance_id,
              expected_epoch: accepted.database_epoch,
              actual_epoch: current.database_epoch },
          });
      }
      if (recoveredDigest !== accepted.recovery.recovered.logical_digest) {
        throw lodestarError("recovery_accounting_conflict", "The recovered state changed before the promotion lock was acquired.");
      }
      const timestamp = now().toISOString();
      validateTimestamp(timestamp, "timestamp");
      const revision = allocateRevision(db);
      const epoch = createDatabaseInstanceId();
      db.prepare("UPDATE metadata SET value=? WHERE key='database_epoch'").run(epoch);
      const result = { promoted: true,
        database_instance_id: accepted.database_instance_id,
        previous_database_epoch: accepted.database_epoch,
        database_epoch: epoch, revision, provenance_id: id };
      writeRecordSnapshot(db, { id, type: "migration-source",
        name: `Recovery epoch ${accepted.request_id}`, scope: "global",
        content: { state: "known", value: { event: "recovery-promotion",
          request_id: accepted.request_id, request_sha256: requestHash,
          reason: accepted.reason, recovery: accepted.recovery, result } },
        aliases: [], links: [], sources: [] },
      { createdAt: timestamp, updatedAt: timestamp, revision });
      return { ...result, replayed: false };
    }, file);
  } finally {
    if (acceptedDb) { rollback(acceptedDb); acceptedDb.close(); }
    db.close();
  }
}
