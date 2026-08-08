import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  initializeDatabase,
  openConnection,
  beginImmediate,
  commit,
  openReadDatabase,
  openWriteDatabase,
  transaction,
} from "../src/database.mjs";
import { defaultDatabasePath, resolveDatabasePath } from "../src/paths.mjs";

async function temporaryDirectory(t) {
  const directory = await import("node:fs/promises")
    .then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "lodestar-lite-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

test("initializes exactly the five-table schema and is read-only when repeated", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "state", "lodestar.db");
  const now = () => new Date("2026-07-30T10:00:00.000Z");

  const first = await initializeDatabase(file, { now });
  assert.equal(first.created, true);
  const before = {
    digest: await digest(file),
    entries: await readdir(path.dirname(file)),
  };

  const second = await initializeDatabase(file, { now });
  assert.equal(second.created, false);
  assert.deepEqual(
    {
      digest: await digest(file),
      entries: await readdir(path.dirname(file)),
    },
    before,
  );

  const db = await openReadDatabase(file);
  assert.deepEqual(
    db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).all()
      .map(({ name }) => name)
      .filter((name) => !name.toLowerCase().startsWith("sqlite_")),
    ["aliases", "links", "metadata", "records", "sources"],
  );
  assert.deepEqual(
    Object.fromEntries(
      db.prepare("SELECT key, value FROM metadata ORDER BY key").all()
        .map(({ key, value }) => [key, value]),
    ),
    {
      created_at: "2026-07-30T10:00:00.000Z",
      schema_version: "1",
    },
  );
  db.close();
});

test("schema validation rejects names that only resemble SQLite internals", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const raw = new DatabaseSync(file);
  raw.exec(
    "CREATE TRIGGER sqlitehidden AFTER UPDATE ON records "
      + "BEGIN SELECT 1; END",
  );
  raw.close();

  await assert.rejects(
    openReadDatabase(file),
    ({ code, identifiers }) =>
      code === "invalid_database"
      && identifiers.unexpected.includes("sqlitehidden"),
  );
});

test("schema validation rejects forged reserved-prefix objects", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const raw = openConnection(file);
  raw.exec(
    "CREATE TRIGGER schema_probe AFTER UPDATE ON records "
      + "BEGIN SELECT 1; END",
  );
  raw.exec(
    "PRAGMA writable_schema = ON; "
      + "UPDATE sqlite_schema SET name = 'sqlite_hidden', "
      + "sql = replace(sql, 'schema_probe', 'sqlite_hidden') "
      + "WHERE type = 'trigger' AND name = 'schema_probe'; "
      + "PRAGMA writable_schema = OFF",
  );
  raw.close();

  for (const openDatabase of [openReadDatabase, openWriteDatabase]) {
    await assert.rejects(
      openDatabase(file),
      ({ code, identifiers }) =>
        code === "invalid_database"
        && identifiers.unexpected.includes("sqlite_hidden"),
    );
  }
});

test("schema validation permits SQLite's inert statistics table", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const raw = new DatabaseSync(file);
  raw.exec("ANALYZE");
  raw.close();

  const db = await openReadDatabase(file);
  assert.equal(
    db.prepare(
      "SELECT type FROM sqlite_schema WHERE name = 'sqlite_stat1'",
    ).get().type,
    "table",
  );
  db.close();
});

test("a failed transaction leaves no partial records", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const db = openConnection(file);
  assert.throws(() => transaction(db, () => {
    db.prepare(
      "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "record:partial",
      "note",
      "Partial",
      "global",
      '{"state":"known","value":1}',
      "2026-07-30T10:00:00.000Z",
      "2026-07-30T10:00:00.000Z",
    );
    throw new Error("injected failure");
  }));
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM records").get().count,
    0,
  );
  db.close();
});

test("commit ambiguity is explicit and preserves a possibly committed init", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function injectedCommitFailure(sql) {
    const result = originalExec.call(this, sql);
    if (sql === "COMMIT") {
      const error = new Error("injected post-commit failure");
      error.code = "SQLITE_IOERR";
      throw error;
    }
    return result;
  };
  try {
    await assert.rejects(
      initializeDatabase(file),
      ({ code, identifiers }) =>
        code === "database_commit_outcome_unknown"
        && identifiers.committed === "unknown"
        && identifiers.database === file,
    );
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }

  const db = await openReadDatabase(file);
  assert.equal(
    db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get().value,
    "1",
  );
  db.close();
});

test("definite init commit failure preserves a resumable reservation", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function injectedCommitFailure(sql) {
    if (sql === "COMMIT") {
      const error = new Error("injected pre-commit failure");
      error.code = "SQLITE_IOERR";
      throw error;
    }
    return originalExec.call(this, sql);
  };
  try {
    await assert.rejects(
      initializeDatabase(file),
      ({ code, identifiers }) =>
        code === "database_error"
        && identifiers.database === file,
    );
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.equal((await stat(file)).size, 0);
  const resumed = await initializeDatabase(file);
  assert.equal(resumed.created, true);
  const db = await openReadDatabase(file);
  assert.equal(
    db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get().value,
    "1",
  );
  db.close();
});

