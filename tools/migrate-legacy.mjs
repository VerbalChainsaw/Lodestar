#!/usr/bin/env node

import {
  access,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { optionValue } from "../lib/cli-options.mjs";
import { LodestarError, errorResult, wrapError } from "../lib/errors.mjs";
import { isMainModule } from "../lib/main-entry.mjs";
import { nativeProjectPath } from "../lib/native-path.mjs";
import {
  initializeStateHome,
  resolveStateHome,
} from "../lib/state-home.mjs";
import { validateGraph } from "../lib/validation.mjs";

function parseJson(text, file) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw wrapError(
      error,
      "legacy-json-invalid",
      `Legacy JSON is invalid: ${file}`,
      { file },
    );
  }
}

function parseJsonLines(text, file) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw wrapError(
          error,
          "legacy-jsonl-invalid",
          `Legacy JSONL is invalid: ${file}`,
          { file, line: index + 1 },
        );
      }
    });
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

async function confinedFile(sourceRoot, relative) {
  if (
    typeof relative !== "string"
    || relative.length === 0
    || path.isAbsolute(relative)
    || relative.split(/[\\/]/).includes("..")
  ) {
    throw new LodestarError(
      "legacy-path-invalid",
      "Legacy store contains an unsafe record path",
      { detail: { path: relative ?? null } },
    );
  }
  const selected = path.resolve(sourceRoot, relative);
  let physical;
  try {
    physical = await realpath(selected);
  } catch (error) {
    throw wrapError(
      error,
      "legacy-record-file-unreadable",
      `Unable to read legacy record file ${relative}`,
      { path: relative },
    );
  }
  if (!inside(sourceRoot, physical)) {
    throw new LodestarError(
      "legacy-path-escape",
      "Legacy record path escapes the selected store",
      { detail: { path: relative } },
    );
  }
  return physical;
}

function typedLocator(locator) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return locator;
  }
  if (typeof locator.type === "string") return locator;
  const absolute = path.win32.isAbsolute(locator.path)
    || path.posix.isAbsolute(locator.path);
  return {
    ...locator,
    type: absolute ? "external-file" : "file",
  };
}

function migratedRecord(record, scope) {
  const migrated = {
    v: 1,
    ...record,
    scope: [scope],
    ...(record.locators === undefined
      ? {}
      : { locators: record.locators.map(typedLocator) }),
  };
  if (
    migrated.routes
    && Object.values(migrated.routes).some((target) =>
      typeof target !== "string")
  ) {
    if (migrated.legacy_routes !== undefined) {
      throw new LodestarError(
        "legacy-routes-conflict",
        "Legacy record already contains legacy_routes",
        { detail: { id: migrated.id } },
      );
    }
    migrated.legacy_routes = migrated.routes;
    delete migrated.routes;
  }
  return migrated;
}

