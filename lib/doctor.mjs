import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { ContextStore } from "./context-store.mjs";
import {
  computeGenerationId,
  promoteGeneration,
} from "./generation.mjs";
import { canonicalStringify } from "./canonical-json.mjs";
import { readFileLimited } from "./bounded-io.mjs";
import { probeDurability } from "./durable-fs.mjs";
import { buildIndexes, validateIndexes } from "./indexes.mjs";
import { probeLocatorHealth } from "./locator-health.mjs";
import { verifyIntegrityManifest } from "./integrity.mjs";
import {
  generationPaths,
  projectFileStem,
  projectShardPath,
  statePaths,
} from "./store-layout.mjs";
import { STORE_LIMITS_V1 } from "./resource-limits.mjs";
import {
  ContextError,
  validateCatalog,
  validateGraph,
} from "./validation.mjs";
import { probeWriteSemantics, withWriteLock } from "./write-lock.mjs";

const GENERATION_ID = /^[a-f0-9]{64}$/;
const GENERATION_INSPECTION_CONCURRENCY = 4;

function issue(code, severity, detail = {}) {
  return { code, severity, ...detail };
}

async function readJson(file, fsApi) {
  let text;
  try {
    text = await readFileLimited(file, {
      maximum: STORE_LIMITS_V1.maxIndexBytes,
      encoding: "utf8",
      resource: "store-file-bytes",
      fsApi,
    });
  } catch (error) {
    throw new ContextError(
      error.code === "ENOENT" ? "store-file-missing" : "store-file-unreadable",
      { path: file, reason: error.code ?? "unknown" },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ContextError("invalid-json", {
      path: file,
      reason: error.message,
    });
  }
}

async function readJsonLines(file, fsApi) {
  let text;
  try {
    text = await readFileLimited(file, {
      maximum: STORE_LIMITS_V1.maxShardBytes,
      encoding: "utf8",
      resource: "store-shard-bytes",
      fsApi,
    });
  } catch (error) {
    throw new ContextError(
      error.code === "ENOENT" ? "store-file-missing" : "store-file-unreadable",
      { path: file, reason: error.code ?? "unknown" },
    );
  }
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new ContextError("invalid-jsonl", {
        path: file,
        line: index + 1,
        reason: error.message,
      });
    }
  });
}

export async function inspectGeneration(
  home,
  id,
  fsApi = fs,
  { deep = false } = {},
) {
  if (!GENERATION_ID.test(id)) {
    throw new ContextError("generation-id-invalid", { generation: id });
  }
  const paths = generationPaths(home, id);
  const integrity = deep
    ? await verifyIntegrityManifest({
      root: paths.root,
      generation: id,
      fsApi,
    })
    : null;
  const [catalog, schema, globalRecords] = await Promise.all([
    readJson(paths.catalog, fsApi),
    readJson(paths.schema, fsApi),
    readJsonLines(paths.globalRecords, fsApi),
  ]);
  validateCatalog(catalog);
  if (schema?.v !== 1) {
    throw new ContextError("schema-version-invalid", {
      generation: id,
      version: schema?.v ?? null,
    });
  }
  const projectRecords = {};
  for (const project of catalog.projects) {
    projectRecords[project.id] = await readJsonLines(
      path.join(paths.root, projectShardPath(project.id)),
      fsApi,
    );
  }
  const records = [
    ...globalRecords,
    ...Object.values(projectRecords).flat(),
  ];
  validateGraph({ catalog, records });
  const indexes = {
    "routes.json": await readJson(
      path.join(paths.indexes, "routes.json"),
      fsApi,
    ),
    "locator-health.json": await readJson(
      path.join(paths.indexes, "locator-health.json"),
      fsApi,
    ),
    "search/global.json": await readJson(
      path.join(paths.indexes, "search", "global.json"),
      fsApi,
    ),
  };
  for (const project of catalog.projects) {
    const relative = `search/${projectFileStem(project.id)}.json`;
    indexes[relative] = await readJson(
      path.join(paths.indexes, relative),
      fsApi,
    );
  }
  validateIndexes(indexes, id);
  const expectedRoutes = new Set([
    ...catalog.projects.map(({ id: projectId }) => projectId),
    ...records.map(({ id: recordId }) => recordId),
  ]);
  const actualRoutes = new Set(Object.keys(indexes["routes.json"].records ?? {}));
  for (const record of records) {
    if (!actualRoutes.has(record.id)) {
      throw new ContextError("route-missing", { id: record.id });
    }
  }
  for (const routeId of actualRoutes) {
    if (!expectedRoutes.has(routeId)) {
      throw new ContextError("route-orphaned", { id: routeId });
    }
  }
  if (deep) {
    const computed = computeGenerationId({
      catalog,
      schema,
      globalRecords,
      projectRecords,
    });
    if (computed !== id) {
      throw new ContextError("generation-content-mismatch", {
        generation: id,
        computed,
      });
    }
    const health = indexes["locator-health.json"].locators ?? {};
    const rebuilt = await buildIndexes({
      generation: id,
      catalog,
      globalRecords,
      projectRecords,
      probeLocator: async ({ record, locator }) => {
        const locatorIndex = (record.locators ?? []).indexOf(locator);
        return health[`${record.id}#${locatorIndex}`]
          ?? { status: "unchecked" };
      },
    });
    for (const [relative, expected] of Object.entries(rebuilt)) {
      const actual = indexes[relative];
      if (canonicalStringify(actual) !== canonicalStringify(expected)) {
        throw new ContextError("index-content-mismatch", {
          generation: id,
          index: relative,
        });
      }
    }
  }
  return {
    id,
    root: paths.root,
    catalog,
    schema,
    records,
    indexes,
    integrity,
  };
}

