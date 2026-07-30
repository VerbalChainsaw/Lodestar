import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverProjects } from "../lib/discovery.mjs";
import { nativeProjectPath } from "../lib/native-path.mjs";
import {
  canonicalProjectRoot,
  comparablePath,
} from "../lib/project-roots.mjs";
import { readStoreSource, updateStore } from "./tool-store.mjs";
import { profileProjects } from "./profile-projects.mjs";

async function rootIdentity(value, {
  fsApi,
  platform,
  env,
  release,
  cwd,
}) {
  try {
    return comparablePath(await canonicalProjectRoot(value, {
      fsApi,
      platform,
      env,
      release,
      cwd,
    }), { platform });
  } catch {
    return comparablePath(nativeProjectPath(value, {
      platform,
      env,
      release,
      cwd,
      pathApi: platform === "win32" ? path.win32 : path.posix,
    }), { platform });
  }
}

async function newCandidates(candidates, catalog, runtime) {
  const existingRoots = new Set();
  for (const root of catalog.projects.flatMap((project) => project.roots ?? [])) {
    existingRoots.add(await rootIdentity(root, runtime));
  }
  const output = [];
  for (const candidate of candidates) {
    const identity = await rootIdentity(candidate.root, runtime);
    if (existingRoots.has(identity)) continue;
    existingRoots.add(identity);
    output.push(candidate);
  }
  return output;
}

export async function refreshProjects({
  home,
  discoverRoots = [],
  confirm = false,
  maxDepth = 4,
  idFactory = randomUUID,
  now = () => new Date(),
  fsApi = fs,
  platform = process.platform,
  env = process.env,
  release = os.release(),
  cwd = process.cwd(),
} = {}) {
  if (!home) throw new Error("home is required");
  const runtime = { fsApi, platform, env, release, cwd };
  const source = await readStoreSource(home);
  const discovery = await discoverProjects({
    roots: discoverRoots,
    maxDepth,
  });
  const discovered = discovery.projects.map((project) => ({
      name: project.name,
      root: project.root,
      markers: project.markers,
    }));
  const candidates = await newCandidates(
    discovered,
    source.catalog,
    runtime,
  );
  if (!confirm) {
    return {
      ok: true,
      dry_run: true,
      discovered: candidates,
      warnings: discovery.warnings,
    };
  }

  const addedIds = [];
  if (candidates.length > 0) {
    const importedAt = now().toISOString();
    await updateStore({
      home,
      op: "refresh-discover",
      detail: { projects: candidates.length },
      now,
      async transform(current) {
        const accepted = await newCandidates(
          candidates,
          current.catalog,
          runtime,
        );
        for (const candidate of accepted) {
          const id = `p:${idFactory()}`;
          current.catalog.projects.push({
            id,
            name: candidate.name,
            aliases: [],
            roots: [candidate.root],
            markers: candidate.markers,
            provenance: {
              source: "bounded-discovery",
              imported: importedAt,
            },
          });
          current.projectRecords[id] = [];
          addedIds.push(id);
        }
        current.catalog.projects.sort((a, b) => a.id.localeCompare(b.id));
        return { added: addedIds.length };
      },
    });
  }
  const profile = addedIds.length > 0
    ? await profileProjects({
      home,
      projectIds: addedIds,
      now,
    })
    : {
      ok: true,
      profiled: 0,
      failed: 0,
      failures: [],
      generation: (await readStoreSource(home)).generation.id,
    };
  return {
    ok: profile.ok,
    added: addedIds.length,
    discovered: candidates,
    warnings: discovery.warnings,
    profile,
  };
}
