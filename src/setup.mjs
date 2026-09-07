import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lodestarError } from "./errors.mjs";
import { directoryFiles, manageSkills, matches, payload } from "./skills.mjs";
import { installWindowsPosixShim, installWslShim, pathExists, renderWindowsPosixShim, renderWslShim } from "./windows-install.mjs";
import { LODESTAR_VERSION } from "./version.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const optionalJson = async (file) => await pathExists(file) ? readJson(file) : null;
const identity = async (target) => await pathExists(target) ? directoryFiles(target) : null;

async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
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
  const file = path.join(lockDirectory, `${owner.nonce}.json`);
  const removeEmpty = async () => {
    try { await rmdir(lockDirectory); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
  };
  while (true) {
    try {
      await mkdir(lockDirectory);
      await writeFile(file, JSON.stringify(owner), { flag: "wx" });
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
      if (names.length !== 1 || !/^[0-9a-f-]+\.json$/u.test(names[0])) {
        throw lodestarError("install_busy", "Installation lock has unresolved owners.", { identifiers: { lockDirectory } });
      }
      const priorFile = path.join(lockDirectory, names[0]);
      let prior;
      try { prior = await readJson(priorFile); } catch (error) {
        if (error.code === "ENOENT") continue;
        throw lodestarError("install_busy", "Installation lock is being written or needs inspection.", { identifiers: { file: priorFile } });
      }
      if (prior.host !== owner.host || !Number.isSafeInteger(prior.pid) || prior.pid <= 0) {
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
  if (pending.contract !== 5 || pending.target !== item.target ||
      path.dirname(pending.stage) !== item.state || path.dirname(pending.backup) !== item.state ||
      !Array.isArray(pending.files)) {
    throw lodestarError("install_recovery_conflict", "Pending installation does not match its destination.", { identifiers: { file } });
  }
  const current = await identity(item.target);
  if (same(current, pending.files)) {
    await save(path.join(item.state, "installed.json"), {
      contract: 5, version: pending.version, target: item.target, files: pending.files,
    });
  } else if (current === null && await pathExists(pending.backup)) {
    await rename(pending.backup, item.target);
  } else if (!same(current, pending.before)) {
    throw lodestarError("install_recovery_conflict", "Destination changed during an interrupted installation; preserve and inspect it.",
      { identifiers: { target: item.target, pending: file } });
  }
  await rm(pending.stage, { recursive: true, force: true });
  await rm(file);
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
  if (!same(await identity(item.target), item.before)) {
    throw lodestarError("install_changed", "Native skill changed after preflight; no replacement was performed.",
      { identifiers: { target: item.target } });
  }
  await mkdir(path.dirname(item.target), { recursive: true });
  if (item.before !== null) await rename(item.target, backup);
  await onProgress?.({ phase: "displaced", target: item.target });
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
    const resolved = path.resolve(target);
    const present = await pathExists(resolved);
    if (present && !(await lstat(resolved)).isFile()) throw lodestarError("install_layout_conflict", "Launcher must be a regular file.");
    const expectedContent = present ? await readFile(resolved, "utf8") : undefined;
    const desired = kind === "wsl" ? renderWslShim() : renderWindowsPosixShim();
    launchers.push({ kind, target: resolved, expectedContent,
      blocked: present && expectedContent !== desired && !replaceLocal });
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
  try {
    if (apply) {
      const states = [...new Set([...items.map(({ state }) => state), ...launchers.map(({ target }) => stateFor(target))])].sort();
      for (const state of states) releases.push(await lock(state));
      for (const item of items) await recover(item);
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
      ambiguities,
      plans: plans.map(({ target, action, reason, state }) => ({ target, action, reason, state })),
      launchers: launchers.map(({ target, kind, blocked }) => ({ target, kind, blocked })) };
    if (!apply) return summary;
    if (ambiguities.length) throw lodestarError("install_discovery_conflict", "Native skill names are ambiguous; preserve and remove unintended copies from host discovery before applying.",
      { identifiers: { conflicts: ambiguities }, action: "Review the reported native paths. Do not replace project-specific skills with global skills." });
    if (blocked.length) throw lodestarError("install_local_changes", "Installation preflight found content requiring review; nothing was replaced.",
      { identifiers: { targets: blocked.map(({ target }) => target) }, action: "Inspect the setup plan, then use --replace-local to retain backups and replace the selected content." });
    const results = [];
    for (const item of plans) results.push(await install(item, onProgress));
    for (const launcher of launchers) {
      const helper = launcher.kind === "wsl" ? installWslShim : installWindowsPosixShim;
      // Existing launchers are changed only under explicit local replacement.
      await helper(launcher.target, replaceLocal ? { expectedContent: launcher.expectedContent } : {});
    }
    const verification = await manageSkills("verify", options);
    return { ...summary, applied: true, results, verified: verification.verified, verification };
  } finally {
    for (const release of releases.reverse()) await release();
  }
}
