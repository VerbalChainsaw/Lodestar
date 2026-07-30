import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nativeProjectPath } from "./native-path.mjs";
import { ContextError } from "./validation.mjs";

export function comparablePath(value, { platform = process.platform } = {}) {
  let normalized = String(value).replaceAll("\\", "/");
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathContains(
  root,
  candidate,
  { platform = process.platform } = {},
) {
  const normalizedRoot = comparablePath(root, { platform });
  const normalizedCandidate = comparablePath(candidate, { platform });
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

async function canonicalPath(value, fsApi) {
  try {
    return await (fsApi.realpath ?? fs.realpath)(value);
  } catch (error) {
    throw new ContextError("path-unreadable", {
      path: value,
      reason: error.code ?? "unknown",
    });
  }
}

export async function canonicalProjectRoot(
  value,
  {
    fsApi = fs,
    platform = process.platform,
    env = process.env,
    release = os.release(),
    cwd = process.cwd(),
  } = {},
) {
  const nativeRoot = nativeProjectPath(value, {
    platform,
    env,
    release,
    cwd,
    pathApi: platform === "win32" ? path.win32 : path.posix,
  });
  return canonicalPath(nativeRoot, fsApi);
}

async function physicalPathContains(root, candidate, fsApi, platform) {
  if (pathContains(root, candidate, { platform })) return true;
  if (
    platform === "win32"
    || !pathContains(root, candidate, { platform: "win32" })
  ) {
    return false;
  }
  const stat = fsApi.stat ?? fs.stat;
  let rootIdentity;
  try {
    rootIdentity = await stat(root);
  } catch {
    return false;
  }
  if (
    rootIdentity.dev === undefined
    || rootIdentity.ino === undefined
  ) {
    return false;
  }
  let current = candidate;
  while (true) {
    try {
      const identity = await stat(current);
      if (
        identity.dev !== undefined
        && identity.ino !== undefined
        && identity.dev === rootIdentity.dev
        && identity.ino === rootIdentity.ino
      ) {
        return true;
      }
    } catch {
      return false;
    }
    const parent = platform === "win32"
      ? path.win32.dirname(current)
      : path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function resolveProjectAt({
  catalog,
  cwd,
  fsApi = fs,
  platform = process.platform,
  env = process.env,
  release = os.release(),
} = {}) {
  const canonicalCwd = await canonicalPath(cwd, fsApi);
  const matches = [];
  const seen = new Set();
  for (const project of catalog.projects) {
    for (const root of project.roots ?? []) {
      let canonicalRoot;
      try {
        canonicalRoot = await canonicalProjectRoot(root, {
          fsApi,
          platform,
          env,
          release,
          cwd: canonicalCwd,
        });
      } catch {
        continue;
      }
      const physicalKey = comparablePath(canonicalRoot, { platform });
      const projectKey = `${project.id}\0${physicalKey}`;
      if (seen.has(projectKey)) continue;
      seen.add(projectKey);
      if (
        await physicalPathContains(
          canonicalRoot,
          canonicalCwd,
          fsApi,
          platform,
        )
      ) {
        matches.push({
          project,
          root: canonicalRoot,
          length: physicalKey.length,
        });
      }
    }
  }
  matches.sort(
    (a, b) => b.length - a.length || a.project.id.localeCompare(b.project.id),
  );
  return {
    cwd: canonicalCwd,
    project: matches[0]?.project ?? null,
    root: matches[0]?.root ?? null,
  };
}
