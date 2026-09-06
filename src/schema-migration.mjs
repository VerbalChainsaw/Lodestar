import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { backup as sqliteBackup } from "node:sqlite";

import { admittedTransaction, assertSupportedSchema, openConnection,
  beginImmediate, readMetadata, rollback } from "./database.mjs";
import { lodestarError, wrapError } from "./errors.mjs";
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

function numericIssues(inventory) {
  const issues = [];
  for (const [table, rows, jsonField] of [
    ["records", inventory.records, "content_json"],
    ["sources", inventory.sources, "metadata_json"],
  ]) for (const row of rows) {
    try { assertJsonNumericDomain(row[jsonField]); }
    catch (error) {
      if (error?.code !== "unsupported_numeric_value") throw error;
      issues.push({ table, id: row.id ?? row.record_id, origin: row.origin ?? null,
        field: jsonField, pointer: error.identifiers?.pointer ?? "",
        value: error.identifiers?.value ?? null });
    }
  }
  return issues;
}

function legacyChanges(inventory, issues) {
  const records = inventory.records.filter((row) => !issues.some((issue) => issue.table === "records" && issue.id === row.id)
    && !JSON.parse(row.content_json)._lodestar?.semantics);
  const sources = inventory.sources.filter((row) => {
    if (issues.some((issue) => issue.table === "sources" && issue.id === row.record_id && issue.origin === row.origin)) return false;
    try { validateSourceMetadata(JSON.parse(row.metadata_json)); return false; }
    catch { return true; }
  });
  return { records, sources };
}

function inspectV4Connection(db, file = null) {
  const metadata = readMetadata(db, file);
  if (metadata.schema_version !== String(SCHEMA_V4_VERSION)) {
    throw lodestarError("unsupported_schema", "Only the inspected schema-4 store can be converted.", {
      identifiers: { database: file, expected: SCHEMA_V4_VERSION,
        actual: metadata.schema_version ?? null },
      action: "Use the matching Lodestar release to inspect another preserved legacy store.",
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
  const issues = numericIssues(inventory);
  const changes = legacyChanges(inventory, issues);
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
  const source = openConnection(file, { readOnly: true });
  try { await sqliteBackup(source, destination); }
  catch (error) {
    throw wrapError(error, "migration_backup_failed",
      "Lodestar could not create the migration backup.", {
        identifiers: { database: file, backup: destination },
        action: "Choose a writable backup destination and retry before migration.",
      });
  } finally { source.close(); }
  const restored = await migrationPreflight(destination);
  return { path: path.resolve(destination), logical_digest: restored.logical_digest,
    schema_fingerprint: restored.schema_fingerprint };
}

function validateMigrationRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || value.v !== CONTRACT_VERSION) {
    throw lodestarError("invalid_mutation_contract", "Migration requires a contract-5 request.");
  }
  validateIdentifier(value.request_id, "request_id");
  if (!value.preflight || !value.backup) {
    throw lodestarError("invalid_mutation_contract",
      "Migration requires preflight and backup evidence.");
  }
  if (value.backup.logical_digest !== value.preflight.logical_digest) {
    throw lodestarError("migration_source_conflict",
      "The backup does not match the migration preflight.", {
        identifiers: { preflight_digest: value.preflight.logical_digest,
          backup_digest: value.backup.logical_digest ?? null },
        action: "Create and restore-test a fresh backup from the preflight source.",
      });
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
      const changes = legacyChanges(original, actual.numeric_issues);
      const affected = new Set([...changes.records.map(({ id }) => id), ...changes.sources.map(({ record_id }) => record_id)]);
      const beforeImages = original.records.filter(({ id }) => affected.has(id)).map((row) => ({ raw_record: row,
        raw_associations: { aliases: original.aliases.filter(({ record_id }) => record_id === row.id),
          links: original.links.filter(({ from_id }) => from_id === row.id),
          sources: original.sources.filter(({ record_id }) => record_id === row.id) } }));
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
        records: after.records.filter((row) => row.id !== id).map((row) => beforeImages.find((image) => image.raw_record.id === row.id)?.raw_record ?? row),
        sources: after.sources.map((row) => changes.sources.find((source) => source.record_id === row.record_id && source.origin === row.origin) ?? row) };
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
      if (acceptedDigest !== accepted.recovery.accepted_source.logical_digest
        || acceptedDigest !== sha256(canonicalStringify(rawInventory(db)))) {
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
      if (sha256(canonicalStringify(rawInventory(db))) !== accepted.recovery.recovered.logical_digest) {
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
