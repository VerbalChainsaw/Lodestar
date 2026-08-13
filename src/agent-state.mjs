import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { AGENT_BOOTSTRAP } from "./bootstrap.mjs";
import { initializeDatabase, openDiagnosticDatabase, openOrInitializeWriteDatabase,
  openOrMigrateReadDatabase, openOrMigrateWriteDatabase, transaction } from "./database.mjs";
import { diagnoseDatabase } from "./doctor.mjs";
import { lodestarError } from "./errors.mjs";
import { importV070 } from "./import-v070.mjs";
import { canonicalStringify, parseJsonText, readStreamBounded, readTextFileBounded } from "./json.mjs";
import { exportRegistry, findRecords, linkedRecords } from "./queries.mjs";
import { coercePutRecord, contentData, deleteRecord, getRecord, getRecordById, normalizeRecord,
  parseStoredContent, putRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision, currentRevision } from "./revisions.mjs";
import { LIMITS, validatePutInput } from "./validate.mjs";
const hash = (value, length = 20) => createHash("sha256").update(String(value)).digest("hex").slice(0, length);
const slash = (value) => String(value).replaceAll("\\", "/").replace(/\/+$/u, "");
export function normalizeMachinePath(value) {
  let result = slash(String(value).trim()), match = /^\/mnt\/([a-z])(?:\/(.*))?$/iu.exec(result)
    ?? /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+\/mnt\/([a-z])(?:\/(.*))?$/iu.exec(result);
  if (match) result = `${match[1].toUpperCase()}:/${match[2] ?? ""}`;
  if (/^[a-z]:$/iu.test(result)) result += "/";
  if (/^[a-z]:\//iu.test(result)) result = `${result[0].toUpperCase()}${result.slice(1)}`;
  return result || "/";
}
function physical(value) {
  const normalized = normalizeMachinePath(value);
  try { return normalizeMachinePath(realpathSync.native(path.resolve(value))); }
  catch { return /^[A-Z]:\//u.test(normalized) ? normalized : normalizeMachinePath(path.resolve(value)); }
}
const comparable = (value) => /^[A-Z]:\//u.test(normalizeMachinePath(value))
  ? normalizeMachinePath(value).toLowerCase() : normalizeMachinePath(value);
export function resolveProject(db, cwdValue = process.cwd()) {
  const cwd = physical(cwdValue), projects = db.prepare(
    "SELECT id,name,content_json FROM records WHERE type='project' ORDER BY id")
    .all().flatMap((row) => {
    const value = contentData(parseStoredContent(row.content_json, { id: row.id })) ?? {};
    const roots = value.roots ?? (typeof value.root === "string" ? [value.root] : null);
    return Array.isArray(roots) ? roots.filter((root) => typeof root === "string").map((root) =>
      ({ id: row.id, name: row.name, root: normalizeMachinePath(root) })) : [];
  }).filter(({ root }) => comparable(cwd) === comparable(root)
    || comparable(cwd).startsWith(`${comparable(root)}/`))
    .sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id));
  if (projects.length) return { ...projects[0],
    scope: projects[0].id.startsWith("project:") ? projects[0].id : `project:${projects[0].id}`, cwd,
    identity_source: "stored_project_root" };
  const run = (...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  const git = run("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (git.status === 0) {
    const common = physical(git.stdout.trim());
    const rootRun = run("rev-parse", "--path-format=absolute", "--show-toplevel");
    const root = rootRun.status === 0 ? physical(rootRun.stdout.trim()) : cwd;
    const key = hash(comparable(common));
    return { id: `git:${key}`, scope: `project:git:${key}`, name: path.basename(root), root, cwd,
      identity_source: "git_common_directory", git_common_directory: common };
  }
  const key = hash(comparable(cwd)); return { id: `cwd:${key}`, scope: `project:cwd:${key}`,
    name: path.basename(cwd), root: cwd, cwd, identity_source: "canonical_cwd" };
}
export function resolveIdentity(options = {}, env = process.env, write = false) {
  const first = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim();
  const session = first(options.session, env.CODEX_THREAD_ID, env.CODEX_SESSION_ID,
    env.CLAUDE_SESSION_ID, env.OPENCODE_SESSION_ID);
  if (write && !session) throw lodestarError("identity_required",
    "This mutation requires a reliable session identity.",
    { action: "Pass --session or use a supported harness session environment." });
  const agent = first(options.agent, env.LODESTAR_AGENT, env.CODEX_AGENT_NAME, "agent"); return {
    session: session ?? null, agent,
    harness: first(options.harness, env.LODESTAR_HARNESS, env.GLIMPSE_HARNESS) ?? null,
    actor: session ? `${agent}:${session}` : null };
}
const scope = (project, identity) => ({ project: project?.scope ?? null,
  cwd: project?.cwd ?? null, session: identity?.session ?? null, actor: identity?.actor ?? null });
export const operationResult = (data, options = {}) => ({ data, revision: options.revision ?? 0,
  scope: options.scope ?? scope(), more: options.more ?? false, next: options.next ?? [] });
const activeWork = (db, projectScope, actor) => db.prepare("SELECT id FROM records "
  + "WHERE type='work' AND scope=? AND json_extract(content_json,'$.value.status')='open' "
  + "AND json_extract(content_json,'$.value.actor')=? ORDER BY "
  + "json_extract(content_json,'$._lodestar.revision') DESC LIMIT 1").get(projectScope, actor);
const recordInput = (id, type, name, projectScope, priority, data) => ({ id, type,
  name: name.slice(0, 256), scope: projectScope, priority,
  content: { state: "known", value: data }, aliases: [], links: [], sources: [] });
const normalizedRows = (db, sql, ...values) => db.prepare(sql).all(...values).map(({ id }) =>
  normalizeRecord(getRecordById(db, id)));
export const workStatus = (db, project, history = false, limit = 50) => ({ advisory: true,
  records: normalizedRows(db, "SELECT id FROM records WHERE type='work' AND scope=? "
    + (history ? "" : "AND json_extract(content_json,'$.value.status')='open' ")
    + "ORDER BY json_extract(content_json,'$._lodestar.revision') DESC,"
    + "json_extract(content_json,'$.value.actor') COLLATE BINARY LIMIT ?",
  project.scope, limit) });
export function workStart(db, project, identity, report, options = {}) {
  if (typeof report !== "string" || !report.trim()) throw lodestarError("invalid_input",
    "Current work must be nonempty text.");
  const now = (options.now ?? (() => new Date()))().toISOString(); let id;
  transaction(db, () => {
    const revision = allocateRevision(db); id = activeWork(db, project.scope, identity.actor)?.id
      ?? `work:${hash(project.scope, 16)}:${hash(identity.actor, 16)}:${revision}`;
    const prior = db.prepare("SELECT content_json FROM records WHERE id=?").get(id);
    const started = prior ? JSON.parse(prior.content_json).value.started_at : now;
    writeRecordSnapshot(db, recordInput(id, "work", `${identity.agent}: ${report}`,
      project.scope, 0, { status: "open", actor: identity.actor, agent: identity.agent,
        harness: identity.harness, session: identity.session, current_work: report.trim(),
        branch: options.branch ?? null, location: project.cwd, started_at: started,
        last_seen_at: now }), { createdAt: started, updatedAt: now, revision });
  }, options.database);
  return normalizeRecord(getRecordById(db, id));
}
export function workDone(db, project, identity, completion, options = {}) {
  const row = activeWork(db, project.scope, identity.actor);
  if (!row) throw lodestarError("work_not_active", "This actor has no active work report.");
  const record = getRecordById(db, row.id), now = (options.now ?? (() => new Date()))().toISOString();
  transaction(db, () => writeRecordSnapshot(db, recordInput(record.id, "work", record.name,
    project.scope, 0, { ...record.content.value, status: "closed",
        completion: typeof completion === "string" && completion.trim() ? completion.trim() : null,
        completed_at: now, last_seen_at: now }),
    { createdAt: record.created_at, updatedAt: now, revision: allocateRevision(db) }), options.database);
  return normalizeRecord(getRecordById(db, record.id));
}
const handoffId = (project) => `handoff:${hash(project.scope, 24)}`;
const handoffRecord = (db, project) => {
  const row = db.prepare("SELECT id FROM records WHERE id=?").get(handoffId(project));
  return row ? getRecordById(db, row.id) : null;
};
const handoffInput = (project, data) => recordInput(handoffId(project), "handoff",
  `Handoff for ${project.name}`, project.scope, 1000, data);
export const handoffStatus = (db, project) => {
  const record = handoffRecord(db, project);
  return record ? { found: true, record: normalizeRecord(record) } : { found: false };
};
export function handoffSave(db, project, identity, packet, options = {}) {
  if (!packet || Object.getPrototypeOf(packet) !== Object.prototype) throw lodestarError(
    "invalid_input", "A handoff packet object is required.");
  const now = (options.now ?? (() => new Date()))().toISOString(); transaction(db, () => {
    const prior = handoffRecord(db, project), priorData = prior?.content.value;
    if (priorData?.state === "pending" && priorData.source_session === identity.session
      && canonicalStringify(priorData.packet) === canonicalStringify(packet)) return;
    writeRecordSnapshot(db, handoffInput(project, { state: "pending",
      generation: Number(priorData?.generation ?? 0) + 1,
      project: project.scope, source_session: identity.session, source_actor: identity.actor,
      saved_at: now, claimed_by: null, claimed_at: null, packet }),
    { createdAt: prior?.created_at ?? now, updatedAt: now, revision: allocateRevision(db) });
  }, options.database);
  return normalizeRecord(handoffRecord(db, project));
}
export function claimHandoffInside(db, project, identity, options = {}) {
  const record = identity.session ? handoffRecord(db, project) : null;
  if (!record) return null; const data = record.content.value;
  if (data.state === "claimed") return data.claimed_by === identity.session
    ? normalizeRecord(record) : null;
  if (data.state !== "pending" || data.source_session === identity.session) return null;
  const now = (options.now ?? (() => new Date()))().toISOString(); writeRecordSnapshot(db,
    handoffInput(project, { ...data, state: "claimed", claimed_by: identity.session, claimed_at: now }),
  { createdAt: record.created_at, updatedAt: now, revision: allocateRevision(db) });
  return normalizeRecord(handoffRecord(db, project));
}
export function handoffClear(db, project, identity, options = {}) {
  const record = handoffRecord(db, project); if (!record) return { found: false };
  const now = (options.now ?? (() => new Date()))().toISOString(); transaction(db, () =>
    writeRecordSnapshot(db, handoffInput(project,
    { ...record.content.value, state: "cleared", cleared_by: identity.session,
      cleared_at: now, packet: null }),
  { createdAt: record.created_at, updatedAt: now, revision: allocateRevision(db) }), options.database);
  return { found: true, record: normalizeRecord(handoffRecord(db, project)) };
}
export function startProjection(db, project, identity, options = {}) {
  return transaction(db, () => {
    const handoff = claimHandoffInside(db, project, identity, options);
    const order = "ORDER BY json_extract(content_json,'$._lodestar.priority') DESC,"
      + "json_extract(content_json,'$._lodestar.revision') DESC,id";
    const required = normalizedRows(db, "SELECT id FROM records WHERE scope IN ('global',?) "
      + "AND json_extract(content_json,'$.value.required')=1 " + order, project.scope);
    const limit = options.optionalLimit ?? 12, optional = db.prepare(
      "SELECT id FROM records WHERE scope IN ('global',?) "
      + "AND type NOT IN ('work','handoff','project') "
      + "AND COALESCE(json_extract(content_json,'$.value.required'),0)!=1 "
      + order + " LIMIT ?").all(project.scope, limit + 1);
    const more = optional.length > limit, data = { project: { id: project.id,
      scope: project.scope, name: project.name,
      root: project.root, cwd: project.cwd, identity_source: project.identity_source,
      git_common_directory: project.git_common_directory ?? null }, required,
      context: optional.slice(0, limit).map(({ id }) => normalizeRecord(getRecordById(db, id))),
      active_work: workStatus(db, project).records, handoff,
      omitted: more ? { context: optional.length - limit } : {} };
    const next = more ? [`lodestar find "${project.name}" --scope ${project.scope} --limit 50`] : [];
    if (handoff?.data?.packet && Buffer.byteLength(JSON.stringify(handoff.data.packet), "utf8") > 4096) {
      handoff.data.packet = { truncated: true, summary: handoff.data.packet.goal
        ?? handoff.data.packet.summary ?? "Handoff packet exceeds the startup head limit." };
      next.push(`lodestar handoff status --cwd "${project.cwd}"`);
    }
    return { data, revision: currentRevision(db), more, next };
  }, options.database);
}
async function withDatabase(open, file, operation) {
  const db = await open(file); try { return await operation(db); } finally { db.close(); }
}
const cwd = (options) => options["--cwd"] ?? process.cwd();
const identity = (options, write = false) => resolveIdentity({ session: options["--session"],
  agent: options["--agent"], harness: options["--harness"] }, process.env, write);
async function input(options, io, resource) {
  const bounds = { maximum: LIMITS.putInputBytes, resource };
  const text = options["--file"] ? await readTextFileBounded(path.resolve(options["--file"]), bounds)
    : await readStreamBounded(io.stdin, bounds);
  return parseJsonText(text, { maximum: LIMITS.putInputBytes, resource });
}
const scoped = (db, project, actor, data, extra = {}) => operationResult(data,
  { revision: currentRevision(db), scope: scope(project, actor), ...extra });
export async function dispatch(command, { options, positionals }, database, io) {
  if (command === "init") return operationResult({ ...(await initializeDatabase(database)),
    bootstrap: AGENT_BOOTSTRAP });
  if (command === "import") return operationResult(await importV070({ sourcePath: path.resolve(positionals[0]),
    database, dryRun: options["--dry-run"] === true }));
  if (command === "start") return withDatabase(openOrInitializeWriteDatabase, database, (db) => {
    const actor = identity(options), project = resolveProject(db, cwd(options));
    const result = startProjection(db, project, actor, { database });
    return scoped(db, project, actor, result.data, result);
  });
  if (command === "put") {
    const value = coercePutRecord(await input(options, io, "put_input")); validatePutInput(value);
    return withDatabase(openOrInitializeWriteDatabase, database, (db) => {
      const record = putRecord(db, value, { database });
      return operationResult(normalizeRecord(record), { revision: currentRevision(db),
        scope: { project: record.scope, cwd: null, session: null, actor: null } });
    });
  }
  if (["get", "find", "links", "export"].includes(command)) return withDatabase(
    openOrMigrateReadDatabase, database, (db) => {
      if (command === "get") {
        const record = getRecord(db, positionals[0]); return operationResult(normalizeRecord(record),
          { revision: currentRevision(db),
          scope: { project: record.scope, cwd: null, session: null, actor: null } });
      }
      if (command === "find") {
        const result = findRecords(db, positionals[0], { scope: options["--scope"],
          type: options["--kind"] ?? options["--type"], limit: options["--limit"] });
        return operationResult({ query: result.query, records: result.records.map(({ id }) =>
          normalizeRecord(getRecordById(db, id))) }, { revision: currentRevision(db),
          more: result.truncated, next: result.truncated
            ? [`lodestar find "${result.query}" --limit ${result.limit}`] : [] });
      }
      if (command === "links") {
        const result = linkedRecords(db, positionals[0], { limit: options["--limit"] });
        result.links = result.links.map((link) => ({ ...link,
          peer: normalizeRecord(getRecordById(db, link.peer.id)) }));
        return operationResult(result, { revision: currentRevision(db), more: result.truncated });
      }
      return operationResult(exportRegistry(db).document, { revision: currentRevision(db) });
    });
  if (command === "delete") return withDatabase(openOrMigrateWriteDatabase, database, (db) => {
    const result = deleteRecord(db, positionals[0], { database });
    return operationResult(result, { revision: result.revision });
  });
  if (command === "doctor") return withDatabase(openDiagnosticDatabase, database, (db) => {
    let revision = 0; try { revision = currentRevision(db); } catch { /* Reported by doctor. */ }
    return operationResult(diagnoseDatabase(db, { database }), { revision });
  });
  if (command === "work") return dispatchWork(options, positionals, database);
  if (command === "handoff") return dispatchHandoff(options, positionals, database, io);
  throw lodestarError("unknown_command", "The requested command is not part of Lodestar.");
}
async function dispatchWork(options, positionals, database) {
  const action = positionals[0] ?? "status", write = ["start", "done"].includes(action);
  const actor = identity(options, write);
  return withDatabase(write ? openOrInitializeWriteDatabase : openOrMigrateReadDatabase,
    database, (db) => {
      const project = resolveProject(db, cwd(options)); let data;
      if (action === "status") data = workStatus(db, project);
      else if (action === "history") {
        const limit = Number(options["--limit"] ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw lodestarError(
          "invalid_input", "Work history limit must be from 1 to 200.");
        data = workStatus(db, project, true, limit);
      } else if (action === "start" && positionals.length === 2) data = workStart(
        db, project, actor, positionals[1], { database });
      else if (action === "done" && positionals.length <= 2) data = workDone(
        db, project, actor, positionals[1], { database });
      else throw lodestarError("unknown_operation", "The work operation is not supported.");
      return scoped(db, project, actor, data);
    });
}
async function dispatchHandoff(options, positionals, database, io) {
  const action = positionals[0], write = ["save", "clear"].includes(action);
  const actor = identity(options, write);
  const packet = action === "save" ? await input(options, io, "handoff_input") : null;
  return withDatabase(write ? openOrInitializeWriteDatabase : openOrMigrateReadDatabase,
    database, (db) => {
      const project = resolveProject(db, cwd(options));
      const data = action === "save" ? handoffSave(db, project, actor, packet.packet ?? packet, { database })
        : action === "status" ? handoffStatus(db, project)
          : action === "clear" ? handoffClear(db, project, actor, { database })
            : (() => { throw lodestarError("unknown_operation", "The handoff operation is not supported."); })();
      return scoped(db, project, actor, data);
    });
}
