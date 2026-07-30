#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalStringify } from "../lib/canonical-json.mjs";
import { optionValue } from "../lib/cli-options.mjs";
import { errorResult, LodestarError, wrapError } from "../lib/errors.mjs";
import { isMainModule } from "../lib/main-entry.mjs";
import { nativeProjectPath } from "../lib/native-path.mjs";
import { resolveStateHome } from "../lib/state-home.mjs";
import { readStoreSource, updateStore } from "./tool-store.mjs";

const IMPORTER_ID = "lodestar-project-registry-v1";
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_STRING_BYTES = 8 * 1024;
const MAX_LIST_ITEMS = 64;
const SUPPORTED_FIELDS = new Set([
  "id",
  "project_id",
  "slug",
  "name",
  "aliases",
  "path",
  "repo_path",
  "alt_paths",
  "roots",
  "stack",
  "description",
  "status",
  "activity_summary",
  "is_git_repo",
  "test_cmd",
  "build_cmd",
  "typecheck_cmd",
  "test",
  "build",
  "typecheck",
  "entry_points",
  "entrypoints",
  "endpoints",
  "memory_anchors",
]);

export function normalizeProjectRoot(value, runtime) {
  const raw = String(value).trim();
  const slashPath = raw.replaceAll("\\", "/");
  const windows = slashPath.match(/^([a-z]):\/(.*)$/i);
  if (windows) {
    return `${windows[1].toUpperCase()}:/${windows[2]}`;
  }
  const mountedDrive = slashPath.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (mountedDrive) {
    return `${mountedDrive[1].toUpperCase()}:/${mountedDrive[2]}`;
  }
  if (/^\/\/(?:wsl\.localhost|wsl\$)\//i.test(slashPath)) {
    return slashPath;
  }
  return nativeProjectPath(raw, runtime);
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").trim()
    .replace(/\s+/g, " ");
}

function identityText(value) {
  return normalizedText(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function pathKey(value) {
  let normalized = String(value).replaceAll("\\", "/").replace(/\/+$/, "");
  const mountedDrive = normalized.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (mountedDrive) {
    normalized = `${mountedDrive[1]}:/${mountedDrive[2]}`;
  }
  return process.platform === "win32"
      || /^[a-z]:\//i.test(normalized)
      || /^\/mnt\/[a-z]\//i.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function assertBoundedString(value, field, project, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new LodestarError(
        "registry-project-invalid",
        `Registry project ${project} requires ${field}`,
        { detail: { project, field, reason: "required" } },
      );
    }
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new LodestarError(
      "registry-project-invalid",
      `Registry project ${project} has an invalid ${field}`,
      { detail: { project, field, reason: "non-empty-string-required" } },
    );
  }
  const normalized = normalizedText(value);
  if (Buffer.byteLength(normalized) > MAX_STRING_BYTES) {
    throw new LodestarError(
      "registry-project-too-large",
      `Registry project ${project} exceeds the ${field} size limit`,
      {
        detail: {
          project,
          field,
          max_bytes: MAX_STRING_BYTES,
        },
      },
    );
  }
  return normalized;
}

