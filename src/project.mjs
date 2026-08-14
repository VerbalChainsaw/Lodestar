import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { lodestarError } from "./errors.mjs";
import { translateWindowsDialectPath } from "./paths.mjs";
import {
  contentData,
  getRecordById,
  normalizeRecord,
  parseStoredContent,
} from "./records.mjs";

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

// Windows paths compare case-insensitively; POSIX paths do not.
const comparable = (value) => (/^[A-Z]:\//u.test(normalizeMachinePath(value))
  ? normalizeMachinePath(value).toLowerCase()
  : normalizeMachinePath(value));

function storedProjectRoots(db) {
  const rows = db
    .prepare("SELECT id,name,content_json FROM records WHERE type='project' ORDER BY id")
    .all();
  return rows.flatMap((row) => {
    const value = contentData(parseStoredContent(row.content_json, { id: row.id })) ?? {};
    const roots = value.roots ?? (typeof value.root === "string" ? [value.root] : null);
    if (!Array.isArray(roots)) return [];
    return roots
      .filter((root) => typeof root === "string")
      // `root` stays as stored for the projection; `match` carries the physical form.
      // The cwd is realpath-resolved, so an unresolved stored root never matches behind
      // a symlink — macOS resolves /var to /private/var, Windows expands 8.3 names.
      .map((root) => ({ id: row.id, name: row.name, root: normalizeMachinePath(root),
        match: comparable(physical(root)) }));
  });
}

export function resolveProject(db, cwdValue = process.cwd()) {
  const cwd = physical(cwdValue);
  const projects = storedProjectRoots(db)
    .filter(({ match }) => comparable(cwd) === match
      || comparable(cwd).startsWith(`${match}/`))
    .sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id));
  if (projects.length) {
    // `match` is a comparison key, not part of the reported projection.
    const [{ match: _match, ...best }] = projects;
    return {
      ...best,
      scope: best.id.startsWith("project:") ? best.id : `project:${best.id}`,
      cwd,
      identity_source: "stored_project_root",
    };
  }
  // One spawn, not two: `start` runs every session and a second git costs ~45ms. A bare
  // repo or .git dir exits 128 from the failed --show-toplevel while still printing the
  // common dir, so the first stdout line is the predicate; status would lose git identity.
  const git = spawnSync("git", [
    "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel",
  ], { encoding: "utf8", windowsHide: true });
  const [commonLine, rootLine] = git.stdout.trim().split(/\r?\n/u);
  if (commonLine) {
    const common = physical(commonLine);
    const root = rootLine ? physical(rootLine) : cwd;
    const key = hash(comparable(common));
    return {
      id: `git:${key}`,
      scope: `project:git:${key}`,
      name: path.basename(root),
      root,
      cwd,
      identity_source: "git_common_directory",
      git_common_directory: common,
    };
  }
  const key = hash(comparable(cwd));
  return {
    id: `cwd:${key}`,
    scope: `project:cwd:${key}`,
    name: path.basename(cwd),
    root: cwd,
    cwd,
    identity_source: "canonical_cwd",
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
  name: name.slice(0, 256),
  scope: projectScope,
  priority,
  content: { state: "known", value: data },
  aliases: [],
  links: [],
  sources: [],
});

export const normalizedRows = (db, sql, ...values) => db
  .prepare(sql)
  .all(...values)
  .map(({ id }) => normalizeRecord(getRecordById(db, id)));
