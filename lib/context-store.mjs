import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BUDGETS_V1 } from "./budgets.mjs";
import {
  decorateRecord,
  locatorWarnings,
  recordCard,
} from "./cards.mjs";
import {
  readCurrentGeneration,
} from "./generation.mjs";
import { searchTerms } from "./indexes.mjs";
import { canonicalStringify } from "./canonical-json.mjs";
import { nativeProjectPath } from "./native-path.mjs";
import {
  canonicalProjectRoot,
  comparablePath,
  resolveProjectAt,
} from "./project-roots.mjs";
import { resolveLinks } from "./resolve.mjs";
import {
  projectFileStem,
  projectShardPath,
} from "./store-layout.mjs";
import {
  ContextError,
  COVERAGE_CATEGORIES,
  validateCatalog,
  validateGraph,
  validateRecord,
} from "./validation.mjs";
import { updateStore } from "../tools/tool-store.mjs";

async function readJson(file, fsApi) {
  try {
    return JSON.parse(await (fsApi.readFile ?? fs.readFile)(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ContextError("store-file-missing", { path: file });
    }
    if (error instanceof SyntaxError) {
      throw new ContextError("invalid-json", { path: file });
    }
    throw error;
  }
}

async function readJsonLines(file, fsApi, optional = false) {
  const text = await (fsApi.readFile ?? fs.readFile)(file, "utf8").catch(
    (error) => {
      if (optional && error.code === "ENOENT") return "";
      if (error.code === "ENOENT") {
        throw new ContextError("store-file-missing", { path: file });
      }
      throw error;
    },
  );
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new ContextError("invalid-jsonl", {
          path: file,
          line: index + 1,
        });
      }
    });
}

function scopesEqual(left, right) {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function projectBySelector(catalog, selector) {
  if (!selector) return null;
  const normalizeName = (value) =>
    String(value).toLowerCase().replace(/[\s_-]+/g, "");
  const wanted = normalizeName(selector);
  const exact = catalog.projects.filter((project) =>
    [project.id, project.name, ...(project.aliases ?? [])]
      .filter(Boolean)
      .some((value) => normalizeName(value) === wanted));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new ContextError("project-ambiguous", {
      query: selector,
      matches: exact.map(({ id }) => id),
    });
  }
  const partial = catalog.projects.filter((project) =>
    [project.id, project.name, ...(project.aliases ?? [])]
      .filter(Boolean)
      .some((value) => normalizeName(value).includes(wanted)));
  if (partial.length === 1) return partial[0];
  throw new ContextError(
    partial.length > 1 ? "project-ambiguous" : "project-not-found",
    {
      query: selector,
      matches: partial.map(({ id }) => id),
    },
  );
}

export class ContextStore {
  static async open({
    home,
    cwd = process.cwd(),
    project = null,
    fsApi = fs,
    platform = process.platform,
    env = process.env,
    release,
  } = {}) {
    const generation = await readCurrentGeneration(home, { fsApi });
    const catalog = await readJson(
      path.join(generation.root, "catalog.json"),
      fsApi,
    );
    validateCatalog(catalog);
    const routes = await readJson(
      path.join(generation.root, "indexes", "routes.json"),
      fsApi,
    );
    const locatorHealth = await readJson(
      path.join(generation.root, "indexes", "locator-health.json"),
      fsApi,
    );
    for (const [file, index] of [
      ["indexes/routes.json", routes],
      ["indexes/locator-health.json", locatorHealth],
    ]) {
      if (index?.generation !== generation.id) {
        throw new ContextError("index-generation-mismatch", {
          file,
          expected: generation.id,
          actual: index?.generation ?? null,
        });
      }
    }

    let resolved;
    const selected = projectBySelector(catalog, project);
    if (selected) {
      const canonicalCwd = await (fsApi.realpath ?? fs.realpath)(cwd);
      let selectedRoot = null;
      for (const candidate of selected.roots ?? []) {
        try {
          selectedRoot = await canonicalProjectRoot(candidate, {
            fsApi,
            platform,
            env,
            ...(release === undefined ? {} : { release }),
            cwd: canonicalCwd,
          });
          break;
        } catch {
          // An explicitly selected project may be temporarily unavailable.
        }
      }
      resolved = {
        cwd: canonicalCwd,
        project: selected,
        root: selectedRoot,
      };
    } else {
      resolved = await resolveProjectAt({
        catalog,
        cwd,
        fsApi,
        platform,
        env,
        ...(release === undefined ? {} : { release }),
      });
    }
    return new ContextStore({
      home,
      generation,
      catalog,
      routes,
      locatorHealth,
      project: resolved.project,
      cwd: resolved.cwd,
      root: resolved.root,
      fsApi,
      platform,
      env,
      release,
    });
  }

