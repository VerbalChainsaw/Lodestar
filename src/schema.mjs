export const SCHEMA_VERSION = 1;

export const SCHEMA_TABLES = Object.freeze([
  "aliases",
  "links",
  "metadata",
  "records",
  "sources",
]);

export const SCHEMA_INDEXES = Object.freeze([
  "aliases_record_id",
  "links_to_id",
  "records_scope_type_id",
]);

export const EXPECTED_COLUMNS = Object.freeze({
  metadata: ["key", "value"],
  records: [
    "id",
    "type",
    "name",
    "scope",
    "content_json",
    "created_at",
    "updated_at",
  ],
  links: ["from_id", "relationship", "to_id", "created_at"],
  aliases: ["alias", "record_id"],
  sources: ["record_id", "origin", "freshness", "metadata_json"],
});

export const SCHEMA_SQL = String.raw`
CREATE TABLE metadata (
  key TEXT PRIMARY KEY
    CHECK(length(CAST(key AS BLOB)) BETWEEN 1 AND 64),
  value TEXT NOT NULL
    CHECK(length(CAST(value AS BLOB)) BETWEEN 1 AND 4096)
) STRICT, WITHOUT ROWID;

CREATE TABLE records (
  id TEXT PRIMARY KEY
    CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 256),
  type TEXT NOT NULL
    CHECK(length(CAST(type AS BLOB)) BETWEEN 1 AND 64),
  name TEXT NOT NULL
    CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 256),
  scope TEXT NOT NULL
    CHECK(length(CAST(scope AS BLOB)) BETWEEN 1 AND 512),
  content_json TEXT NOT NULL
    CHECK(
      length(CAST(content_json AS BLOB)) <= 262144
      AND CASE WHEN json_valid(content_json) THEN (
        json_type(content_json) = 'object'
        AND json_type(content_json, '$.state') = 'text'
        AND json_extract(content_json, '$.state')
          IN ('known', 'known_empty', 'unavailable', 'unknown', 'stale')
      ) ELSE 0 END
    ),
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  updated_at TEXT NOT NULL
    CHECK(
      length(CAST(updated_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at,
        0
      )
    )
) STRICT, WITHOUT ROWID;

CREATE TABLE links (
  from_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL
    CHECK(length(CAST(relationship AS BLOB)) BETWEEN 1 AND 64),
  to_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
    CHECK(
      length(CAST(created_at AS BLOB)) = 24
      AND COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at,
        0
      )
    ),
  PRIMARY KEY (from_id, relationship, to_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE aliases (
  alias TEXT PRIMARY KEY
    CHECK(length(CAST(alias AS BLOB)) BETWEEN 1 AND 256),
  record_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE sources (
  record_id TEXT NOT NULL
    REFERENCES records(id) ON DELETE CASCADE,
  origin TEXT NOT NULL
    CHECK(length(CAST(origin AS BLOB)) BETWEEN 1 AND 4096),
  freshness TEXT NOT NULL
    CHECK(freshness IN ('current', 'stale', 'unknown')),
  metadata_json TEXT NOT NULL
    CHECK(
      length(CAST(metadata_json AS BLOB)) <= 65536
      AND CASE WHEN json_valid(metadata_json) THEN (
        json_type(metadata_json) = 'object'
        AND json_type(metadata_json, '$.inspection') = 'text'
        AND json_extract(metadata_json, '$.inspection')
          IN ('inspected', 'not_inspected', 'inspected_no_value', 'unknown')
      ) ELSE 0 END
    ),
  PRIMARY KEY (record_id, origin)
) STRICT, WITHOUT ROWID;

CREATE INDEX records_scope_type_id
  ON records(scope, type, id);

CREATE INDEX links_to_id
  ON links(to_id, relationship, from_id);

CREATE INDEX aliases_record_id
  ON aliases(record_id, alias);
`;

function normalizedSql(value) {
  return value.replace(/\s+/gu, " ").trim();
}

const SQLITE_STATISTICS_DEFINITIONS = Object.freeze({
  sqlite_stat1: Object.freeze({
    type: "table",
    sql: "CREATE TABLE sqlite_stat1(tbl,idx,stat)",
  }),
  sqlite_stat4: Object.freeze({
    type: "table",
    sql: "CREATE TABLE sqlite_stat4(tbl,idx,nEq,nLt,nDLt,sample)",
  }),
});

function isSqliteStatisticsTable({ type, name, tbl_name: table, sql }) {
  const expected = SQLITE_STATISTICS_DEFINITIONS[name];
  return expected !== undefined
    && type === expected.type
    && table === name
    && typeof sql === "string"
    && normalizedSql(sql) === expected.sql;
}

function expectedDefinitions() {
  const definitions = {};
  for (const statement of SCHEMA_SQL.split(";")) {
    const sql = statement.trim();
    if (!sql) continue;
    const match = /^CREATE\s+(TABLE|INDEX)\s+([a-z0-9_]+)/iu.exec(sql);
    if (!match) throw new Error("Lodestar schema contains an unknown statement.");
    definitions[match[2]] = Object.freeze({
      type: match[1].toLowerCase(),
      sql: normalizedSql(sql),
    });
  }
  return Object.freeze(definitions);
}

export const EXPECTED_SCHEMA_DEFINITIONS = expectedDefinitions();

export function inspectSchemaDefinitions(db) {
  const rows = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema "
      + "WHERE type IN ('table', 'index', 'trigger', 'view') "
      + "ORDER BY name",
  ).all().filter((row) => !isSqliteStatisticsTable(row));
  const actual = Object.fromEntries(rows.map(({ type, name, sql }) => [
    name,
    {
      type,
      sql: typeof sql === "string" ? normalizedSql(sql) : null,
    },
  ]));
  const expectedNames = Object.keys(EXPECTED_SCHEMA_DEFINITIONS).sort();
  const actualNames = Object.keys(actual).sort();
  const missing = expectedNames.filter((name) => !Object.hasOwn(actual, name));
  const unexpected = actualNames.filter(
    (name) => !Object.hasOwn(EXPECTED_SCHEMA_DEFINITIONS, name),
  );
  const mismatched = expectedNames.filter((name) => {
    if (!Object.hasOwn(actual, name)) return false;
    const expected = EXPECTED_SCHEMA_DEFINITIONS[name];
    return actual[name].type !== expected.type
      || actual[name].sql !== expected.sql;
  });
  return {
    matches:
      missing.length === 0
      && unexpected.length === 0
      && mismatched.length === 0,
    expected: expectedNames,
    actual: actualNames,
    missing,
    unexpected,
    mismatched,
  };
}

export function createSchema(db, { createdAt }) {
  db.exec(SCHEMA_SQL);
  const insert = db.prepare(
    "INSERT INTO metadata(key, value) VALUES (?, ?)",
  );
  insert.run("schema_version", String(SCHEMA_VERSION));
  insert.run("created_at", createdAt);
}
