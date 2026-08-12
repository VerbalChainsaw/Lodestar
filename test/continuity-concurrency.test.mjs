import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeDatabase,
  openReadDatabase,
} from "../src/database.mjs";

function child(database, session) {
  const databaseModule = new URL("../src/database.mjs", import.meta.url).href;
  const continuityModule = new URL("../src/continuity.mjs", import.meta.url).href;
  const source = `
    import { openWriteDatabase } from ${JSON.stringify(databaseModule)};
    import {
      executeContinuityOperation,
      prepareContinuityRequest
    } from ${JSON.stringify(continuityModule)};
    const db = await openWriteDatabase(${JSON.stringify(database)});
    try {
      const operation = "continuity_arm";
      const input = prepareContinuityRequest(operation, {
        project_key: "project:shared",
        session_id: ${JSON.stringify(session)},
        turn_id: "turn:arm",
        packet_json: { state: "armed" }
      });
      console.log(JSON.stringify(executeContinuityOperation(
        db,
        operation,
        input,
        { database: ${JSON.stringify(database)} }
      )));
    } finally { db.close(); }
  `;
  const childProcess = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--input-type=module",
    "--eval",
    source,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  childProcess.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => childProcess.on("close", (status) =>
    resolve({ status, stdout, stderr })
  ));
}

test("concurrent independent lanes in one project both commit", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lodestar-continuity-concurrency-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "lodestar.db");
  await initializeDatabase(database);
  const results = await Promise.all([
    child(database, "session:first"),
    child(database, "session:second"),
  ]);
  assert.deepEqual(results.map(({ status }) => status), [0, 0], results);
  const db = await openReadDatabase(database);
  assert.deepEqual(
    db.prepare(
      "SELECT owner_session_id FROM continuity_lanes ORDER BY owner_session_id",
    ).all().map(({ owner_session_id: owner }) => owner),
    ["session:first", "session:second"],
  );
  db.close();
});
