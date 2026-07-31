import { Buffer } from "node:buffer";

import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import {
  parseStoredContent,
  parseStoredMetadata,
  resolveRecordId,
} from "./records.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import {
  FRESHNESS_STATES,
  LIMITS,
  validateIdentifier,
  validateLimit,
  validateName,
  validateOrigin,
  validateQuery,
  validateRelationship,
  validateScope,
  validateTimestamp,
  validateType,
} from "./validate.mjs";

function aliasesFor(db, id) {
  const rows = db.prepare(
    "SELECT alias FROM aliases WHERE record_id = ? ORDER BY alias LIMIT ?",
  ).all(id, LIMITS.aliasesPerRecord + 1);
  if (rows.length > LIMITS.aliasesPerRecord) {
    throw lodestarError(
      "database_integrity",
      "A record exceeds its stored alias limit.",
      {
        identifiers: {
          id,
          count: rows.length,
          maximum: LIMITS.aliasesPerRecord,
        },
        action: "Run lodestar doctor and restore a valid external backup.",
      },
    );
  }
  return rows.map(({ alias }) => alias);
}

function invalidStoredRow(kind, identifiers, error) {
  throw lodestarError(
    "database_integrity",
    `The database contains an invalid ${kind} row.`,
    {
      identifiers,
      action: "Run lodestar doctor and restore a valid external backup.",
      cause: error,
    },
  );
}

function recordFields(row) {
  try {
    validateIdentifier(row.id);
    validateType(row.type);
    validateName(row.name);
    validateScope(row.scope);
    validateTimestamp(row.created_at, "records.created_at");
    validateTimestamp(row.updated_at, "records.updated_at");
    return parseStoredContent(row.content_json, { id: row.id });
  } catch (error) {
    if (error?.code === "database_integrity") throw error;
    invalidStoredRow("record", { id: row.id ?? null }, error);
  }
}

function summary(db, row) {
  const content = recordFields(row);
  const aliases = aliasesFor(db, row.id);
  try {
    for (const alias of aliases) validateIdentifier(alias, "alias");
  } catch (error) {
    invalidStoredRow("alias", { record_id: row.id }, error);
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    scope: row.scope,
    state: content.state,
    aliases,
    updated_at: row.updated_at,
  };
}

export function findRecords(
  db,
  queryValue,
  {
    scope,
    type,
    limit,
  } = {},
) {
  const query = validateQuery(queryValue);
  const selectedLimit = validateLimit(limit, {
    fallback: LIMITS.findDefault,
    maximum: LIMITS.findMaximum,
  });
  const clauses = [String.raw`
    (
      instr(lower(r.id), lower($query)) > 0
      OR instr(lower(r.type), lower($query)) > 0
      OR instr(lower(r.name), lower($query)) > 0
      OR instr(lower(r.scope), lower($query)) > 0
      OR instr(lower(r.content_json), lower($query)) > 0
      OR EXISTS (
        SELECT 1 FROM aliases a
        WHERE a.record_id = r.id
          AND instr(lower(a.alias), lower($query)) > 0
      )
    )
  `];
  const parameters = {
    $query: query,
    $limit: selectedLimit + 1,
  };
  if (scope !== undefined) {
    validateScope(scope);
    clauses.push("r.scope = $scope");
    parameters.$scope = scope;
  }
  if (type !== undefined) {
    validateType(type);
    clauses.push("r.type = $type");
    parameters.$type = type;
  }
  const rows = db.prepare(String.raw`
    SELECT
      r.id,
      r.type,
      r.name,
      r.scope,
      r.content_json,
      r.created_at,
      r.updated_at,
      CASE
        WHEN r.id = $query
          OR EXISTS (
            SELECT 1 FROM aliases exact_alias
            WHERE exact_alias.record_id = r.id
              AND exact_alias.alias = $query
          )
          THEN 0
        WHEN lower(r.name) = lower($query) THEN 1
        WHEN instr(lower(r.id), lower($query)) = 1
          OR instr(lower(r.name), lower($query)) = 1
          OR EXISTS (
            SELECT 1 FROM aliases prefix_alias
            WHERE prefix_alias.record_id = r.id
              AND instr(lower(prefix_alias.alias), lower($query)) = 1
          )
          THEN 2
        ELSE 3
      END AS rank
    FROM records r
    WHERE ${clauses.join(" AND ")}
    ORDER BY rank, r.id COLLATE BINARY
    LIMIT $limit
  `).all(parameters);
  const truncated = rows.length > selectedLimit;
  return {
    query,
    scope: scope ?? null,
    type: type ?? null,
    limit: selectedLimit,
    truncated,
    records: rows.slice(0, selectedLimit).map((row) => summary(db, row)),
  };
}

