import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  initializeDatabase,
  openWriteDatabase,
  openReadDatabase,
} from "../src/database.mjs";
import { fixture } from "./helpers/contract.mjs";

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
  const recordsModule =
    new URL("../src/records.mjs", import.meta.url).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import {
      initializeDatabase,
      openWriteDatabase
    } from ${JSON.stringify(databaseModule)};
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

function boundedOutcomeDiagnostics(outcomes) {
  const bounded = (value) => value.length > 2_048
    ? `${value.slice(0, 2_048)}...[truncated]`
    : value;
  return JSON.stringify(outcomes.map(({ status, stdout, stderr }) => ({
    status,
    stdout: bounded(stdout),
    stderr: bounded(stderr),
  })));
}

function parseChildEnvelope(text, diagnostics) {
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`Child output was not a JSON envelope: ${diagnostics}`);
  }
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


test('competing processes either commit the same request once or return retryable busy without partial effects', async (t) => {
  const f = await fixture(t);
  const request = await f.request({ mode: 'create', record: { id: 'fact:race', kind: 'fact', name: 'Race', scope: 'global',
    data: { value: 'once' }, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id: 'fact:race' }]);
  const outcomes = await Promise.all([cliPutChild({ t, database: f.database, record: request }), cliPutChild({ t, database: f.database, record: request })]);
  const diagnostics = boundedOutcomeDiagnostics(outcomes);
  const accepted = [];
  for (const outcome of outcomes) {
    if (outcome.status === 0) {
      assert.equal(outcome.stderr, '', diagnostics);
      const envelope = parseChildEnvelope(outcome.stdout, diagnostics);
      assert.equal(envelope.ok, true, diagnostics);
      assert.equal(envelope.request.id, request.request_id, diagnostics);
      assert.equal(typeof envelope.request.replayed, 'boolean', diagnostics);
      accepted.push(envelope);
    } else {
      assert.equal(outcome.status, 5, diagnostics);
      assert.equal(outcome.stdout, '', diagnostics);
      const envelope = parseChildEnvelope(outcome.stderr, diagnostics);
      assert.equal(envelope.ok, false, diagnostics);
      assert.equal(envelope.error.code, 'database_busy', diagnostics);
    }
  }
  const initialCommits = accepted.filter(({ request: result }) => result.replayed === false);
  assert.equal(initialCommits.length, accepted.length > 0 ? 1 : 0, diagnostics);
  const initiallyCommitted = initialCommits.length === 1;

  const retry = await f.cli(['put'], request);
  assert.equal(retry.code, 0, JSON.stringify(retry.value));
  assert.equal(retry.value.ok, true, JSON.stringify(retry.value));
  assert.equal(retry.value.request.id, request.request_id, JSON.stringify(retry.value));
  assert.equal(retry.value.request.replayed, initiallyCommitted, JSON.stringify(retry.value));
  for (const envelope of accepted) {
    assert.equal(envelope.receipt_id, retry.value.receipt_id, diagnostics);
    assert.equal(envelope.revision, retry.value.revision, diagnostics);
  }

  const replay = await f.cli(['put'], request);
  assert.equal(replay.code, 0, JSON.stringify(replay.value));
  assert.equal(replay.value.ok, true, JSON.stringify(replay.value));
  assert.equal(replay.value.request.id, request.request_id, JSON.stringify(replay.value));
  assert.equal(replay.value.request.replayed, true, JSON.stringify(replay.value));
  assert.equal(replay.value.receipt_id, retry.value.receipt_id);
  assert.equal(replay.value.revision, retry.value.revision);

  const db = await openReadDatabase(f.database);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE id='fact:race' AND type='fact'").get().n, 1);
    const receipts = db.prepare("SELECT id, content_json FROM records WHERE type='mutation-receipt'").all();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].id, retry.value.receipt_id);
    const receipt = JSON.parse(receipts[0].content_json).value;
    assert.equal(receipt.request_id, request.request_id);
    assert.equal(receipt.committed_revision, 1);
    assert.deepEqual(receipt.changed_ids, ['fact:race']);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value, '1');
  } finally { db.close(); }
});

test('busy refusal leaves the request reusable and the lock holder untouched', async (t) => {
  const f = await fixture(t);
  const request = await f.request({ mode: 'create', record: { id: 'fact:busy', kind: 'fact', name: 'Busy', scope: 'global',
    data: {}, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id: 'fact:busy' }]);
  const holder = new DatabaseSync(f.database);
  try {
    holder.exec('BEGIN IMMEDIATE');
    const refused = await cliPutChild({ t, database: f.database, record: request });
    assert.notEqual(refused.status, 0);
    assert.equal(JSON.parse(refused.stderr).error.code, 'database_busy');
    assert.equal(holder.isTransaction, true);
    assert.equal(holder.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
    holder.exec('ROLLBACK');
  } finally { if (holder.isTransaction) holder.exec('ROLLBACK'); holder.close(); }
  assert.equal((await f.cli(['put'], request)).code, 0);
});
