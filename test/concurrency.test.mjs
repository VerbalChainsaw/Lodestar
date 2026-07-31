import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  initializeDatabase,
  openOrInitializeWriteDatabase,
  openReadDatabase,
} from "../src/database.mjs";
import { importV070 } from "../src/import-v070.mjs";
import { putRecord } from "../src/records.mjs";

const GENERATION = "a".repeat(64);
const FIXED_TIME = () => new Date("2026-07-30T12:00:00.000Z");
const CLI = fileURLToPath(new URL("../lodestar.mjs", import.meta.url));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lodestar-concurrency-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function createLegacyStore(directory) {
  const source = path.join(directory, "legacy");
  const generationRoot = path.join(source, "generations", GENERATION);
  await writeJson(path.join(source, "current.json"), {
    v: 1,
    generation: GENERATION,
  });
  await writeJson(path.join(generationRoot, "catalog.json"), {
    v: 1,
    projects: [],
  });
  await writeJson(path.join(generationRoot, "schema", "store.json"), {
    v: 1,
    record: "context-record",
  });
  await writeJson(
    path.join(generationRoot, "records", "global.jsonl"),
    {
      v: 1,
      id: "g:concurrency",
      kind: "memory",
      priority: 1,
      scope: ["global"],
      aliases: ["concurrency"],
      links: [],
      summary: "Concurrency fixture.",
    },
  );
  return source;
}

async function waitFor(file) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${file}`);
}

function pausedChild({
  t,
  operation,
  marker,
  release,
}) {
  const databaseModule =
    new URL("../src/database.mjs", import.meta.url).href;
  const importModule =
    new URL("../src/import-v070.mjs", import.meta.url).href;
  const recordsModule =
    new URL("../src/records.mjs", import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import {
      initializeDatabase,
      openOrInitializeWriteDatabase
    } from ${JSON.stringify(databaseModule)};
    import { importV070 } from ${JSON.stringify(importModule)};
    import { putRecord } from ${JSON.stringify(recordsModule)};
    const originalExec = DatabaseSync.prototype.exec;
    let paused = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (!paused && sql === "PRAGMA synchronous = FULL") {
        paused = true;
        writeFileSync(${JSON.stringify(marker)}, "ready");
        while (!existsSync(${JSON.stringify(release)})) {
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            25
          );
        }
      }
      return originalExec.call(this, sql);
    };
    try {
      const result = await (${operation});
      console.log(JSON.stringify({ status: "fulfilled", result }));
    } catch (error) {
      console.log(JSON.stringify({
        status: "rejected",
        code: error.code,
        identifiers: error.identifiers,
      }));
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
  `;
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      script,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve) => {
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
  return { completed };
}