export function linkedRecords(
  db,
  identifier,
  {
    limit,
  } = {},
) {
  const id = resolveRecordId(db, identifier);
  const selectedLimit = validateLimit(limit, {
    fallback: LIMITS.linksDefault,
    maximum: LIMITS.linksMaximum,
  });
  const rows = db.prepare(String.raw`
    SELECT
      0 AS direction_rank,
      'outgoing' AS direction,
      l.from_id,
      l.relationship,
      l.to_id,
      l.created_at,
      peer.id,
      peer.type,
      peer.name,
      peer.scope,
      peer.content_json,
      peer.created_at,
      peer.updated_at
    FROM links l
    JOIN records peer ON peer.id = l.to_id
    WHERE l.from_id = $id
    UNION ALL
    SELECT
      1 AS direction_rank,
      'incoming' AS direction,
      l.from_id,
      l.relationship,
      l.to_id,
      l.created_at,
      peer.id,
      peer.type,
      peer.name,
      peer.scope,
      peer.content_json,
      peer.created_at,
      peer.updated_at
    FROM links l
    JOIN records peer ON peer.id = l.from_id
    WHERE l.to_id = $id
    ORDER BY direction_rank, relationship, from_id, to_id
    LIMIT $limit
  `).all({
    $id: id,
    $limit: selectedLimit + 1,
  });
  const truncated = rows.length > selectedLimit;
  return {
    id,
    limit: selectedLimit,
    truncated,
    links: rows.slice(0, selectedLimit).map((row) => {
      try {
        validateIdentifier(row.from_id, "from_id");
        validateRelationship(row.relationship);
        validateIdentifier(row.to_id, "to_id");
        validateTimestamp(row.created_at, "links.created_at");
      } catch (error) {
        invalidStoredRow("link", {
          from_id: row.from_id,
          to_id: row.to_id,
        }, error);
      }
      return {
        direction: row.direction,
        from_id: row.from_id,
        relationship: row.relationship,
        to_id: row.to_id,
        created_at: row.created_at,
        peer: summary(db, row),
      };
    }),
  };
}

export function exportRegistry(db) {
  const document = {
    schema_version: SCHEMA_VERSION,
    records: [],
    aliases: [],
    links: [],
    sources: [],
  };
  let estimatedBytes = 128;
  const append = (section, item) => {
    estimatedBytes += Buffer.byteLength(canonicalStringify(item), "utf8") + 1;
    if (estimatedBytes > LIMITS.exportBytes) {
      throw lodestarError(
        "resource_limit",
        "The registry export exceeds its byte limit.",
        {
          identifiers: {
            resource: "export",
            bytes_at_least: estimatedBytes,
            maximum: LIMITS.exportBytes,
          },
          action: "Delete obsolete records before exporting the registry.",
        },
      );
    }
    document[section].push(item);
  };

  for (const row of db.prepare(
      "SELECT id, type, name, scope, content_json, created_at, updated_at "
        + "FROM records ORDER BY id",
    ).iterate()) {
    const content = recordFields(row);
    try {
      validateTimestamp(row.created_at, "records.created_at");
    } catch (error) {
      invalidStoredRow("record", { id: row.id }, error);
    }
    append("records", {
      id: row.id,
      type: row.type,
      name: row.name,
      scope: row.scope,
      content,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
  for (const { alias, record_id: recordId } of db.prepare(
    "SELECT alias, record_id FROM aliases ORDER BY alias",
  ).iterate()) {
    try {
      validateIdentifier(alias, "alias");
      validateIdentifier(recordId, "record_id");
    } catch (error) {
      invalidStoredRow("alias", { alias }, error);
    }
    append("aliases", { alias, record_id: recordId });
  }
  for (const {
    from_id: fromId,
    relationship,
    to_id: toId,
    created_at: createdAt,
  } of db.prepare(
      "SELECT from_id, relationship, to_id, created_at FROM links "
        + "ORDER BY from_id, relationship, to_id",
    ).iterate()) {
    try {
      validateIdentifier(fromId, "from_id");
      validateRelationship(relationship);
      validateIdentifier(toId, "to_id");
      validateTimestamp(createdAt, "links.created_at");
    } catch (error) {
      invalidStoredRow("link", { from_id: fromId, to_id: toId }, error);
    }
    append("links", {
      from_id: fromId,
      relationship,
      to_id: toId,
      created_at: createdAt,
    });
  }
  for (const row of db.prepare(
      "SELECT record_id, origin, freshness, metadata_json FROM sources "
        + "ORDER BY record_id, origin",
    ).iterate()) {
    let metadata;
    try {
      validateIdentifier(row.record_id, "record_id");
      validateOrigin(row.origin);
      if (!FRESHNESS_STATES.includes(row.freshness)) throw new Error();
      metadata = parseStoredMetadata(row.metadata_json, {
        id: row.record_id,
        origin: row.origin,
      });
    } catch (error) {
      if (error?.code === "database_integrity") throw error;
      invalidStoredRow("source", {
        record_id: row.record_id,
        origin: row.origin,
      }, error);
    }
    append("sources", {
      record_id: row.record_id,
      origin: row.origin,
      freshness: row.freshness,
      metadata,
    });
  }
  const bytes = Buffer.byteLength(canonicalStringify(document), "utf8");
  if (bytes > LIMITS.exportBytes) {
    throw lodestarError(
      "resource_limit",
      "The registry export exceeds its byte limit.",
      {
        identifiers: {
          resource: "export",
          bytes,
          maximum: LIMITS.exportBytes,
        },
        action: "Delete obsolete records before exporting the registry.",
      },
    );
  }
  return { document, bytes };
}
