import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  runPerformanceBenchmark,
  timingStatistics,
} from "../lib/performance-benchmark.mjs";
import { run } from "../tools/benchmark-performance.mjs";

const execFileAsync = promisify(execFile);
const TEST_PROFILES = Object.freeze([
  Object.freeze({
    name: "test-small",
    runs: 1,
    projectCount: 10,
    documentCount: 8,
    documentBytes: 4 * 1024,
  }),
  Object.freeze({
    name: "test-scale",
    runs: 1,
    projectCount: 50,
    documentCount: 12,
    documentBytes: 4 * 1024,
  }),
]);

test("timing statistics use deterministic nearest-rank percentiles", () => {
  assert.deepEqual(timingStatistics([5, 1, 4, 2, 3]), {
    samples: 5,
    min_ms: 1,
    p50_ms: 3,
    p95_ms: 5,
    max_ms: 5,
    mean_ms: 3,
  });
});

test("performance suite reports scale and operation distributions", async () => {
  const report = await runPerformanceBenchmark({
    profiles: TEST_PROFILES,
    iterations: 5,
    warmups: 1,
  });

  assert.equal(report.passed, true);
  assert.equal(report.scale.length, 2);
  assert.equal(report.summary.scale_profiles_passed, 2);
  for (const { report: scaleReport } of report.scale) {
    assert.equal(scaleReport.passed, true);
  }
  for (const result of Object.values(report.operations.timings)) {
    assert.equal(result.samples, 5);
    assert.ok(result.p95_ms >= result.p50_ms);
    assert.ok(result.max_ms >= result.min_ms);
  }
  assert.match(
    report.operations.definitions.fresh_store_start,
    /OS caches left intact/,
  );
  assert.match(report.operations.memory.note, /not forced or gated/);
});

test("performance CLI emits JSON and rejects invalid counts", async () => {
  const stdout = [];
  const stderr = [];
  const code = await run([
    "--quick",
    "--json",
    "--iterations",
    "3",
    "--warmups",
    "1",
  ], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.equal(JSON.parse(stdout.join("")).passed, true);

  const failures = [];
  assert.equal(await run(["--iterations", "0"], {
    stdout: () => {},
    stderr: (value) => failures.push(value),
  }), 1);
  assert.equal(JSON.parse(failures.join("")).ok, false);
});

test("performance executable uses the cross-platform main entry", async () => {
  const executable = path.resolve("tools", "benchmark-performance.mjs");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    executable,
    "--quick",
    "--json",
    "--iterations",
    "3",
    "--warmups",
    "1",
  ]);

  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).passed, true);
});

test("performance CLI exposes conventional help without running profiles", async () => {
  const stdout = [];
  const stderr = [];
  const code = await run(["-h"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /^Usage: lodestar-performance/m);
  assert.match(stdout.join(""), /--iterations/);
});
