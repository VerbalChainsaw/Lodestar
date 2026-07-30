import * as fs from "node:fs/promises";
import path from "node:path";

import { LodestarError } from "./errors.mjs";

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

export async function pathEntryExists(target, { fsApi = fs } = {}) {
  try {
    await operation(fsApi, "lstat")(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function physicalPathWithMissingTail(
  target,
  { fsApi = fs } = {},
) {
  let cursor = path.resolve(target);
  const missing = [];
  while (true) {
    try {
      const physical = await operation(fsApi, "realpath")(cursor);
      return path.join(physical, ...missing);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function nested(relative) {
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

export async function assertPhysicallySeparatePaths({
  source,
  destination,
  fsApi = fs,
  code = "path-overlap",
  message = "Source and destination must not contain one another",
} = {}) {
  const [from, to] = await Promise.all([
    physicalPathWithMissingTail(source, { fsApi }),
    physicalPathWithMissingTail(destination, { fsApi }),
  ]);
  if (nested(path.relative(from, to)) || nested(path.relative(to, from))) {
    throw new LodestarError(code, message, {
      detail: {
        source: path.resolve(source),
        destination: path.resolve(destination),
        physical_source: from,
        physical_destination: to,
      },
    });
  }
}

export async function publishDirectoryNoReplace({
  stage,
  destination,
  terminalEntries = [],
  fsApi = fs,
} = {}) {
  const mkdir = operation(fsApi, "mkdir");
  const readdir = operation(fsApi, "readdir");
  const rename = operation(fsApi, "rename");
  const rmdir = operation(fsApi, "rmdir");
  const rm = operation(fsApi, "rm");
  try {
    // Claim the exact destination with an exclusive directory creation. Unlike
    // rename(stage, destination), this cannot replace a competing empty folder.
    await mkdir(destination);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new LodestarError(
        "destination-exists",
        "Destination already exists",
        { cause: error, detail: { destination } },
      );
    }
    throw error;
  }
  try {
    const terminal = new Set(terminalEntries);
    const entries = await readdir(stage);
    entries.sort((a, b) =>
      Number(terminal.has(a)) - Number(terminal.has(b))
      || a.localeCompare(b));
    for (const entry of entries) {
      await rename(path.join(stage, entry), path.join(destination, entry));
    }
    await rmdir(stage);
  } catch (error) {
    let cleanupError = null;
    try {
      await rm(destination, { recursive: true, force: true });
      await rm(stage, { recursive: true, force: true });
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      throw new LodestarError(
        "directory-publication-cleanup-failed",
        "Directory publication failed and its claimed destination could not be cleaned",
        {
          cause: new AggregateError([error, cleanupError]),
          detail: {
            stage,
            destination,
            cause_code: error.code ?? null,
            cleanup_code: cleanupError.code ?? null,
          },
        },
      );
    }
    throw error;
  }
}
