import { projectFileStem, projectShardPath } from "./store-layout.mjs";
import { ContextError } from "./validation.mjs";

const HEALTH_STATES = new Set([
  "ok",
  "missing",
  "unreadable",
  "unchecked",
]);

function searchableStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(searchableStrings);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) => [
      key,
      ...searchableStrings(nested),
    ]);
  }
  return [];
}

function words(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function searchTerms(value) {
  return words(value);
}

function recordTerms(record) {
  const terms = new Set([record.id.toLowerCase()]);
  for (const field of [
    "aliases",
    "topics",
    "summary",
    "commands",
    "facts",
    "action",
    "locators",
  ]) {
    for (const value of searchableStrings(record[field])) {
      for (const term of words(value)) terms.add(term);
    }
  }
  return [...terms];
}

function sortedRecordEntries(globalRecords, projectRecords) {
  return [
    ...globalRecords.map((record) => ({
      record,
      scope: "global",
      shard: "records/global.jsonl",
    })),
    ...Object.entries(projectRecords).flatMap(([projectId, records]) =>
      records.map((record) => ({
        record,
        scope: `project:${projectId}`,
        shard: projectShardPath(projectId),
      }))),
  ].sort((a, b) => a.record.id.localeCompare(b.record.id));
}

function buildSearchIndex(scope, entries, generation) {
  const postings = new Map();
  const priorities = new Map(
    entries.map(({ record }) => [record.id, record.priority ?? 0]),
  );
  for (const { record } of entries) {
    for (const term of recordTerms(record)) {
      if (!postings.has(term)) postings.set(term, new Set());
      postings.get(term).add(record.id);
    }
  }
  return {
    v: 1,
    generation,
    scope,
    terms: Object.fromEntries(
      [...postings.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([term, ids]) => [
          term,
          [...ids].sort((a, b) =>
            priorities.get(b) - priorities.get(a) || a.localeCompare(b)),
        ]),
    ),
  };
}

export async function buildIndexes({
  generation,
  catalog,
  globalRecords = [],
  projectRecords = {},
  probeLocator = async () => ({ status: "unchecked" }),
} = {}) {
  const entries = sortedRecordEntries(globalRecords, projectRecords);
  const routes = {};
  for (const { record, shard } of entries) {
    if (Object.hasOwn(routes, record.id)) {
      throw new ContextError("duplicate-route", { id: record.id });
    }
    routes[record.id] = {
      shard,
      scope: [...record.scope],
    };
  }

  const indexes = {
    "routes.json": {
      v: 1,
      generation,
      records: routes,
    },
    "search/global.json": buildSearchIndex(
      "global",
      entries.filter(({ scope }) => scope === "global"),
      generation,
    ),
  };
  for (const project of [...catalog.projects]
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const scope = `project:${project.id}`;
    indexes[`search/${projectFileStem(project.id)}.json`] = buildSearchIndex(
      scope,
      entries.filter((entry) => entry.scope === scope),
      generation,
    );
  }

  const health = {};
  const projects = new Map(catalog.projects.map((project) => [project.id, project]));
  for (const { record, scope } of entries) {
    const projectId = scope.startsWith("project:")
      ? scope.slice("project:".length)
      : null;
    for (const [index, locator] of (record.locators ?? []).entries()) {
      const result = await probeLocator({
        project: projects.get(projectId) ?? null,
        record,
        locator,
      });
      if (!HEALTH_STATES.has(result?.status)) {
        throw new ContextError("invalid-locator-health", {
          id: record.id,
          index,
          status: result?.status ?? null,
        });
      }
      health[`${record.id}#${index}`] = result;
    }
  }
  indexes["locator-health.json"] = {
    v: 1,
    generation,
    locators: health,
  };
  return indexes;
}

export function validateIndexes(indexes, generation) {
  for (const [file, index] of Object.entries(indexes)) {
    if (index?.v !== 1) {
      throw new ContextError("invalid-index", { file });
    }
    if (index.generation !== generation) {
      throw new ContextError("index-generation-mismatch", {
        file,
        expected: generation,
        actual: index.generation ?? null,
      });
    }
  }
  for (const [locator, health] of Object.entries(
    indexes["locator-health.json"]?.locators ?? {},
  )) {
    if (!HEALTH_STATES.has(health.status)) {
      throw new ContextError("invalid-locator-health", {
        locator,
        status: health.status ?? null,
      });
    }
  }
  return indexes;
}
