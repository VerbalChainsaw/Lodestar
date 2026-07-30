import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalStringify } from "./canonical-json.mjs";
import {
  buildCategoryTrialFixture,
  CATEGORY_QUESTIONS,
  CATEGORY_SCENARIOS,
  categoryFixtureFingerprint,
  scenarioById,
} from "./category-fixture.mjs";
import {
  scoreCategoryTrial,
  summarizeCategoryTrials,
} from "./category-score.mjs";
import { LodestarError, wrapError } from "./errors.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONDITIONS = Object.freeze(["unmanaged", "lodestar"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

function harnessError(code, message, detail = {}, cause) {
  return new LodestarError(code, message, { cause, detail });
}

function integer(name, value, { minimum = 1, maximum = 100 } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw harnessError("category-config-invalid", `Invalid ${name}`, {
      field: name,
      value,
      minimum,
      maximum,
    });
  }
  return value;
}

function number(name, value, { minimum = 0, maximum = 1_000_000 } = {}) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw harnessError("category-config-invalid", `Invalid ${name}`, {
      field: name,
      value,
      minimum,
      maximum,
    });
  }
  return value;
}

function stringArray(name, values, allowed) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.some((value) => typeof value !== "string")
  ) {
    throw harnessError("category-config-invalid", `Invalid ${name}`, {
      field: name,
      value: values,
    });
  }
  const unique = [...new Set(values)];
  const unexpected = unique.filter((value) => !allowed.includes(value));
  if (unexpected.length > 0) {
    throw harnessError(
      "category-config-invalid",
      `Unknown values in ${name}`,
      { field: name, unexpected, allowed },
    );
  }
  return unique;
}

function validateRunner(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw harnessError("category-config-invalid", "Runner must be an object", {
      index,
    });
  }
  if (
    typeof raw.id !== "string"
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(raw.id)
  ) {
    throw harnessError("category-config-invalid", "Runner id is invalid", {
      index,
      id: raw.id ?? null,
    });
  }
  if (
    !Array.isArray(raw.command)
    || raw.command.length === 0
    || raw.command.some((entry) =>
      typeof entry !== "string" || entry.length === 0)
  ) {
    throw harnessError(
      "category-config-invalid",
      "Runner command must be a non-empty string array",
      { runner: raw.id },
    );
  }
  return {
    id: raw.id,
    command: [...raw.command],
    enabled: raw.enabled !== false,
    estimatedCostUsdPerTrial: number(
      `runners[${index}].estimated_cost_usd_per_trial`,
      raw.estimated_cost_usd_per_trial ?? raw.estimatedCostUsdPerTrial,
      { minimum: 0.000001, maximum: 10_000 },
    ),
    metadata:
      raw.metadata && typeof raw.metadata === "object"
        ? structuredClone(raw.metadata)
        : {},
  };
}

export function validateCategoryConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1) {
    throw harnessError(
      "category-config-invalid",
      "Category benchmark config must be a v1 object",
    );
  }
  const scenarioIds = CATEGORY_SCENARIOS.map(({ id }) => id);
  const scenarios = stringArray(
    "scenarios",
    raw.scenarios ?? scenarioIds,
    scenarioIds,
  );
  const conditions = stringArray(
    "conditions",
    raw.conditions ?? CONDITIONS,
    CONDITIONS,
  );
  if (!conditions.includes("unmanaged") || !conditions.includes("lodestar")) {
    throw harnessError(
      "category-config-invalid",
      "Paired benchmark config must include both conditions",
      { conditions },
    );
  }
  if (!Array.isArray(raw.runners) || raw.runners.length === 0) {
    throw harnessError(
      "category-config-invalid",
      "At least one runner is required",
    );
  }
  const runners = raw.runners.map(validateRunner);
  const duplicate = runners.find((runner, index) =>
    runners.findIndex(({ id }) => id === runner.id) !== index);
  if (duplicate) {
    throw harnessError("category-config-invalid", "Duplicate runner id", {
      id: duplicate.id,
    });
  }
  if (!runners.some(({ enabled }) => enabled)) {
    throw harnessError(
      "category-config-invalid",
      "At least one runner must be enabled",
    );
  }
  return {
    v: 1,
    seed:
      typeof raw.seed === "string" && raw.seed.length > 0
        ? raw.seed
        : "lodestar-category-v1",
    repetitions: integer("repetitions", raw.repetitions ?? 2, {
      maximum: 20,
    }),
    timeoutMs: integer(
      "timeout_ms",
      raw.timeout_ms ?? raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      {
      minimum: 1_000,
      maximum: 60 * 60 * 1_000,
      },
    ),
    scenarios,
    conditions,
    runners,
  };
}

function questionMap() {
  return new Map(CATEGORY_QUESTIONS.map((question) => [question.id, question]));
}

