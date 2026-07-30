import { performance } from "node:perf_hooks";
import os from "node:os";

import { ContextStore } from "./context-store.mjs";
import {
  runLiftBenchmark,
  withLiftBenchmarkFixture,
} from "./lift-benchmark.mjs";

const DEFAULT_PROFILES = Object.freeze([
  Object.freeze({
    name: "small",
    runs: 11,
    projectCount: 10,
    documentCount: 16,
    documentBytes: 4 * 1024,
  }),
  Object.freeze({
    name: "standard",
    runs: 9,
    projectCount: 100,
    documentCount: 64,
    documentBytes: 16 * 1024,
  }),
  Object.freeze({
    name: "stress",
    runs: 5,
    projectCount: 500,
    documentCount: 256,
    documentBytes: 32 * 1024,
  }),
]);

const QUICK_PROFILES = Object.freeze([
  Object.freeze({
    name: "quick-small",
    runs: 2,
    projectCount: 10,
    documentCount: 8,
    documentBytes: 1024,
  }),
  Object.freeze({
    name: "quick-standard",
    runs: 2,
    projectCount: 100,
    documentCount: 16,
    documentBytes: 2 * 1024,
  }),
]);

const OPERATION_FIXTURE = Object.freeze({
  runs: 1,
  projectCount: 100,
  documentCount: 64,
  documentBytes: 16 * 1024,
});

function performanceError(message, detail = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "PerformanceBenchmarkError";
  error.code = "performance-benchmark-failed";
  error.detail = detail;
  return error;
}

function boundedInteger(
  name,
  value,
  { minimum = 0, maximum = 10_000 } = {},
) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw performanceError(`Invalid ${name}`, {
      option: name,
      value,
      minimum,
      maximum,
    });
  }
  return value;
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function percentile(ordered, fraction) {
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * fraction) - 1),
  );
  return ordered[index];
}

export function timingStatistics(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw performanceError("Timing samples are required");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const sum = ordered.reduce((total, value) => total + value, 0);
  return {
    samples: ordered.length,
    min_ms: rounded(ordered[0]),
    p50_ms: rounded(percentile(ordered, 0.5)),
    p95_ms: rounded(percentile(ordered, 0.95)),
    max_ms: rounded(ordered.at(-1)),
    mean_ms: rounded(sum / ordered.length),
  };
}

async function measureOperation({ iterations, warmups, operation }) {
  for (let index = 0; index < warmups; index += 1) await operation();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return timingStatistics(samples);
}

function assertResult(condition, operation, detail = {}) {
  if (!condition) {
    throw performanceError("Performance probe returned an invalid result", {
      operation,
      ...detail,
    });
  }
}

