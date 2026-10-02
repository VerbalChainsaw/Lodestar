import { createHash } from "node:crypto";
import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import {
  FRESHNESS_STATES,
  validateContent,
  validateIdentifier,
  validateName,
  validateOrigin,
  validateRelationship,
  validateScope,
  validateSourceMetadata,
  validateTimestamp,
  validateType,
} from "./validate.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fingerprint = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

export function storedSourceCorrection(message, identifiers = {}, cause) {
  const rawArgs = typeof identifiers.id === "string" && identifiers.id.length > 0
    ? ["get", "--raw", "--", identifiers.id] : null;
  return lodestarError("record_requires_source_correction", message, {
    identifiers: { ...identifiers, ...(rawArgs ? { raw_read_args: rawArgs } : {}) },
    action: rawArgs
      ? "Inspect the original source using the argument array " + JSON.stringify(rawArgs) +
        " against this same database, then use an explicit checked source correction."
      : "Inspect the raw stored JSON and correct its source representation.",
    cause,
  });
}

export function requireStoredRecordSemantics(content, { id } = {}) {
  if (!content?._lodestar?.semantics) {
    throw storedSourceCorrection("The record is missing current-contract semantic metadata.",
      { id, pointer: "/_lodestar/semantics" });
  }
}

// Validate the shape actually emitted by mutate. Historical before-images retain
// their original content bytes, including legacy/source-correction representations.
export function validateStoredReceipt(content, { id, databaseInstanceId = null, expected = null } = {}) {
  let field = "content";
  const require = (condition, name) => {
    field = name;
    if (!condition) throw new Error("Invalid stored receipt field.");
  };
  try {
    validateContent(content);
    require(content.state === "known" && object(content.value), "value");
    const data = content.value;
    for (const name of ["request_id", "operation"]) {
      field = name;
      validateIdentifier(data[name], name);
    }
    require(fingerprint(data.database_epoch), "database_epoch");
    require(fingerprint(data.payload_sha256), "payload_sha256");
    require(Number.isSafeInteger(data.committed_revision) && data.committed_revision > 0,
      "committed_revision");
    require(content._lodestar?.revision === data.committed_revision, "committed_revision");
    require(Number.isSafeInteger(data.database_revision_before) && data.database_revision_before >= 0
      && data.database_revision_before + 1 === data.committed_revision, "database_revision_before");
    require(object(data.result) && Object.hasOwn(data.result, "data"), "result");
    require(!Object.hasOwn(data.result, "next") || (Array.isArray(data.result.next)
      && data.result.next.every((line) => typeof line === "string")), "result.next");
    require(Array.isArray(data.changed_ids), "changed_ids");
    for (const changedId of data.changed_ids) {
      field = "changed_ids";
      validateIdentifier(changedId, field);
    }
    require(Array.isArray(data.before_images), "before_images");
    for (const image of data.before_images) {
      require(object(image) && object(image.raw_record) && object(image.raw_associations), "before_images");
      // These are raw historical rows: require their full structure and types,
      // preserving original text, timestamps and opaque JSON representations.
      for (const name of ["id", "type", "name", "scope", "content_json", "created_at", "updated_at"]) {
        require(Object.hasOwn(image.raw_record, name) && typeof image.raw_record[name] === "string",
          `before_images.raw_record.${name}`);
      }
      for (const [table, fields] of [
        ["aliases", ["alias", "record_id"]],
        ["links", ["from_id", "relationship", "to_id", "created_at"]],
        ["sources", ["record_id", "origin", "freshness", "metadata_json"]],
      ]) {
        const entries = image.raw_associations[table];
        require(Array.isArray(entries), `before_images.raw_associations.${table}`);
        for (const entry of entries) {
          require(object(entry), `before_images.raw_associations.${table}`);
          for (const name of fields) {
            require(Object.hasOwn(entry, name) && typeof entry[name] === "string",
              `before_images.raw_associations.${table}.${name}`);
          }
        }
      }
    }
    require(typeof id === "string" && /^mutation-receipt:[0-9a-f]{64}$/u.test(id), "id");
    if (fingerprint(databaseInstanceId)) {
      const key = createHash("sha256").update(canonicalStringify([
        databaseInstanceId, data.database_epoch, data.request_id,
      ])).digest("hex");
      require(id === `mutation-receipt:${key}`, "receipt_identity");
    }
    // Changed valid input belongs to request_conflict; exact-payload identity
    // disagreement proves damaged receipt evidence instead.
    if (expected && data.payload_sha256 === expected.payload_sha256) for (const name of ["request_id", "database_epoch", "operation"]) {
      require(data[name] === expected[name], name);
    }
    return data;
  } catch (error) {
    throw lodestarError("database_integrity", "A stored mutation receipt is invalid.", {
      identifiers: { id, field: error?.identifiers?.field ?? field },
      action: "Preserve the receipt and exact saved request. Run lodestar doctor and inspect the raw receipt; recover from a verified external backup before replaying.",
      cause: error,
    });
  }
}