function stableTrialId(parts) {
  return createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 20);
}

function trialOrder(seed, trial) {
  return createHash("sha256")
    .update(`${seed}\0${trial.pairId}`)
    .digest("hex");
}

export function buildCategoryPlan(rawConfig) {
  const config = validateCategoryConfig(rawConfig);
  const questions = questionMap();
  const trials = [];
  for (const runner of config.runners.filter(({ enabled }) => enabled)) {
    for (const scenarioId of config.scenarios) {
      const scenario = scenarioById(scenarioId);
      for (const questionId of scenario.questions) {
        const question = questions.get(questionId);
        for (const condition of config.conditions) {
          for (
            let repetition = 1;
            repetition <= config.repetitions;
            repetition += 1
          ) {
            const pairId = stableTrialId([
              config.seed,
              runner.id,
              scenarioId,
              questionId,
              String(repetition),
            ]);
            trials.push({
              id: stableTrialId([
                config.seed,
                runner.id,
                scenarioId,
                questionId,
                condition,
                String(repetition),
              ]),
              pairId,
              runnerId: runner.id,
              scenarioId,
              questionId,
              condition,
              repetition,
              estimatedCostUsd: runner.estimatedCostUsdPerTrial,
            });
          }
        }
      }
    }
  }
  trials.sort((left, right) => {
    const pairComparison = trialOrder(config.seed, left)
      .localeCompare(trialOrder(config.seed, right));
    if (pairComparison !== 0) return pairComparison;
    return left.id.localeCompare(right.id);
  });
  const plan = {
    v: 1,
    benchmark: "lodestar-category-benchmark",
    config,
    fixtureFingerprint: categoryFixtureFingerprint(),
    trialCount: trials.length,
    estimatedMaxCostUsd: Number(
      trials.reduce((total, trial) =>
        total + trial.estimatedCostUsd, 0).toFixed(6),
    ),
    trials,
  };
  plan.planFingerprint = createHash("sha256")
    .update(canonicalStringify(plan))
    .digest("hex");
  return plan;
}

function expandedCommand(command) {
  return command.map((entry) => entry
    .replaceAll("{node}", process.execPath)
    .replaceAll("{packageRoot}", PACKAGE_ROOT));
}

function parseRunnerOutput(text, trialId) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw harnessError(
      "category-runner-output-invalid",
      "Runner stdout must contain exactly one JSON object",
      { trial_id: trialId },
      error,
    );
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.v !== 1
    || value.trial_id !== trialId
    || value.status !== "completed"
    || !Array.isArray(value.events)
  ) {
    throw harnessError(
      "category-runner-output-invalid",
      "Runner response does not satisfy the v1 protocol",
      { trial_id: trialId },
    );
  }
  return value;
}

async function runChild({
  command,
  request,
  cwd,
  env,
  timeoutMs,
  maxCaptureBytes = MAX_CAPTURE_BYTES,
}) {
  return await new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const [executable, ...args] = command;
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(harnessError(
        "category-runner-timeout",
        "Benchmark runner exceeded its timeout",
        { trial_id: request.trial_id, timeout_ms: timeoutMs },
      ));
    }, timeoutMs);
    child.on("error", (error) => fail(harnessError(
      "category-runner-launch-failed",
      "Unable to launch benchmark runner",
      { trial_id: request.trial_id, executable },
      error,
    )));
    for (const [stream, chunks, counter] of [
      [child.stdout, stdout, () => stdoutBytes],
      [child.stderr, stderr, () => stderrBytes],
    ]) {
      stream.on("data", (chunk) => {
        chunks.push(chunk);
        if (stream === child.stdout) stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (counter() > maxCaptureBytes) {
          child.kill();
          fail(harnessError(
            "category-runner-output-too-large",
            "Runner output exceeded the capture budget",
            {
              trial_id: request.trial_id,
              max_capture_bytes: maxCaptureBytes,
            },
          ));
        }
      });
    }
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const completedAtMs = Date.now();
      const output = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        startedAtMs,
        completedAtMs,
      };
      if (code !== 0) {
        reject(harnessError(
          "category-runner-failed",
          "Benchmark runner exited unsuccessfully",
          {
            trial_id: request.trial_id,
            exit_code: code,
            signal,
            stderr_tail: output.stderr.slice(-4_096),
          },
        ));
        return;
      }
      resolve(output);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(error);
    });
    child.stdin.end(`${canonicalStringify(request)}\n`, "utf8");
  });
}

