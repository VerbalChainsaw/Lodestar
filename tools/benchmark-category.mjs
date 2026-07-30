#!/usr/bin/env node

import path from "node:path";

import {
  buildCategoryPlan,
  executeCategoryPlan,
  loadCategoryConfig,
} from "../lib/category-harness.mjs";
import { errorResult, LodestarError } from "../lib/errors.mjs";
import { isMainModule } from "../lib/main-entry.mjs";

function value(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  const found = args[index + 1];
  if (!found || found.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return found;
}

function numeric(args, name, options = {}) {
  const raw = value(args, name, options);
  if (raw === null) return null;
  const found = Number(raw);
  if (!Number.isFinite(found)) throw new Error(`${name} must be a number`);
  return found;
}

function validateArgs(args) {
  const flags = new Set(["--execute", "--keep-workspaces", "--json"]);
  const valued = new Set([
    "--config",
    "--output",
    "--max-cost-usd",
    "--max-trials",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (flags.has(current)) continue;
    if (!valued.has(current)) throw new Error(`Unknown option: ${current}`);
    index += 1;
  }
}

function humanPlan(plan) {
  return [
    "Lodestar category benchmark plan",
    "=================================",
    `Fixture fingerprint: ${plan.fixtureFingerprint}`,
    `Enabled runners: ${plan.config.runners.filter(({ enabled }) => enabled).length}`,
    `Scenarios: ${plan.config.scenarios.join(", ")}`,
    `Repetitions: ${plan.config.repetitions}`,
    `Paired trials: ${plan.trialCount}`,
    `User-estimated maximum cost: $${plan.estimatedMaxCostUsd.toFixed(2)}`,
    "",
    "DRY RUN ONLY — no model process was started.",
    "Execution requires --execute, an absolute --output, and --max-cost-usd.",
    "",
  ].join("\n");
}

export async function run(args = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  try {
    validateArgs(args);
    const configFile = path.resolve(value(args, "--config", { required: true }));
    const config = await loadCategoryConfig(configFile);
    const plan = buildCategoryPlan(config);
    if (!args.includes("--execute")) {
      stdout(args.includes("--json")
        ? `${JSON.stringify(plan)}\n`
        : humanPlan(plan));
      return 0;
    }
    const outputInput = value(args, "--output", { required: true });
    if (!path.isAbsolute(outputInput)) {
      throw new Error("--output must be an absolute path");
    }
    const output = path.resolve(outputInput);
    const maxCostUsd = numeric(args, "--max-cost-usd", { required: true });
    const maxTrials = numeric(args, "--max-trials") ?? plan.trialCount;
    if (!Number.isInteger(maxTrials)) {
      throw new Error("--max-trials must be an integer");
    }
    const report = await executeCategoryPlan(plan, {
      output,
      maxCostUsd,
      maxTrials,
      keepWorkspaces: args.includes("--keep-workspaces"),
      onProgress: ({ current, total, trial }) => {
        if (!args.includes("--json")) {
          stderr(
            `[${current}/${total}] ${trial.runnerId} `
              + `${trial.scenarioId}/${trial.questionId}/${trial.condition}\n`,
          );
        }
      },
    });
    stdout(`${JSON.stringify(report)}\n`);
    return report.results.conditions.lodestar.failed === 0
      && report.results.conditions.unmanaged.failed === 0
      ? 0
      : 1;
  } catch (error) {
    const reported = error instanceof LodestarError
      ? error
      : new LodestarError(
        "category-cli-invalid",
        error instanceof Error ? error.message : "Invalid benchmark request",
      );
    stderr(`${JSON.stringify({
      ok: false,
      ...errorResult(reported),
    })}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run();
}
