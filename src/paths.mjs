import os from "node:os";
import path from "node:path";

import { lodestarError } from "./errors.mjs";

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
  // Path limits differ by filesystem, namespace, and Windows long-path policy.
  // The filesystem operation is the owning compatibility boundary; a global byte
  // ceiling here would reject paths that the selected platform can represent.
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

export function resolveSourceLocator(locator, { project = {}, sourceRoots = {} } = {}) {
  if (!locator || typeof locator !== "object" || !["project_root", "checkout_root", "source_root", "absolute"].includes(locator.base)) {
    throw lodestarError("invalid_path", "A source locator needs an explicit base and path.");
  }
  assertPath(locator.path, "source locator");
  if (locator.base === "absolute") {
    const selected = translateWindowsDialectPath(locator.path, { includeMsys: process.platform === "win32" });
    if (!path.isAbsolute(selected)) throw lodestarError("invalid_path", "An absolute source locator must be absolute.");
    return { path: resolveInputPath(selected), root: null };
  }
  const root = locator.base === "project_root" ? project.root
    : locator.base === "checkout_root" ? project.checkout_root : sourceRoots[locator.source_id];
  if (!root) throw lodestarError("invalid_path", "The declared source root is unavailable.",
    { identifiers: { base: locator.base, source_id: locator.source_id ?? null } });
  if (path.isAbsolute(locator.path)) throw lodestarError("invalid_path", "A relative source locator cannot contain an absolute path.");
  const absoluteRoot = resolveInputPath(root), resolved = path.resolve(absoluteRoot, locator.path);
  const relative = path.relative(absoluteRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw lodestarError("invalid_path", "The source locator escapes its declared root.", { identifiers: { locator } });
  }
  return { path: resolved, root: absoluteRoot };
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