async function readCompleted(resultsFile, plan) {
  try {
    const text = await fs.readFile(resultsFile, "utf8");
    const values = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw harnessError(
            "category-results-invalid",
            "Existing results JSONL is malformed",
            { results_file: resultsFile, line: index + 1 },
            error,
          );
        }
      });
    const expected = new Map(plan.trials.map((trial) => [trial.id, trial]));
    const seen = new Set();
    for (const value of values) {
      const trial = expected.get(value.trial_id);
      if (!trial || seen.has(value.trial_id)) {
        throw harnessError(
          "category-results-invalid",
          "Existing results contain an unknown or duplicate trial",
          { trial_id: value.trial_id ?? null },
        );
      }
      seen.add(value.trial_id);
      for (const [field, expectedValue] of [
        ["runner_id", trial.runnerId],
        ["scenario_id", trial.scenarioId],
        ["question_id", trial.questionId],
        ["condition", trial.condition],
        ["repetition", trial.repetition],
      ]) {
        if (value[field] !== expectedValue) {
          throw harnessError(
            "category-results-invalid",
            "Existing result does not match the immutable trial plan",
            {
              trial_id: value.trial_id,
              field,
              expected: expectedValue,
              actual: value[field] ?? null,
            },
          );
        }
      }
    }
    return values;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function appendJsonLine(file, value) {
  await fs.appendFile(file, `${canonicalStringify(value)}\n`, "utf8");
}

function requestFor({ trial, runner, fixture, question }) {
  const agentctx = path.join(PACKAGE_ROOT, "agentctx.mjs");
  return {
    v: 1,
    trial_id: trial.id,
    benchmark: "lodestar-category-benchmark",
    runner: {
      id: runner.id,
      metadata: runner.metadata,
    },
    condition: trial.condition,
    scenario: {
      id: trial.scenarioId,
      description: fixture.scenario.description,
    },
    question: {
      id: question.id,
      prompt: question.prompt,
    },
    workspace: fixture.workspace,
    constraints: {
      read_only: true,
      repository_scope: fixture.workspace,
      return_schema: {
        answer: "non-empty string",
        confidence: "number from 0 to 1",
        evidence: "repository-relative path array",
        explanation: "short string",
      },
    },
    lodestar: trial.condition === "lodestar"
      ? {
        home: fixture.home,
        command: [process.execPath, agentctx],
        boot: [
          process.execPath,
          agentctx,
          "start",
          "--home",
          fixture.home,
          "--cwd",
          fixture.workspace,
        ],
      }
      : null,
  };
}

async function writeSummary(output, plan, results, execution = {}) {
  const report = {
    v: 1,
    benchmark: plan.benchmark,
    fixture_fingerprint: plan.fixtureFingerprint,
    planned_trials: plan.trialCount,
    recorded_trials: results.length,
    estimated_max_cost_usd: plan.estimatedMaxCostUsd,
    execution,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
    },
    results: summarizeCategoryTrials(results),
  };
  await fs.writeFile(
    path.join(output, "summary.json"),
    `${canonicalStringify(report)}\n`,
    "utf8",
  );
  return report;
}

