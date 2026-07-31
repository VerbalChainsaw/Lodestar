import {
  FRESHNESS_STATES,
  LIMITS,
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

const ROW_LIMITS = Object.freeze({
  records: LIMITS.recordsMaximum + 1,
  aliases:
    LIMITS.recordsMaximum * LIMITS.aliasesPerRecord + 1,
  links:
    LIMITS.recordsMaximum * LIMITS.linksPerRecord + 1,
  sources:
    LIMITS.recordsMaximum * LIMITS.sourcesPerRecord + 1,
});

function fieldError(row, value, bytes, maximum, validate) {
  if (Number(row[bytes]) > maximum) {
    throw new Error(`${value} exceeds its byte limit.`);
  }
  validate(row[value]);
}

function jsonError(row, value, bytes, maximum, validate) {
  if (Number(row[bytes]) > maximum) {
    throw new Error(`${value} exceeds its byte limit.`);
  }
  validate(JSON.parse(row[value]));
}

function details(error, identifiers) {
  return {
    ...identifiers,
    field: error?.identifiers?.field ?? null,
    reason: error?.message ?? "Stored validation failed.",
  };
}

function* recordIssues(db) {
  const rows = db.prepare(String.raw`
    SELECT
      substr(id, 1, ${LIMITS.identifierBytes + 1}) AS id,
      length(CAST(id AS BLOB)) AS id_bytes,
      substr(type, 1, ${LIMITS.typeBytes + 1}) AS type,
      length(CAST(type AS BLOB)) AS type_bytes,
      substr(name, 1, ${LIMITS.nameBytes + 1}) AS name,
      length(CAST(name AS BLOB)) AS name_bytes,
      substr(scope, 1, ${LIMITS.scopeBytes + 1}) AS scope,
      length(CAST(scope AS BLOB)) AS scope_bytes,
      substr(content_json, 1, ${LIMITS.contentBytes + 1}) AS content_json,
      length(CAST(content_json AS BLOB)) AS content_bytes,
      substr(created_at, 1, 25) AS created_at,
      substr(updated_at, 1, 25) AS updated_at
    FROM records
    ORDER BY id
    LIMIT ?
  `).iterate(ROW_LIMITS.records);
  for (const row of rows) {
    try {
      fieldError(
        row,
        "id",
        "id_bytes",
        LIMITS.identifierBytes,
        validateIdentifier,
      );
      fieldError(row, "type", "type_bytes", LIMITS.typeBytes, validateType);
      fieldError(row, "name", "name_bytes", LIMITS.nameBytes, validateName);
      fieldError(row, "scope", "scope_bytes", LIMITS.scopeBytes, validateScope);
    } catch (error) {
      yield {
        code: "record_fields_invalid",
        message: "A record has invalid stored fields.",
        identifiers: details(error, { id: row.id }),
      };
    }
    try {
      jsonError(
        row,
        "content_json",
        "content_bytes",
        LIMITS.contentBytes,
        validateContent,
      );
    } catch (error) {
      yield {
        code: "record_content_invalid",
        message: "A record has an invalid content envelope.",
        identifiers: details(error, { id: row.id }),
      };
    }
    for (const field of ["created_at", "updated_at"]) {
      try {
        validateTimestamp(row[field], `records.${field}`);
      } catch (error) {
        yield {
          code: "record_timestamp_invalid",
          message: "A record timestamp is invalid.",
          identifiers: details(error, {
            id: row.id,
            field,
            value: row[field],
          }),
        };
      }
    }
  }
}

function* aliasIssues(db) {
  const rows = db.prepare(String.raw`
    SELECT
      substr(alias, 1, ${LIMITS.identifierBytes + 1}) AS alias,
      length(CAST(alias AS BLOB)) AS alias_bytes,
      substr(record_id, 1, ${LIMITS.identifierBytes + 1}) AS record_id,
      length(CAST(record_id AS BLOB)) AS record_id_bytes
    FROM aliases
    ORDER BY alias
    LIMIT ?
  `).iterate(ROW_LIMITS.aliases);
  for (const row of rows) {
    try {
      fieldError(
        row,
        "alias",
        "alias_bytes",
        LIMITS.identifierBytes,
        (value) => validateIdentifier(value, "alias"),
      );
      fieldError(
        row,
        "record_id",
        "record_id_bytes",
        LIMITS.identifierBytes,
        (value) => validateIdentifier(value, "record_id"),
      );
    } catch (error) {
      yield {
        code: "alias_invalid",
        message: "An alias has invalid stored fields.",
        identifiers: details(error, {
          alias: row.alias,
          record_id: row.record_id,
        }),
      };
    }
  }
}

function* linkIssues(db) {
  const rows = db.prepare(String.raw`
    SELECT
      substr(from_id, 1, ${LIMITS.identifierBytes + 1}) AS from_id,
      length(CAST(from_id AS BLOB)) AS from_id_bytes,
      substr(relationship, 1, ${LIMITS.relationshipBytes + 1})
        AS relationship,
      length(CAST(relationship AS BLOB)) AS relationship_bytes,
      substr(to_id, 1, ${LIMITS.identifierBytes + 1}) AS to_id,
      length(CAST(to_id AS BLOB)) AS to_id_bytes,
      substr(created_at, 1, 25) AS created_at
    FROM links
    ORDER BY from_id, relationship, to_id
    LIMIT ?
  `).iterate(ROW_LIMITS.links);
  for (const row of rows) {
    try {
      fieldError(
        row,
        "from_id",
        "from_id_bytes",
        LIMITS.identifierBytes,
        (value) => validateIdentifier(value, "from_id"),
      );
      fieldError(
        row,
        "relationship",
        "relationship_bytes",
        LIMITS.relationshipBytes,
        validateRelationship,
      );
      fieldError(
        row,
        "to_id",
        "to_id_bytes",
        LIMITS.identifierBytes,
        (value) => validateIdentifier(value, "to_id"),
      );
    } catch (error) {
      yield {
        code: "link_invalid",
        message: "A link has invalid stored fields.",
        identifiers: details(error, {
          from_id: row.from_id,
          relationship: row.relationship,
          to_id: row.to_id,
        }),
      };
    }
    try {
      validateTimestamp(row.created_at, "links.created_at");
    } catch (error) {
      yield {
        code: "link_timestamp_invalid",
        message: "A link timestamp is invalid.",
        identifiers: details(error, {
          from_id: row.from_id,
          relationship: row.relationship,
          to_id: row.to_id,
          value: row.created_at,
        }),
      };
    }
  }
}

function* sourceIssues(db) {
  const rows = db.prepare(String.raw`
    SELECT
      substr(record_id, 1, ${LIMITS.identifierBytes + 1}) AS record_id,
      length(CAST(record_id AS BLOB)) AS record_id_bytes,
      substr(origin, 1, ${LIMITS.originBytes + 1}) AS origin,
      length(CAST(origin AS BLOB)) AS origin_bytes,
      substr(freshness, 1, 32) AS freshness,
      substr(metadata_json, 1, ${LIMITS.sourceMetadataBytes + 1})
        AS metadata_json,
      length(CAST(metadata_json AS BLOB)) AS metadata_bytes
    FROM sources
    ORDER BY record_id, origin
    LIMIT ?
  `).iterate(ROW_LIMITS.sources);
  for (const row of rows) {
    try {
      fieldError(
        row,
        "record_id",
        "record_id_bytes",
        LIMITS.identifierBytes,
        (value) => validateIdentifier(value, "record_id"),
      );
      fieldError(
        row,
        "origin",
        "origin_bytes",
        LIMITS.originBytes,
        validateOrigin,
      );
      if (!FRESHNESS_STATES.includes(row.freshness)) {
        throw new Error("freshness is not a supported state.");
      }
      jsonError(
        row,
        "metadata_json",
        "metadata_bytes",
        LIMITS.sourceMetadataBytes,
        validateSourceMetadata,
      );
    } catch (error) {
      yield {
        code: "source_metadata_invalid",
        message: "A source has invalid stored metadata.",
        identifiers: details(error, {
          record_id: row.record_id,
          origin: row.origin,
        }),
      };
    }
  }
}

export function* storedSemanticIssues(db, validColumns) {
  const inspections = [
    ["records", recordIssues],
    ["aliases", aliasIssues],
    ["links", linkIssues],
    ["sources", sourceIssues],
  ];
  for (const [table, inspect] of inspections) {
    if (validColumns[table]) yield* inspect(db);
  }
}
