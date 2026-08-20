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

function details(error, identifiers) {
  return {
    ...identifiers,
    field: error?.identifiers?.field ?? null,
    reason: error?.message ?? "Stored validation failed.",
  };
}

function* recordIssues(db) {
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
    try { validateContent(JSON.parse(row.content_json)); }
    catch (error) {
      yield { code: "record_content_invalid", message: "A record has an invalid content envelope.",
        identifiers: details(error, { id: row.id }) };
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
  const inspections = [["records", recordIssues], ["aliases", aliasIssues],
    ["links", linkIssues], ["sources", sourceIssues]];
  for (const [table, inspect] of inspections) if (validColumns[table]) yield* inspect(db);
}
