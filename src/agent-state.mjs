import { Buffer } from "node:buffer";
import path from "node:path";
import { AGENT_BOOTSTRAP, REQUIRED_GOVERNANCE } from "./bootstrap.mjs";
import { initializeDatabase, openDiagnosticDatabase, openOrInitializeWriteDatabase,
  openOrMigrateReadDatabase, openOrMigrateWriteDatabase, transaction } from "./database.mjs";
import { diagnoseDatabase } from "./doctor.mjs";
import { decisionDrop, decisionInjection, decisionProjection, decisionSet } from "./decision.mjs";
import { lodestarError } from "./errors.mjs";
import {
  claimHandoffInside, handoffArm, handoffCheckpoint, handoffDisarm, handoffNow,
  handoffStartupView, handoffStatus, handoffTail,
} from "./continuity.mjs";
import { canonicalStringify, parseJsonText, readStreamBounded,
  readTextFileBounded } from "./json.mjs";
import { resolveInputPath } from "./paths.mjs";
import { normalizedRows, resolveIdentity, resolveProject, scope } from "./project.mjs";
import { exportRegistry, findRecords, linkedRecords } from "./queries.mjs";
import { coercePutRecord, deleteRecord, getRecord, getRecordById, normalizeRecord,
  putRecord } from "./records.mjs";
import { currentRevision } from "./revisions.mjs";
import { LIMITS, validatePutInput } from "./validate.mjs";
import { workDone, workExpire, workStart, workStatus } from "./work.mjs";
export { normalizeMachinePath, resolveIdentity, resolveProject } from "./project.mjs";
const STARTUP_BYTES = 16 * 1024;
export const operationResult = (data, options = {}) => ({ data,
  revision: options.revision ?? 0, scope: options.scope ?? scope(),
  more: options.more ?? false, next: options.next ?? [] });
// The budget is measured on encoded JSON so a UTF-8 character is never split.
const startupBytes = (data, revision, project, identity, more, next) => Buffer.byteLength(
  canonicalStringify({ v: 1, ok: true, operation: "start", revision,
    scope: scope(project, identity), data, more, next }), "utf8") + 1;

export function startProjection(db, project, identity, options = {}) {
  return transaction(db, () => {
    const handoff = handoffStartupView(claimHandoffInside(db, project, identity, options));
    const order = "ORDER BY json_extract(content_json,'$._lodestar.priority') DESC,"
      + "json_extract(content_json,'$._lodestar.revision') DESC,id";
    const storedRequired = normalizedRows(db,
      "SELECT id FROM records WHERE scope IN ('global',?) "
        + "AND json_extract(content_json,'$.value.required')=1 " + order, project.scope);
    const required = [REQUIRED_GOVERNANCE,
      ...storedRequired.filter(({ id }) => id !== REQUIRED_GOVERNANCE.id)];
    const limit = options.optionalLimit ?? 12;
    const optionalWhere = "FROM records WHERE scope IN ('global',?) "
      + "AND type NOT IN ('work','handoff','project','decision-event') "
      + "AND type NOT LIKE 'handoff-%' "
      + "AND COALESCE(json_extract(content_json,'$.value.required'),0)!=1 ";
    const optionalTotal = Number(db.prepare(`SELECT count(*) AS count ${optionalWhere}`)
      .get(project.scope).count);
    const optional = db.prepare(`SELECT id ${optionalWhere}${order} LIMIT ?`)
      .all(project.scope, limit);
    const omitted = {};
    if (optionalTotal > optional.length) omitted.context = optionalTotal - optional.length;
    const data = {
      project: { id: project.id, scope: project.scope, name: project.name,
        root: project.root, cwd: project.cwd, identity_source: project.identity_source,
        git_common_directory: project.git_common_directory ?? null },
      required,
      decisions: decisionProjection(db, project),
      context: optional.map(({ id }) => normalizeRecord(getRecordById(db, id))),
      active_work: workStatus(db, project).records,
      handoff,
      omitted,
    };
    const next = omitted.context
      ? [`lodestar find "${project.name}" --scope ${project.scope} --limit 50`]
      : [];
    if (handoff?.packet?.summary) next.push(`lodestar handoff status --cwd "${project.cwd}"`);
    const revision = currentRevision(db);
    const fits = () => startupBytes(data, revision, project, identity,
      Object.keys(omitted).length > 0, next) <= STARTUP_BYTES;
    // Optional context is shed before advisory work, and the follow-up command that
    // recovers what was dropped is added before the budget is measured again.
    while (!fits() && data.context.length) {
      data.context.pop();
      omitted.context = (omitted.context ?? 0) + 1;
      const command = `lodestar find "${project.name}" --scope ${project.scope} --limit 50`;
      if (!next.includes(command)) next.unshift(command);
    }
    while (!fits() && data.active_work.length) {
      data.active_work.pop();
      omitted.work = (omitted.work ?? 0) + 1;
      const command = `lodestar work status --cwd "${project.cwd}"`;
      if (!next.includes(command)) next.push(command);
    }
    const more = Object.keys(omitted).length > 0;
    if (!fits()) {
      throw lodestarError("resource_limit",
        "Required startup context exceeds the 16 KiB startup budget.", {
          identifiers: { resource: "startup_output", maximum: STARTUP_BYTES },
          action: "Reduce required Lodestar context and retry; no handoff was claimed." });
    }
    return { data, revision, more, next };
  }, options.database);
}