async function operationProfile({
  fixture,
  iterations,
  warmups,
}) {
  const entrypoint = `${fixture.activeId}:entrypoints`;
  const exactId = `${fixture.activeId}:answer:test_command`;
  const exactIds = [
    exactId,
    `${fixture.activeId}:answer:rollback_rule`,
    `${fixture.activeId}:answer:architecture_entrypoint`,
    "g:benchmark:secret-policy",
  ];
  const memoryBefore = process.memoryUsage();

  const freshStoreStart = await measureOperation({
    iterations,
    warmups,
    async operation() {
      const store = await ContextStore.open({
        home: fixture.home,
        cwd: fixture.activeRoot,
      });
      const result = await store.start();
      assertResult(
        result.project?.id === fixture.activeId,
        "fresh_store_start",
      );
    },
  });

  const store = await ContextStore.open({
    home: fixture.home,
    cwd: fixture.activeRoot,
  });
  await store.start();
  await Promise.all(exactIds.map((id) => store.get(id)));

  const warmStoreStart = await measureOperation({
    iterations,
    warmups,
    async operation() {
      const result = await store.start();
      assertResult(
        result.project?.id === fixture.activeId,
        "warm_store_start",
      );
    },
  });
  const warmExactGet = await measureOperation({
    iterations,
    warmups,
    async operation() {
      const result = await store.get(exactId);
      assertResult(result.id === exactId, "warm_exact_get");
    },
  });
  const warmResolve = await measureOperation({
    iterations,
    warmups,
    async operation() {
      const result = await store.resolve(entrypoint);
      assertResult(
        result.records.length === 5 && result.truncated === false,
        "warm_linked_resolve",
        { records: result.records.length, truncated: result.truncated },
      );
    },
  });
  const warmFind = await measureOperation({
    iterations,
    warmups,
    async operation() {
      const result = await store.find("test command");
      assertResult(
        result.ok === true
          && result.results.some(({ id }) => id === exactId),
        "warm_indexed_find",
      );
    },
  });
  const parallelExactGet = await measureOperation({
    iterations,
    warmups,
    async operation() {
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          store.get(exactIds[index % exactIds.length])),
      );
      assertResult(results.length === 16, "parallel_exact_get_16");
    },
  });
  const memoryAfter = process.memoryUsage();

  return {
    fixture: {
      projects: OPERATION_FIXTURE.projectCount,
      repository_documents: OPERATION_FIXTURE.documentCount,
    },
    iterations,
    warmups,
    definitions: {
      fresh_store_start:
        "new ContextStore per sample with process and OS caches left intact",
      warm_store_start: "reused ContextStore after scoped shards are cached",
      warm_exact_get: "exact stable-ID read from a reused ContextStore",
      warm_linked_resolve: "depth-one entrypoint traversal from cached shards",
      warm_indexed_find: "scoped two-term structured index lookup",
      parallel_exact_get_16: "one batch of 16 cached exact reads",
    },
    timings: {
      fresh_store_start: freshStoreStart,
      warm_store_start: warmStoreStart,
      warm_exact_get: warmExactGet,
      warm_linked_resolve: warmResolve,
      warm_indexed_find: warmFind,
      parallel_exact_get_16: parallelExactGet,
    },
    memory: {
      rss_before_bytes: memoryBefore.rss,
      rss_after_bytes: memoryAfter.rss,
      rss_delta_bytes: memoryAfter.rss - memoryBefore.rss,
      heap_used_before_bytes: memoryBefore.heapUsed,
      heap_used_after_bytes: memoryAfter.heapUsed,
      heap_used_delta_bytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      note:
        "observational snapshots; garbage collection is not forced or gated",
    },
  };
}

function validatedProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw performanceError("At least one scale profile is required");
  }
  const names = new Set();
  return profiles.map((profile, index) => {
    if (
      !profile
      || typeof profile !== "object"
      || typeof profile.name !== "string"
      || profile.name.trim().length === 0
    ) {
      throw performanceError("Invalid scale profile", { index });
    }
    if (names.has(profile.name)) {
      throw performanceError("Duplicate scale profile", {
        name: profile.name,
      });
    }
    names.add(profile.name);
    return { ...profile };
  });
}

export async function runPerformanceBenchmark({
  profiles = DEFAULT_PROFILES,
  iterations = 75,
  warmups = 10,
} = {}) {
  const selectedProfiles = validatedProfiles(profiles);
  const checkedIterations = boundedInteger("iterations", iterations, {
    minimum: 1,
    maximum: 2_000,
  });
  const checkedWarmups = boundedInteger("warmups", warmups, {
    maximum: 500,
  });
  const startedAt = performance.now();
  try {
    const scale = [];
    for (const profile of selectedProfiles) {
      scale.push({
        name: profile.name,
        report: await runLiftBenchmark(profile),
      });
    }
    const operations = await withLiftBenchmarkFixture(
      OPERATION_FIXTURE,
      ({ fixture }) => operationProfile({
        fixture,
        iterations: checkedIterations,
        warmups: checkedWarmups,
      }),
    );
    return {
      v: 1,
      benchmark: "lodestar-performance-suite",
      methodology: [
        "scale results compare broad repository discovery with Lodestar",
        "operation results use warm OS caches and distinguish fresh stores",
        "timing and memory are observations, not portable pass/fail gates",
      ],
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
      },
      scale,
      operations,
      summary: {
        scale_profiles_passed: scale.filter(({ report }) => report.passed)
          .length,
        scale_profiles_total: scale.length,
        elapsed_ms: rounded(performance.now() - startedAt),
      },
      passed: scale.every(({ report }) => report.passed),
    };
  } catch (error) {
    if (
      error?.code === "performance-benchmark-failed"
      || error?.code === "lift-benchmark-failed"
    ) {
      throw error;
    }
    throw performanceError(
      "Unable to complete the performance benchmark",
      {},
      error,
    );
  }
}

export const PERFORMANCE_BENCHMARK_PROFILES = Object.freeze({
  default: DEFAULT_PROFILES,
  quick: QUICK_PROFILES,
});