function stringList(value, field, project) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length > MAX_LIST_ITEMS
    || values.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new LodestarError(
      "registry-project-invalid",
      `Registry project ${project} has an invalid ${field}`,
      {
        detail: {
          project,
          field,
          reason: "bounded-string-list-required",
          max_items: MAX_LIST_ITEMS,
        },
      },
    );
  }
  const seen = new Set();
  return values.map((entry) =>
    assertBoundedString(entry, field, project, { required: true }))
    .filter((entry) => {
      const key = normalizedText(entry).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function boundedJson(value, field, project) {
  if (value === undefined || value === null) return undefined;
  if (
    !["string", "number", "boolean", "object"].includes(typeof value)
    || typeof value === "function"
  ) {
    throw new LodestarError(
      "registry-project-invalid",
      `Registry project ${project} has an invalid ${field}`,
      { detail: { project, field, reason: "json-value-required" } },
    );
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw wrapError(
      error,
      "registry-project-invalid",
      `Registry project ${project} has a non-serializable ${field}`,
      { project, field },
    );
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_STRING_BYTES) {
    throw new LodestarError(
      "registry-project-too-large",
      `Registry project ${project} exceeds the ${field} size limit`,
      {
        detail: {
          project,
          field,
          max_bytes: MAX_STRING_BYTES,
        },
      },
    );
  }
  return structuredClone(value);
}

function uniqueRoots(values, runtime) {
  const seen = new Set();
  return values
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => normalizeProjectRoot(value, runtime))
    .filter((value) => {
      const key = pathKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function commandMap(entry, name) {
  return Object.fromEntries([
    ["test", entry.test_cmd ?? entry.test],
    ["build", entry.build_cmd ?? entry.build],
    ["typecheck", entry.typecheck_cmd ?? entry.typecheck],
  ].filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [
      key,
      assertBoundedString(value, `${key}_cmd`, name, { required: true }),
    ]));
}

function registryKey(entry, name, roots) {
  const explicit = entry.id ?? entry.project_id ?? entry.slug;
  if (explicit !== undefined) {
    return `explicit:${identityText(
      assertBoundedString(explicit, "id", name, { required: true }),
    )}`;
  }
  return `name:${identityText(name)}|root:${pathKey(roots[0])}`;
}

function parseRegistryProjects(input, nativeSource, runtime) {
  if (!input || !Array.isArray(input.projects)) {
    throw new LodestarError(
      "registry-invalid",
      "Registry must contain a projects array",
      { detail: { source: nativeSource, field: "projects" } },
    );
  }
  const seenKeys = new Set();
  return input.projects.map((entry, index) => {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Buffer.byteLength(JSON.stringify(entry)) > MAX_ENTRY_BYTES
    ) {
      throw new LodestarError(
        "registry-project-invalid",
        `Registry project at index ${index} is invalid or too large`,
        { detail: { index, max_bytes: MAX_ENTRY_BYTES } },
      );
    }
    const unknown = Object.keys(entry)
      .filter((field) => !SUPPORTED_FIELDS.has(field))
      .sort();
    if (unknown.length > 0) {
      throw new LodestarError(
        "registry-fields-unsupported",
        `Registry project at index ${index} contains unsupported fields`,
        {
          detail: {
            index,
            project: entry.name ?? null,
            fields: unknown,
            repair:
              "Add a bounded field adapter before importing so data is not silently discarded.",
          },
        },
      );
    }
    const name = assertBoundedString(
      entry.name,
      "name",
      `index ${index}`,
      { required: true },
    );
    const roots = uniqueRoots([
      entry.path,
      entry.repo_path,
      ...stringList(entry.alt_paths, "alt_paths", name),
      ...stringList(entry.roots, "roots", name),
    ], runtime);
    if (roots.length === 0) {
      throw new LodestarError(
        "registry-project-invalid",
        `Registry project ${name} has no root`,
        { detail: { project: name, field: "roots", reason: "required" } },
      );
    }
    const key = registryKey(entry, name, roots);
    if (seenKeys.has(key)) {
      throw new LodestarError(
        "registry-project-duplicate",
        `Registry contains duplicate project identity ${key}`,
        { detail: { project: name, registry_key: key } },
      );
    }
    seenKeys.add(key);
    if (
      entry.is_git_repo !== undefined
      && typeof entry.is_git_repo !== "boolean"
    ) {
      throw new LodestarError(
        "registry-project-invalid",
        `Registry project ${name} has an invalid is_git_repo`,
        {
          detail: {
            project: name,
            field: "is_git_repo",
            reason: "boolean-required",
          },
        },
      );
    }
    return {
      key,
      name,
      aliases: stringList(entry.aliases, "aliases", name),
      roots,
      stack: stringList(entry.stack, "stack", name),
      commands: commandMap(entry, name),
      description: assertBoundedString(entry.description, "description", name),
      status: assertBoundedString(entry.status, "status", name),
      activity: boundedJson(entry.activity_summary, "activity_summary", name),
      isGitRepo: entry.is_git_repo === undefined
        ? undefined
        : entry.is_git_repo,
      entrypoints: boundedJson(
        entry.entry_points ?? entry.entrypoints,
        "entrypoints",
        name,
      ),
      endpoints: boundedJson(entry.endpoints, "endpoints", name),
      memoryAnchors: stringList(
        entry.memory_anchors,
        "memory_anchors",
        name,
      ),
    };
  });
}

function mergeUnique(left = [], right = [], key = (value) =>
  normalizedText(value).toLowerCase()) {
  const seen = new Set();
  return [...left, ...right].filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function projectMatches(catalog, incoming) {
  const byRegistryKey = catalog.filter((project) =>
    project.provenance?.registry_key === incoming.key);
  if (byRegistryKey.length > 0) return byRegistryKey;
  const byName = catalog.filter((project) =>
    identityText(project.name) === identityText(incoming.name));
  if (byName.length > 0) return byName;
  const primaryRoot = pathKey(incoming.roots[0]);
  const byPrimaryRoot = catalog.filter((project) =>
    project.roots?.[0] && pathKey(project.roots[0]) === primaryRoot);
  if (byPrimaryRoot.length > 0) return byPrimaryRoot;
  const incomingRoots = new Set(incoming.roots.map(pathKey));
  const byRoot = catalog.filter((project) =>
    (project.roots ?? []).some((root) => incomingRoots.has(pathKey(root))));
  if (byRoot.length > 0) return byRoot;
  const names = new Set(incoming.aliases.map(identityText));
  return catalog.filter((project) =>
    [project.name, ...(project.aliases ?? [])]
      .some((value) => names.has(identityText(value))));
}

function portfolioRecords(project, incoming, nativeSource, timestamp, prior) {
  const base = `${project.id}:portfolio`;
  const priorById = new Map(
    (prior ?? []).map((record) => [record.id, record]),
  );
  const operationLinks = [];
  if (
    Object.keys(incoming.commands).length > 0
    || incoming.entrypoints !== undefined
    || incoming.endpoints !== undefined
  ) {
    operationLinks.push(`${base}:operations`);
  }
  if (incoming.memoryAnchors.length > 0) {
    operationLinks.push(`${base}:memory`);
  }
  const verified = (id) => ({
    at: priorById.get(id)?.verified?.at ?? timestamp,
    source: `registry:${path.basename(nativeSource)}`,
  });
  const common = (id) => ({
    v: 1,
    id,
    priority: 760,
    scope: [`project:${project.id}`],
    links: [],
    ownership: "imported",
    generated_by: IMPORTER_ID,
    source_key: incoming.key,
    verified: verified(id),
  });
  const records = [{
    ...common(base),
    kind: "index",
    priority: 805,
    aliases: mergeUnique(
      [incoming.name, ...incoming.aliases, "project portfolio"],
      [],
    ).slice(0, 12),
    topics: ["project.identity", "project.portfolio"],
    summary: incoming.description ?? `${incoming.name} project portfolio`,
    facts: {
      name: incoming.name,
      ...(incoming.status ? { status: incoming.status } : {}),
      ...(incoming.activity !== undefined
        ? { activity_summary: incoming.activity }
        : {}),
      ...(incoming.isGitRepo !== undefined
        ? { is_git_repo: incoming.isGitRepo }
        : {}),
    },
    covers: ["identity"],
    links: operationLinks,
  }];
  if (operationLinks.includes(`${base}:operations`)) {
    records.push({
      ...common(`${base}:operations`),
      kind: "command",
      aliases: ["project operations", "project commands", "project endpoints"],
      topics: ["project.commands", "project.entrypoints", "project.environment"],
      summary: `Operational routes imported for ${incoming.name}`,
      ...(Object.keys(incoming.commands).length > 0
        ? { commands: incoming.commands }
        : {}),
      ...(incoming.entrypoints !== undefined
        ? { entrypoints: incoming.entrypoints }
        : {}),
      ...(incoming.endpoints !== undefined
        ? { endpoints: incoming.endpoints }
        : {}),
      covers: [
        ...(Object.keys(incoming.commands).length > 0 ? ["commands"] : []),
        ...(incoming.entrypoints !== undefined ? ["entrypoints"] : []),
        ...(incoming.endpoints !== undefined ? ["environment"] : []),
      ],
      startup: false,
    });
  }
  if (operationLinks.includes(`${base}:memory`)) {
    records.push({
      ...common(`${base}:memory`),
      kind: "memory",
      aliases: ["project memory anchors", "durable project context"],
      topics: ["project.memory"],
      summary: `Durable memory anchors imported for ${incoming.name}`,
      facts: { memory_anchors: incoming.memoryAnchors },
      covers: ["memory"],
      startup: false,
    });
  }
  return records;
}

function withoutRefreshMetadata(value) {
  const clone = structuredClone(value);
  if (clone.provenance) delete clone.provenance.synced;
  if (clone.verified) delete clone.verified.at;
  return clone;
}

function sameMeaning(left, right) {
  return canonicalStringify(withoutRefreshMetadata(left))
    === canonicalStringify(withoutRefreshMetadata(right));
}

function buildMergePlan({
  source,
  incomingProjects,
  nativeSource,
  force,
  idFactory,
  assignedIds,
  timestamp,
}) {
  const existingCatalog = force ? [] : source.catalog.projects;
  const catalog = force ? [] : structuredClone(source.catalog.projects);
  const projectRecords = force
    ? {}
    : structuredClone(source.projectRecords);
  const changes = [];
  for (const incoming of incomingProjects) {
    const matches = projectMatches(existingCatalog, incoming);
    if (matches.length > 1) {
      throw new LodestarError(
        "registry-project-ambiguous",
        `Registry project ${incoming.name} matches multiple Lodestar projects`,
        {
          detail: {
            project: incoming.name,
            matches: matches.map(({ id }) => id).sort(),
          },
        },
      );
    }
    const existing = matches[0] ?? null;
    let id = existing?.id ?? assignedIds.get(incoming.key);
    if (!id) {
      id = `p:${idFactory()}`;
      assignedIds.set(incoming.key, id);
    }
    const index = catalog.findIndex((project) => project.id === id);
    const priorProject = index >= 0 ? catalog[index] : null;
    const project = {
      ...(priorProject ?? {}),
      id,
      name: incoming.name,
      aliases: mergeUnique(
        incoming.aliases,
        priorProject?.aliases ?? [],
      ),
      roots: mergeUnique(
        incoming.roots,
        priorProject?.roots ?? [],
        pathKey,
      ),
      ...(incoming.stack.length > 0 || priorProject?.stack
        ? {
          stack: mergeUnique(
            incoming.stack,
            priorProject?.stack ?? [],
          ),
        }
        : {}),
      ...(Object.keys(incoming.commands).length > 0 || priorProject?.commands
        ? {
          commands: {
            ...(priorProject?.commands ?? {}),
            ...incoming.commands,
          },
        }
        : {}),
      ...(incoming.status || priorProject?.status
        ? { status: incoming.status ?? priorProject.status }
        : {}),
      provenance: {
        ...(priorProject?.provenance ?? {}),
        source: path.basename(nativeSource),
        registry_key: incoming.key,
        imported: priorProject?.provenance?.imported ?? timestamp,
        synced: priorProject?.provenance?.synced ?? timestamp,
      },
    };
    const currentRecords = projectRecords[id] ?? [];
    const priorImported = currentRecords.filter(
      ({ generated_by: generatedBy }) => generatedBy === IMPORTER_ID,
    );
    let imported = portfolioRecords(
      project,
      incoming,
      nativeSource,
      timestamp,
      priorImported,
    );
    const projectChanged = !priorProject || !sameMeaning(priorProject, project);
    const priorImportedById = new Map(
      priorImported.map((record) => [record.id, record]),
    );
    const recordsChanged = imported.length !== priorImported.length
      || imported.some((record) =>
        !priorImportedById.has(record.id)
        || !sameMeaning(priorImportedById.get(record.id), record));
    if (projectChanged || recordsChanged) {
      project.provenance.synced = timestamp;
      imported = imported.map((record) => ({
        ...record,
        verified: { ...record.verified, at: timestamp },
      }));
    }
    if (index >= 0) catalog[index] = project;
    else catalog.push(project);
    projectRecords[id] = [
      ...currentRecords.filter(
        ({ generated_by: generatedBy }) => generatedBy !== IMPORTER_ID,
      ),
      ...imported,
    ].sort((left, right) => left.id.localeCompare(right.id));
    changes.push({
      id,
      name: incoming.name,
      action: existing
        ? projectChanged || recordsChanged ? "updated" : "unchanged"
        : "added",
      records: imported.map(({ id: recordId }) => recordId),
    });
  }
  catalog.sort((left, right) => left.id.localeCompare(right.id));
  const removed = force
    ? source.catalog.projects
      .filter(({ id }) => !catalog.some((project) => project.id === id))
      .map(({ id }) => id)
      .sort()
    : [];
  return {
    catalog,
    projectRecords,
    changes,
    removed,
    changed: changes.some(({ action }) => action !== "unchanged")
      || removed.length > 0,
  };
}

function resultFor(plan, generation, dryRun) {
  const count = (action) =>
    plan.changes.filter((change) => change.action === action).length;
  return {
    ok: true,
    dry_run: dryRun,
    changed: plan.changed,
    added: count("added"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    imported: plan.changes.length,
    removed: plan.removed,
    projects: plan.changes,
    generation,
  };
}

export async function migrateRegistry({
  home,
  sourcePath,
  force = false,
  dryRun = false,
  idFactory = randomUUID,
  now = () => new Date(),
  runtime,
} = {}) {
  if (!home) {
    throw new LodestarError("state-home-required", "home is required");
  }
  if (!sourcePath) {
    throw new LodestarError(
      "registry-source-required",
      "sourcePath is required",
    );
  }
  const nativeSource = nativeProjectPath(sourcePath, runtime);
  let input;
  try {
    input = JSON.parse(await readFile(nativeSource, "utf8"));
  } catch (error) {
    throw wrapError(
      error,
      "registry-read-failed",
      `Unable to read project registry ${nativeSource}`,
      { source: nativeSource },
    );
  }
  const incomingProjects = parseRegistryProjects(input, nativeSource, runtime);
  const timestamp = now().toISOString();
  const assignedIds = new Map();
  const before = await readStoreSource(home);
  const preview = buildMergePlan({
    source: before,
    incomingProjects,
    nativeSource,
    force,
    idFactory,
    assignedIds,
    timestamp,
  });
  if (dryRun || !preview.changed) {
    return resultFor(preview, before.generation.id, dryRun);
  }
  let applied;
  const update = await updateStore({
    home,
    op: "migrate-registry",
    detail: () => ({
      source: nativeSource,
      force,
      added: applied.changes.filter(({ action }) => action === "added").length,
      updated: applied.changes
        .filter(({ action }) => action === "updated").length,
      removed: applied.removed.length,
    }),
    now,
    transform(source) {
      applied = buildMergePlan({
        source,
        incomingProjects,
        nativeSource,
        force,
        idFactory,
        assignedIds,
        timestamp,
      });
      source.catalog.projects = applied.catalog;
      source.projectRecords = applied.projectRecords;
      return applied;
    },
  });
  return resultFor(applied, update.generation, false);
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const result = await migrateRegistry({
      home: resolveStateHome({
        explicit: optionValue(args, "--home"),
      }),
      sourcePath: optionValue(args, "--from"),
      force: args.includes("--force"),
      dryRun: args.includes("--dry-run"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = errorResult(error);
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: failure })}\n`,
    );
    process.exitCode = 2;
  }
}
