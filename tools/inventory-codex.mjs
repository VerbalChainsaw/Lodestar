#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { atomicWriteFile } from "../lib/atomic-file.mjs";
import { optionValue, optionValues } from "../lib/cli-options.mjs";
import { errorResult, LodestarError } from "../lib/errors.mjs";
import { readCurrentGeneration } from "../lib/generation.mjs";
import { isMainModule } from "../lib/main-entry.mjs";
import { nativeProjectPath } from "../lib/native-path.mjs";
import { resolveStateHome } from "../lib/state-home.mjs";
import { defaultCodexHomes } from "./install-codex.mjs";

const ignored = new Set([
  ".git",
  ".next",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

function normalized(file) {
  return path.resolve(file).replaceAll("\\", "/");
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function instructionFiles(
  root,
  { maxDepth = 4, maxEntries = 10_000 } = {},
) {
  const output = [];
  const warnings = [];
  let entriesSeen = 0;
  let entryLimitReported = false;
  async function walk(directory, depth) {
    if (entriesSeen >= maxEntries) {
      if (!entryLimitReported) {
        warnings.push({
          code: "inventory-entry-limit",
          root: normalized(root),
          limit: maxEntries,
        });
        entryLimitReported = true;
      }
      return;
    }
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    const entries = await readdir(directory, { withFileTypes: true })
      .catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > maxEntries) {
        if (!entryLimitReported) {
          warnings.push({
            code: "inventory-entry-limit",
            root: normalized(root),
            limit: maxEntries,
          });
          entryLimitReported = true;
        }
        break;
      }
      const target = path.join(directory, entry.name);
      if (
        entry.isFile()
        && (entry.name === "AGENTS.md" || entry.name === "AGENTS.override.md")
      ) {
        output.push(target);
      } else if (
        entry.isDirectory()
        && !entry.isSymbolicLink()
        && !ignored.has(entry.name)
      ) {
        if (depth < maxDepth) {
          await walk(target, depth + 1);
        } else {
          warnings.push({
            code: "inventory-depth-limit",
            path: normalized(target),
            limit: maxDepth,
          });
        }
      }
    }
  }
  await walk(path.resolve(root), 0);
  return { files: output, warnings, entriesSeen };
}

function projectFor(file, catalog) {
  const target = normalized(file);
  return (catalog.projects ?? [])
    .flatMap((project) => (project.roots ?? []).map((root) => ({
      id: project.id,
      root: normalized(root),
    })))
    .filter(({ root }) => target === root || target.startsWith(`${root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0] ?? null;
}

async function describe(file, kind, catalog) {
  const content = await readFile(file);
  const info = await stat(file);
  const project = projectFor(file, catalog);
  return {
    path: normalized(file),
    kind,
    state: "observed",
    bytes: info.size,
    sha256: createHash("sha256").update(content).digest("hex"),
    ...(project ? { project: project.id } : {}),
  };
}

async function currentCatalog(stateHome) {
  const generation = await readCurrentGeneration(stateHome);
  return JSON.parse(
    await readFile(path.join(generation.root, "catalog.json"), "utf8"),
  );
}

export async function inventoryCodex({
  roots = [],
  codexHomes = defaultCodexHomes(),
  stateHome,
  catalog,
  maxDepth = 4,
  maxEntries = 10_000,
  now = () => new Date(),
} = {}) {
  if (!stateHome) {
    throw new LodestarError(
      "state-home-required",
      "stateHome is required for Codex inventory",
    );
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) {
    throw new LodestarError(
      "inventory-depth-invalid",
      "maxDepth must be an integer from 0 through 8",
      { detail: { max_depth: maxDepth } },
    );
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new LodestarError(
      "inventory-entry-limit-invalid",
      "maxEntries must be a positive integer",
      { detail: { max_entries: maxEntries } },
    );
  }
  const activeCatalog = catalog ?? await currentCatalog(stateHome);
  const files = new Map();
  const warnings = [];
  for (
    const root of [
      ...new Set(roots.map((item) => nativeProjectPath(item))),
    ]
  ) {
    const scanned = await instructionFiles(root, { maxDepth, maxEntries });
    warnings.push(...scanned.warnings);
    for (const file of scanned.files) {
      files.set(normalized(file), { file, kind: "repo-instructions" });
    }
  }
  for (const rawCodexHome of codexHomes) {
    const codexHome = nativeProjectPath(rawCodexHome);
    for (const [relative, kind] of [
      ["config.toml", "codex-adapter"],
      ["AGENTS.md", "codex-adapter"],
      ["AGENTS.override.md", "codex-adapter"],
      [path.join("memories", "MEMORY.md"), "codex-native-memory"],
      [path.join("memories", "memory_summary.md"), "codex-native-memory"],
      [path.join("memories", "raw_memories.md"), "codex-native-memory"],
    ]) {
      const file = path.join(codexHome, relative);
      if (await pathExists(file)) {
        files.set(normalized(file), { file, kind });
      }
    }
  }
  const sources = [];
  for (const { file, kind } of [...files.values()]
    .sort((a, b) => normalized(a.file).localeCompare(normalized(b.file)))) {
    sources.push(await describe(file, kind, activeCatalog));
  }
  const inventory = {
    v: 1,
    generated: now().toISOString(),
    roots: [...new Set(roots.map(normalized))].sort(),
    sources,
    warnings,
  };
  const directory = path.join(stateHome, "inventory");
  const destination = path.join(directory, "codex-sources.json");
  await mkdir(directory, { recursive: true });
  await atomicWriteFile(
    destination,
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  return inventory;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const explicitHome = optionValue(args, "--home");
    const explicitCodexHomes = optionValues(args, "--codex-home");
    const inventory = await inventoryCodex({
      roots: optionValues(args, "--root"),
      codexHomes: explicitCodexHomes.length > 0
        ? explicitCodexHomes
        : defaultCodexHomes(),
      stateHome: resolveStateHome({ explicit: explicitHome }),
      maxDepth: Number(optionValue(args, "--max-depth", 4)),
      maxEntries: Number(optionValue(args, "--max-entries", 10_000)),
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, sources: inventory.sources.length })}\n`,
    );
  } catch (error) {
    const failure = errorResult(error);
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: failure })}\n`,
    );
    process.exitCode = 2;
  }
}
