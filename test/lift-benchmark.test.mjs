import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runLiftBenchmark } from "../lib/lift-benchmark.mjs";
import { run } from "../tools/benchmark-lift.mjs";

const execFileAsync = promisify(execFile);
const FAST_FIXTURE = Object.freeze({
  runs: 2,
  projectCount: 100,
  documentCount: 16,
  documentBytes: 2 * 1024,
});

test("paired benchmark proves scoped retrieval lift against a broad control", async () => {
  const report = await runLiftBenchmark(FAST_FIXTURE);
  const without = report.results.without_lodestar;
  const withLodestar = report.results.with_lodestar;

  assert.equal(report.passed, true);
  assert.deepEqual(report.gates, {
    answer_parity: true,
    deterministic_lodestar: true,
    fewer_files_inspected: true,
    fewer_bytes_inspected: true,
    no_broad_search: true,
    no_cross_project_records: true,
    startup_payload_within_budget: true,
  });
  assert.equal(without.accuracy.ratio, 1);
  assert.equal(withLodestar.accuracy.ratio, 1);
  assert.ok(withLodestar.files_inspected < without.files_inspected);
  assert.ok(withLodestar.bytes_inspected < without.bytes_inspected);
  assert.equal(withLodestar.unrelated_records.length, 0);
  assert.ok(
    withLodestar.startup_bytes <= withLodestar.startup_budget_bytes,
  );
  assert.equal(
    report.value_observations.inspected_bytes_avoided,
    without.bytes_inspected - withLodestar.bytes_inspected,
  );
  assert.match(report.value_observations.note, /no token, dollar/);
  assert.equal(without.broad_search_used, true);
  assert.equal(withLodestar.broad_search_used, false);
});

test("benchmark CLI emits a machine-readable report", async () => {
  const stdout = [];
  const stderr = [];
  const code = await run([
    "--json",
    "--runs",
    "1",
    "--projects",
    "10",
    "--documents",
    "8",
    "--document-bytes",
    "1024",
  ], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  const report = JSON.parse(stdout.join(""));
  assert.equal(report.benchmark, "lodestar-paired-retrieval-lift");
  assert.equal(report.fixture.projects, 10);
  assert.equal(report.passed, true);
});

test("benchmark executable runs through the cross-platform main entry", async () => {
  const executable = path.resolve("tools", "benchmark-lift.mjs");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    executable,
    "--json",
    "--runs",
    "1",
    "--projects",
    "10",
    "--documents",
    "8",
    "--document-bytes",
    "1024",
  ]);

  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.passed, true);
});

test("benchmark CLI rejects malformed options without throwing", async () => {
  const stdout = [];
  const stderr = [];
  const code = await run(["--runs", "many"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });

  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.equal(JSON.parse(stderr.join("")).ok, false);
});

test("benchmark CLI exposes conventional help without running a fixture", async () => {
  const stdout = [];
  const stderr = [];
  const code = await run(["--help"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /^Usage: lodestar-benchmark/m);
  assert.match(stdout.join(""), /--document-bytes/);
});
