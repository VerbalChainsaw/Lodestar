import { createHash } from "node:crypto";
import os from "node:os";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOOTSTRAP_TEXT } from "./bootstrap.mjs";
import { lodestarError, wrapError } from "./errors.mjs";
import { managedBackupPath, pathExists as exists, prepareBootstrapPlan,
  resolveClientStateHome } from "./windows-install.mjs";
const TARGETS = Object.freeze({ claude: [".claude", "skills"],
  opencode: [".config", "opencode", "skills"] });
const CODEX_ROOTS = Object.freeze({ codex: [".codex", "skills"], agents: [".agents", "skills"] });
const PAYLOAD_URL = new URL("./skills-payload.json", import.meta.url);
let payloadPromise;
const safeRealpath = (candidate) => realpath(candidate).catch(() => path.resolve(candidate));
async function payload() {
  payloadPromise ??= readFile(PAYLOAD_URL, "utf8").then((text) => {
    const parsed = JSON.parse(text);
    if (parsed?.schema !== 2 || !Array.isArray(parsed.skills))
      throw new Error("Unsupported managed skill payload schema");
    return parsed;
  });
  return payloadPromise;
}
function selectedTargets(value) {
  if (value === undefined || value === "all") return ["codex", "claude", "hermes", "opencode"];
  if (value !== "codex" && value !== "hermes" && !Object.hasOwn(TARGETS, value))
    throw lodestarError("invalid_input", "Target must be codex, claude, hermes, opencode, or all.",
      { identifiers: { target: value } });
  return [value];
}
function resolveHermesHome({ override, env, platform, home }) {
  if (override !== undefined) return path.resolve(override);
  const configured = env.HERMES_HOME?.trim();
  if (configured) return path.resolve(configured);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return path.resolve(localAppData, "hermes");
  }
  return path.resolve(home, ".hermes");
}
function assertAction(action) {
  if (!["install", "sync", "verify", "remove"].includes(action))
    throw lodestarError("unknown_operation",
      "The skills operation must be install, sync, verify, or remove.",
      { identifiers: { operation: action } });
}
function digestFiles(files) {
  const hash = createHash("sha256");
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  for (const file of ordered) hash.update(file.path).update("\0")
    .update(file.content).update("\0");
  return hash.digest("hex");
}
async function directoryFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await directoryFiles(root, absolute));
    else if (entry.isFile()) {
      files.push({ path: path.relative(root, absolute).split(path.sep).join("/"),
        content: await readFile(absolute, "utf8") });
    } else files.push({ path: path.relative(root, absolute), content: null });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
