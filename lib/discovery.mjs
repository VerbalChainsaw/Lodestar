import * as fs from "node:fs/promises";
import path from "node:path";

export const projectMarkers = new Set([
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "deno.json",
]);

export const ignoredDirectories = new Set([
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

function discoveryError(message, code) {
  return Object.assign(new Error(message), { code });
}

function warningFor(target, error) {
  return {
    code: "directory-unreadable",
    path: target,
    detail: error.code || "unknown",
  };
}

export async function discoverProjects({
  roots = [],
  maxDepth = 4,
  fsApi = fs,
} = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw discoveryError("Discovery depth must be a non-negative integer", "invalid-depth");
  }
  if (maxDepth > 8) {
    throw discoveryError("Discovery depth cannot exceed 8", "depth-too-large");
  }

  const projectsByPhysicalRoot = new Map();
  const warnings = [];

  async function walk(target, depth) {
    let targetStat;
    try {
      targetStat = await fsApi.lstat(target);
    } catch (error) {
      warnings.push(warningFor(target, error));
      return;
    }
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return;

    let entries;
    try {
      entries = await fsApi.readdir(target, { withFileTypes: true });
    } catch (error) {
      warnings.push(warningFor(target, error));
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const markers = entries
      .map(({ name }) => name)
      .filter((name) => projectMarkers.has(name))
      .sort((a, b) => a.localeCompare(b));

    if (markers.length > 0) {
      try {
        const physicalRoot = path.normalize(await fsApi.realpath(target));
        if (!projectsByPhysicalRoot.has(physicalRoot)) {
          projectsByPhysicalRoot.set(physicalRoot, {
            name: path.basename(physicalRoot),
            root: physicalRoot,
            markers,
          });
        }
      } catch (error) {
        warnings.push(warningFor(target, error));
      }
      return;
    }

    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      const child = path.join(target, entry.name);
      let childStat;
      try {
        childStat = await fsApi.lstat(child);
      } catch (error) {
        warnings.push(warningFor(child, error));
        continue;
      }
      if (!childStat.isDirectory() || childStat.isSymbolicLink()) continue;
      await walk(child, depth + 1);
    }
  }

  const normalizedRoots = [...new Set(roots.map((root) => path.resolve(root)))]
    .sort((a, b) => a.localeCompare(b));
  for (const root of normalizedRoots) {
    await walk(root, 0);
  }

  return {
    projects: [...projectsByPhysicalRoot.values()]
      .sort((a, b) => a.root.localeCompare(b.root)),
    warnings,
  };
}
