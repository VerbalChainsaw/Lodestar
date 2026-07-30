import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCategoryTrialFixture,
  categoryFixtureFingerprint,
} from "../lib/category-fixture.mjs";
import {
  buildCategoryPlan,
  executeCategoryPlan,
  loadCategoryConfig,
} from "../lib/category-harness.mjs";
import {
  scoreCategoryTrial,
  summarizeCategoryTrials,
} from "../lib/category-score.mjs";
import { run as runCli } from "../tools/benchmark-category.mjs";
import { resolveCodexInvocation } from "../tools/category-codex-runner.mjs";

function mockConfig(overrides = {}) {
  return {
    v: 1,
    seed: "category-test",
    repetitions: 1,
    timeout_ms: 10_000,
    scenarios: ["tiny-direct"],
    conditions: ["unmanaged", "lodestar"],
    runners: [{
      id: "mock",
      command: [
        "{node}",
        "{packageRoot}/tools/category-mock-runner.mjs",
      ],
      estimated_cost_usd_per_trial: 0.01,
    }],
    ...overrides,
  };
}

test("category fixture contains honest ambiguity and isolated cross-project traps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "category-fixture-"));
  try {
    const fixture = await buildCategoryTrialFixture({
      root,
      scenarioId: "ambiguous-repository",
      condition: "lodestar",
    });
    assert.equal(fixture.questions.length, 7);
    assert.match(
      await fs.readFile(
        path.join(fixture.workspace, "docs/plans/2025-02-abandoned.md"),
        "utf8",
      ),
      /Status: Abandoned/,
    );
    assert.match(
      await fs.readFile(path.join(fixture.workspace, "AGENTS.md"), "utf8"),
      /BOOT=agentctx start/,
    );
    assert.match(
      await fs.readFile(path.join(fixture.trap, "README.md"), "utf8"),
      new RegExp(fixture.canary),
    );
    assert.ok(!fixture.trap.startsWith(`${fixture.workspace}${path.sep}`));
    assert.equal(fixture.fixtureFingerprint, categoryFixtureFingerprint());
    await fs.access(path.join(fixture.home, "current.json"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex adapter unwraps a Windows npm launcher without invoking a shell", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "category-codex-"));
  try {
    const codexJs = path.join(
      root,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    await fs.mkdir(path.dirname(codexJs), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, "codex.cmd"), "@echo off\r\n"),
      fs.writeFile(path.join(root, "node.exe"), ""),
      fs.writeFile(codexJs, ""),
    ]);
    const resolved = await resolveCodexInvocation("codex", {
      platform: "win32",
      env: { PATH: root },
      nodeExecutable: "fallback-node.exe",
    });
    assert.equal(resolved.command, path.join(root, "node.exe"));
    assert.deepEqual(resolved.argsPrefix, [codexJs]);
    assert.equal(resolved.launcher, "npm-node-entrypoint");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("category plan is paired, deterministic, randomized, and costed", () => {
  const first = buildCategoryPlan(mockConfig());
  const second = buildCategoryPlan(mockConfig());
  assert.deepEqual(first, second);
  assert.equal(first.trialCount, 4);
  assert.equal(first.estimatedMaxCostUsd, 0.04);
  assert.deepEqual(
    new Set(first.trials.map(({ condition }) => condition)),
    new Set(["unmanaged", "lodestar"]),
  );
  assert.equal(new Set(first.trials.map(({ id }) => id)).size, 4);
  for (let index = 0; index < first.trials.length; index += 2) {
    assert.equal(first.trials[index].pairId, first.trials[index + 1].pairId);
    assert.notEqual(
      first.trials[index].condition,
      first.trials[index + 1].condition,
    );
  }
});

test("scorer measures correctness, wrong turns, broad search, and leakage", () => {
  const result = scoreCategoryTrial({
    question: {
      id: "test-command",
      answer: "npm run verify:ci",
      evidence: ["docs/operations/testing-current.md"],
    },
    answer: {
      answer: "npm run verify:ci",
      confidence: 0.8,
      evidence: ["docs/operations/testing-current.md"],
      explanation: "Current operational documentation says so.",
    },
    events: [{
      type: "tool",
      broad: true,
      path: "docs/plans/2025-02-abandoned.md",
      bytes: 200,
      command: "rg --files .",
    }],
    canary: "PRIVATE_CANARY",
    condition: "unmanaged",
    startedAtMs: 100,
    completedAtMs: 250,
  });
  assert.equal(result.correct, true);
  assert.equal(result.evidence_correct, true);
  assert.equal(result.wrong_turns, 1);
  assert.equal(result.broad_searches, 1);
  assert.equal(result.bytes_observed, 200);
  assert.equal(result.leakage, false);
  assert.equal(result.brier_score, 0.04);
  assert.equal(result.elapsed_ms, 150);

  const leaked = scoreCategoryTrial({
    question: {
      id: "test-command",
      answer: "npm run verify:ci",
      evidence: ["docs/operations/testing-current.md"],
    },
    answer: {
      answer: "PRIVATE_CANARY",
      confidence: 0.99,
      evidence: [],
    },
    events: [],
    canary: "PRIVATE_CANARY",
    condition: "lodestar",
  });
  assert.equal(leaked.correct, false);
  assert.equal(leaked.leakage, true);
  assert.equal(leaked.protocol_compliant, false);
});

test("mock execution writes resumable raw evidence and paired summaries", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "category-run-"));
  try {
    const plan = buildCategoryPlan(mockConfig());
    const first = await executeCategoryPlan(plan, {
      output,
      maxCostUsd: 0.04,
    });
    assert.equal(first.recorded_trials, 4);
    assert.equal(first.results.conditions.unmanaged.correctness, 1);
    assert.equal(first.results.conditions.lodestar.correctness, 1);
    assert.equal(first.results.conditions.unmanaged.broad_search_rate, 1);
    assert.equal(first.results.conditions.lodestar.broad_search_rate, 0);

    const before = await fs.readFile(path.join(output, "results.jsonl"), "utf8");
    const resumed = await executeCategoryPlan(plan, {
      output,
      maxCostUsd: 0.04,
    });
    const after = await fs.readFile(path.join(output, "results.jsonl"), "utf8");
    assert.equal(resumed.recorded_trials, 4);
    assert.equal(after, before);
    assert.equal((await fs.readdir(path.join(output, "raw"))).length, 8);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test("execution refuses to exceed an explicit cost cap", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "category-cost-"));
  try {
    const plan = buildCategoryPlan(mockConfig());
    await assert.rejects(
      executeCategoryPlan(plan, {
        output,
        maxCostUsd: 0.03,
      }),
      ({ code }) => code === "category-cost-cap-exceeded",
    );
    assert.deepEqual(await fs.readdir(output), []);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test("execution refuses partial pairs and unrelated output directories", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "category-safe-"));
  try {
    const plan = buildCategoryPlan(mockConfig());
    await assert.rejects(
      executeCategoryPlan(plan, {
        output,
        maxCostUsd: 1,
        maxTrials: 1,
      }),
      ({ code }) => code === "category-unpaired-trial-limit",
    );
    await fs.writeFile(path.join(output, "belongs-to-user.txt"), "keep\n");
    await assert.rejects(
      executeCategoryPlan(plan, {
        output,
        maxCostUsd: 1,
      }),
      ({ code }) => code === "category-output-not-empty",
    );
    assert.equal(
      await fs.readFile(path.join(output, "belongs-to-user.txt"), "utf8"),
      "keep\n",
    );
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test("STOP produces a resumable partial summary without starting a trial", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "category-stop-"));
  try {
    const plan = buildCategoryPlan(mockConfig());
    await fs.writeFile(
      path.join(output, "manifest.json"),
      `${JSON.stringify({
        ...plan,
        execution: {
          selected_trials: plan.trialCount,
          max_cost_usd: 1,
          keep_workspaces: false,
        },
      })}\n`,
    );
    await fs.writeFile(path.join(output, "STOP"), "");
    const report = await executeCategoryPlan(plan, {
      output,
      maxCostUsd: 1,
    });
    assert.equal(report.execution.status, "stopped");
    assert.equal(report.recorded_trials, 0);
    assert.equal(report.results.conditions.unmanaged.trials, 0);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test("stale Lodestar cases remain visible as losses", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "category-stale-"));
  try {
    const plan = buildCategoryPlan(mockConfig({
      scenarios: ["stale-lodestar"],
    }));
    const report = await executeCategoryPlan(plan, {
      output,
      maxCostUsd: plan.estimatedMaxCostUsd,
    });
    assert.ok(
      report.results.conditions.lodestar.correctness
        < report.results.conditions.unmanaged.correctness,
    );
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test("malformed provider output becomes a retained failed trial", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "category-broken-"));
  try {
    const plan = buildCategoryPlan(mockConfig({
      runners: [{
        id: "broken",
        command: [
          "{node}",
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>console.log('not-json'))",
        ],
        estimated_cost_usd_per_trial: 0.01,
      }],
    }));
    const report = await executeCategoryPlan(plan, {
      output,
      maxCostUsd: 0.02,
      maxTrials: 2,
    });
    assert.equal(report.recorded_trials, 2);
    assert.equal(
      report.results.conditions.unmanaged.failed
        + report.results.conditions.lodestar.failed,
      2,
    );
    const results = (await fs.readFile(
      path.join(output, "results.jsonl"),
      "utf8",
    )).trim().split("\n").map(JSON.parse);
    assert.ok(results.every(({ error }) =>
      error.code === "category-runner-output-invalid"));
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test("CLI defaults to a no-execution plan", async () => {
  const stdout = [];
  const stderr = [];
  const code = await runCli([
    "--config",
    "benchmarks/category/config.example.json",
    "--json",
  ], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  const plan = JSON.parse(stdout.join(""));
  assert.equal(plan.benchmark, "lodestar-category-benchmark");
  assert.ok(plan.trialCount > 0);
});

test("category CLI exposes help without requiring config or starting a runner", async () => {
  const stdout = [];
  const stderr = [];
  const code = await runCli(["--help"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /^Usage: lodestar-category-benchmark/m);
  assert.match(stdout.join(""), /no-spend dry run/);
});

test("CLI rejects a relative paid-run output before starting a runner", async () => {
  const stdout = [];
  const stderr = [];
  const code = await runCli([
    "--config",
    "benchmarks/category/config.example.json",
    "--execute",
    "--output",
    "relative-results",
    "--max-cost-usd",
    "100",
  ], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.equal(JSON.parse(stderr.join("")).code, "category-cli-invalid");
  await assert.rejects(fs.access("relative-results"));
});

test("category config input is bounded before JSON parsing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "category-config-"));
  try {
    const config = path.join(root, "oversized.json");
    await fs.writeFile(config, "x".repeat(1024 * 1024 + 1));
    await assert.rejects(
      loadCategoryConfig(config),
      {
        code: "resource-limit-exceeded",
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("summary retains failed trials instead of hiding them", () => {
  const summary = summarizeCategoryTrials([{
    runner_id: "broken",
    scenario_id: "tiny-direct",
    condition: "unmanaged",
    status: "failed",
  }]);
  assert.equal(summary.conditions.unmanaged.failed, 1);
  assert.equal(summary.conditions.unmanaged.correctness, null);
});
