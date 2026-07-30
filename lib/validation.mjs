import path from "node:path";

import { LodestarError } from "./errors.mjs";

export const RECORD_KINDS = new Set([
  "answer",
  "command",
  "decision",
  "environment",
  "index",
  "memory",
  "preference",
  "rule",
]);

export const COVERAGE_CATEGORIES = Object.freeze([
  "identity",
  "commands",
  "architecture",
  "entrypoints",
  "environment",
  "rules",
  "hazards",
  "decisions",
  "memory",
  "answers",
]);

const SEARCH_LIMITS = Object.freeze({
  aliases: 12,
  topics: 8,
});

function normalized(value) {
  return String(value).normalize("NFKC").toLowerCase().trim()
    .replace(/\s+/g, " ");
}

export class ContextError extends LodestarError {
  constructor(code, detail = {}) {
    super(code, code, { detail });
    this.name = "ContextError";
  }
}

function invalidRecord(record, field, reason = "invalid") {
  throw new ContextError("invalid-record", {
    id: record?.id ?? null,
    field,
    reason,
  });
}

export function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    invalidRecord(record, "record");
  }
  if (record.v !== 1) {
    if (record.v !== undefined) {
      throw new ContextError("unsupported-record-version", {
        id: record.id ?? null,
        version: record.v,
      });
    }
    invalidRecord(record, "v", "required");
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    invalidRecord(record, "id");
  }
  if (!RECORD_KINDS.has(record.kind)) {
    invalidRecord(record, "kind");
  }
  if (!Number.isInteger(record.priority)) {
    invalidRecord(record, "priority");
  }
  if (
    !Array.isArray(record.scope)
    || record.scope.length === 0
    || record.scope.some((entry) => typeof entry !== "string")
  ) {
    invalidRecord(record, "scope");
  }
  if (
    !Array.isArray(record.links)
    || record.links.some((entry) => typeof entry !== "string")
  ) {
    invalidRecord(record, "links");
  }
  if (
    record.locators !== undefined
    && (
      !Array.isArray(record.locators)
      || record.locators.some(
        (locator) => !locator
          || typeof locator !== "object"
          || typeof locator.type !== "string"
          || typeof locator.path !== "string"
          || locator.path.length === 0,
      )
    )
  ) {
    invalidRecord(record, "locators");
  }
  for (const [field, limit] of Object.entries(SEARCH_LIMITS)) {
    if (record[field] === undefined) continue;
    if (
      !Array.isArray(record[field])
      || record[field].length > limit
      || record[field].some((value) =>
        typeof value !== "string" || normalized(value).length === 0)
    ) {
      throw new ContextError("invalid-record-search-metadata", {
        id: record.id,
        field,
        max: limit,
      });
    }
    const values = record[field].map(normalized);
    if (new Set(values).size !== values.length) {
      throw new ContextError(
        field === "aliases"
          ? "duplicate-record-alias"
          : "duplicate-record-topic",
        {
        id: record.id,
        field,
        },
      );
    }
  }
  const invalidCoverage = (record.covers ?? []).filter(
    (category) => !COVERAGE_CATEGORIES.includes(category),
  );
  if (
    record.covers !== undefined
    && (!Array.isArray(record.covers) || invalidCoverage.length > 0)
  ) {
    throw new ContextError("invalid-coverage-category", {
      id: record.id,
      categories: invalidCoverage,
    });
  }
  if (
    record.routes !== undefined
    && (
      !record.routes
      || Array.isArray(record.routes)
      || typeof record.routes !== "object"
      || Object.values(record.routes).some((target) =>
        typeof target !== "string" || target.length === 0)
    )
  ) {
    throw new ContextError("invalid-record-routes", { id: record.id });
  }
  if (record.vocabulary !== undefined) {
    if (
      record.id !== "g:index:vocabulary"
      || !record.vocabulary
      || Array.isArray(record.vocabulary)
      || typeof record.vocabulary !== "object"
    ) {
      throw new ContextError("invalid-vocabulary", { id: record.id });
    }
    const aliasOwners = new Map();
    const concepts = new Map();
    for (const [rawConcept, rawAliases] of Object.entries(record.vocabulary)) {
      const concept = normalized(rawConcept);
      if (
        !concept
        || !Array.isArray(rawAliases)
        || rawAliases.length > 12
        || rawAliases.some((alias) =>
          typeof alias !== "string" || !normalized(alias))
      ) {
        throw new ContextError("invalid-vocabulary", {
          id: record.id,
          concept: rawConcept,
        });
      }
      const aliases = rawAliases.map(normalized);
      if (new Set(aliases).size !== aliases.length) {
        throw new ContextError("duplicate-vocabulary-alias", {
          id: record.id,
          concept,
        });
      }
      for (const alias of aliases) {
        const owner = aliasOwners.get(alias);
        if (owner && owner !== concept) {
          throw new ContextError("ambiguous-vocabulary-alias", {
            id: record.id,
            alias,
            concepts: [owner, concept],
          });
        }
        aliasOwners.set(alias, concept);
      }
      concepts.set(concept, aliases);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (concept) => {
      if (visiting.has(concept)) {
        throw new ContextError("vocabulary-cycle", {
          id: record.id,
          concept,
        });
      }
      if (visited.has(concept)) return;
      visiting.add(concept);
      for (const alias of concepts.get(concept) ?? []) {
        if (concepts.has(alias)) visit(alias);
      }
      visiting.delete(concept);
      visited.add(concept);
    };
    for (const concept of concepts.keys()) visit(concept);
  }
  return record;
}