async function readLegacySource(sourceHome, packageRoot) {
  let sourceRoot;
  try {
    sourceRoot = await realpath(sourceHome);
  } catch (error) {
    throw wrapError(
      error,
      "legacy-home-unreadable",
      `Legacy Lodestar home is not readable: ${sourceHome}`,
      { home: sourceHome },
    );
  }
  const catalogFile = await confinedFile(sourceRoot, "catalog.json");
  const globalFile = await confinedFile(
    sourceRoot,
    "records/global.jsonl",
  );
  const schemaFile = path.join(packageRoot, "schema", "store.json");
  let catalog;
  let schema;
  let globalRecords;
  try {
    [catalog, schema, globalRecords] = await Promise.all([
      readFile(catalogFile, "utf8").then((text) =>
        parseJson(text, "catalog.json")),
      readFile(schemaFile, "utf8").then((text) =>
        parseJson(text, "schema/store.json")),
      readFile(globalFile, "utf8").then((text) =>
        parseJsonLines(text, "records/global.jsonl")),
    ]);
  } catch (error) {
    if (error instanceof LodestarError) throw error;
    throw wrapError(
      error,
      "legacy-store-read-failed",
      "Unable to read the legacy Lodestar store",
      { home: sourceHome },
    );
  }
  if (catalog?.v !== 1 || !Array.isArray(catalog.projects)) {
    throw new LodestarError(
      "legacy-catalog-invalid",
      "Legacy catalog must be version 1 with a projects array",
    );
  }

  const contexts = new Set();
  const projectRecords = {};
  const projects = [];
  for (const project of catalog.projects) {
    if (
      !project
      || typeof project.id !== "string"
      || typeof project.context !== "string"
    ) {
      throw new LodestarError(
        "legacy-project-invalid",
        "Every legacy project requires an id and context path",
        { detail: { id: project?.id ?? null } },
      );
    }
    if (contexts.has(project.context)) {
      throw new LodestarError(
        "legacy-context-duplicate",
        "Legacy projects cannot share a context shard",
        { detail: { path: project.context } },
      );
    }
    contexts.add(project.context);
    const contextFile = await confinedFile(sourceRoot, project.context);
    let records;
    try {
      records = parseJsonLines(
        await readFile(contextFile, "utf8"),
        project.context,
      );
    } catch (error) {
      if (error instanceof LodestarError) throw error;
      throw wrapError(
        error,
        "legacy-record-file-unreadable",
        `Unable to read legacy record file ${project.context}`,
        { path: project.context },
      );
    }
    const { context: _legacyContext, ...portableProject } = project;
    projects.push(portableProject);
    projectRecords[project.id] = records.map((record) =>
      migratedRecord(record, `project:${project.id}`));
  }

  const source = {
    catalog: { ...catalog, projects },
    schema,
    globalRecords: globalRecords.map((record) =>
      migratedRecord(record, "global")),
    projectRecords,
  };
  validateGraph({
    catalog: source.catalog,
    records: [
      ...source.globalRecords,
      ...Object.values(source.projectRecords).flat(),
    ],
  });
  return source;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function migrateLegacyStore({
  home,
  sourceHome,
  packageRoot = path.resolve(import.meta.dirname, ".."),
  dryRun = false,
  now = () => new Date(),
} = {}) {
  if (!home) {
    throw new LodestarError(
      "state-home-required",
      "A destination Lodestar home is required",
    );
  }
  if (!sourceHome) {
    throw new LodestarError(
      "legacy-home-required",
      "A legacy Lodestar home is required",
    );
  }
  const source = await readLegacySource(sourceHome, packageRoot);
  const summary = {
    projects: source.catalog.projects.length,
    records: source.globalRecords.length
      + Object.values(source.projectRecords)
        .reduce((total, records) => total + records.length, 0),
  };
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      source: sourceHome,
      home,
      ...summary,
    };
  }
  if (await exists(home)) {
    throw new LodestarError(
      "legacy-migration-destination-exists",
      "Legacy migration requires a new destination home",
      {
        detail: {
          home,
          repair: "Choose a new --home or preserve and move the existing destination",
        },
      },
    );
  }
  const migratedAt = now().toISOString();
  let initialized;
  try {
    initialized = await initializeStateHome({
      destination: home,
      packageRoot,
      source,
      event: {
        at: migratedAt,
        op: "migrate-legacy",
        source: path.basename(sourceHome),
        ...summary,
      },
    });
  } catch (error) {
    if (
      error.code === "invalid-state-home"
      || ["EEXIST", "ENOTEMPTY"].includes(error.code)
    ) {
      throw new LodestarError(
        "legacy-migration-destination-exists",
        "Legacy migration requires a new destination home",
        {
          cause: error,
          detail: {
            home,
            repair: "Choose a new --home or preserve and move the existing destination",
          },
        },
      );
    }
    throw wrapError(
      error,
      "legacy-migration-write-failed",
      "Unable to create the migrated Lodestar home",
      { home },
    );
  }
  if (!initialized.created) {
    throw new LodestarError(
      "legacy-migration-destination-exists",
      "Legacy migration requires a new destination home",
      {
        detail: {
          home,
          repair: "Choose a new --home or preserve and move the existing destination",
        },
      },
    );
  }
  return {
    ok: true,
    migrated: true,
    source: sourceHome,
    home,
    generation: initialized.generation,
    ...summary,
  };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const sourceHome = optionValue(args, "--from");
    const result = await migrateLegacyStore({
      home: resolveStateHome({
        explicit: optionValue(args, "--home"),
      }),
      sourceHome: sourceHome === undefined
        ? undefined
        : nativeProjectPath(sourceHome),
      dryRun: args.includes("--dry-run"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: errorResult(error),
    })}\n`);
    process.exitCode = 1;
  }
}