async function matches(directory, skill) {
  if (!await exists(directory)) return false;
  try {
    const actual = await directoryFiles(directory);
    return actual.every(({ content }) => content !== null)
      && digestFiles(actual) === digestFiles(skill.files);
  } catch { return false; }
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
  const samePhysicalRoot = await safeRealpath(roots.codex) === await safeRealpath(roots.agents);
  const occupied = Object.keys(roots).filter((name) => populated[name].length > 0);
  const selected = override ?? (occupied.length === 1 ? occupied[0] : "agents");
  const alternate = selected === "agents" ? "codex" : "agents";
  return {
    selected, alternate, roots, populated,
    root: roots[selected], alternateRoot: roots[alternate],
    reason: samePhysicalRoot ? "aliased-roots" : override ? "override" : occupied.length === 1
      ? "existing-managed-copy" : "default-agents",
    conflict: !samePhysicalRoot && occupied.length > 1, samePhysicalRoot,
  };
}
async function writeSkill(directory, skill) {
  for (const file of skill.files) {
    const destination = path.join(directory, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
  }
}
function backupRun(home, now) {
  const stamp = new Date(now()).toISOString().replaceAll(/[:.]/gu, "-");
  return path.join(home, ".lodestar", "skill-backups", stamp);
}
async function stageSkill(root, target, skill) {
  const parent = path.dirname(root); await mkdir(parent, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const directory = path.join(parent,
    `.lodestar-skill-stage-${target}-${skill.name}-${suffix}`);
  await mkdir(directory); try {
    await writeSkill(directory, skill); return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }); throw error;
  }
}
async function backupPath(context, target, skill) {
  return await managedBackupPath(
    context.backup, target, skill.name, context.dryRun,
  );
}
async function alternateMigration(context, selection, skill) {
  if (selection.samePhysicalRoot) return null;
  const source = path.join(selection.alternateRoot, skill.name);
  if (!await exists(source)) return null;
  if (!context.migrate) {
    throw lodestarError("codex_skill_wrong_root",
      "A managed Codex skill already exists in the alternate recognized root.", {
        identifiers: { skill: skill.name, selectedRoot: selection.root,
          alternateRoot: selection.alternateRoot },
        action: `Rerun with --codex-root ${selection.selected} --migrate to back it up.`,
      });
  }
  const backup = await backupPath(context, `codex-${selection.alternate}`, skill);
  return { source, backup };
}
async function prepareInstall(context, target, root, skill, migration = null) {
  const destination = path.join(root, skill.name);
  const unchanged = await matches(destination, skill);
  const replacing = !unchanged && await exists(destination);
  const backup = replacing ? await backupPath(context, target, skill) : null;
  const staged = unchanged || context.dryRun ? null : await stageSkill(root, target, skill);
  const action = unchanged ? "unchanged" : context.dryRun
    ? replacing ? "replace" : "install" : replacing ? "replaced" : "installed";
  return { kind: "install", destination, staged, backup, migration,
    result: { target, skill: skill.name, action,
      path: destination, backup, migrationBackup: migration?.backup ?? null } };
}
async function verifySkill(target, root, skill) {
  const destination = path.join(root, skill.name);
  const action = !await exists(destination) ? "missing"
    : await matches(destination, skill) ? "verified" : "stale";
  return { target, skill: skill.name, action, path: destination };
}
async function verifyCodexSkill(selection, skill) {
  const destination = path.join(selection.root, skill.name);
  const alternate = path.join(selection.alternateRoot, skill.name);
  const [activeExists, alternateExists] = await Promise.all(
    [exists(destination), selection.samePhysicalRoot ? false : exists(alternate)],
  );
  let action;
  if (activeExists && alternateExists) action = "duplicate";
  else if (!activeExists && alternateExists) action = "alternate-root-only";
  else if (!activeExists) action = "missing";
  else action = await matches(destination, skill) ? "verified" : "stale";
  return { target: "codex", skill: skill.name, action,
    path: destination, alternatePath: alternate };
}
async function prepareRemove(context, target, root, skill) {
  const destination = path.join(root, skill.name);
  const present = await exists(destination);
  const unchanged = present && await matches(destination, skill);
  const backup = present ? await backupPath(context, target, skill) : null;
  const action = !present ? "absent" : context.dryRun
    ? unchanged ? "remove" : "backup-and-remove" : "removed";
  return { kind: "remove", destination, backup,
    result: { target, skill: skill.name, action,
      path: destination, backup } };
}
async function applyMove(context, source, destination, undo) {
  await mkdir(path.dirname(destination), { recursive: true });
  await context.move(source, destination);
  undo.push({ source: destination, destination: source });
}
async function rollbackMoves(context, undo) {
  const failures = []; for (const move of [...undo].reverse()) {
    try {
      await mkdir(path.dirname(move.destination), { recursive: true });
      await context.move(move.source, move.destination);
    } catch (error) { failures.push({ source: move.source, destination: move.destination,
        code: String(error?.code ?? "unknown") });
    }
  }
  return failures;
}
async function cleanStages(plans) {
  await Promise.all(plans.filter(({ staged }) => staged).map(({ staged }) =>
    rm(staged, { recursive: true, force: true }).catch(() => null)));
}
async function commitPlans(context, plans) {
  const undo = []; try {
    for (const plan of plans) {
      if (plan.migration)
        await applyMove(context, plan.migration.source, plan.migration.backup, undo);
      if (plan.kind === "remove") {
        if (plan.backup) await applyMove(context, plan.destination, plan.backup, undo);
        continue;
      }
      if (!plan.staged) continue;
      if (plan.backup) await applyMove(context, plan.destination, plan.backup, undo);
      await applyMove(context, plan.staged, plan.destination, undo);
    }
  } catch (error) {
    const failures = await rollbackMoves(context, undo);
    if (failures.length) throw lodestarError("skills_write_failed",
        "Managed skill rollback was incomplete after a write failure.", {
          identifiers: { rollback_failures: failures },
          action: "Preserve the reported paths and restore them from skill-backups.",
          cause: error,
        });
    throw error;
  }
  return plans.map(({ result }) => result);
}
export async function manageSkills(action, {
  target, home = os.homedir(), dryRun = false, now = Date.now, codexRoot,
  migrate = false, hermesHome, opencodeRoot, env = process.env,
  platform = process.platform, move = rename, bootstrapFiles = {},
} = {}) {
  assertAction(action);
  const operation = action === "sync" ? "install" : action;
  const skills = await payload();
  const targets = selectedTargets(target);
  const resolvedHome = path.resolve(home), stateHome = await resolveClientStateHome(resolvedHome);
  const context = { dryRun, migrate, move, backup: backupRun(stateHome, now) };
  const codex = targets.includes("codex")
    ? await codexSelection(resolvedHome, skills.skills, codexRoot)
    : null;
  const resolvedHermesHome = targets.includes("hermes")
    ? resolveHermesHome({ override: hermesHome, env, platform, home: resolvedHome })
    : null;
  const openCodeRoot = targets.includes("opencode")
    ? path.resolve(opencodeRoot ?? path.join(resolvedHome, ...TARGETS.opencode)) : null;
  const plans = [];
  let results = [];
  try {
    for (const selected of targets) {
      if (selected === "codex" && codex.conflict && operation !== "verify" && !codexRoot) {
        throw lodestarError("codex_skill_root_conflict",
          "Lodestar-managed Codex skills exist in both recognized roots.", {
            identifiers: { operation: action, roots: codex.roots,
              managedSkills: codex.populated },
            action: "Verify duplicates, then choose --codex-root and --migrate.",
          });
      }
      const root = selected === "codex"
        ? codex.root
        : selected === "hermes"
          ? path.join(resolvedHermesHome, "skills")
          : selected === "opencode" ? openCodeRoot
            : path.join(resolvedHome, ...TARGETS[selected]);
      for (const skill of skills.skills) {
        if (selected === "codex" && operation === "install") {
          const migration = await alternateMigration(context, codex, skill);
          plans.push(await prepareInstall(context, "codex", codex.root, skill, migration));
        } else if (selected === "codex" && operation === "verify") {
          results.push(await verifyCodexSkill(codex, skill));
        } else if (operation === "install") {
          plans.push(await prepareInstall(context, selected, root, skill));
        } else if (operation === "verify") {
          results.push(await verifySkill(selected, root, skill));
        } else plans.push(await prepareRemove(context, selected, root, skill));
      }
      const bootstrapFile = bootstrapFiles[`--${selected}-bootstrap`];
      if (bootstrapFile) {
        const backup = await backupPath(context, `${selected}-bootstrap`,
          { name: path.basename(bootstrapFile) });
        const plan = await prepareBootstrapPlan(operation, {
          destination: bootstrapFile, text: BOOTSTRAP_TEXT, dryRun, backup,
          target: `${selected}-bootstrap`,
        });
        if (operation === "verify") results.push(plan.result);
        else plans.push(plan);
      }
    }
    if (operation !== "verify")
      results = dryRun ? plans.map(({ result }) => result) : await commitPlans(context, plans);
  } catch (error) {
    await cleanStages(plans);
    throw wrapError(
      error,
      "skills_write_failed",
      "Lodestar could not complete the managed skill operation.",
      { identifiers: { operation: action, target: target ?? "all" } },
    );
  }
  const verified = operation === "verify"
    ? results.every(({ action: result }) => result === "verified") : null;
  return {
    action, dryRun, targets,
    codex: codex && { selectedRoot: codex.selected, path: codex.root,
      alternateRoot: codex.alternate, alternatePath: codex.alternateRoot,
      reason: codex.reason, conflict: codex.conflict },
    hermes: resolvedHermesHome && { home: resolvedHermesHome,
      path: path.join(resolvedHermesHome, "skills") },
    opencode: openCodeRoot && { path: openCodeRoot,
      reason: opencodeRoot === undefined ? "default" : "override" },
    skills: skills.skills.map(({ name }) => name),
    verified, results,
  };
}
