#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { optionValue } from "../lib/cli-options.mjs";
import { errorResult, LodestarError, wrapError } from "../lib/errors.mjs";
import { isMainModule } from "../lib/main-entry.mjs";
import { nativeProjectPath } from "../lib/native-path.mjs";
import { resolveStateHome } from "../lib/state-home.mjs";
import { updateStore } from "./tool-store.mjs";

export function normalizeProjectRoot(value, runtime) {
  return nativeProjectPath(value, runtime);
}

function unique(values) {
  const seen = new Set();
  return values
    .filter((value) => typeof value === "string" && value.trim())
    .map(normalizeProjectRoot)
    .filter((value) => {
      const key = process.platform === "win32" ? value.toLowerCase() : value;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function commandMap(entry) {
  return Object.fromEntries([
    ["test", entry.test_cmd ?? entry.test],
    ["build", entry.build_cmd ?? entry.build],
    ["typecheck", entry.typecheck_cmd ?? entry.typecheck],
  ].filter(([, value]) => typeof value === "string" && value.trim()));
}

export async function migrateRegistry({
  home,
  sourcePath,
  force = false,
  idFactory = randomUUID,
  now = () => new Date(),
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
  const nativeSource = nativeProjectPath(sourcePath);
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
  if (!Array.isArray(input.projects)) {
    throw new Error("registry must contain a projects array");
  }
  const importedAt = now().toISOString();
  const projects = input.projects.map((entry) => {
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error("every registry project requires a name");
    }
    const roots = unique([
      entry.path,
      entry.repo_path,
      ...(entry.alt_paths ?? []),
      ...(entry.roots ?? []),
    ]);
    if (roots.length === 0) {
      throw new Error(`project has no root: ${entry.name}`);
    }
    const commands = commandMap(entry);
    return {
      id: `p:${idFactory()}`,
      name: entry.name,
      aliases: [...new Set(entry.aliases ?? [])],
      roots,
      ...(Array.isArray(entry.stack) && entry.stack.length > 0
        ? { stack: entry.stack }
        : {}),
      ...(Object.keys(commands).length > 0 ? { commands } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      provenance: {
        source: path.basename(nativeSource),
        imported: importedAt,
      },
    };
  });
  const update = await updateStore({
    home,
    op: "migrate-registry",
    detail: { source: nativeSource, projects: projects.length },
    now,
    transform(source) {
      if (!force && source.catalog.projects.length > 0) {
        throw new Error(
          "catalog already contains projects; use --force only for deliberate replacement",
        );
      }
      source.catalog.projects = projects;
      source.projectRecords = Object.fromEntries(
        projects.map(({ id }) => [id, []]),
      );
      return { imported: projects.length };
    },
  });
  return {
    ok: true,
    imported: projects.length,
    generation: update.generation,
  };
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
