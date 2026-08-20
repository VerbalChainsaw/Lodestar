import { createHash } from "node:crypto";
import os from "node:os";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lodestarError, wrapError } from "./errors.mjs";
import { pathExists as exists } from "./windows-install.mjs";

const TARGETS = Object.freeze({
  claude: [".claude", "skills"],
  opencode: [".config", "opencode", "skills"],
});
const CODEX_ROOTS = Object.freeze({
  codex: [".codex", "skills"],
  agents: [".agents", "skills"],
});
const MANAGED_ASSETS = fileURLToPath(new URL("../managed-assets", import.meta.url));
const MANAGED_MANIFEST = path.join(MANAGED_ASSETS, "manifest.json");
const MANAGED_SKILLS = path.join(MANAGED_ASSETS, "skills");
let payloadPromise;

const safeRealpath = (candidate) => realpath(candidate).catch(() => path.resolve(candidate));

async function payload() {
  payloadPromise ??= (async () => {
    const manifest = JSON.parse(await readFile(MANAGED_MANIFEST, "utf8"));
    if (manifest?.schema !== 2 || !Array.isArray(manifest.skills)) {
      throw new Error("Unsupported canonical managed skill manifest");
    }
    const skills = [];
    for (const name of manifest.skills) {
      const directory = path.join(MANAGED_SKILLS, name);
      const files = await directoryFiles(directory);
      if (!files.some(({ path: file }) => file === "SKILL.md")) {
        throw new Error(`Canonical managed skill ${name} is missing SKILL.md`);
      }
      skills.push({ name, files });
    }
    return { schema: manifest.schema, skills };
  })();
  return payloadPromise;
}

function selectedTargets(value) {
  if (value === undefined || value === "all") {
    return ["codex", "claude", "hermes", "opencode"];
  }
  if (value !== "codex" && value !== "hermes" && !Object.hasOwn(TARGETS, value)) {
    throw lodestarError(
      "invalid_input",
      "Target must be codex, claude, hermes, opencode, or all.",
      { identifiers: { target: value } },
    );
  }
  return [value];
}

function resolveHermesHome({ override, env, platform, home }) {
  if (override !== undefined) return path.resolve(override);
  const configured = env.HERMES_HOME?.trim();
  if (configured) return path.resolve(configured);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim()
      || path.join(home, "AppData", "Local");
    return path.resolve(localAppData, "hermes");
  }
  return path.resolve(home, ".hermes");
}

function assertAction(action) {
  if (["install", "sync", "remove"].includes(action)) {
    throw lodestarError(
      "skills_read_only",
      "Lodestar no longer installs, synchronizes, replaces, migrates, or removes agent skill files.",
      {
        identifiers: { operation: action },
        action: "Manage skill files outside Lodestar. Use `lodestar skills verify` for read-only comparison.",
      },
    );
  }
  if (action !== "verify") {
    throw lodestarError(
      "unknown_operation",
      "The only Lodestar skills operation is read-only verify.",
      {
        identifiers: { operation: action },
        action: "Run `lodestar skills verify`.",
      },
    );
  }
}

function digestFiles(files) {
  const hash = createHash("sha256");
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  for (const file of ordered) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return hash.digest("hex");
}

