import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { lodestarError } from "./errors.mjs";
import { translateWindowsDialectPath } from "./paths.mjs";
import { inspectLocalSource } from "./bootstrap.mjs";
import { canonicalStringify, parseJsonText } from "./json.mjs";
import {
  contentData,
  getRecordById,
  normalizeRecord,
  parseStoredContent,
  RECORD_BATCH,
  writeBasis,
} from "./records.mjs";
import { normalizedForRows } from "./queries.mjs";

export const hash = (value, length = 20) => createHash("sha256")
  .update(String(value))
  .digest("hex")
  .slice(0, length);

const slash = (value) => String(value).replaceAll("\\", "/").replace(/\/+$/u, "");

// Every dialect an agent can arrive in — Windows, MSYS, Cygwin, WSL, UNC — collapses to
// one canonical drive form here so a project resolves to the same identity from any shell.
export function normalizeMachinePath(value) {
  let result = slash(translateWindowsDialectPath(String(value).trim(), {
    includeMsys: process.platform === "win32",
  }));
  if (/^[a-z]:$/iu.test(result)) result += "/";
  if (/^[a-z]:\//iu.test(result)) result = `${result[0].toUpperCase()}${result.slice(1)}`;
  return result || "/";
}

function physical(value) {
  const normalized = normalizeMachinePath(value);
  try {
    return normalizeMachinePath(realpathSync.native(path.resolve(value)));
  } catch {
    return /^[A-Z]:\//u.test(normalized)
      ? normalized
      : normalizeMachinePath(path.resolve(value));
  }
}

export function prepareProjectRoots(db, input) {
  const row = input.mode === "update"
    ? db.prepare("SELECT type,content_json FROM records WHERE id=?").get(input.id) : null;
  if ((input.record?.kind ?? row?.type) !== "project") return null;
  const existing = row ? contentData(parseStoredContent(row.content_json, { id: input.id })) : {};
  const data = input.record?.data ?? { ...existing, ...(input.set?.data ?? {}) };
  if (input.mode === "update") for (const field of input.remove ?? []) delete data[field];
  const hasRoots = Object.hasOwn(data, "roots") || Object.hasOwn(data, "root");
  const roots = hasRoots ? data.roots ?? [data.root] : null;
  if (input.mode !== "update" && roots === null) {
    throw lodestarError("invalid_input", "A new project requires at least one complete filesystem root.");
  }
  if (roots !== null && (!Array.isArray(roots)
    || roots.some((root) => typeof root !== "string" || !root.trim()))) {
    throw lodestarError("invalid_input", "Project roots must be an array of complete filesystem paths.");
  }
  const projects = projectRecords(db);
  return { roots: roots?.map(physical) ?? null, record_errors: projects.record_errors,
    peers: projects.records.filter(({ id }) => id !== input.id && id !== input.record?.id).map((peer) => {
      const rawRoots = peer.data.roots ?? (peer.data.root ? [peer.data.root] : []);
      return { id: peer.id, revision: peer.revision, raw_roots: rawRoots,
        roots: rawRoots.filter((root) => typeof root === "string").map(physical),
        catalog_binding: peer.data.catalog_binding ?? null,
        canonical_project_id: peer.data.canonical_project_id ?? null };
    }) };
}

// Windows paths compare case-insensitively; POSIX paths do not.
const comparable = (value) => (/^[A-Z]:\//u.test(normalizeMachinePath(value))
  ? normalizeMachinePath(value).toLowerCase()
  : normalizeMachinePath(value));
export const sameMachinePath = (left, right) => comparable(left) === comparable(right);

function projectRecords(db) {
  return normalizedForRows(db, db
    .prepare("SELECT * FROM records WHERE type='project' ORDER BY id")
    .all());
}

function canonicalProject(db, id) {
  const visited = new Set(), bindings = [];
  let record;
  while (id) {
    if (visited.has(id)) throw lodestarError("project_conflict", "Project bindings contain a cycle.",
      { identifiers: { projects: [...visited, id] } });
    visited.add(id);
    record = normalizeRecord(getRecordById(db, id));
    if (record.kind !== "project") throw lodestarError("project_conflict",
      "The canonical target is not a project.", { identifiers: { id } });
    bindings.push({ target: { kind: "record", id }, expected_revision: record.revision });
    const linked = record.links.filter(({ relationship }) => relationship === "canonical-project")
      .map(({ to_id }) => to_id);
    const next = record.data.canonical_project_id ?? null;
    if (linked.some((target) => target !== next) || (next && !linked.includes(next))) {
      throw lodestarError("project_conflict", "Project binding field and link disagree.",
        { identifiers: { id, canonical_project_id: next, linked } });
    }
    if (!next) return { record, bindings };
    id = next;
  }
}

export function resolveProjectScope(db, projectScope, checkout = null) {
  if (!projectScope || projectScope === "global") return null;
  const candidates = [projectScope, projectScope.startsWith("project:") ? projectScope.slice(8) : projectScope];
  const id = candidates.find((candidate) => db.prepare("SELECT id FROM records WHERE id=? AND type='project'").get(candidate));
  if (!id) return { scope: projectScope, checkout_root: checkout,
    binding_preconditions: [{ target: { kind: "record", id: projectScope }, expected_revision: null }] };
  const resolved = canonicalProject(db, id);
  return { id: resolved.record.id,
    scope: resolved.record.id.startsWith("project:") ? resolved.record.id : `project:${resolved.record.id}`,
    checkout_root: checkout, binding_preconditions: resolved.bindings };
}

function storedProjectRoots(db) {
  const result = projectRecords(db);
  return { ...result, roots: result.records.flatMap((row) => {
    const value = row.data;
    const roots = value.roots ?? (typeof value.root === "string" ? [value.root] : null);
    if (!Array.isArray(roots)) return [];
    return roots
      .filter((root) => typeof root === "string")
      // `root` stays as stored for the projection; `match` carries the physical form.
      // The cwd is realpath-resolved, so an unresolved stored root never matches behind
      // a symlink — macOS resolves /var to /private/var, Windows expands 8.3 names.
      .map((root) => ({ id: row.id, name: row.name, root: normalizeMachinePath(root),
        match: comparable(physical(root)) }));
  }) };
}

export function validateProjectBindings(db, id, prepared = null) {
  const selected = canonicalProject(db, id);
  const projects = prepared ?? (() => {
    const current = projectRecords(db);
    return { record_errors: current.record_errors, peers: current.records.filter((peer) => peer.id !== id)
      .map((peer) => ({ id: peer.id, revision: peer.revision,
        raw_roots: peer.data.roots ?? (peer.data.root ? [peer.data.root] : []),
        roots: (peer.data.roots ?? (peer.data.root ? [peer.data.root] : [])).map(normalizeMachinePath),
        catalog_binding: peer.data.catalog_binding ?? null,
        canonical_project_id: peer.data.canonical_project_id ?? null })) };
  })();
  if (projects.record_errors.length) throw lodestarError("record_requires_source_correction",
    "Project binding validation cannot prove uniqueness while a project record needs correction.",
    { identifiers: { id, record_errors: projects.record_errors },
      action: "Correct the named project records, then retry the binding mutation." });
  if (prepared) {
    const expectedPeers = prepared.peers.map(({ id: peerId }) => peerId).sort();
    const currentPeers = db.prepare("SELECT id FROM records WHERE type='project' AND id<>? ORDER BY id")
      .all(id).map(({ id: peerId }) => peerId);
    if (canonicalStringify(currentPeers) !== canonicalStringify(expectedPeers)) {
      throw lodestarError("project_binding_conflict",
        "Project membership changed before binding validation.",
        { identifiers: { id, expected_peers: expectedPeers, current_peers: currentPeers },
          action: "Refresh every project binding target and retry the mapping." });
    }
  }
  const changed = selected.record;
  const binding = changed.data.catalog_binding;
  const roots = new Set((prepared?.roots ?? (changed.data.roots ?? (changed.data.root ? [changed.data.root] : [])))
    .map(comparable));
  for (const peer of projects.peers) {
    const current = normalizeRecord(getRecordById(db, peer.id));
    const currentRoots = current.data.roots ?? (current.data.root ? [current.data.root] : []);
    if (current.revision !== peer.revision || canonicalStringify(currentRoots) !== canonicalStringify(peer.raw_roots)) {
      throw lodestarError("project_binding_conflict", "Project root evidence changed before binding validation.",
        { identifiers: { id, peer: peer.id, expected_revision: peer.revision,
          current_revision: current.revision } });
    }
    const peerBinding = peer.catalog_binding;
    const sameSource = binding?.catalog_id && binding.catalog_id === peerBinding?.catalog_id
      && ((binding.source_entry_id != null && binding.source_entry_id === peerBinding.source_entry_id)
        || (binding.binding_id && binding.binding_id === peerBinding.binding_id));
    const sameRoot = peer.roots.some((root) => roots.has(comparable(root)));
    if ((sameSource || sameRoot) && canonicalProject(db, peer.id).record.id !== selected.record.id) {
      throw lodestarError("project_binding_conflict", "Competing projects claim the same source entry or physical root.",
        { identifiers: { projects: [id, peer.id], same_source: Boolean(sameSource), same_root: sameRoot } });
    }
  }
  return selected.bindings.map(({ target }) => target);
}

export function resolveProject(db, cwdValue = process.cwd()) {
  const cwd = physical(cwdValue);
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute",
    "--git-common-dir", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  const [commonLine, rootLine] = String(git.stdout ?? "").trim().split(/\r?\n/u);
  const common = commonLine ? physical(commonLine) : null;
  const checkout = rootLine ? physical(rootLine) : cwd;
  const stored = storedProjectRoots(db);
  const projects = stored.roots
    .filter(({ match }) => comparable(cwd) === match
      || comparable(cwd).startsWith(`${match}/`)
      || (common && comparable(path.dirname(common)) === match))
    .sort((a, b) => b.match.length - a.match.length);
  if (projects.length) {
    const candidates = projects.filter(({ match }) => match.length === projects[0].match.length)
      .map((project) => ({ ...project, canonical: canonicalProject(db, project.id) }));
    const ids = [...new Set(candidates.map(({ canonical }) => canonical.record.id))];
    if (ids.length !== 1) throw lodestarError("project_conflict",
      "The current path maps to competing projects.", {
        identifiers: { cwd, candidates: candidates.map(({ id, root, canonical }) =>
          ({ id, root, canonical_project_id: canonical.record.id })) },
        action: "Inspect the project mappings and correct the affected binding before writing.",
      });
    const best = candidates[0], canonical = best.canonical.record;
    const members = stored.records.filter((record) => {
      if (record.id === canonical.id) return true;
      if (!record.data.canonical_project_id) return false;
      try { return canonicalProject(db, record.id).record.id === canonical.id; }
      catch { return false; } // Unrelated broken bindings are diagnosed on their own use.
    });
    const bindings = new Map(candidates.flatMap(({ canonical: resolved }) => resolved.bindings)
      .map((entry) => [entry.target.id, entry]));
    for (const member of members) {
      for (const entry of canonicalProject(db, member.id).bindings) bindings.set(entry.target.id, entry);
    }
    return {
      id: canonical.id, name: canonical.name, root: best.root,
      scope: canonical.id.startsWith("project:") ? canonical.id : `project:${canonical.id}`,
      cwd, checkout_root: rootLine ? checkout : best.root,
      historical_scopes: members.map(({ id }) => id.startsWith("project:") ? id : `project:${id}`),
      binding_preconditions: [...bindings.values()],
      git_common_directory: common,
      identity_source: "stored_project_root",
      record_errors: stored.record_errors,
    };
  }
  // One spawn, not two: `start` runs every session and a second git costs ~45ms. A bare
  // repo or .git dir exits 128 from the failed --show-toplevel while still printing the
  // common dir, so the first stdout line is the predicate; status would lose git identity.
  if (commonLine) {
    const root = rootLine ? physical(rootLine) : cwd;
    const key = hash(comparable(common));
    return {
      id: `git:${key}`,
      scope: `project:git:${key}`,
      name: path.basename(root),
      root,
      cwd,
      checkout_root: checkout,
      historical_scopes: [`project:git:${key}`],
      binding_preconditions: [],
      identity_source: "git_common_directory",
      git_common_directory: common,
      record_errors: stored.record_errors,
    };
  }
  const key = hash(comparable(cwd));
  return {
    id: `cwd:${key}`,
    scope: `project:cwd:${key}`,
    name: path.basename(cwd),
    root: cwd,
    cwd,
    checkout_root: cwd,
    historical_scopes: [`project:cwd:${key}`],
    binding_preconditions: [],
    identity_source: "canonical_cwd",
    record_errors: stored.record_errors,
  };
}

export function resolveIdentity(options = {}, env = process.env, write = false) {
  const first = (...values) => values
    .find((value) => typeof value === "string" && value.trim())
    ?.trim();
  const session = first(
    options.session,
    env.CODEX_THREAD_ID,
    env.CODEX_SESSION_ID,
    env.CLAUDE_SESSION_ID,
    env.OPENCODE_SESSION_ID,
  );
  if (write && !session) {
    throw lodestarError(
      "identity_required",
      "This mutation requires a reliable session identity.",
      { action: "Under the Lodestar plugin, call the lodestar_work_* tool, which carries "
        + "the host session. From a plain shell, pass --session <id>." },
    );
  }
  const agent = first(options.agent, env.LODESTAR_AGENT, env.CODEX_AGENT_NAME, "agent");
  return {
    session: session ?? null,
    agent,
    harness: first(options.harness, env.LODESTAR_HARNESS) ?? null,
    actor: session ? `${agent}:${session}` : null,
  };
}

export const scope = (project, identity) => ({
  project: project?.scope ?? null,
  cwd: project?.cwd ?? null,
  session: identity?.session ?? null,
  actor: identity?.actor ?? null,
});

// Shared shape for the typed records the work and handoff domains write.
export const recordInput = (id, type, name, projectScope, priority, data) => ({
  id,
  type,
  name,
  scope: projectScope,
  priority,
  content: { state: "known", value: data },
  aliases: [],
  links: [],
  sources: [],
});

export const normalizedRowsResult = (db, sql, ...values) => {
  const rows = db.prepare(sql).all(...values);
  if (rows.length === 0) return { records: [], record_errors: [] };
  let selected = rows;
  if (!Object.hasOwn(rows[0], "content_json")) {
    const byId = new Map();
    for (let offset = 0; offset < rows.length; offset += RECORD_BATCH) {
      const ids = rows.slice(offset, offset + RECORD_BATCH).map(({ id }) => id);
      for (const row of db.prepare(`SELECT * FROM records WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids)) byId.set(row.id, row);
    }
    selected = rows.map(({ id }) => byId.get(id)).filter(Boolean);
  }
  return normalizedForRows(db, selected);
};
export const normalizedRows = (db, sql, ...values) => normalizedRowsResult(db, sql, ...values).records;

// Capture database evidence in the read transaction; inspect catalog bytes only
// after releasing it. Preview requests reuse this exact observed write basis.
export function catalogProjection(db, project, configuration) {
  const projects = projectRecords(db), records = projects.records;
  const id = records.find((record) => record.id === project.id || record.id === project.scope)?.id ?? project.scope;
  return { project, id, records, record_errors: projects.record_errors,
    complete: projects.record_errors.length === 0,
    write_basis: writeBasis(db, { projectScope: project.scope,
    checkout: project.checkout_root, targets: [{ kind: "record", id },
      ...(project.binding_preconditions ?? []).map(({ target }) => target),
      ...(configuration ? [{ kind: "record", id: configuration.id }] : [])] }) };
}

export async function catalogReconciliation(snapshot, descriptors, { cache = new Map() } = {}) {
  const results = [];
  for (const descriptor of descriptors) {
    const locator = typeof descriptor.locator === "string" ? descriptor.locator : descriptor.locator?.path;
    if (!descriptor.id || !locator || !Array.isArray(descriptor.source_owned_fields)) {
      results.push({ source: descriptor.id ?? null, status: "invalid_configuration" }); continue;
    }
    const file = path.resolve(locator);
    if (!cache.has(file)) cache.set(file, inspectLocalSource(file));
    const source = await cache.get(file);
    if (source.status !== "observed") {
      results.push({ source: descriptor.id, status: source.status, path: file }); continue;
    }
    let entries;
    try {
      const document = parseJsonText(source.text, { resource: "project_catalog" });
      entries = Array.isArray(document) ? document : document.projects;
      if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.name !== "string"
        || typeof entry.path !== "string" || (entry.aliases !== undefined && !Array.isArray(entry.aliases)))) {
        throw new Error("Catalog projects require name, path, and optional aliases.");
      }
    } catch (error) {
      results.push({ source: descriptor.id, status: "invalid_catalog", error: error.message }); continue;
    }
    const sourceIds = entries.filter((entry) => entry.id != null).map((entry) => String(entry.id));
    if (new Set(sourceIds).size !== sourceIds.length) {
      results.push({ source: descriptor.id, status: "project_conflict", reason: "duplicate_source_ids" }); continue;
    }
    const prior = snapshot.records.find((record) => record.id === snapshot.id);
    const binding = prior?.data.catalog_binding;
    const sameCatalog = binding?.catalog_id === descriptor.id;
    const knownNames = new Set([prior?.name, ...(prior?.aliases ?? []), ...(binding?.previous_names ?? []),
      binding?.observed_entry?.name].filter(Boolean));
    const pathMatches = entries.filter((entry) => comparable(physical(entry.path)) === comparable(snapshot.project.root));
    let candidates = sameCatalog && binding.source_entry_id != null
      ? entries.filter((entry) => String(entry.id) === String(binding.source_entry_id)) : pathMatches;
    if (!candidates.length && sameCatalog) candidates = entries.filter((entry) =>
      knownNames.has(entry.name) || (entry.aliases ?? []).some((name) => knownNames.has(name)));
    if (candidates.length !== 1) {
      results.push({ source: descriptor.id, status: candidates.length ? "project_conflict"
        : sameCatalog ? "source_entry_missing" : "unresolved", candidates }); continue;
    }
    const entry = candidates[0], root = physical(entry.path);
    const competing = snapshot.records.filter((record) => record.id !== snapshot.id
      && !snapshot.project.historical_scopes.includes(record.scope)
      && ((record.data.roots ?? []).some((value) => comparable(physical(value)) === comparable(root))
        || (entry.id != null && record.data.catalog_binding?.catalog_id === descriptor.id
          && String(record.data.catalog_binding?.source_entry_id) === String(entry.id))));
    if (competing.length) {
      results.push({ source: descriptor.id, status: "project_conflict", candidates: competing.map(({ id }) => id) }); continue;
    }
    const owned = Object.fromEntries(descriptor.source_owned_fields.filter((field) => Object.hasOwn(entry, field))
      .map((field) => [field, entry[field]]));
    if (sameCatalog && canonicalStringify(binding.observed_entry) === canonicalStringify(entry)
      && canonicalStringify(prior.data.catalog_fields ?? {}) === canonicalStringify(owned)) {
      results.push({ source: descriptor.id, status: "unchanged", project_id: snapshot.id, sha256: source.sha256 }); continue;
    }
    const owns = (field) => descriptor.source_owned_fields.includes(field);
    const catalogFields = { ...(prior?.data.catalog_fields ?? {}) };
    for (const field of descriptor.source_owned_fields) delete catalogFields[field];
    Object.assign(catalogFields, owned);
    const data = { ...(prior?.data ?? {}), ...(owns("path") ? { roots: [root] } : {}), catalog_fields: catalogFields,
      catalog_binding: { catalog_id: descriptor.id, source_entry_id: entry.id ?? null,
        binding_id: sameCatalog ? binding.binding_id : `binding:${hash(`${descriptor.id}:${snapshot.id}`, 64)}`,
        observed_entry: entry, fingerprint: source.sha256,
        previous_names: [...new Set([...(binding?.previous_names ?? []), prior?.name].filter(Boolean))],
        previous_roots: [...new Set([...(binding?.previous_roots ?? []), ...(prior?.data.roots ?? [])])],
        previous_aliases: [...new Set([...(binding?.previous_aliases ?? []), ...(prior?.aliases ?? [])])] } };
    const observation = { origin: `catalog:${descriptor.id}`, freshness: "current", metadata: {
      inspection: "inspected", kind: "local_file", relation: "content_owner", locator: { base: "absolute", path: source.path },
      observed_at: source.observed_at, fingerprint: { algorithm: "sha256", value: source.sha256, bytes: source.bytes },
      claim: "Catalog-authored fields were inspected; build/runtime claims require their own verification." } };
    const sources = [...(prior?.sources ?? []).filter(({ origin }) => origin !== observation.origin), observation];
    const semantics = { ...(prior?.semantics ?? { lifecycle: "current", basis: "asserted" }),
      context_role: "orientation", applicability: { project: snapshot.project.scope, checkout: null } };
    const aliases = owns("aliases") ? [...new Set([...(prior?.aliases ?? []).filter((alias) =>
      !(binding?.observed_entry?.aliases ?? []).includes(alias)), ...(entry.aliases ?? [])])] : prior?.aliases ?? [];
    const name = owns("name") ? entry.name : prior?.name ?? snapshot.project.name;
    const input = prior ? { mode: "update", id: prior.id, set: { name, aliases, data, sources, semantics }, remove: [] }
      : { mode: "create", record: { id: snapshot.id, kind: "project", name,
        scope: snapshot.project.scope, data, availability: "known", aliases, links: [], sources, semantics } };
    results.push({ source: descriptor.id, status: "reconciliation_available", project_id: snapshot.id,
      observed_source: { path: source.path, sha256: source.sha256, observed_at: source.observed_at },
      write_basis: snapshot.write_basis, input,
      next: "Recheck the observed source before submitting this put input with a retained request ID." });
  }
  return results;
}
