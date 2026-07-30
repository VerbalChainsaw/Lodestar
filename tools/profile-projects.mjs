#!/usr/bin/env node

// Bounded metadata profiling. This reads small recognized manifests and shallow
// directory names only; it never reads source files or environment-file values.

import { createHash } from "node:crypto";
import {
  access,
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { readFileLimited } from "../lib/bounded-io.mjs";
import { optionValue, optionValues } from "../lib/cli-options.mjs";
import { errorResult } from "../lib/errors.mjs";
import { isMainModule } from "../lib/main-entry.mjs";
import { probeLocatorHealth } from "../lib/locator-health.mjs";
import {
  isWslRuntime,
  nativeProjectPath,
} from "../lib/native-path.mjs";
import { resolveStateHome } from "../lib/state-home.mjs";
import { readStoreSource, updateStore } from "./tool-store.mjs";

const ignored = new Set([
  ".git",
  ".next",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);
const manifestNames = new Set([
  "Cargo.toml",
  "Makefile",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "deno.json",
  "docker-compose.yml",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
]);
const environmentNames = new Set([
  ".env.example",
  ".env.sample",
  ".nvmrc",
  ".python-version",
  "Dockerfile",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);
const entrypointNames = new Set([
  "App.ts",
  "App.tsx",
  "app.js",
  "app.py",
  "cli.js",
  "cli.py",
  "index.js",
  "index.mjs",
  "index.ts",
  "main.go",
  "main.js",
  "main.py",
  "main.rs",
  "main.ts",
  "main.tsx",
  "server.js",
  "server.py",
]);
const dataDirectoryNames = new Set([
  "artifacts",
  "data",
  "database",
  "datasets",
  "db",
  "migrations",
  "output",
  "outputs",
  "prisma",
  "storage",
]);

export function nativePath(
  value,
  runtime = {},
) {
  return isWslRuntime(runtime) ? nativeProjectPath(value, runtime) : value;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function safeProjectRoot(candidate) {
  const translated = nativePath(candidate);
  try {
    const info = await lstat(translated);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return await realpath(translated);
  } catch {
    return null;
  }
}

async function readBounded(file, bytes = 131_072) {
  try {
    return await readFileLimited(file, {
      maximum: bytes,
      encoding: "utf8",
      resource: "project-profile-file-bytes",
    });
  } catch (error) {
    if (
      error.code === "ENOENT"
      || error.code === "EISDIR"
      || error.code === "resource-limit-exceeded"
    ) {
      return null;
    }
    throw error;
  }
}

async function shallowFiles(
  root,
  { maxDepth = 2, maxEntries = 2_000 } = {},
) {
  const output = [];
  async function walk(relative, depth) {
    if (depth > maxDepth || output.length >= maxEntries) return;
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxEntries) return;
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const child = path.posix.join(
        relative.replaceAll("\\", "/"),
        entry.name,
      );
      if (entry.isFile()) output.push(child);
      if (entry.isDirectory()) await walk(child, depth + 1);
    }
  }
  await walk("", 0);
  return output;
}

function parsePyproject(text) {
  if (!text) return {};
  const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  const description = text.match(
    /^\s*description\s*=\s*["']([^"']+)["']/m,
  )?.[1];
  const requiresPython = text.match(
    /^\s*requires-python\s*=\s*["']([^"']+)["']/m,
  )?.[1];
  const scriptsBlock = text.match(
    /^\[project\.scripts\]\s*$([\s\S]*?)(?=^\[|\s*$)/m,
  )?.[1];
  const scripts = {};
  for (const match of scriptsBlock?.matchAll(
    /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/gm,
  ) ?? []) {
    scripts[match[1]] = match[2];
  }
  return { name, description, requiresPython, scripts };
}

function parseMakeTargets(text) {
  if (!text) return [];
  return [...text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*):(?!=)/gm)]
    .map((match) => match[1])
    .filter((name) => !name.includes("%"))
    .slice(0, 24);
}

function unique(values, limit = Infinity) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const key = value.normalize("NFKC").toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function generatedRecord(project, suffix, value) {
  return {
    v: 1,
    id: `${project.id}:profile:${suffix}`,
    priority: 700,
    scope: [`project:${project.id}`],
    links: [],
    ownership: "generated",
    generated_by: "lodestar-profile-v1",
    ...value,
  };
}

export async function inspectProject(
  project,
  root,
  rootValue,
  rootStates,
  timestamp,
) {
  const files = await shallowFiles(root);
  const manifests = files.filter((file) =>
    manifestNames.has(path.posix.basename(file))
  ).slice(0, 24);
  const environment = files.filter((file) => {
    const name = path.posix.basename(file);
    return environmentNames.has(name) || /^\.env\.[^.]+\.example$/.test(name);
  }).slice(0, 50);
  const entrypoints = files.filter((file) =>
    entrypointNames.has(path.posix.basename(file))
  ).slice(0, 50);
  const top = await readdir(root, { withFileTypes: true });
  const directories = top
    .filter((entry) =>
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && !ignored.has(entry.name)
    )
    .map((entry) => entry.name)
    .sort()
    .slice(0, 40);
  const commands = { ...(project.commands ?? {}) };
  const identities = [];
  const declaredEntrypoints = [];

  for (const manifest of manifests) {
    const name = path.posix.basename(manifest);
    const text = await readBounded(path.join(root, manifest));
    if (!text) continue;
    if (name === "package.json") {
      try {
        const parsed = JSON.parse(text);
        if (parsed.name || parsed.description) {
          identities.push({
            source: manifest,
            name: parsed.name,
            description: parsed.description,
          });
        }
        for (const [script, command] of Object.entries(parsed.scripts ?? {})) {
          const key = manifest === "package.json"
            ? script
            : `${path.posix.dirname(manifest)}:${script}`;
          if (Object.keys(commands).length < 40) commands[key] = command;
        }
        for (const value of [parsed.main, parsed.module]) {
          if (typeof value === "string") declaredEntrypoints.push(value);
        }
        if (typeof parsed.bin === "string") {
          declaredEntrypoints.push(parsed.bin);
        } else {
          declaredEntrypoints.push(
            ...Object.values(parsed.bin ?? {}).filter(
              (value) => typeof value === "string",
            ),
          );
        }
      } catch {
        // The locator remains visible even when a recognized manifest is invalid.
      }
    } else if (name === "pyproject.toml") {
      const parsed = parsePyproject(text);
      if (parsed.name || parsed.description) {
        identities.push({
          source: manifest,
          name: parsed.name,
          description: parsed.description,
        });
      }
      for (const [command, target] of Object.entries(parsed.scripts ?? {})) {
        commands[`cli:${command}`] = target;
      }
      if (parsed.requiresPython) {
        commands["requires-python"] = parsed.requiresPython;
      }
    } else if (name === "Makefile") {
      for (const target of parseMakeTargets(text)) {
        commands[`make:${target}`] ??= `make ${target}`;
      }
    }
  }

  const fingerprint = {
    project: project.id,
    root: rootValue,
    stack: project.stack ?? [],
    manifests,
    directories,
    entrypoints,
    environment,
    commands,
  };
  const verified = {
    at: timestamp,
    source: "catalog+bounded-local-profile",
    sha256: createHash("sha256")
      .update(JSON.stringify(fingerprint))
      .digest("hex"),
  };
  const base = project.id;
  const locators = unique([...entrypoints, ...declaredEntrypoints], 50)
    .map((locatorPath) => ({ type: "file", path: locatorPath }));

  return [
    generatedRecord(project, "identity", {
      kind: "index",
      priority: 850,
      covers: ["identity"],
      aliases: unique(project.aliases ?? [], 12),
      topics: ["project.identity"],
      facts: {
        name: project.name,
        aliases: project.aliases ?? [],
        stack: project.stack ?? [],
        local_metadata: identities,
      },
      verified,
      links: [base],
    }),
    generatedRecord(project, "commands", {
      kind: "command",
      priority: 820,
      covers: ["commands"],
      aliases: ["commands", "scripts", "test command", "build command"],
      topics: ["project.commands"],
      commands,
      none_verified: Object.keys(commands).length === 0,
      verified,
      links: [`${base}:profile:identity`],
    }),
    generatedRecord(project, "index", {
      kind: "index",
      priority: 830,
      covers: ["architecture", "entrypoints"],
      aliases: ["architecture", "entry points", "source layout", "main files"],
      topics: ["project.architecture", "project.entrypoints"],
      routes: {
        commands: `${base}:profile:commands`,
        entrypoints: `${base}:profile:index`,
        environment: `${base}:profile:environment`,
        hazards: `${base}:profile:rules`,
        memory: `${base}:profile:memory`,
      },
      architecture: {
        top_level_directories: directories,
        manifests,
        data_locations: directories.filter((name) =>
          dataDirectoryNames.has(name.toLowerCase())
        ),
      },
      locators,
      none_verified: locators.length === 0,
      verified,
      links: [`${base}:profile:identity`],
    }),
    generatedRecord(project, "environment", {
      kind: "environment",
      priority: 810,
      covers: ["environment"],
      aliases: ["environment", "configuration", "runtime setup"],
      topics: ["project.environment"],
      facts: {
        root: rootValue,
        alternate_roots: (project.roots ?? [])
          .filter((candidate) => candidate !== rootValue),
        stack: project.stack ?? [],
        configuration_locators: environment,
      },
      secret_values_read: false,
      verified,
      links: [`${base}:profile:index`],
    }),
    generatedRecord(project, "rules", {
      kind: "rule",
      priority: 900,
      required: true,
      covers: ["rules", "hazards"],
      action: [
        "context-first:agentctx-find-before-broad-search",
        "read:smallest-relevant-file-or-section",
        "scope:stay-inside-canonical-project-root",
        "preserve:dirty-and-unrelated-user-work",
        "secrets:use-configuration-locators-never-values",
      ],
      hazards: {
        excluded_expensive_directories: [...ignored].sort(),
        configuration_locators_may_contain_secrets: environment,
        missing_alternate_roots: rootStates
          .filter((item) => !item.exists)
          .map((item) => item.root),
      },
      verified,
      links: [`${base}:profile:environment`],
    }),
    generatedRecord(project, "decision", {
      kind: "decision",
      priority: 500,
      covers: ["decisions"],
      aliases: ["decisions", "rationale"],
      topics: ["project.decisions"],
      facts: {
        canonical_root: rootValue,
        existing_roots: rootStates
          .filter((item) => item.exists)
          .map((item) => item.root),
      },
      rationale: "catalog root is the canonical navigation authority",
      verified,
      links: [`${base}:profile:identity`],
    }),
    generatedRecord(project, "memory", {
      kind: "memory",
      priority: 600,
      covers: ["memory"],
      aliases: ["memory", "history", "prior context"],
      topics: ["project.memory"],
      facts: {
        durable_project_status: project.status ?? "reachable",
        profile_scope: "manifest metadata and shallow file-name index",
        synthesized_project_history: false,
      },
      verified,
      links: [`${base}:profile:decision`],
    }),
    generatedRecord(project, "answers", {
      kind: "answer",
      priority: 700,
      covers: ["answers"],
      aliases: ["common questions", "project answers"],
      topics: ["project.answers"],
      answers: {
        path: project.roots,
        commands: `${base}:profile:commands`,
        architecture: `${base}:profile:index`,
        entrypoints: `${base}:profile:index`,
        environment: `${base}:profile:environment`,
        hazards: `${base}:profile:rules`,
        memory: `${base}:profile:memory`,
      },
      verified,
      links: [
        `${base}:profile:commands`,
        `${base}:profile:index`,
        `${base}:profile:environment`,
        `${base}:profile:rules`,
        `${base}:profile:memory`,
      ],
    }),
  ];
}

export async function inspectProjectFingerprint(
  project,
  { timestamp = new Date(0).toISOString() } = {},
) {
  const rootStates = [];
  for (const candidate of project.roots ?? []) {
    rootStates.push({
      root: candidate,
      exists: Boolean(await safeProjectRoot(candidate)),
    });
  }
  const rootValue = rootStates.find(({ exists: present }) => present)?.root;
  const root = rootValue ? await safeProjectRoot(rootValue) : null;
  if (!root) {
    return {
      project: project.id,
      status: "missing-root",
      root: null,
      sha256: null,
    };
  }
  const records = await inspectProject(
    project,
    root,
    rootValue,
    rootStates,
    timestamp,
  );
  return {
    project: project.id,
    status: "ok",
    root: rootValue,
    sha256: records[0]?.verified?.sha256 ?? null,
  };
}

export async function profileProjects({
  home,
  projectIds = [],
  dryRun = false,
  now = () => new Date(),
} = {}) {
  if (!home) throw new Error("home is required");
  const selected = new Set(projectIds);
  const failures = [];
  let profiled = 0;
  const timestamp = now().toISOString();
  const transform = async (source) => {
    const known = new Set(source.catalog.projects.map(({ id }) => id));
    for (const id of selected) {
      if (!known.has(id)) {
        throw new Error(`project not found: ${id}`);
      }
    }
    for (const project of source.catalog.projects) {
      if (selected.size > 0 && !selected.has(project.id)) continue;
      const rootStates = [];
      for (const candidate of project.roots ?? []) {
        rootStates.push({
          root: candidate,
          exists: Boolean(await safeProjectRoot(candidate)),
        });
      }
      const rootValue = rootStates.find(({ exists: present }) => present)?.root;
      const root = rootValue ? await safeProjectRoot(rootValue) : null;
      if (!root) {
        failures.push({ project: project.id, code: "project-root-missing" });
        continue;
      }
      try {
        const generated = await inspectProject(
          project,
          root,
          rootValue,
          rootStates,
          timestamp,
        );
        const generatedIds = new Set(generated.map(({ id }) => id));
        const current = source.projectRecords[project.id] ?? [];
        const curatedIds = new Set(
          current
            .filter(({ ownership }) => ownership === "curated")
            .map(({ id }) => id),
        );
        source.projectRecords[project.id] = [
          ...current.filter(({ id }) =>
            !generatedIds.has(id) || curatedIds.has(id)
          ),
          ...generated.filter(({ id }) => !curatedIds.has(id)),
        ].sort((a, b) => a.id.localeCompare(b.id));
        if (
          current.some((record) =>
            record.required === true
            && record.ownership !== "generated"
            && record.id !== `${project.id}:profile:rules`
          )
        ) {
          const fallback = source.projectRecords[project.id]
            .find(({ id }) => id === `${project.id}:profile:rules`);
          if (fallback) fallback.required = false;
        }
        profiled += 1;
      } catch (error) {
        failures.push({
          project: project.id,
          code: "profile-failed",
          message: error.message,
        });
      }
    }
    return { profiled, failures };
  };
  if (dryRun) {
    const source = await readStoreSource(home);
    await transform(source);
    return {
      ok: failures.length === 0,
      dry_run: true,
      profiled,
      failed: failures.length,
      failures,
      projects: source.catalog.projects
        .filter(({ id }) => selected.size === 0 || selected.has(id))
        .map(({ id }) => id),
      generation: source.generation.id,
    };
  }
  const update = await updateStore({
    home,
    op: "profile-projects",
    detail: { selected: [...selected].sort() },
    now,
    probeLocator: probeLocatorHealth,
    transform,
  });
  return {
    ok: failures.length === 0,
    profiled,
    failed: failures.length,
    failures,
    generation: update.generation,
  };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const result = await profileProjects({
      home: resolveStateHome({
        explicit: optionValue(args, "--home"),
      }),
      projectIds: optionValues(args, "--project"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const failure = errorResult(error);
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: failure })}\n`,
    );
    process.exitCode = 2;
  }
}
