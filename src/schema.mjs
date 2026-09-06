import { randomBytes } from "node:crypto";

export const CONTRACT_VERSION = 5;
export const SCHEMA_VERSION = CONTRACT_VERSION;
export const SCHEMA_V4_VERSION = 4;

export function createDatabaseInstanceId() {
  return randomBytes(32).toString("hex");
}

export const SCHEMA_TABLES = Object.freeze([
  "aliases", "links", "metadata", "records", "sources",
]);
export const SCHEMA_INDEXES = Object.freeze([
  "aliases_record_id", "links_to_id", "records_scope_type_id",
]);
export const EXPECTED_COLUMNS = Object.freeze({
  metadata: ["key", "value"],
  records: ["id", "type", "name", "scope", "content_json", "created_at", "updated_at"],
  links: ["from_id", "relationship", "to_id", "created_at"],
  aliases: ["alias", "record_id"],
  sources: ["record_id", "origin", "freshness", "metadata_json"],
});

export const SCHEMA_V4_SQL = String.raw`
CREATE TABLE metadata (
  key TEXT PRIMARY KEY CHECK(length(CAST(key AS BLOB)) >= 1),
  value TEXT NOT NULL CHECK(length(CAST(value AS BLOB)) >= 1)
) STRICT, WITHOUT ROWID;
CREATE TABLE records (
  id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) >= 1),
  type TEXT NOT NULL CHECK(length(CAST(type AS BLOB)) >= 1),
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) >= 1),
  scope TEXT NOT NULL CHECK(length(CAST(scope AS BLOB)) >= 1),
  content_json TEXT NOT NULL CHECK(CASE WHEN json_valid(content_json) THEN (
    json_type(content_json) = 'object'
    AND json_type(content_json, '$.state') = 'text'
    AND json_extract(content_json, '$.state')
      IN ('known', 'known_empty', 'unavailable', 'unknown', 'stale')
  ) ELSE 0 END),
  created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB)) = 24 AND COALESCE(
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK(length(CAST(updated_at AS BLOB)) = 24 AND COALESCE(
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0))
) STRICT, WITHOUT ROWID;
CREATE TABLE links (
  from_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK(length(CAST(relationship AS BLOB)) >= 1),
  to_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB)) = 24 AND COALESCE(
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  PRIMARY KEY (from_id, relationship, to_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE aliases (
  alias TEXT PRIMARY KEY CHECK(length(CAST(alias AS BLOB)) >= 1),
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE sources (
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK(length(CAST(origin AS BLOB)) >= 1),
  freshness TEXT NOT NULL CHECK(freshness IN ('current', 'stale', 'unknown')),
  metadata_json TEXT NOT NULL CHECK(CASE WHEN json_valid(metadata_json) THEN (
    json_type(metadata_json) = 'object'
    AND json_type(metadata_json, '$.inspection') = 'text'
    AND json_extract(metadata_json, '$.inspection')
      IN ('inspected', 'not_inspected', 'inspected_no_value', 'unknown')
  ) ELSE 0 END),
  PRIMARY KEY (record_id, origin)
) STRICT, WITHOUT ROWID;
CREATE INDEX records_scope_type_id ON records(scope, type, id);
CREATE INDEX links_to_id ON links(to_id, relationship, from_id);
CREATE INDEX aliases_record_id ON aliases(record_id, alias);
`;

const WRITE_FENCE_TABLES = Object.freeze([
  "metadata", "records", "aliases", "links", "sources",
]);
export const WRITE_FENCE_SQL = WRITE_FENCE_TABLES.flatMap((table) =>
  ["INSERT", "UPDATE", "DELETE"].map((operation) => String.raw`
CREATE TRIGGER lodestar_contract_${table}_${operation.toLowerCase()}
BEFORE ${operation} ON ${table}
WHEN lodestar_write_contract() IS NOT ${CONTRACT_VERSION}
BEGIN
  SELECT RAISE(ABORT, 'lodestar_write_contract_required');
END;`)
).join("\n");
export const SCHEMA_SQL = `${SCHEMA_V4_SQL}\n${WRITE_FENCE_SQL}`;

