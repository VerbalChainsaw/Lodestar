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
import { pendingAdd, pendingCount, pendingDrop, pendingList,
  pendingPromote } from "./pending.mjs";
import { normalizedRows, resolveIdentity, resolveProject, scope } from "./project.mjs";
import { exportRegistry, findRecords, linkedRecords } from "./queries.mjs";
import { coercePutRecord, deleteRecord, getRecord, getRecordById, normalizeRecord,
  putRecord } from "./records.mjs";
import { currentRevision } from "./revisions.mjs";
import { LIMITS, validatePutInput } from "./validate.mjs";
import { workDone, workExpire, workStart, workStatus } from "./work.mjs";
export { normalizeMachinePath, resolveIdentity, resolveProject } from "./project.mjs";
// The budget belongs to whoever reads the projection, not to Lodestar. 16 KiB is a
// starting point — about 4K tokens, which is generous for a small local model and
// negligible for a 200K-context host — so it is a default, not a wall. What keeps it a
// forcing function is that a raise is deliberate and visible: `start` reports the budget
// in force and where it came from, and `doctor` measures against the same number.
export const STARTUP_BYTES = 16 * 1024;
// A floor that always leaves room for the governance record plus a real projection, and
// a ceiling at the per-record storage limit. Outside these a budget is a typo.
const BUDGET_FLOOR = 8 * 1024;
const BUDGET_CEILING = 256 * 1024;
// How many in-scope records the projection will name but not carry. Stubs are cheap
// enough that this is bounded by usefulness rather than by bytes.
const STUB_LIMIT = 200;

const readBudget = (raw) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < BUDGET_FLOOR || value > BUDGET_CEILING) return null;
  return value;
};

// Precedence runs from most immediate to most durable: an explicit flag, then the host's
// environment, then a project's own configuration, then the machine's. A project setting
// wins over a global one because the project is the narrower statement.
export function resolveStartupBudget(db, project, options = {}) {
  const flag = readBudget(options.startupBudget);
  if (flag) return { bytes: flag, source: "option" };
  const environment = readBudget(process.env.LODESTAR_STARTUP_BUDGET);
  if (environment) return { bytes: environment, source: "environment" };
  const rows = db.prepare("SELECT scope,json_extract(content_json,"
    + "'$.value.startup_budget_bytes') AS bytes FROM records "
    + "WHERE type='config' AND scope IN ('global',?)").all(project.scope);
  for (const [wanted, source] of [[project.scope, "project"], ["global", "global"]]) {
    const found = rows.find(({ scope: at, bytes }) => at === wanted && readBudget(bytes));
    if (found) return { bytes: readBudget(found.bytes), source };
  }
  return { bytes: STARTUP_BYTES, source: "default" };
}
export const operationResult = (data, options = {}) => ({ data,
  revision: options.revision ?? 0, scope: options.scope ?? scope(),
  more: options.more ?? false, next: options.next ?? [] });
// The budget is measured on encoded JSON so a UTF-8 character is never split.
const startupBytes = (data, revision, project, identity, more, next) => Buffer.byteLength(
  canonicalStringify({ v: 1, ok: true, operation: "start", revision,
    scope: scope(project, identity), data, more, next }), "utf8") + 1;