function details(error, identifiers) {
  return {
    ...identifiers,
    field: error?.identifiers?.field ?? null,
    reason: error?.message ?? "Stored validation failed.",
  };
}

function* recordIssues(db, { databaseInstanceId } = {}) {
  const rows = db.prepare(`SELECT id,type,name,scope,content_json,created_at,updated_at
    FROM records ORDER BY id`).iterate();
  for (const row of rows) {
    try {
      validateIdentifier(row.id);
      validateType(row.type);
      validateName(row.name);
      validateScope(row.scope);
    } catch (error) {
      yield { code: "record_fields_invalid", message: "A record has invalid stored fields.",
        identifiers: details(error, { id: row.id }) };
    }
    let content;
    try {
      content = JSON.parse(row.content_json);
      validateContent(content);
      requireStoredRecordSemantics(content, { id: row.id });
    }
    catch (error) {
      if (error.code === "record_requires_source_correction") {
        yield { code: error.code, message: error.message,
          identifiers: error.identifiers, action: error.action };
      } else {
        yield { code: "record_content_invalid", message: "A record has an invalid content envelope.",
          identifiers: details(error, { id: row.id }) };
      }
    }
    if (row.type === "mutation-receipt") {
      try { validateStoredReceipt(content, { id: row.id, databaseInstanceId }); }
      catch (error) {
        yield { code: error.code, message: error.message,
          identifiers: error.identifiers, action: error.action };
      }
    }
    for (const field of ["created_at", "updated_at"]) {
      try { validateTimestamp(row[field], `records.${field}`); }
      catch (error) {
        yield { code: "record_timestamp_invalid", message: "A record timestamp is invalid.",
          identifiers: details(error, { id: row.id, field, value: row[field] }) };
      }
    }
  }
}

function* aliasIssues(db) {
  for (const row of db.prepare("SELECT alias,record_id FROM aliases ORDER BY alias").iterate()) {
    try {
      validateIdentifier(row.alias, "alias");
      validateIdentifier(row.record_id, "record_id");
    } catch (error) {
      yield { code: "alias_invalid", message: "An alias has invalid stored fields.",
        identifiers: details(error, { alias: row.alias, record_id: row.record_id }) };
    }
  }
}

function* linkIssues(db) {
  for (const row of db.prepare(`SELECT from_id,relationship,to_id,created_at
    FROM links ORDER BY from_id,relationship,to_id`).iterate()) {
    try {
      validateIdentifier(row.from_id, "from_id");
      validateRelationship(row.relationship);
      validateIdentifier(row.to_id, "to_id");
    } catch (error) {
      yield { code: "link_invalid", message: "A link has invalid stored fields.",
        identifiers: details(error, { from_id: row.from_id, relationship: row.relationship,
          to_id: row.to_id }) };
    }
    try { validateTimestamp(row.created_at, "links.created_at"); }
    catch (error) {
      yield { code: "link_timestamp_invalid", message: "A link timestamp is invalid.",
        identifiers: details(error, { from_id: row.from_id, relationship: row.relationship,
          to_id: row.to_id, value: row.created_at }) };
    }
  }
}

function* sourceIssues(db) {
  for (const row of db.prepare(`SELECT record_id,origin,freshness,metadata_json
    FROM sources ORDER BY record_id,origin`).iterate()) {
    try {
      validateIdentifier(row.record_id, "record_id");
      validateOrigin(row.origin);
      if (!FRESHNESS_STATES.includes(row.freshness))
        throw new Error("freshness is not a supported state.");
      validateSourceMetadata(JSON.parse(row.metadata_json));
    } catch (error) {
      yield { code: "source_metadata_invalid", message: "A source has invalid stored metadata.",
        identifiers: details(error, { record_id: row.record_id, origin: row.origin }) };
    }
  }
}

export function* storedSemanticIssues(db, validColumns) {
  const databaseInstanceId = validColumns.metadata
    ? db.prepare("SELECT value FROM metadata WHERE key='database_instance_id'").get()?.value : null;
  const inspections = [["records", recordIssues], ["aliases", aliasIssues],
    ["links", linkIssues], ["sources", sourceIssues]];
  for (const [table, inspect] of inspections) if (validColumns[table]) yield* inspect(db, { databaseInstanceId });
}