async function withDatabase(open, file, operation) {
  const db = await open(file);
  try { return await operation(db); }
  finally { db.close(); }
}
const cwd = (options) => options["--cwd"] ?? process.cwd();

const identity = (options, write = false) => resolveIdentity({ session: options["--session"],
  agent: options["--agent"], harness: options["--harness"] }, process.env, write);

async function input(options, io, resource) {
  const bounds = { maximum: LIMITS.putInputBytes, resource };
  const text = options["--file"]
    ? await readTextFileBounded(resolveInputPath(options["--file"]), bounds)
    : await readStreamBounded(io.stdin, bounds);
  return parseJsonText(text, { maximum: LIMITS.putInputBytes, resource });
}

const scoped = (db, project, actor, data, extra = {}) => operationResult(data, {
  revision: currentRevision(db), scope: scope(project, actor), ...extra });

const unscoped = (record) => ({ project: record.scope, cwd: null,
  session: null, actor: null });

async function dispatchRead(command, { options, positionals }, database) {
  return withDatabase(openOrMigrateReadDatabase, database, (db) => {
    if (command === "get") {
      const record = getRecord(db, positionals[0]);
      return operationResult(normalizeRecord(record), {
        revision: currentRevision(db), scope: unscoped(record) });
    }
    if (command === "find") {
      const result = findRecords(db, positionals[0], { scope: options["--scope"],
        type: options["--kind"] ?? options["--type"], limit: options["--limit"] });
      return operationResult({ query: result.query,
        records: result.records.map(({ id }) => normalizeRecord(getRecordById(db, id))),
      }, { revision: currentRevision(db), more: result.truncated,
        next: result.truncated
          ? [`lodestar find "${result.query}" --limit ${result.limit}`] : [] });
    }
    if (command === "links") {
      const result = linkedRecords(db, positionals[0], { limit: options["--limit"] });
      result.links = result.links.map((link) => ({ ...link,
        peer: normalizeRecord(getRecordById(db, link.peer.id)) }));
      return operationResult(result, { revision: currentRevision(db),
        more: result.truncated });
    }
    return operationResult(exportRegistry(db).document, { revision: currentRevision(db) });
  });
}

export async function dispatch(command, parsed, database, io) {
  const { options, positionals } = parsed;
  if (command === "init") {
    return operationResult({ ...(await initializeDatabase(database)),
      bootstrap: AGENT_BOOTSTRAP });
  }
  if (command === "import") {
    const sourcePath = resolveInputPath(positionals[0]);
    const unified = sourcePath.toLowerCase().endsWith(".json");
    const module = await import(unified ? "./legacy-v070/unified.mjs" : "./import-v070.mjs");
    const importer = unified ? module.importUnified : module.importV070;
    return operationResult(await importer({ sourcePath, database,
      dryRun: options["--dry-run"] === true }));
  }
  if (command === "start") {
    return withDatabase(openOrInitializeWriteDatabase, database, (db) => {
      const actor = identity(options);
      const project = resolveProject(db, cwd(options));
      const result = startProjection(db, project, actor, { database });
      return scoped(db, project, actor, result.data, result);
    });
  }
  if (command === "put") {
    const value = coercePutRecord(await input(options, io, "put_input"));
    validatePutInput(value);
    return withDatabase(openOrInitializeWriteDatabase, database, (db) => {
      const record = putRecord(db, value, { database });
      return operationResult(normalizeRecord(record), {
        revision: currentRevision(db), scope: unscoped(record) });
    });
  }
  if (["get", "find", "links", "export"].includes(command)) {
    return dispatchRead(command, parsed, database);
  }
  if (command === "delete") {
    return withDatabase(openOrMigrateWriteDatabase, database, (db) => {
      const result = deleteRecord(db, positionals[0], { database });
      return operationResult(result, { revision: result.revision });
    });
  }
  if (command === "doctor") {
    return withDatabase(openDiagnosticDatabase, database, (db) => {
      let revision = 0;
      try { revision = currentRevision(db); }
      catch { /* Reported by doctor. */ }
      return operationResult(diagnoseDatabase(db, { database }), { revision });
    });
  }
  if (command === "work") return dispatchWork(options, positionals, database);
  if (command === "handoff") return dispatchHandoff(options, positionals, database, io);
  if (command === "decision") return dispatchDecision(options, positionals, database);
  throw lodestarError("unknown_command", "The requested command is not part of Lodestar.");
}

