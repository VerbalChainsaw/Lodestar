import { createHash } from "node:crypto";
import os from "node:os";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lodestarError, wrapError } from "./errors.mjs";
import { pathExists as exists } from "./windows-install.mjs";

const TARGETS = Object.freeze({ claude: [".claude", "skills"], opencode: [".config", "opencode", "skills"] });
const CODEX_ROOTS = Object.freeze({ codex: [".codex", "skills"], agents: [".agents", "skills"] });
const MANAGED_ASSETS = fileURLToPath(new URL("../managed-assets", import.meta.url));
const MANAGED_MANIFEST = path.join(MANAGED_ASSETS, "manifest.json");
let payloadPromise;

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeRealpath = (candidate) => realpath(candidate).catch(() => path.resolve(candidate));

async function directoryFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await directoryFiles(root, absolute));
    else if (entry.isFile()) {
      const content = await readFile(absolute);
      files.push({ path: path.relative(root, absolute).split(path.sep).join("/"),
        bytes: content.length, sha256: digest(content) });
    } else files.push({ path: path.relative(root, absolute), bytes: null, sha256: null });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function payload() {
  payloadPromise ??= (async () => {
    const manifest = JSON.parse(await readFile(MANAGED_MANIFEST, "utf8"));
    if (manifest?.contract !== 5 || !Array.isArray(manifest.skills)) {
      throw new Error("Unsupported managed skill contract");
    }
    const skills = [];
    for (const skill of manifest.skills) {
      if (!skill?.name || !skill.source_id || !skill.source_entrypoint
          || !skill.payload_root || !Array.isArray(skill.files)
          || typeof skill.distribution_owner !== "string") {
        throw new Error("Managed skill manifest entry is incomplete");
      }
      const root = path.join(MANAGED_ASSETS, ...skill.payload_root.split("/"));
      const actual = await directoryFiles(root);
      if (JSON.stringify(actual) !== JSON.stringify(skill.files)) {
        throw new Error(`Managed skill payload differs from its byte manifest: ${skill.name}`);
      }
      if (!actual.some(({ path: file }) => file === "SKILL.md")) {
        throw new Error(`Managed skill ${skill.name} is missing SKILL.md`);
      }
      skills.push({ ...skill, root });
    }
    return { contract: manifest.contract, skills };
  })();
  return payloadPromise;
}

function selectedTargets(value) {
  if (value === undefined || value === "all") return ["codex", "claude", "hermes", "opencode"];
  if (value !== "codex" && value !== "hermes" && !Object.hasOwn(TARGETS, value)) {
    throw lodestarError("invalid_input", "Target must be codex, claude, hermes, opencode, or all.",
      { identifiers: { target: value } });
  }
  return [value];
}

function resolveHermesHome({ override, env, platform, home }) {
  if (override !== undefined) return path.resolve(override);
  if (env.HERMES_HOME?.trim()) return path.resolve(env.HERMES_HOME.trim());
  return platform === "win32"
    ? path.resolve(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), "hermes")
    : path.resolve(home, ".hermes");
}

function assertAction(action) {
  if (["install", "sync", "remove"].includes(action)) {
    throw lodestarError("skills_read_only",
      "Lodestar does not install, replace, synchronize, or remove native skill files.", {
        identifiers: { operation: action },
        action: "Use the target host's native distribution owner, then run `lodestar skills verify`.",
      });
  }
  if (action !== "verify") throw lodestarError("unknown_operation",
    "The only Lodestar skills operation is read-only verify.",
    { identifiers: { operation: action }, action: "Run `lodestar skills verify`." });
}

async function matches(directory, skill) {
  if (!await exists(directory)) return false;
  try { return JSON.stringify(await directoryFiles(directory)) === JSON.stringify(skill.files); }
  catch { return false; }
}