async function directoryFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await directoryFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        content: await readFile(absolute, "utf8"),
      });
    } else {
      files.push({ path: path.relative(root, absolute), content: null });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function matches(directory, skill) {
  if (!await exists(directory)) return false;
  try {
    const actual = await directoryFiles(directory);
    return actual.every(({ content }) => content !== null)
      && digestFiles(actual) === digestFiles(skill.files);
  } catch {
    return false;
  }
}

async function codexSelection(home, skills, override) {
  if (override !== undefined && !Object.hasOwn(CODEX_ROOTS, override)) {
    throw lodestarError("invalid_input", "Codex skill root must be codex or agents.", {
      identifiers: { codexRoot: override },
    });
  }
  const roots = {};
  const populated = { codex: [], agents: [] };
  for (const [name, parts] of Object.entries(CODEX_ROOTS)) {
    roots[name] = path.join(home, ...parts);
    for (const { name: skill } of skills) {
      if (await exists(path.join(roots[name], skill))) populated[name].push(skill);
    }
  }
  const samePhysicalRoot = await safeRealpath(roots.codex)
    === await safeRealpath(roots.agents);
  const occupied = Object.keys(roots).filter((name) => populated[name].length > 0);
  const selected = override ?? (occupied.length === 1 ? occupied[0] : "agents");
  const alternate = selected === "agents" ? "codex" : "agents";
  return {
    selected,
    alternate,
    roots,
    populated,
    root: roots[selected],
    alternateRoot: roots[alternate],
    reason: samePhysicalRoot
      ? "aliased-roots"
      : override
        ? "override"
        : occupied.length === 1
          ? "existing-copy"
          : "default-agents",
    conflict: !samePhysicalRoot && occupied.length > 1,
    samePhysicalRoot,
  };
}

async function verifySkill(target, root, skill) {
  const destination = path.join(root, skill.name);
  const action = !await exists(destination)
    ? "missing"
    : await matches(destination, skill)
      ? "verified"
      : "stale";
  return { target, skill: skill.name, action, path: destination };
}

async function verifyCodexSkill(selection, skill) {
  const destination = path.join(selection.root, skill.name);
  const alternate = path.join(selection.alternateRoot, skill.name);
  const [activeExists, alternateExists] = await Promise.all([
    exists(destination),
    selection.samePhysicalRoot ? false : exists(alternate),
  ]);
  let action;
  if (activeExists && alternateExists) action = "duplicate";
  else if (!activeExists && alternateExists) action = "alternate-root-only";
  else if (!activeExists) action = "missing";
  else action = await matches(destination, skill) ? "verified" : "stale";
  return {
    target: "codex",
    skill: skill.name,
    action,
    path: destination,
    alternatePath: alternate,
  };
}

export async function manageSkills(action = "verify", {
  target,
  home = os.homedir(),
  codexRoot,
  hermesHome,
  opencodeRoot,
  env = process.env,
  platform = process.platform,
} = {}) {
  assertAction(action);
  try {
    const skills = await payload();
    const targets = selectedTargets(target);
    const resolvedHome = path.resolve(home);
    const codex = targets.includes("codex")
      ? await codexSelection(resolvedHome, skills.skills, codexRoot)
      : null;
    const resolvedHermesHome = targets.includes("hermes")
      ? resolveHermesHome({
        override: hermesHome,
        env,
        platform,
        home: resolvedHome,
      })
      : null;
    const openCodeRoot = targets.includes("opencode")
      ? path.resolve(opencodeRoot ?? path.join(resolvedHome, ...TARGETS.opencode))
      : null;
    const results = [];
    for (const selected of targets) {
      const root = selected === "codex"
        ? codex.root
        : selected === "hermes"
          ? path.join(resolvedHermesHome, "skills")
          : selected === "opencode"
            ? openCodeRoot
            : path.join(resolvedHome, ...TARGETS[selected]);
      for (const skill of skills.skills) {
        results.push(selected === "codex"
          ? await verifyCodexSkill(codex, skill)
          : await verifySkill(selected, root, skill));
      }
    }
    return {
      action: "verify",
      readOnly: true,
      targets,
      codex: codex && {
        selectedRoot: codex.selected,
        path: codex.root,
        alternateRoot: codex.alternate,
        alternatePath: codex.alternateRoot,
        reason: codex.reason,
        conflict: codex.conflict,
      },
      hermes: resolvedHermesHome && {
        home: resolvedHermesHome,
        path: path.join(resolvedHermesHome, "skills"),
      },
      opencode: openCodeRoot && {
        path: openCodeRoot,
        reason: opencodeRoot === undefined ? "default" : "override",
      },
      skills: skills.skills.map(({ name }) => name),
      verified: results.every(({ action: result }) => result === "verified"),
      results,
    };
  } catch (error) {
    throw wrapError(
      error,
      "skills_verify_failed",
      "Lodestar could not complete the read-only skill comparison.",
      { identifiers: { operation: action, target: target ?? "all" } },
    );
  }
}
