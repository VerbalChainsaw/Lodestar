import { createHash } from "node:crypto";
import path from "node:path";
import { AGENT_BOOTSTRAP, REQUIRED_GOVERNANCE } from "./bootstrap.mjs";
import { initializeDatabase, openDiagnosticDatabase, openOrInitializeWriteDatabase,
  openOrMigrateReadDatabase, openOrMigrateWriteDatabase, transaction } from "./database.mjs";
import { diagnoseDatabase } from "./doctor.mjs";
import { decisionDrop, decisionInjection, decisionProjection, decisionSet,
  decisionStatus } from "./decision.mjs";
import { lodestarError } from "./errors.mjs";
import {
  claimHandoffInside, handoffArm, handoffCheckpoint, handoffDisarm, handoffNow,
  handoffStartupView, handoffStatus, handoffTail,
} from "./continuity.mjs";
import { canonicalStringify, parseJsonText, readStreamComplete,
  readTextFileComplete } from "./json.mjs";
import { resolveInputPath } from "./paths.mjs";
import { pendingAdd, pendingCount, pendingDrop, pendingList,
  pendingPromote } from "./pending.mjs";
import { hash, normalizedRows, recordInput, resolveIdentity, resolveProject,
  scope } from "./project.mjs";
import { exportRegistry, findRecords, linkedRecords } from "./queries.mjs";
import { coercePutRecord, deleteRecord, getRecord, getRecordById, normalizeRecord,
  putRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision, currentRevision } from "./revisions.mjs";
import { validateLimit, validatePutInput } from "./validate.mjs";
import { workDone, workExpire, workStart, workStatus } from "./work.mjs";
export { normalizeMachinePath, resolveIdentity, resolveProject } from "./project.mjs";
export const operationResult = (data, options = {}) => ({ data,
  revision: options.revision ?? 0, scope: options.scope ?? scope(),
  more: options.more ?? false, next: options.next ?? [] });

function startProjectionInside(db, project, identity, options = {}) {
  const handoff = handoffStartupView(claimHandoffInside(db, project, identity, options));
  const order = "ORDER BY json_extract(content_json,'$._lodestar.priority') DESC,"
    + "json_extract(content_json,'$._lodestar.revision') DESC,id";
  const storedRequired = normalizedRows(db,
    "SELECT id FROM records WHERE scope IN ('global',?) "
      + "AND json_extract(content_json,'$.value.required')=1 " + order, project.scope);
  const required = [REQUIRED_GOVERNANCE,
    ...storedRequired.filter(({ id }) => id !== REQUIRED_GOVERNANCE.id)];
  const optionalWhere = "FROM records WHERE scope IN ('global',?) "
    + "AND type NOT IN ('work','handoff','project','decision-event','config','startup-snapshot') "
    + "AND type NOT LIKE 'handoff-%' "
    + "AND COALESCE(json_extract(content_json,'$.value.required'),0)!=1 ";
  const optional = db.prepare(`SELECT id ${optionalWhere}${order}`).all(project.scope)
    .map(({ id }) => normalizeRecord(getRecordById(db, id)));
  const stub = (record) => ({
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    availability: record.availability,
    priority: record.priority,
    revision: record.revision,
    updated_at: record.updated_at,
    data: { name: record.data.name },
  });
  const target = options.startupBudget ?? null;
  const budget = {
    bytes: target,
    source: target === null ? "unbounded" : "option",
    applies_to: "optional",
    target_met: true,
  };
  const data = {
    project: { id: project.id, scope: project.scope, name: project.name,
      root: project.root, cwd: project.cwd, identity_source: project.identity_source,
      git_common_directory: project.git_common_directory ?? null },
    required,
    decisions: decisionProjection(db, project),
    context: [],
    available: optional.map(stub),
    active_work: workStatus(db, project).records,
    handoff,
    pending: pendingCount(db, project),
    budget,
    ...(options.snapshot ? { startup_snapshot: options.snapshot } : {}),
  };
  if (target === null) {
    data.context = optional;
    data.available = [];
  } else {
    for (const record of optional) {
      const candidate = data.context.concat(record);
      const candidateData = { ...data, context: candidate,
        available: data.available.slice(1) };
      if (Buffer.byteLength(canonicalStringify(candidateData), "utf8") > target) break;
      data.context = candidate;
      data.available = candidateData.available;
    }
    budget.target_met = data.available.length === 0
      && Buffer.byteLength(canonicalStringify(data), "utf8") <= target;
  }
  const next = [];
  if (data.available.length > 0) next.push(`lodestar get "${data.available[0].id}"`);
  return { data, revision: currentRevision(db), more: data.available.length > 0, next };
}

