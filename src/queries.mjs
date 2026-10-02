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
    all = false,
    compact = false,
    match = "contains",
    explain = false,
  } = {},
) {
  if (!["contains", "terms"].includes(match)) throw lodestarError("invalid_input", "Unsupported find match mode.",
    { action: "Use --match contains for contiguous substrings or --match terms for explicit AND terms." });
  if (all && match === "terms") throw lodestarError("invalid_input", "Terms matching requires a query.",
    { action: "Supply a query with --match terms, or use --all with --match contains." });
  if (all && queryValue !== undefined) throw lodestarError("invalid_input", "Find query and --all are mutually exclusive.");
  if (!all) validateQuery(match === "terms" && typeof queryValue === "string"
    ? queryValue.normalize("NFC") : queryValue);
  const query = all ? null : queryValue;
  const terms = match === "terms" ? [...new Set(searchFold(query).split(/\s+/u).filter(Boolean))].sort() : [];
  if (match === "terms" && (!terms.length || terms.length > 16)) throw lodestarError("invalid_input", "Terms search requires one to sixteen distinct nonempty terms.",
    { action: "Supply 1–16 distinct whitespace-separated terms; use --match contains for a literal phrase." });
  if (match === "terms") db.function("lodestar_search_fold", { deterministic: true }, searchFold);
  const askedLimit = limit === undefined ? null : validateLimit(limit, {});
  const selectedLimit = compact ? Math.min(askedLimit ?? COMPACT_MAX_ROWS, COMPACT_MAX_ROWS) : askedLimit;
  const selectedOffset = offset === undefined ? 0 : validateOffset(offset, {});
  if (selectedLimit === null && selectedOffset !== 0) {
    throw lodestarError("invalid_input",
      "Find offset requires an explicit --limit page size.",
      { action: "Retry with --limit set, or drop --offset for an unbounded search." });
  }
  // The alias predicate comes from the single-pass alias_info CTE (defined in
  // the main query below) instead of a per-row EXISTS: the aliases table is
  // scanned once, not once per scanned record.
  const clauses = all ? [] : [String.raw`
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
    $query: query ?? "",
  };
  const fieldNames = ["id", "type", "name", "scope", "content_json"];
  if (match === "terms") {
    parameters.$query = searchFold(query);
    clauses.splice(0, 1, ...terms.map((term, index) => {
      parameters[`$term${index}`] = term;
      return `(${fieldNames.map(field => `instr(lodestar_search_fold(r.${field}), $term${index}) > 0`).join(" OR ")} OR ai.term${index} = 1)`;
    }));
  }
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
  const folded = expression => match === "terms" ? `lodestar_search_fold(${expression})` : `lower(${expression})`;
  const rows = db.prepare(String.raw`
    WITH alias_info AS (
      SELECT
        record_id,
        MAX(CASE WHEN ${match === "terms" ? folded("alias") : "alias"} = $query THEN 1 ELSE 0 END) AS exact,
        MAX(CASE WHEN instr(${folded("alias")}, ${folded("$query")}) = 1 THEN 1 ELSE 0 END) AS prefix
        ${terms.map((_, index) => `, MAX(CASE WHEN instr(lodestar_search_fold(alias), $term${index}) > 0 THEN 1 ELSE 0 END) AS term${index}`).join("")}
      FROM aliases
      WHERE ${all ? "0" : match === "terms" ? terms.map((_, index) => `instr(lodestar_search_fold(alias), $term${index}) > 0`).join(" OR ") : "instr(lower(alias), lower($query)) > 0"}
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
        WHEN ${match === "terms" ? folded("r.id") : "r.id"} = $query OR ai.exact = 1 THEN 0
        WHEN ${folded("r.name")} = ${folded("$query")} THEN 1
        WHEN instr(${folded("r.id")}, ${folded("$query")}) = 1
          OR instr(${folded("r.name")}, ${folded("$query")}) = 1
          OR ai.prefix = 1
          THEN 2
        ELSE 3
      END AS rank
    FROM records r
    LEFT JOIN alias_info ai ON ai.record_id = r.id
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY ${all ? "r.id COLLATE BINARY" : "rank, r.id COLLATE BINARY"}
    ${selectedLimit === null ? "" : "LIMIT $limit + 1 OFFSET $offset"}
  `).all(selectedLimit === null
    ? parameters
    : { ...parameters, $limit: selectedLimit, $offset: selectedOffset });
  const truncated = selectedLimit !== null && rows.length > selectedLimit;
  const selected = truncated ? rows.slice(0, selectedLimit) : rows;
  const normalized = normalizedForRows(db, selected);
  if (compact || explain) {
    const bodies = new Map(selected.map(row => [row.id, row.content_json]));
    for (const record of normalized.records) record.match_reasons = matchReasons(record, bodies.get(record.id), query, { all, match, terms });
  }
  return { query, all, scope: scope ?? null, type: type ?? null, limit: selectedLimit,
    offset: selectedOffset, truncated, ...normalized,
    ...(match === "terms" ? { match_policy: TERMS_MATCH_POLICY } : {}) };
}

export const COMPACT_MAX_ROWS = 20;
export const COMPACT_MAX_BYTES = 24000;
export const TERMS_MATCH_POLICY = Object.freeze({ normalization: "NFC", case: "Unicode toLowerCase",
  combination: "AND", maximum_terms: 16, synonyms: false });
const searchFold = value => String(value).normalize("NFC").toLowerCase();
// SQLite's built-in lower() folds ASCII only. Explanation of the unchanged
// contains path uses that same policy; terms explicitly uses Unicode folding.
const containsFold = value => String(value).replace(/[A-Z]/gu, letter => letter.toLowerCase());
function matchReasons(record, body, query, { all, match, terms }) {
  if (all) return ["all_records"];
  const fold = match === "terms" ? searchFold : containsFold;
  const needle = fold(query), reasons = [];
  for (const [field, values] of [["id", [record.id]], ["kind", [record.kind]],
    ["name", [record.name]], ["scope", [record.scope]], ["body", [body]], ["alias", record.aliases]]) {
    if (match === "terms") {
      if (values.some(value => terms.some(term => fold(value).includes(term)))) reasons.push(`${field}_terms`);
    } else if (values.some(value => fold(value).includes(needle))) {
      const exact = values.some(value => ["id", "alias"].includes(field) ? value === query : fold(value) === needle);
      reasons.push(exact ? `exact_${field}` : values.some(value => fold(value).startsWith(needle)) ? `${field}_prefix` : `${field}_substring`);
    }
  }
  return reasons;
}

export const serializedBytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
export function compactRecord(record, query = null, match = "contains") {
  const fold = match === "terms" ? searchFold : containsFold;
  const originalBody = JSON.stringify(record.data);
  // Terms normalization can change string length. Slice that declared preview
  // itself so its match offset cannot accidentally point elsewhere in the source.
  const body = match === "terms" ? fold(originalBody) : originalBody;
  const terms = query ? match === "terms" ? fold(query).split(/\s+/u).filter(Boolean) : [fold(query)] : [];
  const foldedBody = fold(body);
  const position = terms.reduce((found, term) => {
    const index = foldedBody.indexOf(term);
    return index >= 0 && (found < 0 || index < found) ? index : found;
  }, -1);
  let snippetStart = Math.max(0, position - 60);
  if (/[\uDC00-\uDFFF]/u.test(body[snippetStart] ?? "")) snippetStart -= 1;
  let snippetEnd = Math.min(body.length, snippetStart + 240);
  if (/[\uD800-\uDBFF]/u.test(body[snippetEnd - 1] ?? "")) snippetEnd -= 1;
  const snippet = body.slice(snippetStart, snippetEnd);
  return { id: record.id, revision: record.revision, kind: record.kind, name: record.name,
    scope: record.scope, applicability: record.semantics.applicability,
    lifecycle: record.semantics.lifecycle, match_reasons: record.match_reasons ?? [record.selection_reason ?? "orientation"],
    snippet, snippet_policy: match === "terms" ? "NFC and Unicode toLowerCase excerpt" : "stored JSON data excerpt",
    snippet_truncated: body.length > snippet.length, snippet_omitted_characters: body.length - snippet.length,
    read_args: ["get", "--", record.id], requires_full_read: true,
    omitted_fields: Object.keys(record).filter(field => !["id", "revision", "kind", "name", "scope", "match_reasons", "claim_status"].includes(field)),
    ...(record.claim_status ? { claim_status: record.claim_status,
      source_status_counts: Object.fromEntries([...new Set(record.current_source_status.map(source => source.status))]
        .map(status => [status, record.current_source_status.filter(source => source.status === status).length])) } : {}) };
}

export function compactRows(records, query = null, match = "contains") {
  const selected = [];
  let bytes = 0;
  for (const record of records) {
    if (selected.length >= COMPACT_MAX_ROWS) break;
    const row = compactRecord(record, query, match), size = serializedBytes(row);
    if (size > 4096 || bytes + size > 16000) continue;
    selected.push(row); bytes += size;
  }
  return { records: selected, selected_records: records.length, displayed_records: selected.length,
    omitted_records: records.length - selected.length };
}

// Bound every serialized field, including errors, query text and exact argument
// arrays. Oversized fields are omitted whole; literal identifiers are never cut.
export function boundCompactData(data) {
  const clean = value => Array.isArray(value) ? value.map(clean)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, clean(entry)])) : value;
  data = clean(data);
  data.projection_complete = false;
  data.discovery_complete = data.discovery_complete !== false && data.omitted_records === 0;
  const omitted = [...(data.omitted_fields ?? [])];
  for (const [field, value] of Object.entries(data)) {
    if (field === "omitted_fields") continue;
    if (serializedBytes(value) > 4096 && !["records", "context"].includes(field)) {
      if (Array.isArray(value)) data[`omitted_${field}_count`] = value.length;
      delete data[field]; omitted.push(field);
    }
  }
  data.omitted_fields = [...new Set(omitted)];
  if (serializedBytes(data) > COMPACT_MAX_BYTES) {
    for (const field of ["records", "context", "required", "record_errors", "read_pointers"]) {
      if (!Object.hasOwn(data, field)) continue;
      data[`omitted_${field}_count`] = data[field].length ?? Object.keys(data[field]).length;
      if (["records", "context"].includes(field)) {
        data.omitted_records += data.displayed_records; data.displayed_records = 0;
        data.discovery_complete = false;
      }
      delete data[field]; data.omitted_fields.push(field);
      if (serializedBytes(data) <= COMPACT_MAX_BYTES) break;
    }
  }
  data.required_action = "Repeat the original command without --compact using --args-file <JSON-array-file> or --args-stdin when needed. Read exact get read_args before evidence-dependent work or a guarded edit; compact omissions are not evidence.";
  if (serializedBytes(data) > COMPACT_MAX_BYTES) {
    for (const field of Object.keys(data)) {
      if (["projection", "complete", "required_complete", "instructions_complete", "requires_full_start",
        "requires_full_read", "omitted_fields", "required_action"].includes(field) || typeof data[field] !== "object" && typeof data[field] !== "string") continue;
      if (["records", "context"].includes(field)) {
        data.omitted_records += data.displayed_records; data.displayed_records = 0;
        data.discovery_complete = false;
      }
      if (Array.isArray(data[field])) data[`omitted_${field}_count`] = data[field].length;
      delete data[field]; data.omitted_fields.push(field);
      if (serializedBytes(data) <= COMPACT_MAX_BYTES) break;
    }
  }
  return data;
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
