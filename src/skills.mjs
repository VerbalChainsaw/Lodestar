import { createHash } from "node:crypto";
import os from "node:os";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
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
export async function safeRealpath(candidate, seen = new Set()) {
  const absolute = path.resolve(candidate);
  try { return await realpath(absolute); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (seen.has(absolute)) throw lodestarError("invalid_input", "Skill path contains a symbolic-link cycle.",
    { identifiers: { path: absolute } });
  seen.add(absolute);
  const entry = await lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  // Preserve a link's target identity while an interrupted install has displaced
  // that target. Falling back to the alias would orphan its recovery journal.
  if (entry?.isSymbolicLink()) return safeRealpath(path.resolve(path.dirname(absolute), await readlink(absolute)), seen);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(await safeRealpath(parent, seen), path.basename(absolute));
}

export async function directoryFiles(root, directory = root) {
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

export async function payload() {
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
      "The skills command only verifies native skill files; installation is an explicit setup operation.", {
        identifiers: { operation: action },
        action: "Use `lodestar setup` to review an installation plan, then run `lodestar skills verify` after applying it.",
      });
  }
  if (action !== "verify") throw lodestarError("unknown_operation",
    "The only Lodestar skills operation is read-only verify.",
    { identifiers: { operation: action }, action: "Run `lodestar skills verify`." });
}

export async function matches(directory, skill) {
  if (!await exists(directory)) return false;
  try { return JSON.stringify(await directoryFiles(directory)) === JSON.stringify(skill.files); }
  catch { return false; }
}