// What a newly required record costs the scope it lands in. Global records are charged
// to every project, so the figure reported is the heaviest project the mark affects.
export function requiredBudgetNotice(db, value) {
  if (value?.content?.value?.required !== true) return {};
  const global = value.scope === "global";
  const rows = db.prepare("SELECT id,scope FROM records "
    + (global ? "WHERE json_extract(content_json,'$.value.required')=1"
      : "WHERE scope IN ('global',?) AND json_extract(content_json,'$.value.required')=1"))
    .all(...(global ? [] : [value.scope]));
  const totals = new Map();
  for (const row of rows) {
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(normalizeRecord(getRecordById(db, row.id))),
      "utf8"); } catch { continue; }
    const key = row.scope === "global" ? null : row.scope;
    totals.set(key, (totals.get(key) ?? 0) + bytes);
  }
  const base = totals.get(null) ?? 0;
  let worst = { scope: value.scope, bytes: base };
  for (const [key, bytes] of totals) {
    if (key !== null && base + bytes > worst.bytes) worst = { scope: key, bytes: base + bytes };
  }
  if (worst.bytes <= STARTUP_BYTES) return {};
  return { more: true, next: [`lodestar doctor — required records in ${worst.scope} now total `
    + `${worst.bytes} of the ${STARTUP_BYTES} startup budget, so start will demote some`] };
}

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
    const budget = resolveStartupBudget(db, project, options);
    const limit = options.optionalLimit ?? 12;
    // `config` joins the types startup never projects as context: it describes how the
    // projection is built, so carrying it would spend the budget describing the budget.
    const optionalWhere = "FROM records WHERE scope IN ('global',?) "
      + "AND type NOT IN ('work','handoff','project','decision-event','config') "
      + "AND type NOT LIKE 'handoff-%' "
      + "AND COALESCE(json_extract(content_json,'$.value.required'),0)!=1 ";
    const optionalTotal = Number(db.prepare(`SELECT count(*) AS count ${optionalWhere}`)
      .get(project.scope).count);
    const optional = db.prepare(`SELECT id ${optionalWhere}${order} LIMIT ?`)
      .all(project.scope, limit);
    // Everything shed becomes a stub instead of vanishing. A stub costs about a
    // twentieth of a record and keeps the id, so an agent that needs one fetches it with
    // a single `lodestar get`. Dropping records outright and pointing at a broad `find`
    // spent more reading than the shedding saved — the agent searched, re-read up to
    // fifty records, and still might not surface the one that mattered. The budget
    // exists to stop that, not to cause it.
    const carried = new Set(optional.map(({ id }) => id));
    const available = db.prepare(`SELECT id,name,type AS kind ${optionalWhere}${order} LIMIT ?`)
      .all(project.scope, STUB_LIMIT)
      .filter(({ id }) => !carried.has(id));
    // A projected record carries no display name, so demoting one to a stub needs the
    // name from the row it came from. One scoped query is cheaper than a lookup per
    // demotion, and a stub without a name makes the agent fetch it just to find out.
    const nameById = new Map(db
      .prepare("SELECT id,name FROM records WHERE scope IN ('global',?)")
      .all(project.scope).map(({ id, name }) => [id, name]));
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
      pending: pendingCount(db, project),
      available,
      // Stated so a reader can tell a shed projection from a small one, and can see that
      // a non-default budget is in force rather than wondering why the numbers moved.
      budget: { bytes: budget.bytes, source: budget.source },
      omitted,
    };
    const next = [];
    if (handoff?.packet?.summary) next.push(`lodestar handoff status --cwd "${project.cwd}"`);
    const revision = currentRevision(db);
    const fits = () => startupBytes(data, revision, project, identity,
      Object.keys(omitted).length > 0, next) <= budget.bytes;
    // Shedding demotes in one direction: optional context, then advisory work, then the
    // least important required records. Each demotion leaves a stub behind, so the
    // projection always names everything that exists in scope even when it cannot carry
    // it. `start` is the first command of every session; refusing to run stops all work,
    // so it is never the answer while there is anything left to demote.
    // The recovery line is charged to the budget before the next measurement, never
    // after. Adding it once the loops have finished grows the envelope past the limit
    // the loops just satisfied, which is how a bounded projection ships over budget.
    const recover = `lodestar find "${project.name}" --scope ${project.scope}`;
    const chargeRecovery = () => {
      if (!next.includes(recover)) next.unshift(recover);
    };
    const demote = (list, key) => {
      const record = list.pop();
      available.unshift({ id: record.id, name: nameById.get(record.id) ?? record.id,
        kind: record.kind });
      omitted[key] = (omitted[key] ?? 0) + 1;
      chargeRecovery();
    };
    const drop = () => {
      available.pop();
      omitted.hidden = (omitted.hidden ?? 0) + 1;
      chargeRecovery();
    };
    if (omitted.context) chargeRecovery();
    while (!fits() && data.context.length) demote(data.context, "context");
    while (!fits() && data.active_work.length) demote(data.active_work, "work");
    // A stub for an optional record is the cheapest thing here to lose — a pointer to
    // something already judged not worth carrying — so every one of them goes before a
    // required record's content does. Demoted records are unshifted to the front, which
    // leaves the optional stubs at the tail exactly where popping removes them first.
    while (!fits() && available.length) drop();
    // The governance record states the operating contract, so it is demoted last and
    // only if it is the one thing standing between here and the budget.
    while (!fits() && data.required.length > 1) demote(data.required, "required");
    while (!fits() && available.length) drop();
    const more = Object.keys(omitted).length > 0;
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
      const result = startProjection(db, project, actor,
        { database, startupBudget: options["--startup-budget"] });
      return scoped(db, project, actor, result.data, result);
    });
  }
  if (command === "put") {
    const value = coercePutRecord(await input(options, io, "put_input"));
    validatePutInput(value);
    return withDatabase(openOrInitializeWriteDatabase, database, (db) => {
      const record = putRecord(db, value, { database });
      return operationResult(normalizeRecord(record), {
        revision: currentRevision(db), scope: unscoped(record),
        // Marking a record required is where the budget is actually spent, and it used
        // to say nothing. The cost then surfaced at some later `start`, in some other
        // project, as records quietly demoted — far from the decision that caused it.
        // Reported, never refused: a bulk import must not fail on its last record.
        ...requiredBudgetNotice(db, value) });
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
