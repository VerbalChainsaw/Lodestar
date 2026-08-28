import { Buffer } from "node:buffer";

import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import {
  normalizeRecord,
  parseStoredContent,
  parseStoredMetadata,
  recordsByRows,
  resolveRecordId,
} from "./records.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import {
  FRESHNESS_STATES,
  validateIdentifier,
  validateLimit,
  validateName,
  validateOffset,
  validateOrigin,
  validateQuery,
  validateRelationship,
  validateScope,
  validateTimestamp,
  validateType,
} from "./validate.mjs";

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

// Validate a stored record row and parse its content exactly once. Callers
// destructure the returned stored object (content plus any _lodestar metadata).
function parsedContent(row) {
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

// Assemble the already-selected rows into normalized records exactly once.
// The previous path built throwaway summaries here and then re-fetched and
// re-parsed the same rows in the caller, so find and links parsed every
// selected record twice.
function normalizedForRows(db, rows) {
  return recordsByRows(db, rows).map(normalizeRecord);
}

export function findRecords(
  db,
  queryValue,
  {
    scope,
    type,
    limit,
    offset = 0,
  } = {},
) {
  const query = validateQuery(queryValue);
  const selectedLimit = limit === undefined ? null : validateLimit(limit, {});
  const selectedOffset = offset === undefined ? 0 : validateOffset(offset, {});
  if (selectedLimit === null && selectedOffset !== 0) {
    throw lodestarError("invalid_input",
      "Find offset requires an explicit --limit page size.",
      { action: "Retry with --limit set, or drop --offset for an unbounded search." });
  }
  // The alias predicate comes from the single-pass alias_info CTE (defined in
  // the main query below) instead of a per-row EXISTS: the aliases table is
  // scanned once, not once per scanned record.
  const clauses = [String.raw`
    (
      instr(lower(r.id), lower($query)) > 0
      OR instr(lower(r.type), lower($query)) > 0
      OR instr(lower(r.name), lower($query)) > 0
      OR instr(lower(r.scope), lower($query)) > 0
      OR instr(lower(r.content_json), lower($query)) > 0
      OR ai.record_id IS NOT NULL
    )
  `];
  const parameters = {
    $query: query,
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
  } else {
    // Reserved internal cache: `start` persists the projection as a
    // startup-snapshot record. Users cannot create or delete that type, and
    // searching it returns a copy of other records' content, so default find
    // omits it unless the caller explicitly asks for the kind.
    clauses.push("r.type != 'startup-snapshot'");
  }
  // One pass over aliases computes exact/prefix flags per record; the record
  // scan LEFT JOINs that result. Rank semantics are unchanged: exact id or
  // alias = 0, exact name = 1, prefix id/name/alias = 2, substring = 3.
  const rows = db.prepare(String.raw`
    WITH alias_info AS (
      SELECT
        record_id,
        MAX(CASE WHEN alias = $query THEN 1 ELSE 0 END) AS exact,
        MAX(CASE WHEN instr(lower(alias), lower($query)) = 1 THEN 1 ELSE 0 END) AS prefix
      FROM aliases
      WHERE instr(lower(alias), lower($query)) > 0
      GROUP BY record_id
    )
    SELECT
      r.id,
      r.type,
      r.name,
      r.scope,
      r.content_json,
      r.created_at,
      r.updated_at,
      CASE
        WHEN r.id = $query OR ai.exact = 1 THEN 0
        WHEN lower(r.name) = lower($query) THEN 1
        WHEN instr(lower(r.id), lower($query)) = 1
          OR instr(lower(r.name), lower($query)) = 1
          OR ai.prefix = 1
          THEN 2
        ELSE 3
      END AS rank
    FROM records r
    LEFT JOIN alias_info ai ON ai.record_id = r.id
    WHERE ${clauses.join(" AND ")}
    ORDER BY rank, r.id COLLATE BINARY
    ${selectedLimit === null ? "" : "LIMIT $limit + 1 OFFSET $offset"}
  `).all(selectedLimit === null
    ? parameters
    : { ...parameters, $limit: selectedLimit, $offset: selectedOffset });
  const truncated = selectedLimit !== null && rows.length > selectedLimit;
  const selected = truncated ? rows.slice(0, selectedLimit) : rows;
  return { query, scope: scope ?? null, type: type ?? null, limit: selectedLimit,
    offset: selectedOffset, truncated, records: normalizedForRows(db, selected) };
}

export function linkedRecords(
  db,
  identifier,
  {
    limit,
  } = {},
) {
  const id = resolveRecordId(db, identifier);
  const selectedLimit = limit === undefined ? null : validateLimit(limit, {});
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
    ${selectedLimit === null ? "" : "LIMIT $limit + 1"}
  `).all(selectedLimit === null ? { $id: id } : { $id: id, $limit: selectedLimit });
  const truncated = selectedLimit !== null && rows.length > selectedLimit;
  const selected = truncated ? rows.slice(0, selectedLimit) : rows;
  const peers = normalizedForRows(db, selected);
  return {
    id,
    limit: selectedLimit,
    truncated,
    links: selected.map((row, index) => {
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
        peer: peers[index],
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
  const append = (section, item) => { document[section].push(item); };

  for (const row of db.prepare(
      "SELECT id, type, name, scope, content_json, created_at, updated_at "
        + "FROM records ORDER BY id",
    ).iterate()) {
    const stored = parsedContent(row);
    const { _lodestar: _ignored, ...content } = stored;
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
  return { document, bytes };
}