function projectIdFor(record) {
  return record.scope
    .find((scope) => scope.startsWith("project:"))
    ?.slice("project:".length);
}

function validateLocator(locator, record, roots) {
  const absolute = path.isAbsolute(locator.path)
    || path.win32.isAbsolute(locator.path)
    || path.posix.isAbsolute(locator.path);
  if (locator.type === "external-file") {
    if (!absolute) {
      throw new ContextError("invalid-locator", {
        id: record.id,
        path: locator.path,
        reason: "external-path-not-absolute",
      });
    }
    return;
  }
  if (locator.type !== "file") {
    throw new ContextError("invalid-locator", {
      id: record.id,
      path: locator.path,
      reason: "unsupported-type",
    });
  }
  if (absolute) {
    throw new ContextError("locator-escape", {
      id: record.id,
      path: locator.path,
    });
  }
  if (roots.length === 0) {
    throw new ContextError("invalid-locator", {
      id: record.id,
      path: locator.path,
      reason: "project-root-missing",
    });
  }
  for (const root of roots) {
    const resolved = path.resolve(root, locator.path);
    const relative = path.relative(path.resolve(root), resolved);
    if (
      relative === ""
      || (!relative.startsWith(`..${path.sep}`) && relative !== ".."
        && !path.isAbsolute(relative))
    ) {
      return;
    }
  }
  throw new ContextError("locator-escape", {
    id: record.id,
    path: locator.path,
  });
}

export function validateGraph({ catalog, records }) {
  if (
    !catalog
    || catalog.v !== 1
    || !Array.isArray(catalog.projects)
  ) {
    throw new ContextError("invalid-catalog");
  }
  const projects = new Map(
    catalog.projects.map((project) => [
      project.id,
      Array.isArray(project.roots) ? project.roots : [],
    ]),
  );
  const ids = new Set(catalog.projects.map((project) => project.id));
  for (const record of records) {
    validateRecord(record);
    if (ids.has(record.id)) {
      throw new ContextError("duplicate-id", { id: record.id });
    }
    ids.add(record.id);
  }
  for (const record of records) {
    for (const link of record.links) {
      if (!ids.has(link)) {
        throw new ContextError("broken-link", { id: record.id, link });
      }
    }
    for (const [route, target] of Object.entries(record.routes ?? {})) {
      if (!ids.has(target)) {
        throw new ContextError("broken-route", {
          id: record.id,
          route,
          target,
        });
      }
    }
    const projectId = projectIdFor(record);
    const roots = projectId ? projects.get(projectId) ?? [] : [];
    for (const locator of record.locators ?? []) {
      validateLocator(locator, record, roots);
    }
  }
  return { catalog, records };
}