test("SQLite rolls back an interrupted uncommitted transaction", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const databaseModule = new URL("../src/database.mjs", import.meta.url).href;
  const script = [
    `import { openConnection } from ${JSON.stringify(databaseModule)};`,
    `const db = openConnection(${JSON.stringify(file)});`,
    "db.exec('BEGIN IMMEDIATE');",
    "db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)').run(",
    "'record:interrupted','note','Interrupted','global',",
    "'{\"state\":\"known\",\"value\":true}',",
    "'2026-07-30T10:00:00.000Z','2026-07-30T10:00:00.000Z');",
    "process.exit(0);",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      script,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);

  const db = await openReadDatabase(file);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM records").get().count,
    0,
  );
  db.close();
});

test("rejects non-Lodestar files without replacing them", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "not-a-database");
  await writeFile(file, "keep me", "utf8");
  await assert.rejects(
    initializeDatabase(file),
    ({ code }) => code === "database_integrity",
  );
  assert.equal(await readFile(file, "utf8"), "keep me");
});

test("initialization resumes an interrupted zero-byte reservation", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "reserved.db");
  await writeFile(file, "");
  const result = await initializeDatabase(file, {
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  assert.equal(result.created, true);
  const db = await openReadDatabase(file);
  assert.equal(
    db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get().value,
    "1",
  );
  db.close();
});

test("writer validation does not alter an unrelated SQLite database", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "foreign.db");
  const foreign = new DatabaseSync(file);
  foreign.exec("PRAGMA journal_mode = WAL");
  foreign.exec("CREATE TABLE foreign_data(value TEXT)");
  foreign.close();
  const before = {
    digest: await digest(file),
    entries: (await readdir(directory)).sort(),
  };

  await assert.rejects(
    openWriteDatabase(file),
    ({ code }) => code === "invalid_database",
  );
  assert.deepEqual({
    digest: await digest(file),
    entries: (await readdir(directory)).sort(),
  }, before);

  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  check.close();
});

test("schema constraints enforce byte bounds and exact timestamps", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const db = openConnection(file);
  const insert = db.prepare(
    "INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  assert.throws(() => insert.run(
    "😀".repeat(256),
    "note",
    "Too many bytes",
    "global",
    '{"state":"known"}',
    "2026-07-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
  ));
  assert.throws(() => insert.run(
    "record:bad-time",
    "note",
    "Bad time",
    "global",
    '{"state":"known"}',
    "2026-02-30T10:00:00.000Z",
    "2026-07-30T10:00:00.000Z",
  ));
  db.close();
});

test("concurrent initialization never overwrites another creator", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "state", "lodestar.db");
  const attempts = await Promise.allSettled([
    initializeDatabase(file),
    initializeDatabase(file),
  ]);
  assert.ok(attempts.some(({ status }) => status === "fulfilled"));
  for (const attempt of attempts.filter(({ status }) => status === "rejected")) {
    assert.ok(
      ["database_conflict", "invalid_database"].includes(attempt.reason.code),
      attempt.reason,
    );
  }
  const db = await openReadDatabase(file);
  assert.equal(
    db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get().value,
    "1",
  );
  db.close();
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o077, 0);
  }
});

test("resolves platform data paths without touching the filesystem", () => {
  assert.equal(
    defaultDatabasePath({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Data" },
      home: "C:\\Users\\demo",
      pathApi: path.win32,
    }),
    "C:\\Data\\Lodestar\\lodestar.db",
  );
  assert.equal(
    defaultDatabasePath({
      platform: "darwin",
      env: {},
      home: "/Users/demo",
      pathApi: path.posix,
    }),
    "/Users/demo/Library/Application Support/Lodestar/lodestar.db",
  );
  assert.equal(
    defaultDatabasePath({
      platform: "linux",
      env: { XDG_DATA_HOME: "/data" },
      home: "/home/demo",
      pathApi: path.posix,
    }),
    "/data/lodestar/lodestar.db",
  );
  assert.equal(
    resolveDatabasePath({
      explicit: "./custom.db",
      cwd: "/workspace",
      pathApi: path.posix,
    }),
    "/workspace/custom.db",
  );
  assert.throws(
    () => resolveDatabasePath({
      explicit: "",
      env: {},
      cwd: "/workspace",
      pathApi: path.posix,
    }),
    ({ code }) => code === "invalid_path",
  );
  assert.throws(
    () => resolveDatabasePath({
      env: { LODESTAR_DB: "" },
      cwd: "/workspace",
      pathApi: path.posix,
    }),
    ({ code }) => code === "invalid_path",
  );
});
