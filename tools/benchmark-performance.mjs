#!/usr/bin/env node

import { isMainModule } from "../lib/main-entry.mjs";
import {
  PERFORMANCE_BENCHMARK_PROFILES,
  runPerformanceBenchmark,
} from "../lib/performance-benchmark.mjs";

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function formatBytes(value) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (Math.abs(amount) >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function scaleRow(name, report) {
  return [
    name.padEnd(14),
    String(report.fixture.projects).padStart(10),
    String(report.fixture.repository_documents).padStart(10),
    `${report.results.without_lodestar.elapsed_ms.toFixed(3)} ms`.padStart(16),
    `${report.results.with_lodestar.elapsed_ms.toFixed(3)} ms`.padStart(16),
    `${report.lift.inspected_byte_reduction_percent.toFixed(1)}%`.padStart(14),
  ].join("");
}

function operationRow(name, result) {
  return [
    name.padEnd(24),
    `${result.p50_ms.toFixed(3)} ms`.padStart(14),
    `${result.p95_ms.toFixed(3)} ms`.padStart(14),
    `${result.min_ms.toFixed(3)} ms`.padStart(14),
    `${result.max_ms.toFixed(3)} ms`.padStart(14),
  ].join("");
}

export function humanPerformanceReport(report) {
  const lines = [
    "Lodestar performance suite",
    "===========================",
    `Environment: ${report.environment.platform}/${report.environment.arch}, `
      + `${report.environment.cpus} CPUs, ${report.environment.node}`,
    "",
    "Scale curve",
    [
      "Profile".padEnd(14),
      "Projects".padStart(10),
      "Docs".padStart(10),
      "Broad p50".padStart(16),
      "Lodestar p50".padStart(16),
      "Bytes saved".padStart(14),
    ].join(""),
    ...report.scale.map(({ name, report: scaleReport }) =>
      scaleRow(name, scaleReport)),
    "",
    "Operation latency (warm OS cache)",
    [
      "Operation".padEnd(24),
      "p50".padStart(14),
      "p95".padStart(14),
      "min".padStart(14),
      "max".padStart(14),
    ].join(""),
    ...Object.entries(report.operations.timings).map(([name, result]) =>
      operationRow(name, result)),
    "",
    `Observed RSS change: ${
      formatBytes(report.operations.memory.rss_delta_bytes)
    }`,
    `Profiles passed: ${report.summary.scale_profiles_passed}/${
      report.summary.scale_profiles_total
    }`,
    `Total suite time: ${report.summary.elapsed_ms.toFixed(1)} ms`,
    `Verdict: ${report.passed ? "PASS" : "FAIL"}`,
    "Timing and memory are observations, not cross-machine release gates.",
    "Methodology: docs/performance.md",
  ];
  return `${lines.join("\n")}\n`;
}

export async function run(args = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    const allowed = new Set([
      "--json",
      "--quick",
      "--iterations",
      "--warmups",
    ]);
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (!argument.startsWith("--") || !allowed.has(argument)) {
        throw new Error(`Unknown option: ${argument}`);
      }
      if (!["--json", "--quick"].includes(argument)) index += 1;
    }
    const report = await runPerformanceBenchmark({
      profiles: args.includes("--quick")
        ? PERFORMANCE_BENCHMARK_PROFILES.quick
        : PERFORMANCE_BENCHMARK_PROFILES.default,
      iterations: optionValue(args, "--iterations", 75),
      warmups: optionValue(args, "--warmups", 10),
    });
    stdout(args.includes("--json")
      ? `${JSON.stringify(report)}\n`
      : humanPerformanceReport(report));
    return report.passed ? 0 : 1;
  } catch (error) {
    stderr(`${JSON.stringify({
      ok: false,
      code: error.code ?? "invalid-performance-options",
      message: error.message,
      detail: error.detail ?? {},
      cause: error.cause?.message,
    })}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run();
}
