import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { decodeUtf8 } from "./json.mjs";
import { lodestarError } from "./errors.mjs";
import { resolveInputPath, resolveSourceLocator } from "./paths.mjs";

// Packaged bootstrap is usage guidance. Required instructions come from their
// configured/native files, never a bundled private operating contract.
export const AGENT_BOOTSTRAP = Object.freeze(JSON.parse(readFileSync(
  new URL("../managed-assets/bootstrap.json", import.meta.url), "utf8")));
export const BOOTSTRAP_TEXT = AGENT_BOOTSTRAP.text;

function observedSource(resolved, bytes, before, after, current, finalPath) {
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const stable = before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeNs === after.mtimeNs
    && BigInt(bytes.length) === after.size && current.dev === after.dev && current.ino === after.ino
    && current.mtimeNs === after.mtimeNs && current.size === after.size && finalPath === resolved;
  return { path: resolved, status: stable ? "observed" : "unstable",
    sha256: fingerprint, bytes: bytes.length, encoding: "utf-8",
    observed_at: new Date().toISOString(),
    ...(stable ? { text: decodeUtf8(bytes, { resource: "source", identifiers: { path: resolved } }) } : {}) };
}

export function inspectLocalSourceSync(locator) {
  const file = resolveInputPath(typeof locator === "string" ? locator : locator?.path);
  let descriptor;
  try {
    const resolved = realpathSync.native(file);
    descriptor = openSync(resolved, "r");
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw lodestarError("invalid_path", "Source must be a regular file.",
      { identifiers: { path: file } });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    return observedSource(resolved, bytes, before, after, statSync(file, { bigint: true }), realpathSync.native(file));
  } catch (error) {
    return { path: file, status: error.code === "ENOENT" ? "missing" : "unreadable",
      error: { code: error.code ?? "source_unreadable", message: error.message } };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export async function inspectLocalSource(locator) {
  const file = resolveInputPath(typeof locator === "string" ? locator : locator?.path);
  let handle;
  try {
    const resolved = await realpath(file);
    handle = await open(resolved, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw lodestarError("invalid_path", "Source must be a regular file.",
      { identifiers: { path: file } });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await stat(file, { bigint: true });
    return observedSource(resolved, bytes, before, after, current, await realpath(file));
  } catch (error) {
    return { path: file, status: error.code === "ENOENT" ? "missing" : "unreadable",
      error: { code: error.code ?? "source_unreadable", message: error.message } };
  } finally { await handle?.close(); }
}

export async function nativeInstructionSources(cwd, harness = null) {
  const names = harness === "claude" ? ["CLAUDE.md", "AGENTS.md"] : ["AGENTS.md"];
  const found = [];
  let directory = path.resolve(cwd);
  while (true) {
    for (const name of names) {
      const file = path.join(directory, name);
      try { await access(file); found.unshift({ id: `native:${file}`, locator: file,
        kind: "instruction", required: true, authority: "native" }); }
      catch (error) { if (error.code !== "ENOENT") found.unshift({ id: `native:${file}`,
        locator: file, kind: "instruction", required: true, authority: "native" }); }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return found;
}

export async function requiredSourceBundle(descriptors, { cache = new Map() } = {}) {
  const grouped = new Map();
  for (const descriptor of descriptors) {
    const locator = typeof descriptor.locator === "string"
      ? descriptor.locator : descriptor.locator?.path;
    if (!locator) throw lodestarError("invalid_input", "Instruction source has no locator.",
      { identifiers: { source: descriptor.id } });
    const key = resolveInputPath(locator);
    const groupKey = process.platform === "win32" ? path.normalize(key).toLowerCase() : path.normalize(key);
    const identity = { id: descriptor.id, authority: descriptor.authority ?? "configured",
      required: descriptor.required !== false };
    const group = grouped.get(groupKey);
    if (group) { group.descriptors.push(identity); continue; }
    grouped.set(groupKey, { key, descriptors: [identity] });
  }
  const selected = [];
  for (const { key, descriptors: identities } of grouped.values()) {
    if (!cache.has(key)) cache.set(key, inspectLocalSource(key));
    const observation = await cache.get(key);
    const authorities = [...new Set(identities.map(({ authority }) => authority))];
    selected.push({ id: identities[0].id, ids: identities.map(({ id }) => id),
      kind: "instruction-source", authority: authorities.includes("native") ? "native" : authorities[0],
      authorities,
      required: identities.some(({ required }) => required), descriptors: identities, ...observation });
  }
  // Recheck membership versions before releasing the required collection.
  for (const item of selected) {
    if (item.status !== "observed") continue;
    const again = await inspectLocalSource(item.path);
    if (again.status !== "observed" || again.sha256 !== item.sha256) {
      item.status = "unstable";
      delete item.text;
    }
  }
  const complete = selected.every((source) => !source.required || source.status === "observed");
  if (!complete) for (const source of selected) delete source.text;
  return { complete, sources: selected, next: complete ? [] :
    ["Read or recover the named required sources completely before the dependent action; retry remains available."] };
}

export async function checkRecordSources(record, { cache = new Map(), project = {}, sourceRoots = {} } = {}) {
  const observations = [];
  for (const source of record.sources ?? []) {
    const metadata = source.metadata ?? {};
    if (!["local_file", "package_manifest"].includes(metadata.kind)) {
      observations.push({ origin: source.origin, status: "not_refreshed" });
      continue;
    }
    let located;
    try { located = resolveSourceLocator(metadata.locator, { project, sourceRoots }); }
    catch (error) { observations.push({ origin: source.origin, status: "unreadable", error: error.message }); continue; }
    const key = located.path;
    if (!cache.has(key)) cache.set(key, inspectLocalSource(key));
    const actual = await cache.get(key);
    if (located.root && actual.status === "observed") {
      try {
        const physicalRoot = await realpath(located.root);
        const relative = path.relative(physicalRoot, actual.path);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error("Source escapes its declared physical root.");
        }
      } catch (error) {
        observations.push({ origin: source.origin, status: "unreadable", error: error.message });
        continue;
      }
    }
    const expected = metadata.fingerprint?.value;
    const status = actual.status === "observed"
      ? !expected ? "unobserved" : expected === actual.sha256 ? "unchanged" : "changed"
      : actual.status;
    observations.push({ origin: source.origin, path: actual.path, status,
      ...(actual.sha256 ? { sha256: actual.sha256, bytes: actual.bytes } : {}),
      observed_at: metadata.observed_at ?? null });
  }
  return { ...record, current_source_status: observations,
    claim_status: observations.some(({ status }) => ["changed", "missing", "unreadable", "unstable"].includes(status))
      ? "needs_reinspection" : "as_recorded" };
}