async function codexSelection(home, skills, override) {
  if (override !== undefined && !Object.hasOwn(CODEX_ROOTS, override)) {
    throw lodestarError("invalid_input", "Codex skill root must be codex or agents.",
      { identifiers: { codexRoot: override } });
  }
  const roots = {};
  const populated = { codex: [], agents: [] };
  for (const [name, parts] of Object.entries(CODEX_ROOTS)) {
    roots[name] = path.join(home, ...parts);
    for (const skill of skills) if (await exists(path.join(roots[name], skill.name))) populated[name].push(skill.name);
  }
  const samePhysicalRoot = await safeRealpath(roots.codex) === await safeRealpath(roots.agents);
  const occupied = Object.keys(roots).filter((name) => populated[name].length > 0);
  const selected = override ?? (occupied.length === 1 ? occupied[0] : "agents");
  const alternate = selected === "agents" ? "codex" : "agents";
  return { selected, alternate, roots, populated, root: roots[selected], alternateRoot: roots[alternate],
    reason: samePhysicalRoot ? "aliased-roots" : override ? "override"
      : occupied.length === 1 ? "existing-copy" : "default-agents",
    conflict: !samePhysicalRoot && occupied.length > 1, samePhysicalRoot };
}

async function verifySkill(target, root, skill) {
  const destination = path.join(root, skill.name);
  const action = !await exists(destination) ? "missing" : await matches(destination, skill) ? "verified" : "stale";
  return { target, skill: skill.name, action, source_id: skill.source_id,
    source_path: skill.root, source_identity: skill.source_identity,
    distribution_owner: skill.distribution_owner, path: destination };
}

async function verifyCodexSkill(selection, skill) {
  const destination = path.join(selection.root, skill.name);
  const alternate = path.join(selection.alternateRoot, skill.name);
  const [activeExists, alternateExists] = await Promise.all([
    exists(destination), selection.samePhysicalRoot ? false : exists(alternate),
  ]);
  const action = activeExists && alternateExists ? "duplicate"
    : !activeExists && alternateExists ? "alternate-root-only"
      : !activeExists ? "missing" : await matches(destination, skill) ? "verified" : "stale";
  return { target: "codex", skill: skill.name, action, source_id: skill.source_id,
    source_path: skill.root, source_identity: skill.source_identity,
    distribution_owner: skill.distribution_owner, path: destination, alternatePath: alternate };
}

export async function manageSkills(action = "verify", {
  target, home = os.homedir(), codexRoot, hermesHome, opencodeRoot,
  env = process.env, platform = process.platform,
} = {}) {
  assertAction(action);
  try {
    const managed = await payload();
    const targets = selectedTargets(target);
    const resolvedHome = path.resolve(home);
    const codex = targets.includes("codex")
      ? await codexSelection(resolvedHome, managed.skills, codexRoot) : null;
    const resolvedHermesHome = targets.includes("hermes")
      ? resolveHermesHome({ override: hermesHome, env, platform, home: resolvedHome }) : null;
    const openCodeRoot = targets.includes("opencode")
      ? path.resolve(opencodeRoot ?? path.join(resolvedHome, ...TARGETS.opencode)) : null;
    const results = [];
    for (const selected of targets) {
      const root = selected === "codex" ? codex.root
        : selected === "hermes" ? path.join(resolvedHermesHome, "skills")
          : selected === "opencode" ? openCodeRoot : path.join(resolvedHome, ...TARGETS[selected]);
      for (const skill of managed.skills) results.push(selected === "codex"
        ? await verifyCodexSkill(codex, skill) : await verifySkill(selected, root, skill));
    }
    return { action: "verify", contract: managed.contract, readOnly: true, targets,
      codex: codex && { selectedRoot: codex.selected, path: codex.root,
        alternateRoot: codex.alternate, alternatePath: codex.alternateRoot,
        reason: codex.reason, conflict: codex.conflict },
      hermes: resolvedHermesHome && { home: resolvedHermesHome, path: path.join(resolvedHermesHome, "skills") },
      opencode: openCodeRoot && { path: openCodeRoot, reason: opencodeRoot === undefined ? "default" : "override" },
      skills: managed.skills.map(({ name, source_id, source_identity, distribution_owner }) =>
        ({ name, source_id, source_identity, distribution_owner })),
      verified: results.every(({ action: result }) => result === "verified"), results };
  } catch (error) {
    throw wrapError(error, "skills_verify_failed",
      "Lodestar could not complete the read-only skill comparison.",
      { identifiers: { operation: action, target: target ?? "all" } });
  }
}