async function dispatchWork(options, positionals, database) {
  const action = positionals[0] ?? "status";
  const write = ["start", "done", "expire"].includes(action);
  const actor = identity(options, write);
  const open = write ? openOrInitializeWriteDatabase : openOrMigrateReadDatabase;
  return withDatabase(open, database, (db) => {
    const project = resolveProject(db, cwd(options));
    const history = () => {
      const limit = Number(options["--limit"] ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw lodestarError("invalid_input", "Work history limit must be from 1 to 200.");
      }
      return workStatus(db, project, true, limit);
    };
    const expire = () => {
      const hours = Number(options["--older-than-hours"] ?? 168);
      if (!Number.isFinite(hours) || hours < 1 || hours > 8_760) {
        throw lodestarError("invalid_input", "Work expiration hours must be from 1 to 8760.");
      }
      return workExpire(db, project, hours, { database });
    };
    const operations = { status: () => workStatus(db, project), history,
      start: () => positionals.length === 2
        && workStart(db, project, actor, positionals[1], { database }),
      done: () => positionals.length <= 2
        && workDone(db, project, actor, positionals[1], { database }),
      expire: () => positionals.length === 1 && expire() };
    const data = operations[action]?.();
    if (!data) throw lodestarError("unknown_operation", "The work operation is not supported.");
    return scoped(db, project, actor, data);
  });
}

async function dispatchHandoff(options, positionals, database, io) {
  const action = positionals[0];
  const write = ["arm", "checkpoint", "now", "disarm", "tail"].includes(action);
  const actor = identity(options, write);
  const packet = ["arm", "checkpoint", "now", "tail"].includes(action)
    ? await input(options, io, "handoff_input") : null;
  const open = action === "tail" ? openOrMigrateWriteDatabase
    : write ? openOrInitializeWriteDatabase : openOrMigrateReadDatabase;
  return withDatabase(open, database, (db) => {
    const project = resolveProject(db, cwd(options));
    const value = packet?.packet ?? packet;
    const operations = {
      arm: () => handoffArm(db, project, actor, value, { database }),
      checkpoint: () => handoffCheckpoint(db, project, actor, value, { database }),
      now: () => handoffNow(db, project, actor, value, { database }),
      status: () => handoffStatus(db, project, actor),
      disarm: () => handoffDisarm(db, project, actor, { database }),
      tail: () => handoffTail(db, project, actor, options["--role"] ?? packet.role,
        options["--turn"] ?? packet.turn, packet.text, { database }),
    };
    const data = operations[action]?.();
    if (!data) throw lodestarError("unknown_operation", "The handoff operation is not supported.");
    return scoped(db, project, actor, data);
  });
}

async function dispatchDecision(options, positionals, database) {
  const [action, key, value] = positionals;
  const write = ["set", "drop", "inject"].includes(action);
  const actor = identity(options, write);
  const open = write ? openOrInitializeWriteDatabase : openOrMigrateReadDatabase;
  return withDatabase(open, database, (db) => {
    const project = resolveProject(db, cwd(options));
    const change = { database, reason: options["--reason"] };
    const operations = {
      show: () => positionals.length === 1 && decisionProjection(db, project),
      set: () => positionals.length === 3
        && decisionSet(db, project, actor, key, value, change),
      drop: () => positionals.length === 2 && decisionDrop(db, project, actor, key, change),
      inject: () => positionals.length === 2 && ["on", "off"].includes(key)
        && decisionInjection(db, project, actor, key === "on", change),
    };
    const data = operations[action]?.();
    if (!data) throw lodestarError("unknown_operation", "The decision operation is not supported.");
    return scoped(db, project, actor, data);
  });
}
