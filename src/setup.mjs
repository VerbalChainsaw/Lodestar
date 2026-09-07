import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lodestarError } from "./errors.mjs";
import { AGENT_BOOTSTRAP } from "./bootstrap.mjs";
import { INSTALLATION_OPTIONS } from "./cli-commands.mjs";
import { directoryFiles, manageSkills, matches, payload, safeRealpath } from "./skills.mjs";
import { installWindowsPosixShim, installWslShim, parseWslUncTarget, pathExists, renderWindowsPosixShim, renderWslShim } from "./windows-install.mjs";
import { LODESTAR_VERSION } from "./version.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const optionalJson = async (file) => await pathExists(file) ? readJson(file) : null;
const identity = async (target) => {
  const entry = await lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!entry) return null;
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw lodestarError("install_layout_conflict", "Managed installation entry must be a regular directory.", { identifiers: { target } });
  }
  return directoryFiles(target);
};
const fingerprint = (content) => ({ bytes: content.length, sha256: hash(content) });
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function stateFor(target) {
  // Outside the native skills directory: retained SKILL.md backups must never
  // become discoverable skills. Keep staging on the destination filesystem.
  return path.join(path.dirname(path.dirname(target)), ".lodestar-install",
    hash(process.platform === "win32" ? target.toLowerCase() : target));
}