async function codexSelection(home, skills, override, env, codexHome) {
  if (override !== undefined && !Object.hasOwn(CODEX_ROOTS, override)) {
    throw lodestarError("invalid_input", "Codex skill root must be codex or agents.",
      { identifiers: { codexRoot: override } });
  }
  const roots = {};
  const populated = { codex: [], agents: [] };
  for (const [name, parts] of Object.entries(CODEX_ROOTS)) {
    roots[name] = path.join(home, ...parts);
    if (name === "codex" && (codexHome !== undefined || env.CODEX_HOME?.trim())) {
      roots[name] = path.resolve(codexHome ?? env.CODEX_HOME.trim(), "skills");
    }
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

// Match the installed Hermes iter_skill_index_files boundaries. Nested support
// packages are data, while category directories contain independently loadable skills.
const HERMES_EXCLUDED = new Set([".git", ".github", ".hub", ".archive", ".venv", "venv",
  "node_modules", "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const HERMES_SUPPORT = new Set(["references", "templates", "assets", "scripts"]);

function scalarSkillName(content) {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)^---\s*$/mu.exec(content)?.[1];
  const value = /^name:[ \t]*(.*)$/mu.exec(header ?? "")?.[1].trim();
  if (!value) return null;
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*(?:#.*)?$/u.exec(value)?.[1];
  if (quoted?.startsWith("'")) return quoted.slice(1, -1).replaceAll("''", "'");
  if (quoted) { try { return JSON.parse(quoted); } catch { return null; } }
  return value.split(/[ \t]+#/u)[0].trim();
}

async function hermesCandidates(root, managed) {
  const found = new Map(managed.map(({ name }) => [name, []]));
  const visited = new Set();
  const activeOrg = await readFile(path.join(root, "_org", ".active_org"), "utf8")
    .then((value) => value.trim(), (error) => { if (error.code === "ENOENT") return null; throw error; });
  async function visit(directory) {
    let physical;
    try { physical = await realpath(directory); }
    catch (error) { if (["ENOENT", "ELOOP"].includes(error.code)) return; throw error; }
    if (visited.has(physical)) return;
    visited.add(physical);
    const entries = await readdir(directory, { withFileTypes: true });
    const skillFile = entries.some((entry) => entry.name === "SKILL.md" && !entry.isDirectory());
    if (skillFile) {
      const content = await readFile(path.join(directory, "SKILL.md"), "utf8");
      for (const name of new Set([path.basename(directory), scalarSkillName(content)])) {
        if (found.has(name)) found.get(name).push(directory);
      }
    }
    for (const entry of entries) {
      if (HERMES_EXCLUDED.has(entry.name) || (skillFile && HERMES_SUPPORT.has(entry.name))) continue;
      if (directory === root && entry.name === "_org" && !activeOrg) continue;
      if (directory === path.join(root, "_org") && entry.name !== activeOrg) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isSymbolicLink()) {
        const linked = await stat(candidate).catch((error) => {
          if (["ENOENT", "ELOOP"].includes(error.code)) return null;
          throw error;
        });
        if (linked?.isDirectory()) await visit(candidate);
      }
    }
  }
  await visit(root);
  return found;
}

async function verifySkill(target, roots, skill, nested = []) {
  const [root] = roots;
  const destination = path.join(root, skill.name);
  const copies = [];
  const candidates = [];
  for (const candidate of new Set([...roots.map((entry) => path.join(entry, skill.name)), ...nested])) {
    const present = await exists(candidate);
    const copy = { path: candidate, physicalPath: await safeRealpath(candidate),
      action: !present ? "missing" : await matches(candidate, skill) ? "verified" : "stale" };
    candidates.push(copy);
    if (present || candidate === destination) copies.push(copy);
  }
  const physicalCopies = [...new Map(copies.filter(({ action }) => action !== "missing")
    .map((copy) => [copy.physicalPath, copy])).values()];
  const divergent = physicalCopies.length > 1 && physicalCopies.some(({ action }) => action !== "verified");
  const ambiguous = target === "hermes" && physicalCopies.length > 1;
  const action = ambiguous ? "ambiguous" : divergent ? "conflict" : copies[0].action;
  return { target, skill: skill.name, action, source_id: skill.source_id,
    source_path: skill.root, source_identity: skill.source_identity,
    distribution_owner: skill.distribution_owner, path: destination, copies, candidates,
    warnings: physicalCopies.length > 1 && !divergent && !ambiguous ? ["identical-mirrors"] : [],
    ...(target === "codex" ? { alternatePath: path.join(roots[1], skill.name) } : {}) };
}

export async function manageSkills(action = "verify", options = {}) {
  const { target, home = os.homedir(), codexRoot, codexHome, claudeHome, hermesHome, opencodeRoot, xdgConfigHome,
    // An explicit home describes another installation, not this process's host.
    env = options.home === undefined ? process.env : {}, platform = process.platform } = options;
  assertAction(action);
  try {
    const managed = await payload();
    const targets = selectedTargets(target);
    const resolvedHome = path.resolve(home);
    const codex = targets.includes("codex")
      ? await codexSelection(resolvedHome, managed.skills, codexRoot, env, codexHome) : null;
    const resolvedHermesHome = targets.includes("hermes")
      ? resolveHermesHome({ override: hermesHome, env, platform, home: resolvedHome }) : null;
    const claudeRoot = path.resolve(claudeHome ?? (env.CLAUDE_CONFIG_DIR?.trim() || path.join(resolvedHome, ".claude")), "skills");
    const openCodeDefault = path.resolve(xdgConfigHome ?? (env.XDG_CONFIG_HOME?.trim() || path.join(resolvedHome, ".config")), "opencode", "skills");
    const openCodeRoot = targets.includes("opencode")
      ? path.resolve(opencodeRoot ?? (env.OPENCODE_CONFIG_DIR?.trim()
        ? path.join(env.OPENCODE_CONFIG_DIR.trim(), "skills") : openCodeDefault)) : null;
    const roots = {
      codex: codex ? [codex.root, codex.alternateRoot] : [],
      claude: [claudeRoot],
      hermes: resolvedHermesHome ? [path.join(resolvedHermesHome, "skills")] : [],
      opencode: openCodeRoot ? [...new Set([openCodeRoot, openCodeDefault,
        ...(env.OPENCODE_CONFIG_DIR?.trim() ? [path.resolve(env.OPENCODE_CONFIG_DIR.trim(), "skills")] : []),
        path.join(resolvedHome, ".claude", "skills"), path.join(resolvedHome, ".agents", "skills")])] : [],
    };
    const results = [];
    const nestedHermes = resolvedHermesHome ? await hermesCandidates(roots.hermes[0], managed.skills) : new Map();
    for (const selected of targets) {
      for (const skill of managed.skills) results.push(await verifySkill(selected, roots[selected], skill,
        selected === "hermes" ? nestedHermes.get(skill.name) : []));
    }
    return { action: "verify", contract: managed.contract, readOnly: true, targets,
      codex: codex && { selectedRoot: codex.selected, path: codex.root,
        alternateRoot: codex.alternate, alternatePath: codex.alternateRoot,
        reason: codex.reason, conflict: results.some((entry) => entry.target === "codex" && entry.action === "conflict") },
      claude: targets.includes("claude") ? { path: claudeRoot } : null,
      hermes: resolvedHermesHome && { home: resolvedHermesHome, path: path.join(resolvedHermesHome, "skills") },
      opencode: openCodeRoot && { path: openCodeRoot, reason: opencodeRoot !== undefined ? "override"
        : xdgConfigHome !== undefined ? "override"
          : env.OPENCODE_CONFIG_DIR?.trim() || env.XDG_CONFIG_HOME?.trim() ? "environment" : "default" },
      scope: { kind: "user-skill-files", roots: Object.fromEntries(targets.map((name) => [name, roots[name]])),
        hermesNested: resolvedHermesHome ? "directory and scalar frontmatter names; physical aliases deduplicated; native support/cache/org exclusions" : null,
        excludes: ["project skills", "plugin skills", "additional configured skill paths",
          "host skill permissions and enablement", "model invocation"] },
      skills: managed.skills.map(({ name, source_id, source_identity, distribution_owner }) =>
        ({ name, source_id, source_identity, distribution_owner })),
      verified: results.every(({ action: result }) => result === "verified"), results };
  } catch (error) {
    throw wrapError(error, "skills_verify_failed",
      "Lodestar could not complete the read-only skill comparison.",
      { identifiers: { operation: action, target: target ?? "all" } });
  }
}