  constructor({
    home,
    generation,
    catalog,
    routes,
    locatorHealth,
    project,
    cwd,
    root,
    fsApi,
    platform,
    env,
    release,
  }) {
    this.home = home;
    this.generation = generation;
    this.catalog = catalog;
    this.routes = routes;
    this.locatorHealth = locatorHealth;
    this.project = project;
    this.cwd = cwd;
    this.root = root;
    this.fsApi = fsApi;
    this.platform = platform;
    this.env = env;
    this.release = release;
    this.shardCache = new Map();
    this.allowedScopes = new Set([
      "global",
      ...(project ? [`project:${project.id}`] : []),
    ]);
  }

  routeFor(id) {
    const route = this.routes.records?.[id];
    if (!route) throw new ContextError("record-not-found", { id });
    if (
      !Array.isArray(route.scope)
      || !route.scope.some((scope) => this.allowedScopes.has(scope))
    ) {
      throw new ContextError("scope-denied", {
        id,
        allowed: [...this.allowedScopes],
        actual: route.scope ?? [],
      });
    }
    return route;
  }

  async get(id) {
    const project = this.catalog.projects.find((entry) => entry.id === id);
    if (project) {
      if (this.project?.id !== project.id) {
        throw new ContextError("scope-denied", {
          id,
          allowed: [...this.allowedScopes],
          actual: [`project:${project.id}`],
        });
      }
      return structuredClone(project);
    }
    const route = this.routeFor(id);
    const shard = path.resolve(this.generation.root, route.shard);
    const relative = path.relative(this.generation.root, shard);
    if (
      relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new ContextError("invalid-route", { id, shard: route.shard });
    }
    let records = this.shardCache.get(shard);
    if (!records) {
      records = await readJsonLines(shard, this.fsApi);
      this.shardCache.set(shard, records);
    }
    const record = records
      .find((candidate) => candidate.id === id);
    if (!record) throw new ContextError("record-not-found", { id });
    validateRecord(record);
    if (
      !scopesEqual(record.scope, route.scope)
      || !record.scope.some((scope) => this.allowedScopes.has(scope))
    ) {
      throw new ContextError("scope-denied", {
        id,
        allowed: [...this.allowedScopes],
        actual: record.scope,
      });
    }
    return decorateRecord(record, this.locatorHealth);
  }

