import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nativeProjectPath } from "./native-path.mjs";
import { ContextError } from "./validation.mjs";

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

function inside(root, candidate, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalize = platform === "win32"
    ? (value) => value.toLowerCase()
    : (value) => value;
  const relative = pathApi.relative(normalize(root), normalize(candidate));
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative)
    );
}

export function portableLocatorParts(locatorPath) {
  if (
    typeof locatorPath !== "string"
    || locatorPath.includes("\0")
    || /^[a-zA-Z]:/.test(locatorPath)
  ) {
    return null;
  }
  const parts = locatorPath.replaceAll("\\", "/").split("/");
  if (parts.includes("..")) return null;
  return parts.filter((part) => part !== "" && part !== ".");
}

async function resolveExistingAncestor(target, fsApi, pathApi) {
  const realpath = operation(fsApi, "realpath");
  let cursor = target;
  const missing = [];
  while (true) {
    try {
      const physical = await realpath(cursor);
      return {
        physical: pathApi.join(physical, ...missing),
        exists: missing.length === 0,
      };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(pathApi.basename(cursor));
      cursor = parent;
    }
  }
}

async function inspectConfinedRoot(root, locator, fsApi, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const parts = portableLocatorParts(locator.path);
  if (!parts) {
    throw new ContextError("locator-escape", {
      path: locator.path,
      root,
      reason: "non-portable-relative-path",
    });
  }
  const lexicalRoot = pathApi.resolve(root);
  let physicalRoot;
  try {
    physicalRoot = await operation(fsApi, "realpath")(lexicalRoot);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return { status: "missing", checked_path: lexicalRoot };
    }
    return {
      status: "unreadable",
      checked_path: lexicalRoot,
      reason: error.code ?? "unknown",
    };
  }
  const target = pathApi.join(lexicalRoot, ...parts);
  let resolved;
  try {
    resolved = await resolveExistingAncestor(target, fsApi, pathApi);
  } catch (error) {
    return {
      status: "unreadable",
      checked_path: target,
      reason: error.code ?? "unknown",
    };
  }
  if (!inside(physicalRoot, resolved.physical, platform)) {
    throw new ContextError("locator-escape", {
      path: locator.path,
      root: lexicalRoot,
      physical_root: physicalRoot,
      physical_path: resolved.physical,
      reason: "physical-path-outside-root",
    });
  }
  return {
    status: resolved.exists ? "ok" : "missing",
    checked_path: target,
  };
}

export async function probeLocatorHealth(
  { project, locator },
  {
    fsApi = fs,
    platform = process.platform,
    env = process.env,
    release = os.release(),
    cwd = process.cwd(),
  } = {},
) {
  if (locator.type === "external-file") {
    try {
      const checkedPath = await operation(fsApi, "realpath")(locator.path);
      return { status: "ok", checked_path: checkedPath };
    } catch (error) {
      return {
        status: ["ENOENT", "ENOTDIR"].includes(error.code)
          ? "missing"
          : "unreadable",
        checked_path: locator.path,
        ...(error.code ? { reason: error.code } : {}),
      };
    }
  }
  if (locator.type !== "file" || !project) {
    return { status: "unchecked" };
  }
  const results = [];
  const escapes = [];
  for (const root of project.roots ?? []) {
    try {
      const nativeRoot = nativeProjectPath(root, {
        platform,
        env,
        release,
        cwd,
        pathApi: platform === "win32" ? path.win32 : path.posix,
      });
      const result = await inspectConfinedRoot(
        nativeRoot,
        locator,
        fsApi,
        platform,
      );
      if (result.status === "ok") return result;
      results.push(result);
    } catch (error) {
      if (error.code !== "locator-escape") throw error;
      escapes.push(error);
    }
  }
  if (escapes.length > 0 && results.every(({ status }) => status !== "ok")) {
    throw escapes[0];
  }
  return results.find(({ status }) => status === "unreadable")
    ?? results[0]
    ?? { status: "missing" };
}