export function startProjection(db, project, identity, options = {}) {
  return transaction(db, () => startProjectionInside(db, project, identity, options),
    options.database);
}

const snapshotDigest = (projection) => {
  const snapshot = projection?.data?.startup_snapshot;
  const normalized = { ...projection, data: { ...projection?.data,
    startup_snapshot: { ...snapshot, digest: "0".repeat(64) } } };
  return createHash("sha256").update(canonicalStringify(normalized)).digest("hex");
};
const snapshotId = (project, identity) => `startup-snapshot:${hash(
  canonicalStringify([project.scope, identity.session]), 64)}`;
const snapshotFailure = (id, project, identity) => lodestarError(
  "startup_snapshot_conflict",
  "The persisted Lodestar startup snapshot conflicts with its canonical identity or digest.",
  {
    identifiers: { id, project: project.scope, session: identity.session },
    action: "Do not apply this response. Retry lodestar start with the same session identity; "
      + "if the conflict remains, run lodestar doctor and recover the stored snapshot "
      + "before continuing.",
  },
);

function replaySnapshot(db, id, project, identity) {
  const row = db.prepare("SELECT type,scope,content_json FROM records WHERE id=?").get(id);
  if (!row) return null;
  try {
    const stored = JSON.parse(row.content_json)?.value;
    const projection = stored?.projection;
    if (row.type !== "startup-snapshot" || row.scope !== project.scope
        || stored?.v !== 1 || stored?.project?.id !== project.id
        || stored?.project?.scope !== project.scope || stored?.session !== identity.session
        || stored?.digest !== snapshotDigest(projection)
        || projection?.data?.startup_snapshot?.id !== id
        || projection?.data?.startup_snapshot?.digest !== stored?.digest
        || projection?.data?.startup_snapshot?.persisted !== true
        || !projection || typeof projection !== "object" || Array.isArray(projection)
        || !Object.hasOwn(projection, "data") || !Number.isSafeInteger(projection.revision)
        || typeof projection.more !== "boolean" || !Array.isArray(projection.next)
        || projection.scope?.project !== project.scope
        || projection.scope?.session !== identity.session) throw new Error("invalid snapshot");
    return projection;
  } catch {
    throw snapshotFailure(id, project, identity);
  }
}

