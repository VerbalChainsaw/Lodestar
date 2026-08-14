#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { initializeDatabase, openConnection, transaction } from "../src/database.mjs";
import { writeRecordSnapshot } from "../src/records.mjs";
import { allocateRevision } from "../src/revisions.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const valueOption = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  assert(value, `--${name} requires a value`);
  return value;
};
const ENTRY = path.resolve(valueOption("entry", path.join(ROOT, "lodestar.mjs")));
const integerOption = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  assert(Number.isSafeInteger(value) && value > 0, `--${name} must be a positive integer`);
  return value;
};
const recordCount = integerOption("records", 1_200);
const samples = integerOption("samples", 15);

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const percentile = (values, fraction) => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
};
const summary = (values) => ({
  samples: values.length,
  p50_ms: Number(percentile(values, 0.50).toFixed(2)),
  p95_ms: Number(percentile(values, 0.95).toFixed(2)),
  min_ms: Number(Math.min(...values).toFixed(2)),
  max_ms: Number(Math.max(...values).toFixed(2)),
});

async function invoke(args, { cwd, database, input = "", exits = [0] }) {
  const started = performance.now();
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd,
    env: { ...process.env, LODESTAR_DB: database },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.end(input);
  });
  assert(exits.includes(exit), `${args.join(" ")} exited ${exit}: ${stderr || stdout}`);
  assert.equal(stderr, "", `${args.join(" ")} wrote to stderr`);
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.v, 1);
  assert.equal(envelope.ok, true);
  return { elapsed: performance.now() - started, envelope };
}

async function measure(args, options) {
  const cold = (await invoke(args, options)).elapsed;
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    values.push((await invoke(args, options)).elapsed);
  }
  return { cold_ms: Number(cold.toFixed(2)), warm_process: summary(values) };
}

function seed(database, projectDirectory) {
  const db = openConnection(database), now = "2026-08-13T12:00:00.000Z";
  const record = (index) => index === 0 ? {
    id: "project:benchmark", type: "project", name: "Benchmark", scope: "global",
    content: { state: "known", value: { roots: [projectDirectory] } },
    aliases: ["benchmark project"], links: [], sources: [],
  } : {
    id: `benchmark:${String(index).padStart(4, "0")}`, type: "note",
    name: `Benchmark needle record ${index}`, scope: "project:benchmark",
    content: { state: "known", value: {
      required: false, text: `needle-${index} ${"x".repeat(2_500)}`,
    } },
    aliases: [`benchmark alias ${index}`], links: [], sources: [],
  };
  transaction(db, () => {
    for (let index = 0; index < recordCount; index += 1) {
      writeRecordSnapshot(db, record(index), { createdAt: now, updatedAt: now,
        revision: allocateRevision(db), enforceRecordLimit: false });
    }
  }, database);
  db.close();
}

const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-benchmark-"));
try {
  const database = path.join(directory, "lodestar.db");
  const projectDirectory = path.join(directory, "project");
  await mkdir(projectDirectory);
  await initializeDatabase(database, { now: () => new Date("2026-08-13T12:00:00.000Z") });
  seed(database, projectDirectory);
  const beforeReads = await digest(database);
  const options = { cwd: projectDirectory, database };
  const identity = ["--cwd", projectDirectory, "--session", "benchmark-session",
    "--agent", "benchmark", "--harness", "benchmark"];
  const timings = {
    version: await measure(["--version"], options),
    get_exact: await measure(["get", "benchmark:0600"], options),
    find_50_full_scan: await measure(["find", "needle", "--limit", "50"], options),
    startup_no_handoff: await measure(["start", ...identity], options),
    doctor: await measure(["doctor"], options),
    work_status: await measure(["work", "status", "--cwd", projectDirectory], options),
    handoff_status: await measure(["handoff", "status", "--cwd", projectDirectory], options),
  };
  assert.equal(await digest(database), beforeReads,
    "read/startup benchmark operations changed the database bytes");
  const sidecars = (await readdir(directory)).filter((name) =>
    /^lodestar\.db-(?:journal|shm|wal)$/u.test(name));
  assert.deepEqual(sidecars, [], "read/startup benchmark left a SQLite sidecar");

  const burst = Array.from({ length: 16 }, (_, index) => {
    const id = `benchmark:burst:${index}`;
    const value = { id, type: "note", name: id, scope: "project:benchmark",
      content: { state: "known", value: { index } }, aliases: [], links: [], sources: [] };
    return invoke(["put"], { ...options, input: JSON.stringify(value) });
  });
  const burstStarted = performance.now(), results = await Promise.all(burst);
  const burstElapsed = performance.now() - burstStarted;
  assert.equal(new Set(results.map(({ envelope }) => envelope.data.id)).size, burst.length);
  const finalDoctor = await invoke(["doctor"], options);
  assert.equal(finalDoctor.envelope.data.counts.records, recordCount + burst.length);

  process.stdout.write(`${JSON.stringify({
    node: process.version,
    records: recordCount,
    database_bytes: (await readFile(database)).byteLength,
    cold_process_timings: timings,
    concurrent_unique_puts: {
      writers: burst.length,
      wall_ms: Number(burstElapsed.toFixed(2)),
      writes_per_second: Number((burst.length * 1_000 / burstElapsed).toFixed(2)),
    },
    guarantees: { read_bytes_unchanged: true, read_sidecars_absent: true,
      concurrent_writes_preserved: true },
  }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