async function generationCandidates(home, fsApi) {
  const directory = statePaths(home).generations;
  const entries = await (fsApi.readdir ?? fs.readdir)(directory, {
    withFileTypes: true,
  }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && GENERATION_ID.test(entry.name))
    .map(({ name }) => name)
    .sort();
}

async function inspectGenerations(home, ids, fsApi, { active, deep }) {
  const results = new Array(ids.length);
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const index = next;
      next += 1;
      try {
        const inspected = await inspectGeneration(home, ids[index], fsApi, {
          deep,
        });
        results[index] = {
          ok: true,
          value: ids[index] === active
            ? inspected
            : { id: inspected.id, integrity: inspected.integrity },
        };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  const workers = Math.min(GENERATION_INSPECTION_CONCURRENCY, ids.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function pointerGeneration(home, fsApi) {
  let pointer;
  try {
    pointer = await readJson(statePaths(home).current, fsApi);
  } catch (error) {
    if (
      error.code === "store-file-missing"
      && error.detail.path === statePaths(home).current
    ) {
      throw new ContextError("current-generation-missing", { home });
    }
    throw error;
  }
  if (
    pointer?.v !== 1
    || typeof pointer.generation !== "string"
    || !GENERATION_ID.test(pointer.generation)
  ) {
    throw new ContextError("current-generation-invalid", { home });
  }
  return pointer.generation;
}

function normalizedHostname(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase()
    .replace(/\.$/, "");
}

async function inspectLock(home, {
  fsApi,
  now,
  hostname,
  runtime,
  staleGraceMs,
}) {
  const lock = statePaths(home).lock;
  let owner;
  let heartbeat;
  try {
    [owner, heartbeat] = await Promise.all([
      readJson(path.join(lock, "owner.json"), fsApi),
      readJson(path.join(lock, "heartbeat.json"), fsApi),
    ]);
  } catch (error) {
    try {
      await (fsApi.access ?? fs.access)(lock);
    } catch (accessError) {
      if (accessError.code === "ENOENT") return null;
      throw accessError;
    }
    return issue("writer-lock-invalid", "blocker", {
      path: lock,
      reason: error.code ?? "invalid",
      repair: "Inspect the lock owner before using agentctx doctor --repair-lock --force.",
    });
  }
  const heartbeatAt = heartbeat?.nonce === owner?.nonce
    ? heartbeat.at
    : null;
  const age = typeof heartbeatAt === "number" ? now() - heartbeatAt : null;
  const sameMachine = normalizedHostname(owner?.hostname)
    === normalizedHostname(hostname);
  const sameRuntime = owner?.runtime === undefined || owner.runtime === runtime;
  const stale = age === null || age > staleGraceMs;
  return issue(
    stale ? "writer-lock-stale-or-ambiguous" : "writer-lock-active",
    stale ? "blocker" : "warning",
    {
      path: lock,
      owner,
      heartbeat_at: heartbeatAt,
      age_ms: age,
      same_machine: sameMachine,
      same_runtime: sameRuntime,
      repair: stale
        ? "Confirm no writer is active, then run agentctx doctor --repair-lock --force."
        : "Wait for the active writer to finish.",
    },
  );
}

export async function repairCurrentGeneration({
  home,
  generation,
  fsApi = fs,
} = {}) {
  const inspected = await inspectGeneration(home, generation, fsApi);
  await withWriteLock({ home, fsApi }, () =>
    promoteGeneration({
      home,
      generation: { id: inspected.id, root: inspected.root },
      fsApi,
    }));
  return { repaired: "current-generation", generation: inspected.id };
}

export async function repairWriterLock({
  home,
  force = false,
  fsApi = fs,
  now = Date.now,
  staleGraceMs = 30_000,
} = {}) {
  if (!force) {
    throw new ContextError("repair-force-required", {
      repair: "Retry with --force only after confirming no writer is active.",
    });
  }
  const lock = statePaths(home).lock;
  let heartbeat;
  try {
    heartbeat = await readJson(path.join(lock, "heartbeat.json"), fsApi);
  } catch (error) {
    throw new ContextError("writer-lock-not-found-or-invalid", {
      path: lock,
      reason: error.code ?? "unknown",
    });
  }
  if (
    typeof heartbeat?.at === "number"
    && now() - heartbeat.at <= staleGraceMs
  ) {
    throw new ContextError("writer-lock-not-stale", {
      path: lock,
      heartbeat_at: heartbeat.at,
    });
  }
  const quarantine = `${lock}.repaired-${randomUUID()}`;
  await (fsApi.rename ?? fs.rename)(lock, quarantine);
  return { repaired: "writer-lock", quarantine };
}

export async function diagnoseStore({
  home,
  cwd = process.cwd(),
  project = null,
  fsApi = fs,
  platform = process.platform,
  env = process.env,
  release = os.release(),
  now = Date.now,
  hostname = os.hostname(),
  runtime = process.platform,
  staleGraceMs = 30_000,
  deep = false,
} = {}) {
  const issues = [];
  let active = null;
  try {
    active = await pointerGeneration(home, fsApi);
  } catch (error) {
    issues.push(issue(error.code ?? "current-generation-invalid", "error", {
      detail: error.detail ?? {},
    }));
  }

  const candidates = await generationCandidates(home, fsApi);
  const validGenerations = [];
  const inspections = await inspectGenerations(home, candidates, fsApi, {
    active,
    deep,
  });
  for (const [index, result] of inspections.entries()) {
    const id = candidates[index];
    if (result.ok) {
      const inspected = result.value;
      validGenerations.push(inspected);
      if (deep && inspected.integrity?.sealed === false) {
        issues.push(issue("generation-unsealed", "warning", {
          generation: id,
          repair:
            "A validated write will create a sealed generation; retain a verified snapshot before retiring legacy history.",
        }));
      }
    } else {
      const { error } = result;
      issues.push(issue("generation-invalid", id === active ? "error" : "warning", {
        generation: id,
        reason: error.code ?? "invalid",
        detail: error.detail ?? {},
      }));
    }
  }
  const activeGeneration = validGenerations.find(({ id }) => id === active);
  if (active && !activeGeneration) {
    issues.push(issue("active-generation-invalid", "error", {
      generation: active,
      repair: validGenerations.length > 0
        ? `Run agentctx doctor --repair-current ${
          validGenerations.at(-1).id
        }.`
        : "Restore a valid state-home backup.",
    }));
  }

  let storeReport = null;
  if (activeGeneration) {
    try {
      const store = await ContextStore.open({
        home,
        cwd,
        project,
        fsApi,
        platform,
        env,
        release,
      });
      storeReport = await store.doctor();
      issues.push(...storeReport.issues);
      try {
        await store.start();
      } catch (error) {
        issues.push(issue("startup-invalid", "error", {
          reason: error.code ?? "unknown",
          detail: error.detail ?? {},
        }));
      }
      const projects = new Map(
        activeGeneration.catalog.projects.map((entry) => [entry.id, entry]),
      );
      for (const record of activeGeneration.records) {
        const projectId = record.scope
          .find((scope) => scope.startsWith("project:"))
          ?.slice("project:".length);
        for (const [index, locator] of (record.locators ?? []).entries()) {
          const key = `${record.id}#${index}`;
          try {
            const actual = await probeLocatorHealth({
              project: projects.get(projectId) ?? null,
              record,
              locator,
            }, {
              fsApi,
              platform,
              env,
              release,
              cwd,
            });
            const stored = activeGeneration.indexes[
              "locator-health.json"
            ].locators?.[key] ?? { status: "unchecked" };
            if (["missing", "unreadable"].includes(actual.status)) {
              issues.push(issue("locator-unhealthy", "warning", {
                locator: key,
                status: actual.status,
                repair:
                  "Correct the locator or restore its project root, then run agentctx refresh.",
              }));
            }
            if (stored.status !== actual.status) {
              issues.push(issue("locator-health-stale", "warning", {
                locator: key,
                stored: stored.status,
                actual: actual.status,
                repair: "Run agentctx refresh to update locator health.",
              }));
            }
          } catch (error) {
            issues.push(issue(error.code ?? "locator-check-failed", "error", {
              locator: key,
              detail: error.detail ?? {},
            }));
          }
        }
      }
    } catch (error) {
      issues.push(issue("active-generation-open-failed", "error", {
        generation: active,
        reason: error.code ?? "unknown",
        detail: error.detail ?? {},
      }));
    }
  }

  const lockIssue = await inspectLock(home, {
    fsApi,
    now,
    hostname,
    runtime,
    staleGraceMs,
  });
  if (lockIssue) issues.push(lockIssue);
  const generationEntries = await (fsApi.readdir ?? fs.readdir)(
    statePaths(home).generations,
  ).catch(() => []);
  for (const entry of generationEntries.filter((name) =>
    name.startsWith(".build-") || name.includes(".stale-"))) {
    issues.push(issue("orphaned-transaction", "warning", {
      path: path.join(statePaths(home).generations, entry),
      repair: "Remove only after confirming no Lodestar writer is active.",
    }));
  }
  const homeEntries = await (fsApi.readdir ?? fs.readdir)(home)
    .catch(() => []);
  for (const entry of homeEntries.filter((name) =>
    [
      "current.json.tmp-",
      "current.json.previous-",
      "events.jsonl.tmp-",
      "events.jsonl.previous-",
      ".write-lock.released-",
    ].some((prefix) => name.startsWith(prefix)))) {
    issues.push(issue("orphaned-atomic-file", "warning", {
      path: path.join(home, entry),
      repair: "Remove only after confirming no Lodestar writer is active.",
    }));
  }
  const writeProbe = await probeWriteSemantics(home, { fsApi });
  if (!writeProbe.ok) {
    issues.push(issue("write-semantics-unsupported", "error", {
      reason: writeProbe.code,
      repair: "Move LODESTAR_HOME to a local filesystem with atomic directory rename support.",
    }));
  }
  const durability = await probeDurability(home, { fsApi });
  if (!durability.ok) {
    issues.push(issue("durability-unsupported", "error", {
      reason: durability.code ?? durability.level,
      repair:
        "Move LODESTAR_HOME to a local filesystem that supports file synchronization.",
    }));
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 22) {
    issues.push(issue("node-version-unsupported", "error", {
      actual: process.versions.node,
      required: ">=22",
    }));
  }

  const errors = issues.filter(({ severity }) => severity === "error").length;
  const blockers = issues.filter(({ severity }) => severity === "blocker").length;
  const warnings = issues.filter(({ severity }) => severity === "warning").length;
  return {
    ok: errors === 0 && blockers === 0,
    generation: active,
    valid_generations: validGenerations.map(({ id }) => id),
    integrity: {
      mode: deep ? "deep" : "structural",
      sealed: validGenerations.filter(({ integrity }) => integrity?.sealed)
        .length,
      unsealed: deep
        ? validGenerations.filter(({ integrity }) => !integrity?.sealed).length
        : null,
    },
    durability,
    errors,
    blockers,
    warnings,
    broken_links: issues.filter(({ code }) => code === "broken-link").length,
    counts: storeReport?.counts ?? {
      projects: activeGeneration?.catalog.projects.length ?? 0,
      records: activeGeneration?.records.length ?? 0,
    },
    issues,
  };
}