export async function executeCategoryPlan(plan, {
  output,
  maxCostUsd,
  maxTrials = plan.trialCount,
  keepWorkspaces = false,
  onProgress = () => {},
} = {}) {
  if (!path.isAbsolute(output ?? "")) {
    throw harnessError(
      "category-output-invalid",
      "Execution requires an absolute output directory",
      { output: output ?? null },
    );
  }
  number("max_cost_usd", maxCostUsd, {
    minimum: 0.000001,
    maximum: 1_000_000,
  });
  integer("max_trials", maxTrials, {
    minimum: 1,
    maximum: plan.trialCount,
  });
  if (maxTrials % plan.config.conditions.length !== 0) {
    throw harnessError(
      "category-unpaired-trial-limit",
      "maxTrials must select complete condition pairs",
      {
        max_trials: maxTrials,
        conditions_per_pair: plan.config.conditions.length,
      },
    );
  }
  const selected = plan.trials.slice(0, maxTrials);
  const selectedCost = Number(selected.reduce(
    (total, trial) => total + trial.estimatedCostUsd,
    0,
  ).toFixed(6));
  if (selectedCost > maxCostUsd) {
    throw harnessError(
      "category-cost-cap-exceeded",
      "Planned trials exceed the explicit cost cap",
      {
        selected_trials: selected.length,
        estimated_cost_usd: Number(selectedCost.toFixed(6)),
        max_cost_usd: maxCostUsd,
      },
    );
  }
  await fs.mkdir(output, { recursive: true });
  const manifestFile = path.join(output, "manifest.json");
  const resultsFile = path.join(output, "results.jsonl");
  const rawRoot = path.join(output, "raw");
  const workRoot = path.join(output, "work");
  const existingEntries = await fs.readdir(output);
  if (
    existingEntries.length > 0
    && !existingEntries.includes("manifest.json")
  ) {
    throw harnessError(
      "category-output-not-empty",
      "Output directory is not empty and has no benchmark manifest",
      { output, entries: existingEntries.sort() },
    );
  }
  const manifest = {
    ...plan,
    execution: {
      selected_trials: selected.length,
      max_cost_usd: maxCostUsd,
      keep_workspaces: keepWorkspaces,
    },
  };
  await fs.writeFile(
    manifestFile,
    `${canonicalStringify(manifest)}\n`,
    { encoding: "utf8", flag: "wx" },
  ).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (
      existing.planFingerprint !== manifest.planFingerprint
    ) {
      throw harnessError(
        "category-resume-mismatch",
        "Output directory belongs to a different benchmark plan",
        { output },
      );
    }
  });
  await Promise.all([
    fs.mkdir(rawRoot, { recursive: true }),
    fs.mkdir(workRoot, { recursive: true }),
  ]);
  const prior = await readCompleted(resultsFile, plan);
  const completedIds = new Set(prior.map(({ trial_id: id }) => id));
  const results = [...prior];
  const runners = new Map(plan.config.runners.map((runner) => [runner.id, runner]));
  const questions = questionMap();
  let stopped = false;
  for (const [index, trial] of selected.entries()) {
    if (completedIds.has(trial.id)) continue;
    try {
      await fs.access(path.join(output, "STOP"));
      stopped = true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    onProgress({
      current: index + 1,
      total: selected.length,
      trial,
    });
    const trialRoot = path.join(workRoot, trial.id);
    await fs.mkdir(trialRoot, { recursive: true });
    const fixture = await buildCategoryTrialFixture({
      root: trialRoot,
      scenarioId: trial.scenarioId,
      condition: trial.condition,
    });
    const question = questions.get(trial.questionId);
    const runner = runners.get(trial.runnerId);
    const request = requestFor({ trial, runner, fixture, question });
    const environment = {
      ...process.env,
      LODESTAR_BENCHMARK_TRIAL_ID: trial.id,
      LODESTAR_BENCHMARK_CONDITION: trial.condition,
      ...(fixture.home ? { LODESTAR_HOME: fixture.home } : {}),
    };
    let child;
    let response;
    let result;
    try {
      child = await runChild({
        command: expandedCommand(runner.command),
        request,
        cwd: PACKAGE_ROOT,
        env: environment,
        timeoutMs: plan.config.timeoutMs,
      });
      response = parseRunnerOutput(child.stdout.trim(), trial.id);
      const score = scoreCategoryTrial({
        question,
        answer: response.answer,
        events: response.events,
        canary: fixture.canary,
        condition: trial.condition,
        startedAtMs: child.startedAtMs,
        completedAtMs: child.completedAtMs,
        leakageText: canonicalStringify(response.raw_events ?? []),
      });
      result = {
        v: 1,
        trial_id: trial.id,
        runner_id: trial.runnerId,
        scenario_id: trial.scenarioId,
        question_id: trial.questionId,
        condition: trial.condition,
        repetition: trial.repetition,
        status: "completed",
        answer: response.answer,
        usage: response.usage ?? null,
        score,
      };
    } catch (error) {
      result = {
        v: 1,
        trial_id: trial.id,
        runner_id: trial.runnerId,
        scenario_id: trial.scenarioId,
        question_id: trial.questionId,
        condition: trial.condition,
        repetition: trial.repetition,
        status: "failed",
        error: {
          code: error.code ?? "category-trial-failed",
          message: error.message,
          detail: error.detail ?? {},
        },
      };
    }
    await fs.writeFile(
      path.join(rawRoot, `${trial.id}.request.json`),
      `${canonicalStringify(request)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(rawRoot, `${trial.id}.response.json`),
      `${canonicalStringify({
        child: child
          ? {
            exit_code: child.code,
            signal: child.signal,
            stderr: child.stderr,
            started_at_ms: child.startedAtMs,
            completed_at_ms: child.completedAtMs,
          }
          : null,
        response: response ?? null,
      })}\n`,
      "utf8",
    );
    await appendJsonLine(resultsFile, result);
    results.push(result);
    if (!keepWorkspaces) {
      await fs.rm(trialRoot, { recursive: true, force: true });
    }
  }
  return await writeSummary(output, plan, results, {
    status: stopped ? "stopped" : "completed",
    selected_trials: selected.length,
    completed_or_failed_trials: results.filter(({ trial_id: trialId }) =>
      selected.some(({ id }) => id === trialId)).length,
  });
}

export async function loadCategoryConfig(file) {
  try {
    return validateCategoryConfig(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof LodestarError) throw error;
    throw wrapError(
      error,
      "category-config-read-failed",
      "Unable to read category benchmark config",
      { path: file },
    );
  }
}

export const CATEGORY_HARNESS_DEFAULTS = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
});
