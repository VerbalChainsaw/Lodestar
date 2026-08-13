import { Buffer } from "node:buffer";
import os from "node:os";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { lodestarError } from "./errors.mjs";
import { LIMITS } from "./validate.mjs";

const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function assertPath(value, name) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || UNPAIRED_SURROGATE.test(value)
  ) {
    throw lodestarError(
      "invalid_path",
      `${name} must be a nonempty path with valid Unicode and no NUL bytes.`,
      { identifiers: { field: name } },
    );
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > LIMITS.pathBytes) {
    throw lodestarError(
      "resource_limit",
      `${name} exceeds its path byte limit.`,
      {
        identifiers: {
          field: name,
          bytes,
          maximum: LIMITS.pathBytes,
        },
        action: "Choose a shorter path and retry.",
      },
    );
  }
  return value;
}

export function translateWindowsDialectPath(value, { includeMsys = false } = {}) {
  const slashed = String(value).replaceAll("\\", "/");
  const mounted = /^\/mnt\/([a-z])(?:\/(.*))?$/iu.exec(slashed)
    ?? /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+\/mnt\/([a-z])(?:\/(.*))?$/iu.exec(slashed);
  const posix = includeMsys ? /^\/([a-z])(?:\/(.*))?$/iu.exec(slashed)
    ?? /^\/cygdrive\/([a-z])(?:\/(.*))?$/iu.exec(slashed) : null;
  const match = mounted ?? posix;
  return match ? `${match[1].toUpperCase()}:/${match[2] ?? ""}` : value;
}

export function resolveInputPath(value, { cwd = process.cwd(), platform = process.platform,
  pathApi = path, name = "path" } = {}) {
  assertPath(value, name);
  const selected = platform === "win32" ? translateWindowsDialectPath(value,
    { includeMsys: true }) : value;
  return pathApi.resolve(cwd, selected);
}

export function defaultDatabasePath({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  pathApi = path,
} = {}) {
  let directory;
  if (platform === "win32") {
    directory = env.LOCALAPPDATA
      || pathApi.join(home, "AppData", "Local");
    return pathApi.join(directory, "Lodestar", "lodestar.db");
  }
  if (platform === "darwin") {
    return pathApi.join(
      home,
      "Library",
      "Application Support",
      "Lodestar",
      "lodestar.db",
    );
  }
  const xdg = env.XDG_DATA_HOME;
  directory = xdg && pathApi.isAbsolute(xdg)
    ? xdg
    : pathApi.join(home, ".local", "share");
  return pathApi.join(directory, "lodestar", "lodestar.db");
}

export function resolveDatabasePath({
  explicit,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  home = os.homedir(),
  pathApi = path,
} = {}) {
  const selected = explicit !== undefined
    ? explicit
    : env.LODESTAR_DB !== undefined
      ? env.LODESTAR_DB
      : defaultDatabasePath({ platform, env, home, pathApi });
  return resolveInputPath(selected, { cwd, platform, pathApi, name: "database" });
}

async function prospectivePhysicalPath(candidate) {
  const missing = [];
  let existing = path.resolve(candidate);
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return path.join(await realpath(existing), ...missing);
}

export async function assertImportDestinationOutsideSource({
  source,
  database,
}) {
  let physicalSource;
  let physicalDatabase;
  try {
    physicalSource = await realpath(source);
    physicalDatabase = await prospectivePhysicalPath(database);
  } catch (error) {
    throw lodestarError(
      "invalid_path",
      "The import source or destination path cannot be resolved safely.",
      {
        identifiers: { source, database },
        action: "Choose accessible regular paths and retry.",
        cause: error,
      },
    );
  }
  const relative = path.relative(physicalSource, physicalDatabase);
  if (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  ) {
    throw lodestarError(
      "import_path_overlap",
      "The destination database cannot be inside the legacy source tree.",
      {
        identifiers: {
          source: physicalSource,
          database: physicalDatabase,
        },
        action: "Choose a database path outside the v0.7 store.",
      },
    );
  }
  try {
    const info = await lstat(database);
    if (info.isFile() && info.nlink > 1) {
      throw lodestarError(
        "import_path_overlap",
        "The destination database cannot be a multiply linked file.",
        {
          identifiers: {
            source: physicalSource,
            database: physicalDatabase,
            links: info.nlink,
          },
          action:
            "Choose a new or singly linked database path outside the v0.7 store.",
        },
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return physicalDatabase;
}