async function lock(directory) {
  await mkdir(directory, { recursive: true });
  const lockDirectory = path.join(directory, "lock");
  const owner = { pid: process.pid, host: os.hostname(), nonce: randomUUID() };
  // Ownership is complete when this unique directory entry is created. A killed
  // writer cannot leave a partial JSON body that strands all future attempts.
  const file = path.join(lockDirectory, `${hash(owner.host)}.${owner.pid}.${owner.nonce}.lock`);
  const removeEmpty = async () => {
    try { await rmdir(lockDirectory); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
  };
  while (true) {
    try {
      await mkdir(lockDirectory);
      await writeFile(file, "", { flag: "wx" });
      const owners = await readdir(lockDirectory);
      if (owners.length !== 1 || owners[0] !== path.basename(file)) {
        await rm(file, { force: true });
        throw lodestarError("install_busy", "Another installer claimed this directory; retry.");
      }
      return async () => {
        await rm(file, { force: true });
        await removeEmpty();
      };
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code !== "EEXIST") throw error;
      let names;
      try { names = await readdir(lockDirectory); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (names.length === 0) { await removeEmpty(); continue; }
      if (names.length !== 1) {
        throw lodestarError("install_busy", "Installation lock has unresolved owners.", { identifiers: { lockDirectory } });
      }
      const priorFile = path.join(lockDirectory, names[0]);
      const encoded = /^([0-9a-f]{64})\.([1-9][0-9]*)\.([0-9a-f-]{36})\.lock$/u.exec(names[0]);
      let prior;
      try {
        // Accept intact locks from earlier releases so interrupted upgrades stay retryable.
        prior = encoded ? { host: encoded[1] === hash(owner.host) ? owner.host : null, pid: Number(encoded[2]) }
          : /^[0-9a-f-]{36}\.json$/u.test(names[0]) ? await readJson(priorFile) : null;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw lodestarError("install_busy", "Installation lock is being written or needs inspection.", { identifiers: { file: priorFile } });
      }
      if (prior?.host !== owner.host || !Number.isSafeInteger(prior.pid) || prior.pid <= 0) {
        throw lodestarError("install_busy", "Another host owns this installation lock.", { identifiers: { file: priorFile } });
      }
      try { process.kill(prior.pid, 0); }
      catch (error) {
        if (error.code !== "ESRCH") throw error;
        // Remove only the dead owner's unique filename. A concurrent new owner
        // has a different filename and prevents rmdir from removing its lock.
        await rm(priorFile, { force: true });
        await removeEmpty();
        continue;
      }
      throw lodestarError("install_busy", "Another installation is active; retry after it finishes.",
        { identifiers: { file: priorFile, pid: prior.pid } });
    }
  }
}

async function recover(item) {
  const file = path.join(item.state, "pending.json");
  const pending = await optionalJson(file);
  if (!pending) return;
  const operation = typeof pending.stage === "string"
    ? /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.staged$/u.exec(path.basename(pending.stage)) : null;
  const inventory = (files) => Array.isArray(files) && new Set(files.map((file) => file?.path)).size === files.length &&
    files.every((file) => typeof file?.path === "string" && file.path.length > 0 && !file.path.includes("\\") &&
      !path.posix.isAbsolute(file.path) && !path.win32.isAbsolute(file.path) &&
      file.path.split("/").every((part) => part && part !== "." && part !== "..") &&
      Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[0-9a-f]{64}$/u.test(file.sha256));
  if (pending.contract !== 5 || pending.target !== item.target || !operation ||
      path.dirname(pending.stage) !== item.state || pending.backup !== path.join(item.state, `${operation[1]}.previous`) ||
      typeof pending.version !== "string" || !inventory(pending.files) ||
      !pending.files.some((entry) => entry.path === "SKILL.md") ||
      !(pending.before === null || inventory(pending.before))) {
    throw lodestarError("install_recovery_conflict", "Pending installation does not match its destination.", { identifiers: { file } });
  }
  // Inspect all entries before any recovery mutation. In particular, never let
  // malformed journal paths turn the cleanup of staging into backup deletion.
  const staged = await identity(pending.stage);
  const backup = await identity(pending.backup);
  const current = await identity(item.target);
  if ((backup !== null && !same(backup, pending.before)) ||
      (same(current, pending.files) && pending.before !== null && backup === null)) {
    throw lodestarError("install_recovery_conflict", "Interrupted installation backup is missing or changed; all remaining content was preserved.",
      { identifiers: { target: item.target, pending: file, backup: pending.backup } });
  }
  if (same(current, pending.files)) {
    await save(path.join(item.state, "installed.json"), {
      contract: 5, version: pending.version, target: item.target, files: pending.files,
    });
  } else if (current === null && backup !== null) {
    await rename(pending.backup, item.target);
  } else if (!same(current, pending.before)) {
    throw lodestarError("install_recovery_conflict", "Destination changed during an interrupted installation; preserve and inspect it.",
      { identifiers: { target: item.target, pending: file } });
  }
  // A copy may be partial after process death, or may have acquired newer data.
  // Keep any nonmatching tree outside discovery while allowing recovery to retry.
  // Only a byte-verified payload is disposable; the unique path is never reused.
  const retainedStage = staged !== null && !same(staged, pending.files) ? pending.stage : null;
  if (!retainedStage) await rm(pending.stage, { recursive: true, force: true });
  await rm(file);
  return { target: item.target, retained_stage: retainedStage };
}

async function inspect(item, replaceLocal) {
  const before = await identity(item.target);
  if (before?.some((file) => file.sha256 === null)) {
    return { ...item, before, action: "blocked", reason: "A managed tree contains an unsupported link or special file." };
  }
  const prior = await optionalJson(path.join(item.state, "installed.json"));
  const current = same(before, item.skill.files);
  const owned = prior?.contract === 5 && prior.target === item.target && same(before, prior.files);
  return { ...item, before, action: current ? "current" : before === null ? "install"
    : owned || replaceLocal ? "replace" : "blocked",
  reason: current ? "Package bytes already present" : before === null ? "Missing native skill"
    : owned ? "Unmodified previously installed payload" : replaceLocal ? "Explicit replacement with retained backup"
      : "Existing content has no matching install receipt; use --replace-local after reviewing it" };
}

async function install(item, onProgress) {
  if (item.action === "current") {
    await save(path.join(item.state, "installed.json"), {
      contract: 5, version: LODESTAR_VERSION, target: item.target, files: item.skill.files,
    });
    return { target: item.target, action: "current", backup: null };
  }
  const id = randomUUID();
  const stage = path.join(item.state, `${id}.staged`);
  const backup = path.join(item.state, `${id}.previous`);
  const pending = path.join(item.state, "pending.json");
  await save(pending, { contract: 5, version: LODESTAR_VERSION, target: item.target,
    stage, backup, before: item.before, files: item.skill.files });
  await cp(item.skill.root, stage, { recursive: true, force: false, errorOnExist: true });
  if (!await matches(stage, item.skill)) throw lodestarError("install_payload_mismatch", "Staged payload failed byte verification.");
  for (const entry of item.skill.files) {
    const handle = await open(path.join(stage, ...entry.path.split("/")), "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  if (!same(await identity(item.target), item.before)) {
    throw lodestarError("install_changed", "Native skill changed after preflight; no replacement was performed.",
      { identifiers: { target: item.target } });
  }
  await mkdir(path.dirname(item.target), { recursive: true });
  if (item.before !== null) await rename(item.target, backup);
  await onProgress?.({ phase: "displaced", target: item.target });
  if (item.before !== null && !same(await identity(backup), item.before)) {
    if (await identity(item.target) === null) await rename(backup, item.target);
    throw lodestarError("install_changed", "The displaced skill changed after preflight; its newer content was preserved.",
      { identifiers: { target: item.target, backup } });
  }
  if (await identity(item.target) !== null) throw lodestarError("install_changed", "A destination appeared during installation; it was preserved.",
    { identifiers: { target: item.target, backup } });
  await rename(stage, item.target);
  if (!await matches(item.target, item.skill)) throw lodestarError("install_payload_mismatch", "Published skill failed byte verification.");
  await save(path.join(item.state, "installed.json"), {
    contract: 5, version: LODESTAR_VERSION, target: item.target, files: item.skill.files,
  });
  await rm(pending);
  return { target: item.target, action: item.action, backup: item.before === null ? null : backup };
}

/** Explicit deployment only. Never called by start, skills verify, or the MCP adapter. */
export async function setup({ apply = false, replaceLocal = false, wslShim, posixShim,
  onProgress, ...options } = {}) {
  if (wslShim === undefined && posixShim === undefined) {
    const home = path.resolve(options.home ?? os.homedir());
    if (parseWslUncTarget(home)) wslShim = path.join(home, ".local", "bin", "lodestar");
    else if (process.platform === "win32") posixShim = path.join(home, ".local", "bin", "lodestar");
  }
  const before = await manageSkills("verify", options);
  const managed = await payload();
  const skills = new Map(managed.skills.map((skill) => [skill.name, skill]));
  const ambiguities = before.results.filter(({ action }) => action === "ambiguous")
    .map(({ target, skill, path, copies }) => ({ target, skill, path, copies }));
  const unique = new Map();
  for (const result of before.results) {
    for (const copy of result.candidates ?? result.copies ?? [{ path: result.path, physicalPath: result.path }]) {
      const target = copy.physicalPath ?? copy.path;
      if (copy.action === "missing" && copy.path !== result.path &&
          !await pathExists(path.join(stateFor(target), "pending.json"))) continue;
      const key = process.platform === "win32" ? target.toLowerCase() : target;
      if (!unique.has(key)) unique.set(key, { target, skill: skills.get(result.skill), state: stateFor(target) });
    }
  }
  const items = [...unique.values()].sort((a, b) => a.target.localeCompare(b.target));
  const launchers = [];
  for (const [kind, target] of [["wsl", wslShim], ["posix", posixShim]]) {
    if (!target) continue;
    const entry = await lstat(path.resolve(target)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (entry && !entry.isFile()) throw lodestarError("install_layout_conflict", "Launcher must be a regular file.");
    const resolved = await safeRealpath(target);
    const present = entry !== null;
    const expectedContent = present ? await readFile(resolved) : undefined;
    const desired = kind === "wsl" ? renderWslShim() : renderWindowsPosixShim();
    const prior = await optionalJson(path.join(stateFor(resolved), "installed.json"));
    const owned = present && prior?.contract === 5 && prior.kind === "launcher" && prior.target === resolved &&
      same(prior.fingerprint, fingerprint(expectedContent));
    launchers.push({ kind, target: resolved, expectedContent, desired,
      current: present && expectedContent.equals(Buffer.from(desired)),
      blocked: present && !expectedContent.equals(Buffer.from(desired)) && !owned && !replaceLocal });
  }
  for (const launcher of launchers) {
    if (items.some((item) => inside(item.target, launcher.target) || inside(path.dirname(item.state), launcher.target)) ||
        launchers.some((other) => inside(path.dirname(stateFor(other.target)), launcher.target) ||
          (other !== launcher && inside(other.target, launcher.target)))) {
      throw lodestarError("install_layout_conflict", "Launcher destination overlaps a managed skill, installation state, or another launcher.",
        { identifiers: { target: launcher.target } });
    }
  }
  // Do not stage under any root that a selected host searches recursively.
  const discoveredRoots = before.results.flatMap((result) => (result.copies ?? [{ path: result.path }])
    .map((copy) => path.dirname(copy.physicalPath ?? copy.path)));
  for (const item of items) for (const root of discoveredRoots) {
    const relative = path.relative(root, item.state);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw lodestarError("install_layout_conflict", "Installation backups would enter a discovered skills directory.",
        { identifiers: { target: item.target, root } });
    }
  }
  const releases = [];
  const recoveries = [];
  try {
    if (apply) {
      const states = [...new Set([...items.map(({ state }) => state), ...launchers.map(({ target }) => stateFor(target))])].sort();
      for (const state of states) releases.push(await lock(state));
      for (const item of items) {
        const recovered = await recover(item);
        if (recovered) recoveries.push(recovered);
      }
    }
    const plans = [];
    for (const item of items) {
      const pending = await pathExists(path.join(item.state, "pending.json"));
      plans.push(pending ? { ...item, action: "recover", reason: "Interrupted installation; apply will recover before preflight" }
        : await inspect(item, replaceLocal));
    }
    const blocked = plans.filter((item) => item.action === "blocked");
    blocked.push(...launchers.filter(({ blocked }) => blocked));
    const summary = { contract: 5, version: LODESTAR_VERSION, applied: false,
      ready: blocked.length === 0 && ambiguities.length === 0, discovery: before.discovery ?? before.scope ?? null,
      verified: ambiguities.length === 0 && plans.every(({ action }) => action === "current") && launchers.every(({ current }) => current),
      operating_guide: AGENT_BOOTSTRAP,
      ambiguities, recoveries,
      plans: plans.map(({ target, action, reason, state }) => ({ target, action, reason, state })),
      launchers: launchers.map(({ target, kind, blocked, current }) => ({ target, kind, blocked, current })) };
    if (!apply) return summary;
    if (ambiguities.length) throw lodestarError("install_discovery_conflict", "Native skill names are ambiguous; preserve and remove unintended copies from host discovery before applying.",
      { identifiers: { conflicts: ambiguities }, action: "Review the reported native paths. Do not replace project-specific skills with global skills." });
    if (blocked.length) throw lodestarError("install_local_changes", "Installation preflight found content requiring review; nothing was replaced.",
      { identifiers: { targets: blocked.map(({ target }) => target) }, action: "Inspect the setup plan, then use --replace-local to retain backups and replace the selected content." });
    const results = [];
    for (const item of plans) results.push(await install(item, onProgress));
    for (const launcher of launchers) {
      const helper = launcher.kind === "wsl" ? installWslShim : installWindowsPosixShim;
      await helper(launcher.target, { expectedContent: launcher.expectedContent });
      const content = await readFile(launcher.target);
      if (!content.equals(Buffer.from(launcher.desired))) throw lodestarError("install_changed", "Launcher changed before its receipt could be saved.");
      await save(path.join(stateFor(launcher.target), "installed.json"), {
        contract: 5, kind: "launcher", version: LODESTAR_VERSION, target: launcher.target, fingerprint: fingerprint(content),
      });
    }
    const verification = await manageSkills("verify", options);
    return { ...summary, applied: true, results,
      launchers: summary.launchers.map((launcher) => ({ ...launcher, current: true })),
      verified: verification.verified, verification };
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

/** Fresh advisory installation check, using the deployment owner's exact plan. */
export async function installationStatus(options = {}) {
  const arguments_ = ["setup", ...Object.entries(INSTALLATION_OPTIONS)
    .filter(([, field]) => options[field] !== undefined).flatMap(([flag, field]) => [flag, options[field]]), "--apply"];
  try {
    const plan = await setup(options);
    return { version: plan.version, verified: plan.verified, ready: plan.ready,
      read_only: true, scope: plan.discovery, checked_skills: plan.plans.length,
      issues: plan.plans.filter(({ action }) => action !== "current"),
      ambiguities: plan.ambiguities, launchers: plan.launchers,
      repair: plan.verified ? null : { command: "lodestar", arguments: arguments_,
        review_required: !plan.ready, reason: plan.ready ? "Install missing or upgrade unchanged owned assets."
          : "Review local changes or ambiguous destinations; never force replacement implicitly." } };
  } catch (error) {
    return { version: LODESTAR_VERSION, verified: false, ready: false, read_only: true,
      error: { code: error.code ?? "installation_check_failed", message: error.message },
      repair: { command: "lodestar", arguments: arguments_.slice(0, -1), review_required: true } };
  }
}