function normalizedSql(value) {
  // Compare SQL tokens, preserving string literals. SQLite's table-renaming
  // path quotes identifiers and retains original layout; neither changes DDL.
  return (String(value).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9]*|\d+(?:\.\d+)?|[^\s]/giu) ?? [])
    .map((token) => token.startsWith("'") ? token : /^"[a-z_][a-z_0-9]*"$/iu.test(token)
      ? token.slice(1, -1).toLowerCase() : token.toLowerCase()).join(" ");
}

const SQLITE_STATISTICS_DEFINITIONS = Object.freeze({
  sqlite_stat1: Object.freeze({ type: "table", sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)" }),
  sqlite_stat4: Object.freeze({ type: "table", sql: "CREATE TABLE sqlite_stat4(tbl,idx,nEq,nLt,nDLt,sample)" }),
});

function expectedDefinitions(schemaSql) {
  const definitions = {};
  const statements = schemaSql.match(
    /CREATE\s+TRIGGER[\s\S]*?END;|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)[\s\S]*?;/giu,
  ) ?? [];
  for (const statement of statements) {
    const sql = statement.trim().replace(/;$/u, "");
    const match = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+([a-z0-9_]+)/iu.exec(sql);
    if (!match) throw new Error("Lodestar schema contains an unknown statement.");
    definitions[match[2]] = Object.freeze({ type: match[1].toLowerCase(), sql: normalizedSql(sql) });
  }
  return Object.freeze(definitions);
}

export const SCHEMA_V4_EXPECTED_SCHEMA_DEFINITIONS = expectedDefinitions(SCHEMA_V4_SQL);
export const EXPECTED_SCHEMA_DEFINITIONS = expectedDefinitions(SCHEMA_SQL);

export function inspectSchemaDefinitions(db, { version = SCHEMA_VERSION } = {}) {
  const expected = version === SCHEMA_V4_VERSION
    ? SCHEMA_V4_EXPECTED_SCHEMA_DEFINITIONS
    : version === SCHEMA_VERSION ? EXPECTED_SCHEMA_DEFINITIONS : null;
  if (!expected) throw new Error(`Unsupported schema inspection version: ${version}`);
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema "
    + "WHERE type IN ('table','index','trigger','view') ORDER BY name").all()
    .filter((row) => {
      const known = SQLITE_STATISTICS_DEFINITIONS[row.name];
      return !(known && row.type === known.type && row.tbl_name === row.name
        && normalizedSql(row.sql) === normalizedSql(known.sql));
    });
  const actual = Object.fromEntries(rows.map(({ type, name, sql }) => [
    name, { type, sql: typeof sql === "string" ? normalizedSql(sql) : null },
  ]));
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(actual).sort();
  const missing = expectedNames.filter((name) => !Object.hasOwn(actual, name));
  const unexpected = actualNames.filter((name) => !Object.hasOwn(expected, name));
  const mismatched = expectedNames.filter((name) => Object.hasOwn(actual, name)
    && (actual[name].type !== expected[name].type || actual[name].sql !== expected[name].sql));
  return { matches: missing.length === 0 && unexpected.length === 0
    && mismatched.length === 0, expected: expectedNames, actual: actualNames,
    missing, unexpected, mismatched };
}

export function createSchema(db, { createdAt,
  databaseInstanceId = createDatabaseInstanceId() }) {
  db.exec(SCHEMA_SQL);
  const insert = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  insert.run("schema_version", String(SCHEMA_VERSION));
  insert.run("created_at", createdAt);
  insert.run("database_instance_id", databaseInstanceId);
  insert.run("database_epoch", createDatabaseInstanceId());
  insert.run("database_revision", "0");
}