export function startSnapshotProjection(db, project, identity, options = {}) {
  if (!identity.session) {
    const result = startProjection(db, project, identity, options);
    return operationResult(result.data, { ...result, scope: scope(project, identity) });
  }
  const id = snapshotId(project, identity);
  const snapshotShape = { id, digest: "0".repeat(64), persisted: true };
  return transaction(db, () => {
    const replay = replaySnapshot(db, id, project, identity);
    if (replay) return replay;
    const result = startProjectionInside(db, project, identity,
      { ...options, snapshot: snapshotShape });
    options.beforePersist?.();
    const revision = allocateRevision(db);
    const projection = operationResult({ ...result.data, startup_snapshot: snapshotShape },
      { ...result, revision, scope: scope(project, identity) });
    const digest = snapshotDigest(projection);
    projection.data.startup_snapshot.digest = digest;
    const timestamp = (options.now?.() ?? new Date()).toISOString();
    writeRecordSnapshot(db, recordInput(id, "startup-snapshot", id, project.scope, 0, {
      v: 1,
      project: { id: project.id, scope: project.scope },
      session: identity.session,
      identity: { agent: identity.agent, harness: identity.harness, actor: identity.actor },
      projection,
      digest,
    }), { createdAt: timestamp, updatedAt: timestamp, revision });
    return projection;
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
  const text = options["--file"]
    ? await readTextFileComplete(resolveInputPath(options["--file"]), { resource })
    : await readStreamComplete(io.stdin, { resource });
  return parseJsonText(text, { resource });
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
      const startupBudget = options["--startup-budget"] === undefined
        ? null
        : validateLimit(options["--startup-budget"], { field: "startup-budget" });
      return startSnapshotProjection(db, project, actor, { database, startupBudget });
    });
  }
  if (command === "put") {
    const value = coercePutRecord(await input(options, io, "put_input"));
    validatePutInput(value);
    return withDatabase(openOrInitializeWriteDatabase, database, (db) => {
      const owned = db.prepare("SELECT type FROM records WHERE id=?").get(value.id);
      if (value.type === "startup-snapshot" || owned?.type === "startup-snapshot") {
        throw lodestarError("reserved_record_type",
          "Startup snapshots are owned by lodestar start and cannot be changed publicly.",
          { identifiers: { id: value.id, type: "startup-snapshot" } });
      }
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
      const owned = db.prepare("SELECT type FROM records WHERE id=?").get(positionals[0]);
      if (owned?.type === "startup-snapshot") {
        throw lodestarError("reserved_record_type",
          "Startup snapshots are owned by lodestar start and cannot be deleted publicly.",
          { identifiers: { id: positionals[0], type: owned.type } });
      }
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
  if (command === "pending") return dispatchPending(options, positionals, database);
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
      const raw = options["--limit"];
      const limit = raw === undefined ? null : Number(raw);
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw lodestarError("invalid_input", "Work history limit must be a positive safe integer.");
      }
      return workStatus(db, project, true, limit);
    };
    const expire = () => {
      const raw = options["--older-than-hours"];
      const hours = Number(raw);
      if (raw === undefined || !Number.isFinite(hours) || hours <= 0) {
        throw lodestarError("invalid_input",
          "Work expiration requires an explicit positive --older-than-hours value.");
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

async function dispatchPending(options, positionals, database) {
  const action = positionals[0] ?? "list";
  const argument = positionals[1];
  const write = ["add", "promote", "drop"].includes(action);
  const actor = identity(options, write);
  const open = write ? openOrInitializeWriteDatabase : openOrMigrateReadDatabase;
  return withDatabase(open, database, (db) => {
    const project = resolveProject(db, cwd(options));
    const change = { database, source: options["--source"] };
    const operations = {
      list: () => positionals.length <= 1
        && pendingList(db, project, Number(options["--limit"] ?? 20)),
      add: () => positionals.length === 2 && pendingAdd(db, project, actor, argument, change),
      promote: () => positionals.length === 2
        && pendingPromote(db, project, actor, argument, change),
      drop: () => positionals.length === 2 && pendingDrop(db, project, argument, change),
    };
    const data = operations[action]?.();
    if (!data) throw lodestarError("unknown_operation", "The pending operation is not supported.");
    return scoped(db, project, actor, data);
  });
}

async function dispatchDecision(options, positionals, database) {
  const [action, key, value] = positionals;
  const write = ["set", "drop", "status", "inject"].includes(action);
  const actor = identity(options, write);
  const open = write ? openOrInitializeWriteDatabase : openOrMigrateReadDatabase;
  return withDatabase(open, database, (db) => {
    const project = resolveProject(db, cwd(options));
    const change = { database, reason: options["--reason"],
      authority: options["--authority"], successor: options["--successor"] };
    const operations = {
      show: () => positionals.length === 1 && decisionProjection(db, project),
      set: () => positionals.length === 3
        && decisionSet(db, project, actor, key, value,
          { ...change, status: options["--status"] }),
      status: () => positionals.length === 3 && ["accepted", "blocked"].includes(value)
        && decisionStatus(db, project, actor, key, value, change),
      drop: () => positionals.length === 2 && decisionDrop(db, project, actor, key, change),
      inject: () => positionals.length === 2 && ["on", "off"].includes(key)
        && decisionInjection(db, project, actor, key === "on", change),
    };
    const data = operations[action]?.();
    if (!data) throw lodestarError("unknown_operation", "The decision operation is not supported.");
    return scoped(db, project, actor, data);
  });
}
