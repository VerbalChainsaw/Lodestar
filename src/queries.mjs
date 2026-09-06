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
import { readMetadata } from "./database.mjs";
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
export function normalizedForRows(db, rows) {
  try { return { records: recordsByRows(db, rows).map(normalizeRecord), record_errors: [] }; }
  catch (error) { if (!["record_requires_source_correction", "unsupported_numeric_value"].includes(error.code)) throw error; }
  const records = [], record_errors = [];
  for (const row of rows) {
    try { records.push(normalizeRecord(recordsByRows(db, [row])[0])); }
    catch (error) {
      if (!["record_requires_source_correction", "unsupported_numeric_value"].includes(error.code)) throw error;
      record_errors.push({ code: error.code, message: error.message,
        identifiers: { ...error.identifiers, id: row.id }, action: error.action });
    }
  }
  return { records, record_errors };
}

export function findRecords(
  db,
  queryValue,
  {
    scope,
    type,
    limit,
    offset = 0,
    history = false,
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
  } else if (!history) {
    // Internal histories duplicate current facts; explicit history reads can
    // retrieve them while ordinary discovery stays useful.
    clauses.push("r.type NOT IN ('startup-snapshot','mutation-receipt','migration-source','work-event','handoff-packet')");
  }
  if (!history) clauses.push("COALESCE(json_extract(r.content_json,'$._lodestar.semantics.lifecycle'),'current') NOT IN ('historical','superseded')");
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
    offset: selectedOffset, truncated, ...normalizedForRows(db, selected) };
}

export function linkedRecords(
  db,
  identifier,
  {
    limit,
    offset = 0,
  } = {},
) {
  const id = resolveRecordId(db, identifier);
  const selectedLimit = limit === undefined ? null : validateLimit(limit, {});
  const selectedOffset = offset === undefined ? 0 : validateOffset(offset, {});
  if (selectedLimit === null && selectedOffset !== 0) throw lodestarError("invalid_input",
    "Links offset requires an explicit --limit page size.",
    { action: "Retry with --limit set, or drop --offset for an unbounded read." });
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
    ${selectedLimit === null ? "" : "LIMIT $limit + 1 OFFSET $offset"}
  `).all(selectedLimit === null ? { $id: id }
    : { $id: id, $limit: selectedLimit, $offset: selectedOffset });
  const truncated = selectedLimit !== null && rows.length > selectedLimit;
  const selected = truncated ? rows.slice(0, selectedLimit) : rows;
  const normalized = normalizedForRows(db, selected);
  const peers = new Map(normalized.records.map((record) => [record.id, record]));
  return {
    id,
    limit: selectedLimit,
    offset: selectedOffset,
    truncated,
    record_errors: normalized.record_errors,
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
        peer: peers.get(row.id) ?? null,
      };
    }),
  };
}

export function exportRegistry(db) {
  // Export is exact evidence, including payloads that cannot be normalized safely.
  // It is not a current-context projection and never strips reserved metadata.
  const document = { v: SCHEMA_VERSION, schema_version: SCHEMA_VERSION,
    metadata: Object.fromEntries(db.prepare("SELECT key,value FROM metadata ORDER BY key").all()
      .map(({ key, value }) => [key, value])), private_state: true };
  for (const [table, order] of [["records", "id"], ["aliases", "alias"],
    ["links", "from_id,relationship,to_id"], ["sources", "record_id,origin"]]) {
    document[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  }
  document.schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema "
    + "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { document, bytes: Buffer.byteLength(canonicalStringify(document), "utf8") };
}
