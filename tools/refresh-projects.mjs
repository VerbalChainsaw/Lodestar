import { randomUUID } from "node:crypto";
import path from "node:path";

import { discoverProjects } from "../lib/discovery.mjs";
import { readStoreSource, updateStore } from "./tool-store.mjs";
import { profileProjects } from "./profile-projects.mjs";

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function refreshProjects({
  home,
  discoverRoots = [],
  confirm = false,
  maxDepth = 4,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  if (!home) throw new Error("home is required");
  const source = await readStoreSource(home);
  const existingRoots = new Set(
    source.catalog.projects
      .flatMap((project) => project.roots ?? [])
      .map(comparable),
  );
  const discovery = await discoverProjects({
    roots: discoverRoots,
    maxDepth,
  });
  const candidates = discovery.projects
    .filter(({ root }) => !existingRoots.has(comparable(root)))
    .map((project) => ({
      name: project.name,
      root: project.root,
      markers: project.markers,
    }));
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
      transform(current) {
        for (const candidate of candidates) {
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
  const profile = await profileProjects({
    home,
    projectIds: addedIds,
    now,
  });
  return {
    ok: profile.ok,
    added: addedIds.length,
    discovered: candidates,
    warnings: discovery.warnings,
    profile,
  };
}