  async recordsInScope() {
    const shards = [...new Set(
      Object.values(this.routes.records ?? {})
        .filter((route) =>
          route.scope?.some((scope) => this.allowedScopes.has(scope)))
        .map(({ shard }) => shard),
    )].sort((a, b) => a.localeCompare(b));
    const records = [];
    for (const relativeShard of shards) {
      const shard = path.resolve(this.generation.root, relativeShard);
      let shardRecords = this.shardCache.get(shard);
      if (!shardRecords) {
        shardRecords = await readJsonLines(shard, this.fsApi);
        this.shardCache.set(shard, shardRecords);
      }
      for (const record of shardRecords) {
        validateRecord(record);
        let withinScope = true;
        if (record.within && this.project && this.root) {
          const relative = comparablePath(
            path.relative(this.root, this.cwd),
          ).replace(/^\/+/, "");
          const within = comparablePath(record.within).replace(/^\/+/, "");
          withinScope = relative === within
            || relative.startsWith(`${within}/`);
        }
        if (
          withinScope
          && record.scope.some((scope) => this.allowedScopes.has(scope))
        ) {
          records.push(record);
        }
      }
    }
    return records.sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
    );
  }

  projectCard() {
    if (!this.project) return null;
    return Object.fromEntries([
      ["id", this.project.id],
      ["name", this.project.name],
      ["aliases", this.project.aliases],
      ["roots", this.project.roots],
      ["stack", this.project.stack],
      ["commands", this.project.commands],
      ["memory", this.project.memory],
    ].filter(([, value]) => value !== undefined));
  }

  projectByName(query) {
    return projectBySelector(this.catalog, query);
  }

  async start() {
    const records = await this.recordsInScope();
    const startupRecords = records.filter((record) => record.startup !== false);
    const required = startupRecords
      .filter((record) => record.required)
      .map((record) => decorateRecord(record, this.locatorHealth));
    if (required.length > BUDGETS_V1.start.maxRequired) {
      throw new ContextError("startup-budget-exceeded", {
        reason: "required-record-count",
        actual: required.length,
        limit: BUDGETS_V1.start.maxRequired,
      });
    }
    const available = startupRecords
      .filter((record) => !record.required)
      .map((record) => recordCard(record, this.locatorHealth));
    const warnings = locatorWarnings(startupRecords, this.locatorHealth);
    const fixed = {
      v: 1,
      agent: "codex",
      generation: this.generation.id,
      cwd: this.cwd,
      project: this.projectCard(),
      required,
      warnings,
      protocol: {
        lookup:
          "agentctx get <id> | agentctx resolve <id> | agentctx find <terms>",
        fallback: "targeted repository inspection after context-miss",
        read: "global plus current project only",
      },
    };
    const maxAvailable = Math.min(
      available.length,
      BUDGETS_V1.start.maxAvailable,
    );
    for (let count = maxAvailable; count >= 0; count -= 1) {
      const included = available.slice(0, count);
      const omitted = available.slice(count).map(({ id }) => id)
        .sort((a, b) => a.localeCompare(b));
      const packet = {
        ...fixed,
        available: included,
        ...(omitted.length > 0
          ? { truncated: true, omitted_ids: omitted }
          : {}),
      };
      if (
        Buffer.byteLength(JSON.stringify(packet))
        <= BUDGETS_V1.start.maxBytes
      ) {
        return packet;
      }
    }
    throw new ContextError("startup-budget-exceeded", {
      reason: "required-bytes",
      limit: BUDGETS_V1.start.maxBytes,
    });
  }

  async searchIndexes() {
    const files = [
      path.join(this.generation.root, "indexes", "search", "global.json"),
      ...(this.project
        ? [path.join(
          this.generation.root,
          "indexes",
          "search",
          `${projectFileStem(this.project.id)}.json`,
        )]
        : []),
    ];
    const indexes = [];
    for (const file of files) {
      const index = await readJson(file, this.fsApi);
      if (index.generation !== this.generation.id) {
        throw new ContextError("index-generation-mismatch", {
          file,
          expected: this.generation.id,
          actual: index.generation ?? null,
        });
      }
      indexes.push(index);
    }
    return indexes;
  }

  async vocabularyTerms(terms) {
    if (!this.routes.records?.["g:index:vocabulary"]) return null;
    const vocabulary = (await this.get("g:index:vocabulary")).vocabulary ?? {};
    const expanded = terms.flatMap((term) => vocabulary[term] ?? [term]);
    return expanded.join("\0") === terms.join("\0") ? null : expanded;
  }

  async find(query) {
    const originalTerms = searchTerms(query);
    const indexes = await this.searchIndexes();
    const findIds = (terms) => {
      if (terms.length === 0) return [];
      const postings = terms.map((term) => new Set(
        indexes.flatMap((index) => index.terms?.[term] ?? []),
      ));
      return [...postings[0]].filter((id) =>
        postings.slice(1).every((posting) => posting.has(id)));
    };
    let terms = originalTerms;
    let ids = findIds(terms);
    let reformulated = null;
    if (ids.length === 0) {
      const alternatives = await this.vocabularyTerms(terms);
      if (alternatives) {
        terms = alternatives;
        ids = findIds(terms);
        reformulated = { original: originalTerms, terms };
      }
    }
    if (ids.length === 0) {
      return {
        ok: false,
        code: "context-miss",
        query,
        project: this.project?.id ?? null,
        results: [],
        next: ["inspect the current repository with a targeted search"],
      };
    }
    const records = await Promise.all(ids.map((id) => this.get(id)));
    records.sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
    );
    return {
      ok: true,
      query,
      results: records
        .slice(0, BUDGETS_V1.find.maxResults)
        .map((record) => recordCard(record, this.locatorHealth)),
      ...(reformulated ? { reformulated } : {}),
    };
  }

  async resolve(id, options = {}) {
    return resolveLinks({
      root: id,
      depth: options.depth,
      get: (recordId) => this.get(recordId),
    });
  }

  async sourceSnapshot() {
    const schema = await readJson(
      path.join(this.generation.root, "schema", "store.json"),
      this.fsApi,
    );
    const globalRecords = await readJsonLines(
      path.join(this.generation.root, "records", "global.jsonl"),
      this.fsApi,
      true,
    );
    const projectRecords = {};
    for (const project of this.catalog.projects) {
      projectRecords[project.id] = await readJsonLines(
        path.join(this.generation.root, projectShardPath(project.id)),
        this.fsApi,
        true,
      );
    }
    return {
      catalog: structuredClone(this.catalog),
      schema,
      globalRecords,
      projectRecords,
    };
  }

  async put(record, {
    takeOwnership = false,
    appendEvent = this.fsApi.appendFile ?? fs.appendFile,
  } = {}) {
    const supplied = structuredClone(record);
    validateRecord(supplied);
    const hash = (value) => value === null
      ? null
      : createHash("sha256").update(canonicalStringify(value)).digest("hex");
    const update = await updateStore({
      home: this.home,
      op: "put",
      appendEvent,
      detail: (result) => ({
        id: result.record.id,
        previous_hash: result.previous_hash,
        next_hash: result.next_hash,
        ownership_taken: result.ownership_taken,
      }),
      transform(source) {
      let records;
      if (supplied.scope.includes("global") && supplied.id.startsWith("g:")) {
        records = source.globalRecords;
      } else {
        const projectScope = supplied.scope.find((scope) =>
          scope.startsWith("project:"));
        const projectId = projectScope?.slice("project:".length);
        if (
          !projectId
          || !supplied.id.startsWith(`${projectId}:`)
          || !source.projectRecords[projectId]
        ) {
          throw new ContextError("record-scope-not-found", {
            id: supplied.id,
          });
        }
        records = source.projectRecords[projectId];
      }
      const existing = records.findIndex(({ id }) => id === supplied.id);
      const previous = existing >= 0 ? records[existing] : null;
      if (previous?.ownership === "generated" && !takeOwnership) {
        throw new ContextError("generated-record-read-only", {
          id: supplied.id,
          repair:
            "Retry with --take-ownership to convert it to a curated record.",
        });
      }
      const next = takeOwnership
        ? { ...supplied, ownership: "curated" }
        : supplied;
      if (existing >= 0) records[existing] = next;
      else records.push(next);
      records.sort((a, b) => a.id.localeCompare(b.id));
      validateGraph({
        catalog: source.catalog,
        records: [
          ...source.globalRecords,
          ...Object.values(source.projectRecords).flat(),
        ],
      });
      return {
        record: next,
        previous_hash: hash(previous),
        next_hash: hash(next),
        ownership_taken: previous?.ownership === "generated"
          && next.ownership === "curated",
      };
      },
    });
    return update.result.record;
  }

  async coverage({ project: projectQuery = null } = {}) {
    const source = await this.sourceSnapshot();
    const projects = projectQuery
      ? [projectBySelector(this.catalog, projectQuery)]
      : this.catalog.projects;
    const rows = projects.map((project) => {
      const blocked = project.status === "blocked-missing-root";
      const required = blocked
        ? ["identity", "memory"]
        : COVERAGE_CATEGORIES;
      const covered = new Set(["identity"]);
      const records = source.projectRecords[project.id] ?? [];
      for (const record of records) {
        for (const category of record.covers ?? []) covered.add(category);
      }
      const missing = required.filter((category) => !covered.has(category));
      return {
        id: project.id,
        blocked,
        complete: missing.length === 0,
        covered: [...covered].filter((category) => required.includes(category)),
        missing,
        record_ids: records
          .filter((record) => (record.covers ?? []).length > 0)
          .map(({ id }) => id)
          .sort((a, b) => a.localeCompare(b)),
      };
    });
    const reachable = rows.filter(({ blocked }) => !blocked);
    return {
      v: 1,
      reachable: reachable.length,
      blocked: rows.length - reachable.length,
      complete: reachable.filter(({ complete }) => complete).length,
      incomplete: reachable.filter(({ complete }) => !complete).length,
      projects: rows,
    };
  }

  async ask(intent, projectQuery) {
    const project = projectBySelector(this.catalog, projectQuery);
    if (intent === "project.path") {
      return {
        v: 1,
        intent,
        project: project.id,
        source: "agentctx",
        record_ids: [],
        value: { roots: project.roots },
      };
    }
    const category = {
      "project.commands": "commands",
      "project.entrypoints": "entrypoints",
      "project.environment": "environment",
      "project.data": "architecture",
      "project.hazards": "hazards",
      "project.memory": "memory",
    }[intent];
    if (!category) throw new ContextError("intent-not-found", { intent });
    const source = await this.sourceSnapshot();
    const records = (source.projectRecords[project.id] ?? [])
      .filter((record) => (record.covers ?? []).includes(category))
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
      );
    return {
      v: 1,
      intent,
      project: project.id,
      source: "agentctx",
      record_ids: records.map(({ id }) => id),
      value: records,
    };
  }

  async doctor() {
    const issues = [];
    const source = await this.sourceSnapshot();
    const records = [
      ...source.globalRecords,
      ...Object.values(source.projectRecords).flat(),
    ];
    for (const project of this.catalog.projects) {
      let existingRoots = 0;
      const missing = [];
      for (const root of project.roots ?? []) {
        try {
          const nativeRoot = nativeProjectPath(root, {
            platform: this.platform,
            env: this.env,
            release: this.release,
            cwd: this.cwd,
            pathApi: this.platform === "win32" ? path.win32 : path.posix,
          });
          await (this.fsApi.access ?? fs.access)(nativeRoot);
          existingRoots += 1;
        } catch {
          missing.push(root);
        }
      }
      for (const root of missing) {
        issues.push({
          code: "missing-root",
          severity: project.status === "blocked-missing-root"
            ? "blocker"
            : existingRoots > 0
              ? "warning"
              : "error",
          project: project.id,
          root,
        });
      }
    }
    const ids = new Set(this.catalog.projects.map(({ id }) => id));
    for (const record of records) {
      try {
        validateRecord(record);
      } catch (error) {
        issues.push({
          code: "invalid-record",
          severity: "error",
          id: record?.id ?? null,
          reason: error.code ?? "invalid-record",
        });
      }
      if (ids.has(record.id)) {
        issues.push({
          code: "duplicate-id",
          severity: "error",
          id: record.id,
        });
      }
      ids.add(record.id);
    }
    for (const record of records) {
      for (const link of record.links ?? []) {
        if (!ids.has(link)) {
          issues.push({
            code: "broken-link",
            severity: "error",
            id: record.id,
            link,
          });
        }
      }
      for (const [routeName, target] of Object.entries(record.routes ?? {})) {
        if (!ids.has(target)) {
          issues.push({
            code: "broken-route",
            severity: "error",
            id: record.id,
            route: routeName,
            target,
          });
        }
      }
      const route = this.routes.records?.[record.id];
      if (!route || !route.scope || !route.scope.includes(record.scope[0])) {
        issues.push({
          code: "broken-route",
          severity: "error",
          id: record.id,
        });
      }
    }
    const errors = issues.filter(
      ({ severity = "error" }) => severity === "error",
    ).length;
    const warnings = issues.filter(
      ({ severity }) => severity === "warning",
    ).length;
    const blockers = issues.filter(
      ({ severity }) => severity === "blocker",
    ).length;
    return {
      ok: errors === 0 && blockers === 0,
      errors,
      warnings,
      blockers,
      broken_links: issues.filter(({ code }) => code === "broken-link").length,
      counts: {
        projects: this.catalog.projects.length,
        records: records.length,
      },
      issues,
    };
  }
}
