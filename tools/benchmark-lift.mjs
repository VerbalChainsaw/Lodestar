#!/usr/bin/env node

import {
  LIFT_BENCHMARK_DEFAULTS,
  runLiftBenchmark,
} from "../lib/lift-benchmark.mjs";
import { isMainModule } from "../lib/main-entry.mjs";

export function liftHelpText() {
  return [
    "Usage: lodestar-benchmark [options]",
    "",
    "Run the deterministic paired retrieval benchmark.",
    "",
    "Options:",
    "  --runs <count>             Warm samples (default: 7)",
    "  --projects <count>         Catalog projects (default: 100)",
    "  --documents <count>        Repository documents (default: 64)",
    "  --document-bytes <count>   Target bytes per document (default: 16384)",
    "  --json                     Emit machine-readable JSON",
    "  -h, --help                 Show this help",
    "",
  ].join("\n");
}

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
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatPercent(value) {
  if (value === null) return "n/a";
  const sign = value >= 0 ? "-" : "+";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function row(label, without, withLodestar, change) {
  return [
    label.padEnd(24),
    String(without).padStart(16),
    String(withLodestar).padStart(16),
    String(change).padStart(12),
  ].join("");
}

export function humanReport(report) {
  const without = report.results.without_lodestar;
  const withLodestar = report.results.with_lodestar;
  const lines = [
    "Lodestar paired retrieval benchmark",
    "===================================",
    `Fixture: ${report.fixture.projects} projects, `
      + `${report.fixture.repository_documents} repository documents, `
      + `${report.fixture.questions} questions, `
      + `${report.fixture.warm_runs} warm runs`,
    "",
    row("Metric", "Without Lodestar", "With Lodestar", "Change"),
    row(
      "Correct answers",
      `${without.accuracy.correct}/${without.accuracy.total}`,
      `${withLodestar.accuracy.correct}/${withLodestar.accuracy.total}`,
      "parity",
    ),
    row(
      "Files inspected",
      without.files_inspected,
      withLodestar.files_inspected,
      formatPercent(report.lift.file_reduction_percent),
    ),
    row(
      "Bytes inspected",
      formatBytes(without.bytes_inspected),
      formatBytes(withLodestar.bytes_inspected),
      formatPercent(report.lift.inspected_byte_reduction_percent),
    ),
    row(
      "Evidence returned",
      formatBytes(without.evidence_bytes),
      formatBytes(withLodestar.evidence_bytes),
      formatPercent(report.lift.evidence_byte_reduction_percent),
    ),
    row(
      "Median local time",
      `${without.elapsed_ms.toFixed(3)} ms`,
      `${withLodestar.elapsed_ms.toFixed(3)} ms`,
      formatPercent(report.lift.median_time_reduction_percent),
    ),
    row(
      "Broad search used",
      without.broad_search_used ? "yes" : "no",
      withLodestar.broad_search_used ? "yes" : "no",
      "",
    ),
    row(
      "Cross-project records",
      "not applicable",
      withLodestar.unrelated_records.length,
      "",
    ),
    "",
    `Verdict: ${report.passed ? "PASS" : "FAIL"}`,
    "Scope: deterministic retrieval efficiency, not language-model quality.",
    "Methodology: docs/evaluation.md",
  ];
  return `${lines.join("\n")}\n`;
}

export async function run(args = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      stdout(liftHelpText());
      return 0;
    }
    const allowed = new Set([
      "--json",
      "--runs",
      "--projects",
      "--documents",
      "--document-bytes",
    ]);
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (!argument.startsWith("--") || !allowed.has(argument)) {
        throw new Error(`Unknown option: ${argument}`);
      }
      if (argument !== "--json") index += 1;
    }
    const report = await runLiftBenchmark({
      runs: optionValue(args, "--runs", LIFT_BENCHMARK_DEFAULTS.runs),
      projectCount: optionValue(
        args,
        "--projects",
        LIFT_BENCHMARK_DEFAULTS.projectCount,
      ),
      documentCount: optionValue(
        args,
        "--documents",
        LIFT_BENCHMARK_DEFAULTS.documentCount,
      ),
      documentBytes: optionValue(
        args,
        "--document-bytes",
        LIFT_BENCHMARK_DEFAULTS.documentBytes,
      ),
    });
    stdout(args.includes("--json")
      ? `${JSON.stringify(report)}\n`
      : humanReport(report));
    return report.passed ? 0 : 1;
  } catch (error) {
    stderr(`${JSON.stringify({
      ok: false,
      code: error.code ?? "invalid-benchmark-options",
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