async function childResult(completed) {
  const result = await completed;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function cliPutChild({ t, database, record }) {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      CLI,
      "put",
      "--db",
      database,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve) => {
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
  child.stdin.end(JSON.stringify(record));
  return completed;
}

test("a losing initializer cannot delete a concurrent winner", async (t) => {
  const directory = await temporaryDirectory(t);
  const database = path.join(directory, "lodestar.db");
  const marker = path.join(directory, "opened");
  const release = path.join(directory, "release");
  const child = pausedChild({
    t,
    marker,
    release,
    operation: `initializeDatabase(${JSON.stringify(database)}, {
      now: () => new Date("2026-07-30T12:00:00.000Z")
    })`,
  });
  await waitFor(marker);

  const winner = await initializeDatabase(database, {
    now: () => new Date("2026-07-30T12:00:01.000Z"),
  });
  await writeFile(release, "go");
  const loser = await childResult(child.completed);

  assert.equal(winner.created, true);
  assert.equal(loser.status, "fulfilled");
  assert.equal(loser.result.created, false);
  const db = await openReadDatabase(database);
  assert.equal(
    db.prepare("SELECT value FROM metadata WHERE key = 'created_at'").get()
      .value,
    "2026-07-30T12:00:01.000Z",
  );
  db.close();
});

test("concurrent first writers preserve both records", async (t) => {
  const directory = await temporaryDirectory(t);
  const database = path.join(directory, "lodestar.db");
  const marker = path.join(directory, "opened");
  const release = path.join(directory, "release");
  const childRecord = {
    id: "record:child",
    type: "note",
    name: "Child",
    scope: "global",
    content: { state: "known", value: "child" },
    aliases: [],
    links: [],
    sources: [],
  };
  const child = pausedChild({
    t,
    marker,
    release,
    operation: `(async () => {
      const db = await openOrInitializeWriteDatabase(
        ${JSON.stringify(database)}
      );
      try {
        return putRecord(db, ${JSON.stringify(childRecord)}, {
          database: ${JSON.stringify(database)}
        });
      } finally {
        db.close();
      }
    })()`,
  });
  await waitFor(marker);

  const winnerDb = await openOrInitializeWriteDatabase(database);
  putRecord(winnerDb, {
    ...childRecord,
    id: "record:winner",
    name: "Winner",
    content: { state: "known", value: "winner" },
  }, { database });
  winnerDb.close();
  await writeFile(release, "go");
  const loser = await childResult(child.completed);

  assert.equal(loser.status, "fulfilled");
  const db = await openReadDatabase(database);
  assert.deepEqual(
    db.prepare("SELECT id FROM records ORDER BY id").all()
      .map(({ id }) => id),
    ["record:child", "record:winner"],
  );
  db.close();
});

test("competing CLI processes survive first-write reservation races", async (t) => {
  const directory = await temporaryDirectory(t);
  for (let round = 0; round < 3; round += 1) {
    const database = path.join(directory, String(round), "lodestar.db");
    const records = Array.from({ length: 8 }, (_, writer) => ({
      id: `record:${round}:${writer}`,
      type: "note",
      name: `Writer ${writer}`,
      scope: "global",
      content: { state: "known", value: { round, writer } },
      aliases: [],
      links: [],
      sources: [],
    }));
    const results = await Promise.all(records.map((record) =>
      cliPutChild({ t, database, record })
    ));
    assert.deepEqual(
      results.map(({ status }) => status),
      records.map(() => 0),
      JSON.stringify(results.filter(({ status }) => status !== 0), null, 2),
    );

    const db = await openReadDatabase(database);
    assert.deepEqual(
      db.prepare("SELECT id FROM records ORDER BY id").all()
        .map(({ id }) => id),
      records.map(({ id }) => id).sort(),
    );
    db.close();
  }
});

test("a losing importer cannot delete a concurrent winner", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = await createLegacyStore(directory);
  const database = path.join(directory, "lodestar.db");
  const marker = path.join(directory, "opened");
  const release = path.join(directory, "release");
  const child = pausedChild({
    t,
    marker,
    release,
    operation: `importV070({
      sourcePath: ${JSON.stringify(source)},
      database: ${JSON.stringify(database)},
      now: () => new Date("2026-07-30T12:00:00.000Z")
    })`,
  });
  await waitFor(marker);

  const winner = await importV070({
    sourcePath: source,
    database,
    now: () => new Date("2026-07-30T12:00:01.000Z"),
  });
  await writeFile(release, "go");
  const loser = await childResult(child.completed);

  assert.equal(winner.destination.committed, true);
  assert.equal(loser.status, "rejected");
  const db = await openReadDatabase(database);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM records").get().count,
    1,
  );
  db.close();
});

test("import distinguishes definite and ambiguous commit failures", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = await createLegacyStore(directory);
  const definite = path.join(directory, "definite.db");
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function injectedPreCommitFailure(sql) {
    if (sql === "COMMIT") {
      const error = new Error("injected pre-commit failure");
      error.code = "SQLITE_IOERR";
      throw error;
    }
    return originalExec.call(this, sql);
  };
  try {
    await assert.rejects(
      importV070({ sourcePath: source, database: definite, now: FIXED_TIME }),
      ({ code, identifiers }) =>
        code === "database_error"
        && identifiers.database === definite,
    );
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.equal((await stat(definite)).size, 0);
  const resumed = await importV070({
    sourcePath: source,
    database: definite,
    now: FIXED_TIME,
  });
  assert.equal(resumed.destination.committed, true);

  const ambiguous = path.join(directory, "ambiguous.db");
  DatabaseSync.prototype.exec = function injectedPostCommitFailure(sql) {
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
      importV070({ sourcePath: source, database: ambiguous, now: FIXED_TIME }),
      ({ code, identifiers }) =>
        code === "import_commit_outcome_unknown"
        && identifiers.database === ambiguous
        && identifiers.committed === "unknown",
    );
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  const db = await openReadDatabase(ambiguous);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM records").get().count,
    1,
  );
  db.close();
});
