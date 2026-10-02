import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { canonicalStringify, decodeUtf8, JSON_INPUT_MAXIMUM_BYTES, parseJsonText } from "./json.mjs";
import { buildReadArgs, childEnvironment, executeCli, loadFindPages } from "./interface-client.mjs";
import { revalidateSelection } from "./interface-config.mjs";
import { sameMachinePath } from "./project.mjs";
import { listRecovery } from "./recovery-journal.mjs";
import { buildHumanRequest, buildOperatorRecord, combineReadBases, researchReviewFields } from "./operator-actions.mjs";

const domainKinds = new Set(["work", "work-event", "decision-event", "migration-source",
  "mutation-receipt", "pending", "startup-snapshot", "handoff", "handoff-packet"]);
const projectProtected = new Set(["roots", "root", "catalog_binding", "catalog_fields",
  "name", "path", "aliases", "source_fingerprint", "source_fingerprints"]);
const isProjectProtected = (key) => projectProtected.has(key) || key.startsWith("catalog_");
const display = (value) => JSON.stringify(value, null, 2);
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => canonicalStringify(left) === canonicalStringify(right);
const short = (value, length = 76) => String(value ?? "").replace(/\s+/gu, " ").slice(0, length);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rootOf = (project) => project?.data?.roots?.find((root) => typeof root === "string")
  ?? (typeof project?.data?.root === "string" ? project.data.root : null);
const recordedAt = (record) => record?.updated_at ?? "unknown";
class ProjectJump extends Error {}
function operatorReadOperation(args, cwd, scopes = null) {
  const ordinary = continuityReadOperation(args, cwd);
  if (ordinary) return ordinary;
  if (!Array.isArray(args) || args.some(token => typeof token !== "string" || !token || /[\u0000-\u001f\u007f]/u.test(token))) return null;
  if (args.length === 6 && args[0] === "find" && args[1] === "--all" && args[2] === "--scope" &&
    scopes?.has(args[3]) && args[4] === "--kind" && args[5] === "knowledge") return "find";
  const operation = `${args[0]}.${args[1]}`;
  if (!["work.check", "work.status", "work.history", "pending.list"].includes(operation) ||
    args[2] !== "--cwd" || !cwd || !sameMachinePath(args[3], cwd)) return null;
  if (operation === "work.check") return args.length === 6 && args[4] === "--" ? operation : null;
  return args.length === 4 ? operation : null;
}
function operatorProjectScopes(project) {
  const validScope = scope => typeof scope === "string" && scope.length > 0 && !/[\u0000-\u001f\u007f]/u.test(scope);
  if (!validScope(project?.scope) || !Array.isArray(project.historical_scopes) ||
    !project.historical_scopes.every(validScope)) return null;
  return new Set([project.scope, ...project.historical_scopes]);
}
function capturePreparation(data, draft, envelope, cwd, scope) {
  if (!isObject(data) || data.version !== 1 || data.operation !== "put" || data.stage !== draft.stage ||
    data.intent_record_id !== draft.intent_record_id || data.record_id !== (draft.record?.id ?? draft.record_id) ||
    !isObject(data.review) || typeof data.review.noop !== "boolean" || typeof data.review.summary !== "string" ||
    !/^[a-f0-9]{64}$/u.test(data.review.intent_sha256 ?? "") || !Number.isSafeInteger(data.review.intent_revision) ||
    (draft.stage === "create" ? data.review.record_revision !== null : !Number.isSafeInteger(data.review.record_revision)) ||
    !Array.isArray(data.review.changes) || data.review.changes.some(value => typeof value !== "string") ||
    !Array.isArray(data.read_after) || data.read_after.some(args => !operatorReadOperation(args, cwd))) return false;
  const basis = data.write_basis;
  if (!isObject(basis) || basis.database_instance_id !== envelope.database_instance_id ||
    basis.database_epoch !== envelope.database_epoch || !Array.isArray(basis.targets) || !basis.targets.length ||
    basis.project_scope !== scope || !sameMachinePath(basis.checkout ?? "", cwd) || basis.targets.some(target => !isObject(target) ||
      !["record", "decision"].includes(target.kind) || !(target.expected_revision === null ||
        (Number.isSafeInteger(target.expected_revision) && target.expected_revision >= 0))) ||
    !basis.targets.some(target => target.kind === "record" && target.id === draft.intent_record_id && target.expected_revision === data.review.intent_revision) ||
    !basis.targets.some(target => target.kind === "record" && target.id === data.record_id && target.expected_revision === data.review.record_revision)) return false;
  if (data.review.noop) return data.input === null;
  return isObject(data.input) && (draft.stage === "create"
    ? data.input.mode === "create" && isObject(data.input.record) && data.input.record.id === draft.record.id &&
      data.input.record.kind === (draft.record.type === "research" ? "research" : "knowledge") && data.input.record.scope === scope &&
      data.input.record.semantics?.context_role === "on_demand" && data.input.record.semantics?.applicability?.project === scope &&
      sameMachinePath(data.input.record.semantics?.applicability?.checkout ?? "", cwd)
    : data.input.mode === "update" && data.input.id === draft.intent_record_id && isObject(data.input.set) &&
      Object.keys(data.input.set).every(key => key === "data") && isObject(data.input.set.data) &&
      Object.keys(data.input.set.data).every(key => ["continuation", "acceptance"].includes(key)) &&
      Array.isArray(data.input.remove) && data.input.remove.length === 0);
}
// Only these public reads are admitted from a continuity response. Operands stay
// literal; the selected runtime supplies executable and database separately.
function continuityReadOperation(args, cwd) {
  if (!Array.isArray(args) || args.some(token => typeof token !== "string" || !token || /[\u0000-\u001f\u007f]/u.test(token))) return null;
  if ((args.length === 3 && args[0] === "get" && args[1] === "--") ||
      (args.length === 4 && args[0] === "get" && args[1] === "--raw" && args[2] === "--")) return "get";
  return args.length === 6 && args[0] === "decision" && args[1] === "show" &&
    args[2] === "--cwd" && cwd && sameMachinePath(args[3], cwd) && args[4] === "--" ? "decision.show" : null;
}
const literalContinuityRead = args => continuityReadOperation(args,
  Array.isArray(args) && args.length === 6 ? args[3] : null) !== null;
function explicitScopes(project) {
  return [project.scope !== "global" ? project.scope : null,
    project.semantics?.applicability?.project].filter((value) =>
    typeof value === "string" && value.length > 0);
}
export function projectAssociations(projects, records, scopeOverrides = new Map()) {
  const owners = new Map(), assigned = new Map(), global = [], unassigned = [];
  for (const project of projects) {
    if (project.kind !== "project" || ["historical", "superseded"].includes(project.semantics?.lifecycle)) continue;
    assigned.set(project.id, []);
    for (const scope of new Set([...explicitScopes(project), ...(scopeOverrides.get(project.id) ?? [])])) {
      const members = owners.get(scope) ?? new Set();
      members.add(project.id); owners.set(scope, members);
    }
  }
  for (const record of records) {
    if (record.kind === "project") continue;
    const applicable = record.semantics?.applicability?.project;
    const key = typeof applicable === "string" && applicable ? applicable : record.scope;
    if (key === "global") { global.push(record); continue; }
    const candidates = owners.get(key);
    if (!candidates || candidates.size !== 1) {
      unassigned.push({ record, scope: key, candidateProjects: [...(candidates ?? [])] });
      continue;
    }
    assigned.get([...candidates][0]).push(record);
  }
  return { assigned, global, unassigned };
}
export function projectIdentityMatches(record, resolved) {
  if (!record || !resolved || typeof resolved.id !== "string") return false;
  const direct = record.id === resolved.id || record.data?.canonical_project_id === resolved.id;
  const selectedScope = record.id.startsWith("project:") ? record.id : `project:${record.id}`;
  return direct || (Array.isArray(resolved.historical_scopes) &&
    resolved.historical_scopes.includes(selectedScope));
}

export function editability(record) {
  if (!record || domainKinds.has(record.kind) || record.kind?.startsWith("handoff-") ||
    record.id?.startsWith("mutation-receipt:") || record.id?.startsWith("migration-source:")) {
    return { editable: false, reason: "This record belongs to a domain command or retained history." };
  }
  if (!record.write_basis || !record.semantics || !Array.isArray(record.sources)) {
    return { editable: false, reason: "A fresh normalized record and complete write basis are required." };
  }
  return { editable: true, reason: null };
}

export function editRequest(record, draft, requestId) {
  if (!editability(record).editable) throw new Error(editability(record).reason);
  const set = {}, remove = [];
  for (const field of ["name", "availability", "priority"]) {
    if (!Object.hasOwn(draft, field)) continue;
    if (field === "name" && record.kind === "project") throw new Error("Project catalog name is protected.");
    if (!same(draft[field], record[field])) set[field] = draft[field];
  }
  if (Object.hasOwn(draft, "data")) {
    if (!isObject(record.data) || !isObject(draft.data)) {
      throw new Error("Shallow data edits require object data; scalar and array data are read-only.");
    }
    const changed = {};
    for (const [key, value] of Object.entries(draft.data)) {
      if (record.kind === "project" && isProjectProtected(key) &&
        (!Object.hasOwn(record.data, key) || !same(value, record.data[key]))) {
        throw new Error(`Project field ${key} is catalog-owned and protected.`);
      }
      if (!Object.hasOwn(record.data, key) || !same(value, record.data[key])) changed[key] = value;
    }
    for (const key of Object.keys(record.data)) if (!Object.hasOwn(draft.data, key)) {
      if (record.kind === "project" && isProjectProtected(key)) {
        throw new Error(`Project field ${key} is catalog-owned and protected.`);
      }
      remove.push(key);
    }
    if (Object.keys(changed).length) set.data = changed;
  }
  if (!Object.keys(set).length && !remove.length) return null;
  return { v: 5, request_id: requestId, write_basis: record.write_basis,
    input: { mode: "update", id: record.id, set, remove } };
}

function journalRoot(selection) {
  return path.join(path.dirname(selection.configPath ?? selection.database), "pending");
}
const journalOperations = new Set(["put", "delete", "decision.set", "pending.drop"]);
const journalSubject = (request) => request.input?.id ?? request.input?.record?.id ?? request.input?.key;
const journalArgs = (operation, folder, cwd) => ["put", "delete"].includes(operation)
  ? [operation, "--file", path.join(folder, "request.json")]
  : [...operation.split("."), "--cwd", cwd, "--file", path.join(folder, "request.json")];
async function saveJournal(selection, request, { operation = "put", cwd = null,
  projectId = null } = {}) {
  if (!journalOperations.has(operation) || (operation !== "put" && (!cwd || !projectId))) {
    throw new Error("Unsupported journal operation or missing project context.");
  }
  const folder = path.join(journalRoot(selection), request.request_id);
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  const context = { generation: selection.generation, fingerprint: selection.fingerprint,
    runtime_fingerprint: selection.runtimeFingerprint, request_sha256: sha256(requestBytes),
    node: selection.node, cli: selection.cli, database: selection.database,
    database_instance_id: request.database_instance_id ?? request.write_basis?.database_instance_id,
    database_epoch: request.database_epoch ?? request.write_basis?.database_epoch,
    operation, cwd, project_id: projectId };
  try {
    await mkdir(journalRoot(selection), { recursive: true });
    await mkdir(folder, { recursive: false });
    await writeFile(path.join(folder, "request.json"), requestBytes, { flag: "wx", flush: true });
    await writeFile(path.join(folder, "context.json"), `${JSON.stringify(context)}\n`, { flag: "wx", flush: true });
  } catch (error) {
    throw new Error(`Journal preparation failed (${error.code ?? "storage_error"}): ${error.message}. ` +
      `No write was dispatched for this attempt. Preserve any exact bytes in ${folder}. ` +
      "Action: Correct disk space, directory permissions or storage errors before preparing another write. " +
      "Inspect existing saved requests and receipts before retrying an older attempt.", { cause: error });
  }
  return folder;
}
const uncertainResponse = (response) => response?.mayHaveCommitted === true ||
  response?.error?.identifiers?.committed === "unknown" ||
  response?.error?.identifiers?.committed === true ||
  ["response_delivery_failed", "database_commit_outcome_unknown"].includes(response?.error?.code);
function admitRetainedReport(response, journal) {
  const file = path.join(journal.folder, "response.uncertainty.json");
  const reject = (reason) => { throw new Error(`${file}: ${reason}. Action: Preserve the retained report and exact request; inspect the original receipt and current state before replay.`); };
  if (!isObject(response)) reject("Retained report shape is unsupported");
  const envelope = Object.hasOwn(response, "v") || Object.hasOwn(response, "error") || Object.hasOwn(response, "ok");
  if (envelope) {
    if (response.v !== 5 || response.ok !== false || typeof response.more !== "boolean" ||
      !Array.isArray(response.next) || !isObject(response.error) ||
      typeof response.error.code !== "string" || !response.error.code ||
      typeof response.error.message !== "string" ||
      (response.error.identifiers != null && !isObject(response.error.identifiers)) ||
      (response.error.action != null && typeof response.error.action !== "string")) reject("Retained contract envelope shape or version is unsupported");
    if (response.operation !== journal.context.operation) reject("Retained operation conflicts with this saved request");
    if (response.request != null && !isObject(response.request)) reject("Retained request metadata shape is unsupported");
    if (response.revision != null && (!Number.isSafeInteger(response.revision) || response.revision < 0)) reject("Retained revision is invalid");
  } else {
    const fields = new Set(["kind", "code", "message", "mayHaveCommitted", "operation", "request_id",
      "request_sha256", "database_instance_id", "database_epoch"]);
    if (!["TransportError", "MissingResponse"].includes(response.kind) || response.mayHaveCommitted !== true ||
      Object.keys(response).some((key) => !fields.has(key)) ||
      (response.kind === "TransportError" && (typeof response.code !== "string" || !response.code || typeof response.message !== "string"))) {
      reject("Retained transport marker shape is unsupported");
    }
  }
  const identifiers = response.error?.identifiers;
  for (const [field, value, expected] of [
    ["operation", response.operation, journal.context.operation],
    ["database instance", response.database_instance_id, journal.context.database_instance_id],
    ["database epoch", response.database_epoch, journal.context.database_epoch],
    ["request id", response.request?.id, journal.request.request_id],
    ["top request id", response.request_id, journal.request.request_id],
    ["identifier request id", identifiers?.request_id, journal.request.request_id],
    ["identifier database instance", identifiers?.database_instance_id, journal.context.database_instance_id],
    ["identifier database epoch", identifiers?.database_epoch, journal.context.database_epoch],
    ["request hash", response.request_sha256, journal.context.request_sha256],
  ]) if (value != null && value !== expected) reject(`Retained ${field} conflicts with this saved request`);
  if (!uncertainResponse(response)) reject("Retained report does not establish uncertainty provenance");
  return { folderLocal: !envelope };
}
async function readRetainedReport(journal) {
  const file = path.join(journal.folder, "response.uncertainty.json");
  try {
    const response = parseJsonText(decodeUtf8(await readFile(file), { resource: "retained_uncertainty" }));
    admitRetainedReport(response, journal);
    return response;
  } catch (error) {
    if (error.message.includes(file)) throw error;
    const failure = new Error(`${file}: Retained report could not be read or decoded (${error.code ?? "invalid_report"}): ${error.message}. Action: Preserve the retained report and exact request; inspect the original receipt and current state before replay.`, { cause: error });
    failure.code = error.code;
    throw failure;
  }
}
async function retainUncertainty(folder, bytes, journal) {
  const retained = path.join(folder, "response.uncertainty.json");
  admitRetainedReport(parseJsonText(decodeUtf8(bytes, { resource: "retained_uncertainty" })), journal);
  try { await writeFile(retained, bytes, { flag: "wx", flush: true }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    await readRetainedReport(journal);
  }
}
async function storeResponse(folder, result, selection) {
  if (result.mayHaveCommitted || uncertainResponse(result.envelope)) {
    const first = result.envelope ?? { kind: result.kind, code: result.code,
      message: result.message, mayHaveCommitted: true };
    const journal = await readJournal(selection, path.basename(folder));
    await retainUncertainty(folder, Buffer.from(`${JSON.stringify(first)}\n`, "utf8"), journal);
  }
  if (!result.envelope) return;
  const temporary = path.join(folder, `response.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(result.envelope)}\n`, { flag: "wx", flush: true });
  await rename(temporary, path.join(folder, "response.json"));
}
async function readJournal(selection, name) {
  if (!/^ll-[0-9a-f-]{36}$/iu.test(name)) throw new Error("Invalid request journal name.");
  const folder = path.join(journalRoot(selection), name);
  let requestBytes, contextBytes;
  try { [requestBytes, contextBytes] = await Promise.all([
    readFile(path.join(folder, "request.json")),
    readFile(path.join(folder, "context.json"))]); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("Saved journal evidence is incomplete; the write outcome is unknown. Preserve the folder and inspect the exact saved request, receipt and current record before starting a new request.");
    throw error;
  }
  let requestText, request, context;
  try {
    requestText = decodeUtf8(requestBytes, { resource: "saved_request" });
    request = parseJsonText(requestText);
    context = parseJsonText(decodeUtf8(contextBytes, { resource: "saved_context" }));
  } catch (error) {
    throw new Error("Saved journal bytes cannot be verified (" + (error.code ?? "invalid_json") + "). Preserve " +
      folder + ". Inspect request.json, context.json and the original receipt/current record using the configured Lodestar reads. " +
      "Resolve the saved outcome before replaying its exact request or preparing another write.");
  }
  if (!/^[0-9a-f]{64}$/u.test(context?.runtime_fingerprint ?? "") ||
    !/^[0-9a-f]{64}$/u.test(context?.request_sha256 ?? "") ||
    sha256(requestBytes) !== context.request_sha256 ||
    context.database_instance_id !== (request.database_instance_id ?? request.write_basis?.database_instance_id) ||
    context.database_epoch !== (request.database_epoch ?? request.write_basis?.database_epoch)) {
    throw new Error("Saved request bytes or runtime fingerprint are missing or changed.");
  }
  const legacyEdit = context.operation === "put" && request.input?.mode === "update" &&
    typeof request.input.id === "string" && request.write_basis;
  const humanPut = context.operation === "put" && request.input?.mode === "create" &&
    typeof request.input.record?.id === "string";
  const decision = context.operation === "decision.set" && typeof request.input?.key === "string";
  const pendingDrop = ["pending.drop", "delete"].includes(context.operation) && typeof request.input?.id === "string";
  if (request?.v !== 5 || request.request_id !== name || !journalOperations.has(context.operation) ||
    !(legacyEdit || humanPut || decision || pendingDrop) ||
    (!legacyEdit && (!request.actor?.id?.startsWith("user:") ||
      request.actor.agent !== "human" || request.actor.harness !== "manager" ||
      request.actor.session !== null || !Array.isArray(request.preconditions))) ||
    (context.operation !== "put" && (!context.cwd || !context.project_id))) {
    throw new Error("Saved request has an invalid identity or shape.");
  }
  return { folder, requestBytes, requestText, request, context };
}
async function ensureJournalContext(selection, journal, execute) {
  await revalidateSelection(selection);
  const context = journal.context;
  if (context.fingerprint !== selection.fingerprint || context.generation !== selection.generation ||
    context.runtime_fingerprint !== selection.runtimeFingerprint ||
    context.node !== selection.node || context.cli !== selection.cli ||
    context.database !== selection.database || !journalOperations.has(context.operation)) {
    throw new Error("The journal belongs to a different interface runtime or configuration.");
  }
  const read = await execute(selection, { operation: "find", args: ["find", "--all", "--limit", "1"] });
  if (read.kind !== "EnvelopeSuccess" ||
    read.envelope.database_instance_id !== context.database_instance_id ||
    read.envelope.database_epoch !== context.database_epoch) {
    throw new Error("Cannot verify the journal against its original database instance and epoch.");
  }
  if (context.cwd && context.project_id) {
    const resolved = await execute(selection, { operation: "start", args: ["start", "--cwd", context.cwd] });
    if (resolved.kind !== "EnvelopeSuccess" ||
      !projectIdentityMatches({ id: context.project_id }, resolved.envelope.data?.project) ||
      resolved.envelope.data?.project?.scope !== journal.request.project_scope) {
      throw new Error("Saved project root no longer resolves to the request's project.");
    }
  }
}

export async function runManager({ selection, io = process, ask: injectedAsk = null,
  execute = executeCli, loadPages = loadFindPages, launch = null,
  initialProject = null, initialCwd = null } = {}) {
  const out = (text = "") => io.stdout.write(`${text}\n`);
  const reader = injectedAsk ? null : createInterface({ input: io.stdin, output: io.stdout,
    terminal: Boolean(io.stdin.isTTY && io.stdout.isTTY) });
  let promptAbort = null, activeChild = null, interrupted = false, operations = [], support = {};
  let databaseObservation = null;
  const captureDrafts = new Map();
  const confirmedRecovery = new Set();
  let activeCapture = null;
  reader?.on("SIGINT", () => { promptAbort?.abort(); activeChild?.abort(); });
  const ask = async (question) => {
    interrupted = false;
    const controller = new AbortController();
    promptAbort = controller;
    try { return injectedAsk ? await injectedAsk(question) : await reader.question(question,
      { signal: controller.signal }); }
    catch (error) {
      if (error?.name === "AbortError") { interrupted = true; return null; }
      const failure = new Error("Terminal input failed.");
      failure.name = "ManagerInputError";
      failure.code = "terminal_input_failed";
      throw failure;
    }
    finally { promptAbort = null; }
  };
  const confirmSave = async (question) => {
    try { return await ask(question); }
    catch (error) {
      if (error?.name === "ManagerInputError") {
        out("Draft was not saved; the reviewed changes above remain visible in this terminal. No write was dispatched.");
      }
      throw error;
    }
  };
  const perform = async (selected, invocation) => {
    const controller = new AbortController();
    activeChild = controller;
    try {
      const result = await execute(selected, { ...invocation, signal: controller.signal });
      if (result.kind === "EnvelopeSuccess" && (invocation.effect === undefined || invocation.effect === "read") &&
        result.envelope.database_instance_id && result.envelope.database_epoch && Number.isSafeInteger(result.envelope.revision)) {
        databaseObservation = { instance: result.envelope.database_instance_id, epoch: result.envelope.database_epoch,
          revision: result.envelope.revision, readAt: new Date().toISOString(), operation: invocation.operation };
      }
      return result;
    }
    finally { activeChild = null; }
  };
  const choose = async (title, choices, shortcuts = [], jump = true) => {
    out(`\n${title}`);
    choices.forEach((choice, index) => out(`  ${index + 1}. ${choice}`));
    if (shortcuts.length) out(`  ${shortcuts.join("; ")}`);
    if (jump) out("  p: Jump to project");
    const response = await ask("Choice (number, or q to go back): ");
    if (response === null && interrupted) { out("Interrupted; returned to menu."); return 0; }
    if (response === null || response.trim().toLowerCase() === "q") return -1;
    if (jump && response.trim().toLowerCase() === "p") {
      if (activeCapture) {
        const decision = await choose("Unsaved capture draft", ["Keep draft and jump", "Discard draft and jump", "Cancel jump"], [], false);
        if (decision !== 1 && decision !== 2) return 0;
        if (decision === 2) captureDrafts.delete(activeCapture.key);
        else out(`Draft retained for ${activeCapture.projectId}; fresh preparation is required before Save.`);
        activeCapture = null;
      }
      throw new ProjectJump();
    }
    if (shortcuts.some((entry) => entry.startsWith(`${response.trim().toLowerCase()}:`))) return response.trim().toLowerCase();
    const value = Number(response);
    if (!Number.isInteger(value) || value < 1 || value > choices.length) {
      out("Invalid choice. Use a listed number or q."); return 0;
    }
    return value;
  };
  const request = async (operation, args, effect = "read") => {
    const result = await perform(selection, { operation, args, effect });
    if (result.kind === "EnvelopeError") {
      const { error, next } = result.envelope;
      out(`Lodestar ${error.code}: ${short(error.message, 500)}`);
      if (typeof error.action === "string" && error.action.trim()) out(`Action: ${short(error.action, 500)}`);
      if (isObject(error.identifiers) && Object.keys(error.identifiers).length) {
        out(`Identifiers (including any write basis):\n${display(error.identifiers)}`);
      }
      for (const step of new Set(Array.isArray(next) ? next : [])) {
        if (typeof step === "string" && step.trim() && step !== error.action) out(`Next: ${short(step, 500)}`);
      }
    } else if (result.kind === "TransportError") {
      out(`Connection ${result.code}: ${short(result.message, 500)}`);
      if (result.mayHaveCommitted && result.envelope?.error && result.code !== "response_delivery_failed") {
        const reported = result.envelope.error;
        out(`Lodestar ${reported.code}: ${short(reported.message, 500)}`);
        out(`Reported commit certainty: ${reported.identifiers?.committed ?? "unknown"}. Verify against the exact saved request, original receipt and current state.`);
        if (typeof reported.action === "string") out(`Action: ${short(reported.action, 500)}`);
        for (const step of new Set(Array.isArray(result.envelope.next) ? result.envelope.next : [])) {
          if (typeof step === "string" && step.trim() && step !== reported.action) out(`Next: ${short(step, 500)}`);
        }
      }
      if (result.code === "response_delivery_failed" && result.envelope?.error) {
        const reported = result.envelope.error;
        const identifiers = isObject(reported.identifiers) ? reported.identifiers : {};
        const requestId = typeof identifiers.request_id === "string" ? short(identifiers.request_id, 120) : "unknown";
        const revision = Number.isSafeInteger(identifiers.committed_revision)
          ? identifiers.committed_revision : "unknown";
        const receiptId = typeof identifiers.receipt_id === "string" ? short(identifiers.receipt_id, 160) : "unknown";
        if (requestId !== "unknown" && revision !== "unknown" && receiptId !== "unknown" &&
          result.envelope.request?.id === identifiers.request_id &&
          result.envelope.revision === identifiers.committed_revision) {
          out(`CLI reports request ${requestId} committed at revision ${revision}; receipt ${receiptId}. Verify against the exact saved request and receipt.`);
        } else out("CLI reported a response failure with incomplete or mismatched commit identifiers. The write outcome remains unknown.");
        if (typeof reported.action === "string") out(`Action: ${short(reported.action, 500)}`);
        if (Array.isArray(identifiers.receipt_read_args)) {
          out(`Receipt read args: ${short(JSON.stringify(identifiers.receipt_read_args), 500)}`);
        }
        if (isObject(identifiers.output_file)) {
          out(`Completed response file reported: ${short(identifiers.output_file.path, 240)}; bytes ${identifiers.output_file.bytes}; SHA-256 ${short(identifiers.output_file.sha256, 64)}.`);
        }
      }
      if (effect !== "read") out(result.mayHaveCommitted
        ? "Write outcome is uncertain. Use the exact saved request in Recovery; do not create a new request."
        : "The write was not dispatched; review the saved request before retrying.");
    }
    return result;
  };
  const read = async (operation, args) => {
    const result = await request(operation, args);
    return result.kind === "EnvelopeSuccess" ? result.envelope : null;
  };
  const partialEmpty = "no loaded matches in this partial read; review errors and advisories above";
  const presentDiagnostics = (snapshot, args, title) => {
    const recordErrors = Array.isArray(snapshot.recordErrors) ? snapshot.recordErrors : [];
    const advisories = Array.isArray(snapshot.advisories) ? snapshot.advisories : [];
    if (snapshot.complete && !recordErrors.length && !advisories.length) return;
    out(`${title}: ${snapshot.complete ? "complete" : "partial"}; ${recordErrors.length} record errors; ${advisories.length} advisories.`);
    for (const error of recordErrors.slice(0, 8)) {
      const id = error?.identifiers?.id;
      out(`Record error ${short(id ?? "unknown", 120)} [${short(error?.code ?? "unknown", 80)}]: ${short(error?.message, 300)}`);
      if (error?.action) out(`Action: ${short(error.action, 300)}`);
      if (typeof id === "string") {
        if (id.length <= 240) {
          out(`Raw read arguments: ${JSON.stringify(["--db", selection.database, "get", "--raw", "--", id])}`);
          out(`History read arguments: ${JSON.stringify(["--db", selection.database, "get", "--history", "--", id])}`);
        } else out("2 literal read argument arrays omitted because the identifier exceeds the display bound; retrieve the exact record ID from the full read below.");
      }
    }
    if (recordErrors.length > 8) out(`${recordErrors.length - 8} more record errors omitted; inspect the full read below.`);
    for (const advisory of advisories.slice(0, 8)) out(`Advisory: ${short(advisory, 300)}`);
    if (advisories.length > 8) out(`${advisories.length - 8} more advisories omitted; inspect the full read below.`);
    const fullArgs = [...args];
    if (Number.isSafeInteger(snapshot.revision) && !fullArgs.includes("--at-revision")) {
      const separator = fullArgs.indexOf("--");
      fullArgs.splice(separator < 0 ? fullArgs.length : separator, 0, "--at-revision", String(snapshot.revision));
    }
    out("Diagnostic text is bounded; complete page evidence is available through the configured Lodestar CLI.");
    out(`Full read arguments: ${JSON.stringify(["--db", selection.database, "find", "--output", "<new-file>", ...fullArgs])}`);
    out("Replace <new-file> with a new output path; pass the argument array using --args-file. Verify output bytes/hash and follow returned next argument arrays at the same revision for all pages. If the revision changed, restart the read.");
  };
  const listRecords = async (records, title, emptyMessage = "no recorded matches") => {
    if (!records.length) { out(`${title}: ${emptyMessage}.`); return; }
    while (true) {
      const choice = await choose(title, [...records.map((record) =>
        `${record.id} | ${short(record.name)} | ${record.kind} | ${recordedAt(record)}`), "Back"]);
      if (choice < 0 || choice === records.length + 1) return;
      if (choice === 0) continue;
      await recordDetail(records[choice - 1].id);
    }
  };
  const recordDetail = async (id) => {
    const envelope = await read("get", ["get", "--", id]);
    if (!envelope) return;
    let record = envelope.data;
    while (true) {
      out(`\n${record.name} (${record.id})`);
      out(`Kind ${record.kind}; scope ${record.scope}; availability ${record.availability}; priority ${record.priority}`);
      out(`Saved ${record.updated_at}; revision ${record.revision}; lifecycle ${record.semantics?.lifecycle ?? "unknown"}`);
      out(`Data:\n${display(record.data)}`);
      out(`Semantics:\n${display(record.semantics)}`);
      const choice = await choose("Record detail", ["Sources", "Links", "Retained history", "Raw stored row",
        "Edit ordinary fields", "Back"], record.kind === "research" ? ["r: Review research source freshness"] : []);
      if (choice < 0 || choice === 6) return;
      if (choice === 0) continue;
      if (choice === 1) out(display(record.sources));
      if (choice === 2) { const links = await read("links", ["links", "--", id]); if (links) out(display(links.data)); }
      if (choice === 3) { const history = await read("get", ["get", "--history", "--", id]);
        if (history) out(display(history.data)); }
      if (choice === 4) { const raw = await read("get", ["get", "--raw", "--", id]);
        if (raw) out(display(raw.data)); }
      if (choice === 5) record = await editRecord(id) ?? record;
      if (choice === "r") record = await editRecord(id, { reviewResearch: true }) ?? record;
    }
  };
  const editRecord = async (id, { reviewResearch = false } = {}) => {
    const fresh = await read("get", ["get", "--", id]);
    if (!fresh) return;
    const record = fresh.data;
    const edit = editability(record);
    if (!edit.editable) { out(edit.reason); return; }
    const draft = {};
    if (reviewResearch) {
      if (record.kind !== "research" || !isObject(record.data)) { out("Research source review needs a research record."); return; }
      out(`Research source information:\n${display(record.data)}`);
      out("Source freshness is an operator attestation. Lodestar does not fetch or independently verify the source. Record updated_at describes this edit, separately from the source observation date.");
      const reviewed_at = await ask("Source observation date (YYYY-MM-DD; blank cancels): ");
      if (!reviewed_at) return;
      const source_version = await ask("Applicable source version (blank means unspecified): ");
      if (source_version === null) return;
      const review_qualifiers = await ask("Review qualifiers (scope and limitations): ");
      if (!review_qualifiers) return;
      const reviewed_by = await ask("Review author (operator attestation): ");
      if (!reviewed_by) return;
      try { draft.data = { ...record.data, ...researchReviewFields({ reviewed_at, source_version,
        review_qualifiers, reviewed_by }) }; }
      catch (error) { out(`Research review blocked: ${error.message}`); return; }
    } else {
      if (record.kind !== "project") {
        const name = await ask(`Name [${record.name}] (blank keeps): `);
        if (name === null) return;
        if (name) draft.name = name;
      }
      const availability = await ask(`Availability [${record.availability}] (blank keeps): `);
      if (availability === null) return;
      if (availability) draft.availability = availability;
      const priority = await ask(`Priority [${record.priority}] (blank keeps): `);
      if (priority === null) return;
      if (priority) {
        const value = Number(priority);
        if (!Number.isSafeInteger(value)) { out("Priority must be a safe integer."); return; }
        draft.priority = value;
      }
      if (isObject(record.data)) {
        out(`Current data:\n${display(record.data)}`);
        const data = await ask("Full data object JSON (blank keeps; top-level removals are explicit in review): ");
        if (data === null) return;
        if (data.trim()) {
          try { draft.data = parseJsonText(data, { resource: "manager_editor_data", maximum: JSON_INPUT_MAXIMUM_BYTES }); }
          catch (error) {
            const action = error.action ?? "Correct the JSON object and remove duplicate member names; preserve exact larger numbers as strings, then reopen the editor.";
            out(`Data rejected ${error.code}: ${error.message} Action: ${action}`);
            return;
          }
        }
      } else out("Non-object data is read-only in the shallow editor.");
    }
    let baseline = record;
    while (true) {
      let mutation;
      try { mutation = editRequest(baseline, draft, `ll-${randomUUID()}`); }
      catch (error) { out(error.message); return; }
      if (!mutation) { out("No changes to save."); return; }
      out(`\nReview update for ${id} in ${selection.database}:`);
      out(`Set:\n${display(mutation.input.set)}`);
      out(`Remove top-level data keys: ${display(mutation.input.remove)}`);
      if ((await confirmSave("Type SAVE to commit, or anything else to cancel: ")) !== "SAVE") {
        out("Draft cancelled."); return;
      }
      try { await revalidateSelection(selection); }
      catch (error) { out(`Save blocked: ${error.message}`); return; }
      let folder;
      try { folder = await saveJournal(selection, mutation); }
      catch (error) { out(`Save blocked; journal could not be written: ${error.message}`); return; }
      out(`Saved request ${mutation.request_id} at ${folder}.`);
      const result = await request("put", ["put", "--file", path.join(folder, "request.json")], "record_write");
      try { await storeResponse(folder, result, selection); }
      catch (error) { out(`Response could not be journaled: ${error.message}`); }
      if (result.kind === "EnvelopeSuccess") {
        out(`Saved ${id} at revision ${result.envelope.revision}.`);
        for (const advisory of result.envelope.next ?? []) if (typeof advisory === "string") out(advisory);
        const refreshed = await read("get", ["get", "--", id]);
        if (refreshed) out(`Current record:\n${display(refreshed.data)}`);
        return refreshed?.data;
      }
      if (result.kind === "EnvelopeError" && ["revision_conflict", "missing_precondition",
        "project_binding_conflict", "needs_reinspection"].includes(result.envelope.error.code)) {
        const current = await read("get", ["get", "--", id]);
        out(`Baseline data:\n${display(baseline.data)}\nCurrent data:\n${display(current?.data?.data ?? null)}\nYour draft:\n${display(draft)}`);
        if (!current || (await ask("Type REAPPLY to review a new request against current, or anything else to keep the old journal: ")) !== "REAPPLY") {
          out(`Draft and original request are recorded in ${folder}.`); return;
        }
        baseline = current.data;
        continue;
      }
      out(result.mayHaveCommitted || result.code === "response_delivery_failed"
        ? `Request ${mutation.request_id} remains in ${folder}; inspect its reported receipt and current record before any exact replay.`
        : `Request ${mutation.request_id} remains in ${folder}; use Recovery for exact replay.`);
      return;
    }
  };
  let lastLibrary = null;
  const loadLibrary = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const catalogArgs = ["--all", "--kind", "project", "--history", "--limit", "250"];
      const catalog = await loadPages(selection, catalogArgs, { execute: perform });
      if (catalog.kind !== "ReadSnapshot") {
        if (attempt === 0 && (catalog.code === "mixed_snapshot" ||
          catalog.envelope?.error?.code === "read_revision_conflict")) continue;
        out(`Project catalog unavailable: ${catalog.message ?? catalog.envelope?.error?.message ?? catalog.kind}`);
        break;
      }
      const currentArgs = ["--all", "--limit", "250", "--at-revision", String(catalog.revision)];
      const current = await loadPages(selection, currentArgs, { execute: perform });
      if (current.kind === "ReadSnapshot" && current.revision === catalog.revision &&
        current.database_instance_id === catalog.database_instance_id &&
        current.database_epoch === catalog.database_epoch) {
        const candidate = { catalog, current };
        presentDiagnostics(catalog, catalogArgs, "Project catalog read");
        presentDiagnostics(current, currentArgs, "Current library read");
        if (!catalog.complete || !current.complete) out("Library is partial; counts and ordering cover loaded records only.");
        if (catalog.complete && current.complete) lastLibrary = candidate;
        else if (lastLibrary) {
          out(`New library read is partial; showing last complete snapshot from ${lastLibrary.current.readAt}.`);
          return lastLibrary;
        }
        return candidate;
      }
      if (attempt === 1) out("Library refresh changed twice; no mixed snapshot was displayed.");
    }
    if (lastLibrary) out(`Showing last complete library snapshot from ${lastLibrary.current.readAt}.`);
    return lastLibrary;
  };
  const openLoader = async (project = null, record = null) => {
    if (!selection.configPath || !selection.loader) { out("Loader is unavailable without a configured executable."); return; }
    try { await revalidateSelection(selection); }
    catch (error) { out(`Loader launch blocked: ${error.message}`); return; }
    const argv = ["--interface-config", selection.configPath,
      ...(project ? ["--project", project] : []), ...(record ? ["--record", record] : [])];
    try {
      if (launch) await launch(selection.loader, argv);
      else await new Promise((resolve, reject) => {
        const child = spawn(selection.loader, argv, { detached: true, shell: false,
          windowsHide: false, stdio: "ignore", env: childEnvironment() });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      out("Lodestar Loader opened with the selected context.");
    } catch (error) { out(`Loader launch failed: ${error.message}`); }
  };
  const recovery = async () => {
    let foreign = [];
    try {
      const shared = await listRecovery(selection);
      foreign = shared.journals.filter(item => path.dirname(item.folder) !== journalRoot(selection));
      for (const error of shared.errors) out(`Recovery ${error.code}: ${error.message}. Action: ${error.action}`);
    } catch (error) { out(`Shared recovery could not be inspected: ${error.message}. Action: Preserve the journals; correct the selected runtime/storage and run recovery list before replay.`); }
    let names;
    try { names = (await readdir(journalRoot(selection), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
    catch (error) {
      if (error.code === "ENOENT") names = [];
      else {
        out(`Recovery unavailable at ${journalRoot(selection)} (${error.code ?? "filesystem_error"}). Action: Preserve this path and any saved request bytes. Restore a readable pending directory in the selected configuration, then open Recovery again. No replay was dispatched.`);
        return;
      }
    }
    if (!names.length && !foreign.length) { out("No saved mutation requests."); return; }
    const choice = await choose("Saved requests (including completed receipts)", [...names,
      ...(foreign.length ? ["Shared CLI / Loader pending requests"] : []), "Back"]);
    if (foreign.length && choice === names.length + 1) {
      const selected = await choose("Shared pending requests", [...foreign.map(item =>
        `${item.operation} ${item.request_id}${item.replay_eligible ? "" : " — blocked"}`), "Back"]);
      const item = foreign[selected - 1]; if (!item) return;
      out(`Journal: ${item.folder}\n${item.issue}\nAction: ${item.action}`);
      if (!item.replay_eligible || (await confirmSave("Type SAVE to replay this exact saved request, or anything else to cancel: ")) !== "SAVE") return;
      const args = ["recovery", "replay", item.key, ...(selection.configPath ? ["--interface-config", selection.configPath] : [])];
      const result = await request(item.operation, args, item.operation.includes(".") ? "domain_write" : "record_write");
      if (result.kind === "EnvelopeSuccess" && result.envelope.request?.id === item.request_id) {
        confirmedRecovery.add(item.request_id); out("Original request confirmed by its receipt.");
      }
      else out(`Original outcome remains unresolved. Preserve ${item.folder} and inspect its receipt before a new request.`);
      return;
    }
    if (choice < 1 || choice > names.length) return;
    let journal;
    try { journal = await readJournal(selection, names[choice - 1]); }
    catch (error) { out(`Saved request needs manual repair: ${error.message}`); return; }
    out(`Exact ${journal.context.operation} request ${journal.request.request_id} for ${journalSubject(journal.request)}:\n${journal.requestText}`);
    let recordedResponse = null;
    let recordedBytes = null, earlierUncertainty = null;
    try {
      recordedBytes = await readFile(path.join(journal.folder, "response.json"));
      recordedResponse = parseJsonText(decodeUtf8(recordedBytes,
        { resource: "saved_response" }));
      if (recordedResponse?.error?.code === "response_delivery_failed") {
        out(`Recorded response_delivery_failed report in ${path.join(journal.folder, "response.json")}.`);
      } else out(`Recorded response:\n${display(recordedResponse)}`);
    } catch (error) {
      out(`Saved response ${short(error?.code ?? error?.name ?? "saved_response_read_failed", 80)}: ${short(error?.message ?? "The saved response could not be read.", 500)}`);
      out("No complete response was recorded; outcome is uncertain. Action: preserve " +
        path.join(journal.folder, "response.json") + " and inspect the original receipt and current record before exact replay.");
    }
    try {
      earlierUncertainty = await readRetainedReport(journal);
    } catch (error) {
      if (error.code !== "ENOENT") {
        out(`Retained uncertainty evidence could not be verified: ${error.message}. Preserve the journal; inspect the original receipt and current state before replay.`);
        return;
      }
    }
    if (earlierUncertainty) {
      if (!Object.hasOwn(earlierUncertainty, "v")) out("Retained folder-local transport provenance has no core request/store identity; commit certainty remains unknown.");
      const committed = earlierUncertainty.error?.identifiers?.committed ?? "unknown";
      out(`Earlier attempt commit certainty: ${committed}; retained report in ${path.join(journal.folder, "response.uncertainty.json")}.`);
      const reported = earlierUncertainty.error ?? earlierUncertainty;
      out(`Earlier failure ${reported.code ?? reported.kind}: ${short(reported.message ?? "No complete response was recorded.", 500)}`);
      if (typeof reported.action === "string") out(`Action: ${short(reported.action, 500)}`);
      for (const step of new Set(Array.isArray(earlierUncertainty.next) ? earlierUncertainty.next : [])) {
        if (typeof step === "string" && step.trim() && step !== reported.action) out(`Next: ${short(step, 500)}`);
      }
      if (recordedResponse?.ok === false && !uncertainResponse(recordedResponse)) {
        out("The latest replay rejection does not settle the earlier attempt. Inspect the original receipt and current state before any replay or changed request.");
      }
    }
    if (recordedResponse?.error && (recordedResponse.error.identifiers?.committed === "unknown" ||
      recordedResponse.error.identifiers?.committed === true ||
      recordedResponse.error.code === "database_commit_outcome_unknown")) {
      const reported = recordedResponse.error;
      out(`Recorded commit certainty: ${reported.identifiers?.committed ?? "unknown"}. Preserve this response and the exact request.`);
      if (typeof reported.action === "string") out(`Action: ${short(reported.action, 500)}`);
      for (const step of new Set(Array.isArray(recordedResponse.next) ? recordedResponse.next : [])) {
        if (typeof step === "string" && step.trim() && step !== reported.action) out(`Next: ${short(step, 500)}`);
      }
      out("Inspect the original receipt and current state before any exact replay; do not create a new request while this outcome is unresolved.");
    }
    if (recordedResponse?.error?.code === "response_delivery_failed") {
      const identifiers = recordedResponse.error.identifiers;
      const receiptId = identifiers?.receipt_id;
      const reportedIdentityMatches = identifiers?.request_id === journal.request.request_id &&
        Number.isSafeInteger(identifiers.committed_revision) &&
        recordedResponse.revision === identifiers.committed_revision &&
        recordedResponse.database_instance_id === journal.context.database_instance_id &&
        recordedResponse.database_epoch === journal.context.database_epoch &&
        typeof receiptId === "string";
      if (!reportedIdentityMatches) {
        out("Reported commit identity conflicts with this saved request. Preserve the journal and inspect the receipt manually before any replay.");
        return;
      }
      let receipt;
      try { receipt = await request("get", ["get", "--", receiptId]); }
      catch (error) {
        out(`Receipt read failed ${short(error?.code ?? error?.name ?? "receipt_read_failed", 80)}: ${short(error?.message ?? "The receipt reader supplied no failure detail.", 500)}`);
      }
      const row = receipt?.kind === "EnvelopeSuccess" ? receipt.envelope.data : null;
      if (row?.id === receiptId && row.data?.request_id === journal.request.request_id &&
        row.data?.committed_revision === identifiers.committed_revision &&
        receipt.envelope.database_instance_id === journal.context.database_instance_id &&
        receipt.envelope.database_epoch === journal.context.database_epoch) {
        out(`Receipt confirmed: request ${journal.request.request_id} already committed at revision ${identifiers.committed_revision}. No replay is needed.`);
        confirmedRecovery.add(journal.request.request_id);
        return;
      }
      out("Receipt read did not confirm the reported commit. Preserve the exact saved request; only an exact replay after identity checks is safe.");
      out(`Receipt read arguments: ${JSON.stringify(["--db", selection.database, "get", "--", receiptId])}`);
      out(`Action: preserve ${path.join(journal.folder, "request.json")}; inspect the original receipt and current record before replaying or changing this request.`);
    }
    if ((await ask("Type REPLAY to resend these exact bytes after identity checks: ")) !== "REPLAY") return;
    if (!earlierUncertainty && (!recordedResponse || uncertainResponse(recordedResponse))) {
      try { await retainUncertainty(journal.folder, recordedResponse ? recordedBytes
        : Buffer.from(`${JSON.stringify({ kind: "MissingResponse", mayHaveCommitted: true })}\n`, "utf8"), journal); }
      catch (error) { out(`Replay blocked; prior uncertainty could not be retained: ${error.message}. Preserve the existing journal response.`); return; }
    }
    try { await ensureJournalContext(selection, journal, execute); }
    catch (error) { out(`Replay blocked: ${error.message}`); return; }
    const currentBytes = await readFile(path.join(journal.folder, "request.json"));
    if (!currentBytes.equals(journal.requestBytes) || sha256(currentBytes) !== journal.context.request_sha256) {
      out("Replay blocked: saved request bytes changed during review."); return;
    }
    const operation = journal.context.operation;
    const result = await request(operation, journalArgs(operation, journal.folder, journal.context.cwd),
      ["put", "delete"].includes(operation) ? "record_write" : "domain_write");
    try { await storeResponse(journal.folder, result, selection); }
    catch (error) { out(`Response could not be journaled: ${error.message}`); }
    if (result.kind === "EnvelopeSuccess" && result.envelope.request?.id === journal.request.request_id) {
      confirmedRecovery.add(journal.request.request_id);
      out(`Request ${journal.request.request_id} returned revision ${result.envelope.revision}.`);
    }
  };
  const commandCatalog = async (operations) => {
    while (true) {
      const choice = await choose("Commands", [...operations.map((op) =>
        `${op.id} [${op.effect}] ${short(op.summary)}`), "Back"]);
      if (choice < 0 || choice === operations.length + 1) return;
      if (choice === 0) continue;
      const selected = operations[choice - 1];
      out(display(selected));
      if (selected.guidance) for (const field of ["purpose", "use", "scope", "limits", "recovery"]) {
        if (typeof selected.guidance[field] === "string") out(`${field}: ${selected.guidance[field]}`);
      }
      if (selected.effect !== "read" || !Array.isArray(selected.parameters) ||
        selected.context?.actor || selected.constraints?.some((rule) =>
          !["at_most_one", "exactly_one"].includes(rule.kind))) {
        out("This operation is descriptive-only in Manager; its generic form is unavailable. Inspect the typed CLI contract before choosing the operation's dedicated workflow.");
        if (Array.isArray(selected.argv) && selected.argv.every((item) => typeof item === "string")) {
          out(`Typed help arguments: ${JSON.stringify(["--db", selection.database, ...selected.argv, "--help"])}`);
          out(`Use the selected Node ${selection.node} and CLI ${selection.cli} shown above. Typed help is a read; review its inputs, constraints and recovery before an explicit write.`);
        }
        continue;
      }
      if ((await ask("Run this read? (yes to continue): ")) !== "yes") continue;
      const values = {};
      let invalid = false;
      for (const param of selected.parameters) {
        if (!["positional", "option", "flag"].includes(param.binding) ||
          !param.schema || !["string", "integer", "boolean"].includes(param.schema.type)
          && !Array.isArray(param.schema.enum)) { invalid = true; break; }
        const input = await ask(`${param.name}${param.required ? " (required)" : ""}: `);
        if (input === null) { invalid = true; break; }
        if (!input) { if (param.required) invalid = true; continue; }
        if (param.binding === "flag") { if (!["true", "false"].includes(input)) { invalid = true; break; }
          values[param.name] = input === "true"; continue; }
        if (param.schema.enum && !param.schema.enum.includes(input)) { invalid = true; break; }
        if (param.schema.type === "integer" && (!/^\d+$/u.test(input) ||
          !Number.isSafeInteger(Number(input)) || Number(input) < (param.schema.minimum ?? 0))) {
          invalid = true; break;
        }
        values[param.name] = param.schema.type === "integer" ? Number(input) : input;
      }
      if (invalid) { out("Unsupported or invalid read parameters."); continue; }
      let args;
      try { args = buildReadArgs(selected, values); }
      catch (error) { out(`Read form unavailable: ${error.message}`); continue; }
      const result = await read(selected.id, args);
      if (result) out(display(result.data));
      out("This read does not certify an answer. Failed, empty or incomplete evidence remains unresolved; inspect the reported limits and recovery guidance.");
    }
  };
  const domainReads = async (project, selectedCwd, title, entries) => {
    while (true) {
      const choice = await choose(title, [...entries.map(([label]) => label), "Back"]);
      if (choice < 0 || choice === entries.length + 1) return;
      if (choice === 0) continue;
      if (!selectedCwd) { out("Domain read needs a valid current project root."); continue; }
      try { await revalidateSelection(selection); }
      catch (error) { out(`Domain read blocked: ${error.message}`); continue; }
      const resolved = await read("start", ["start", "--cwd", selectedCwd]);
      if (!projectIdentityMatches(project, resolved?.data?.project)) {
        out("Domain read blocked: this root no longer resolves to the selected project.");
        continue;
      }
      const operation = entries[choice - 1][1];
      const answer = await read(operation, [...operation.split("."), "--cwd", selectedCwd]);
      if (!answer) continue;
      out(`Domain ${operation} (read-only):\n${display(answer.data)}`);
      if (answer.data?.complete === false) out("Domain read is partial; inspect record_errors above.");
      if (answer.more || answer.data?.more) out("More domain records exist than this response contains.");
      for (const advisory of [...(answer.next ?? []), ...(answer.data?.next ?? [])]) {
        if (typeof advisory === "string") out(advisory);
      }
    }
  };
  const requiredAnswer = async (label) => {
    while (true) {
      const value = await ask(`${label} (q to cancel): `);
      if (value === null || value.trim().toLowerCase() === "q") return null;
      if (value.trim()) return value.trim();
      out(`${label} is required.`);
    }
  };
  const contentAnswer = async (label) => {
    while (true) {
      const first = await ask(`${label} (q cancels; > starts multiple lines): `);
      if (first === null || first.trim().toLowerCase() === "q") return null;
      let value = first;
      if (first === ">") {
        out(`Enter ${label} lines; a single . line finishes.`);
        const lines = [];
        while (true) {
          const line = await ask("> ");
          if (line === null) return null;
          if (line === ".") break;
          lines.push(line);
        }
        value = lines.join("\n");
      }
      if (value.trim()) return value;
      out(`${label} is required.`);
    }
  };
  const absentTarget = async (id) => {
    const result = await perform(selection, { operation: "get", args: ["get", "--", id] });
    if (result.kind === "EnvelopeError" && result.envelope.error?.code === "record_not_found") {
      return result.envelope;
    }
    out(result.kind === "EnvelopeSuccess" ? `Record ${id} already exists; choose another name or refresh.`
      : `Could not verify absent target ${id}: ${result.envelope?.error?.message ?? result.message ?? result.kind}`);
    return null;
  };
  const verifiedStart = async (project, cwd) => {
    if (!cwd) { out("A current project root is required for this action."); return null; }
    const start = await read("start", ["start", "--cwd", cwd]);
    if (!projectIdentityMatches(project, start?.data?.project) || !start?.data?.write_basis) {
      out("Action blocked: this root no longer resolves to the selected project with a write basis.");
      return null;
    }
    return start;
  };
  let lastHumanOutcome = "not_dispatched";
  let lastHumanRequestId = null;
  const saveHumanAction = async (operation, input, basis, author, { cwd = null,
    projectId = null } = {}) => {
    lastHumanOutcome = "not_dispatched";
    lastHumanRequestId = null;
    let mutation;
    try { mutation = buildHumanRequest(operation, input, basis, author, `ll-${randomUUID()}`); }
    catch (error) { out(`Action blocked: ${error.message}`); return false; }
    out(`\nReview exact ${operation} request for ${journalSubject(mutation)} in ${selection.database}:`);
    out(display(mutation));
    if ((await confirmSave("Type SAVE to commit, or q to cancel: ")) !== "SAVE") {
      out("Draft cancelled."); return false;
    }
    try { await revalidateSelection(selection); }
    catch (error) { out(`Save blocked: ${error.message}`); return false; }
    let folder;
    try { folder = await saveJournal(selection, mutation, { operation, cwd, projectId }); }
    catch (error) {
      out(`Save blocked; journal preparation failed before dispatch: ${error.message}`);
      return false;
    }
    out(`Saved request ${mutation.request_id} at ${folder}.`);
    lastHumanRequestId = mutation.request_id;
    const result = await request(operation, journalArgs(operation, folder, cwd),
      operation === "put" ? "record_write" : "domain_write");
    lastHumanOutcome = result.kind === "EnvelopeSuccess" ? "confirmed" :
      result.mayHaveCommitted || result.code === "response_delivery_failed" ? "unresolved" : "rejected";
    try { await storeResponse(folder, result, selection); }
    catch (error) { out(`Response could not be journaled: ${error.message}`); }
    if (result.kind === "EnvelopeSuccess") {
      out(`Saved ${journalSubject(mutation)} at revision ${result.envelope.revision}.`);
      return true;
    }
    out(result.mayHaveCommitted || result.code === "response_delivery_failed"
      ? `Request ${mutation.request_id} remains in ${folder}; inspect its reported receipt and current record before any exact replay.`
      : `Request ${mutation.request_id} remains in ${folder}; use Recovery for exact replay. Refresh before making a changed request.`);
    return false;
  };
  const createProject = async () => {
    const author = await requiredAnswer("Human author");
    if (!author) return;
    const name = await requiredAnswer("Project name");
    if (!name) return;
    const rootInput = await requiredAnswer("Existing absolute project root");
    if (!rootInput) return;
    if (!path.isAbsolute(rootInput) || !(await stat(rootInput).catch(() => null))?.isDirectory()) {
      out("Project root must be an existing absolute directory."); return;
    }
    const root = path.resolve(rootInput);
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "").slice(0, 60) || randomUUID();
    const id = `project:${slug}`;
    const missing = await absentTarget(id);
    if (!missing) return;
    let basis, record;
    try {
      basis = combineReadBases([missing]);
      record = buildOperatorRecord("project", { id, name, root, scope: id, author });
    } catch (error) { out(`Project preparation blocked: ${error.message}`); return; }
    await saveHumanAction("put", { mode: "create", record }, basis, author);
  };
  const projectActions = async (project, cwd) => {
    while (true) {
      const choice = await choose("Human actions", ["Add note", "Add research", "Record rejection",
        "Set decision", "Retire pending", "Back"], ["r: Retire ordinary record"]);
      if (choice < 0 || choice === 6) return false;
      if (choice === 0) continue;
      const start = await verifiedStart(project, cwd);
      if (!start) continue;
      const author = await requiredAnswer("Human author");
      if (!author) continue;
      const labels = { 1: ["Note name", "Note body"],
        2: ["Research name", "Source reference (supplied; no fetch)", "Research body",
          "Claim", "Limitations"],
        3: ["Rejection name", "Rejected subject", "Reason"],
        4: ["Decision key", "Decision value", "Reason", "User reference", "User instruction"],
        5: ["Pending ID", "Retirement reason"], r: ["Record ID", "Retirement reason"] };
      const contentFields = { 1: new Set(["Note body"]),
        2: new Set(["Research body", "Claim", "Limitations"]),
        3: new Set(["Reason"]),
        4: new Set(["Decision value", "Reason", "User instruction"]),
        5: new Set(["Retirement reason"]), r: new Set(["Retirement reason"]) };
      const values = [];
      for (const label of labels[choice]) {
        const value = await (contentFields[choice].has(label) ? contentAnswer(label) : requiredAnswer(label));
        if (!value) break;
        values.push(value);
      }
      if (values.length !== labels[choice].length) continue;
      let operation, input, basis;
      try {
        if (choice <= 3) {
          const kind = { 1: "note", 2: "research", 3: "rejection" }[choice];
          const id = `${kind}:${randomUUID()}`;
          const absent = await absentTarget(id);
          if (!absent) continue;
          basis = combineReadBases([start, absent]);
          const fields = choice === 1 ? { name: values[0], body: values[1] }
            : choice === 2 ? { name: values[0], source: values[1], body: values[2],
              claim: values[3], limitations: values[4] }
              : { name: values[0], subject: values[1], reason: values[2] };
          const record = buildOperatorRecord(kind, { id, ...fields, author,
            scope: basis.project_scope, checkout: basis.checkout });
          operation = "put"; input = { mode: "create", record };
        } else if (choice === 4) {
          const shown = await read("decision.show", ["decision", "show",
            "--cwd", cwd, "--at-revision", String(start.revision), "--", values[0]]);
          if (!shown || shown.data?.complete === false) { out("Decision read is incomplete; action blocked."); continue; }
          basis = combineReadBases([start, shown]);
          operation = "decision.set";
          input = { key: values[0], value: values[1], reason: values[2], status: "accepted",
            direction: { kind: "user", attribution: "asserted", reference: values[3],
              instruction: values[4] } };
        } else if (choice === "r") {
          const exact = await read("get", ["get", values[0], "--at-revision", String(start.revision)]);
          if (!exact || exact.data.kind === "project" || !editability(exact.data).editable || exact.data.scope !== start.data.project.scope) {
            out("Select a current ordinary record owned by this project; catalog/domain/history records need their dedicated workflow."); continue;
          }
          basis = combineReadBases([start, exact]); operation = "delete";
          input = { id: values[0], reason: values[1] };
        } else {
          const pending = await read("pending.list", ["pending", "list", "--cwd", cwd,
            "--at-revision", String(start.revision)]);
          if (!pending || pending.data?.complete === false ||
            !pending.data?.records?.some((record) => record.id === values[0])) {
            out("Pending item is absent or the list is incomplete; action blocked."); continue;
          }
          basis = combineReadBases([start, pending]);
          operation = "pending.drop"; input = { id: values[0], reason: values[1] };
        }
      } catch (error) { out(`Action preparation blocked: ${error.message}`); continue; }
      if (await saveHumanAction(operation, input, basis, author,
        { cwd, projectId: project.id })) return true;
    }
  };
  const supportsRead = (id) => {
    const descriptor = operations.find(item => item.id === id);
    return descriptor?.effect === "read" && same(descriptor.argv, id.split(".")) &&
      descriptor.context?.project === true && descriptor.context?.actor === false;
  };
  const selectIntent = async (project, cwd, title, verifyIntent = false,
    { autoSingle = false, readableOnly = false } = {}) => {
    const start = await verifiedStart(project, cwd), library = start ? await loadLibrary() : null;
    if (!library) return null;
    const scopes = operatorProjectScopes(start.data.project);
    const intents = library.current.records.filter(record => record.kind === "knowledge" &&
      isObject(record.data?.intent) && scopes?.has(record.scope) &&
      !["historical", "superseded"].includes(record.semantics?.lifecycle) &&
      (!readableOnly || !["unavailable", "stale"].includes(record.availability)));
    if (!intents.length) {
      out("No current intent is loaded; it must be a current project-scoped knowledge record with data.intent. Inspect Records and library coverage for an existing intent.");
      const put = operations.find(operation => operation.id === "put");
      const check = operations.find(operation => operation.id === "work.check");
      if (put?.effect === "record_write" && same(put.argv, ["put"]) &&
        check?.effect === "read" && same(check.argv, ["work", "check"]) && isObject(check.record_schema)) {
        out("From Main menu > Commands, inspect put for the checked creation contract and work.check for the intent data schema. Commands provides typed help arguments for the selected Node, CLI and database shown above.");
        out("Create the knowledge record with checked put using fresh public read write bases and a complete request file; the Commands write entry describes the contract.");
      } else out("Inspect Commands for the selected core's supported creation contract and intent data schema before creating a record.");
      out("After creation or correction, reopen this project's Intent / continuity to refresh the library and select the current intent. Capture / link requires an existing intent.");
      return null;
    }
    const picked = autoSingle && intents.length === 1 ? 1
      : await choose(title, [...intents.map(record => `${record.id} | ${short(record.name)}`), "Back"]);
    const intent = picked > 0 && picked <= intents.length ? intents[picked - 1] : null;
    if (intent && verifyIntent && !await read("work.check", ["work", "check", "--cwd", cwd, "--", intent.id])) {
      out("Selected intent is unavailable to the public work check; inspect its recorded diagnostics.");
      return null;
    }
    return intent;
  };
  const captureLink = async (project, cwd) => {
    if (!supportsRead("work.prepare-capture")) { out("Selected core does not support this action: Capture / link."); return; }
    if (!await verifiedStart(project, cwd)) return;
    let state = [...captureDrafts.values()].find(draft => draft.runtime === selection.runtimeFingerprint &&
      draft.projectId === project.id && sameMachinePath(draft.cwd, cwd));
    const key = state?.key ?? `${selection.runtimeFingerprint}\0${project.id}\0${cwd}`;
    if (!state) {
      const intent = await selectIntent(project, cwd, "Select capture intent");
      if (!intent) return;
      out(`Original brief: ${intent.data.intent.brief}`);
      const purpose = await choose("Capture purpose", ["Mission context only", "Requirement context only", "Requirement context and recorded result", "Recorded result only", "Back"]);
      if (purpose < 1 || purpose > 4) return;
      let requirement;
      if (purpose !== 1) {
        const requirements = intent.data.intent.requirements;
        if (!Array.isArray(requirements) || !requirements.length) { out("Intent has no selectable requirements."); return; }
        const picked = await choose("Select requirement", [...requirements.map(item => `${item.id} | ${short(item.text)}`), "Back"]);
        requirement = requirements[picked - 1]?.id; if (!requirement) return;
      }
      let acceptance_result;
      if (purpose === 3 || purpose === 4) {
        const picked = await choose("Recorded result status", ["Unverified (default)", "Passed (explicit assertion)", "Failed (explicit assertion)", "Back"]);
        if (picked < 1 || picked > 3) return;
        const notes = await contentAnswer("Result notes"); if (!notes) return;
        acceptance_result = { requirement_id: requirement, status: ["unverified", "passed", "failed"][picked - 1], notes };
      }
      const context_target = purpose === 1 ? { kind: "mission" } : purpose === 4 ? null
        : { kind: "requirements", requirement_ids: [requirement] };
      const source = await choose("Capture source", ["Create knowledge", "Create research", "Create result", "Link existing record", "Back"]);
      if (source < 1 || source > 4) return;
      const author = await requiredAnswer("Human author"); if (!author) return;
      let record, record_id;
      if (source === 4) { record_id = await requiredAnswer("Existing record ID"); if (!record_id) return; }
      else {
        const name = await requiredAnswer("Record name"), body = name ? await contentAnswer("Body") : null;
        if (!body) return;
        const type = ["knowledge", "research", "result"][source - 1];
        record = { id: `${type === "research" ? "research" : "knowledge"}:${randomUUID()}`, type, name, body };
        for (const [field, label] of type === "research" ? [["source", "Source reference"], ["claim", "Claim"], ["limitations", "Limitations"]]
          : type === "result" ? [["observed_outcome", "Observed outcome"], ["evidence_reference", "Evidence reference"], ["limitations", "Limitations"]] : []) {
          const value = await contentAnswer(label); if (!value) return; record[field] = value;
        }
      }
      let initialize_continuation;
      if (context_target && !intent.data.continuation) {
        const ids = await requiredAnswer("Explicit active requirement IDs (comma-separated; none for empty)");
        const next_action = ids ? await contentAnswer("Explicit next action") : null; if (!next_action) return;
        initialize_continuation = { active_requirement_ids: ids === "none" ? [] : ids.split(",").map(id => id.trim()), next_action };
      }
      state = { key, projectId: project.id, cwd, runtime: selection.runtimeFingerprint, brief: intent.data.intent.brief,
        activeRequirementIds: intent.data.continuation?.active_requirement_ids ?? [],
        intentId: intent.id, author, record, recordId: record?.id ?? record_id, created: !record,
        association: { version: 1, stage: "associate", intent_record_id: intent.id, author,
          record_id: record?.id ?? record_id, context_target, ...(acceptance_result ? { acceptance_result } : {}),
          ...(initialize_continuation ? { initialize_continuation } : {}) } };
      captureDrafts.set(key, state);
    }
    activeCapture = state;
    try {
      if (state.uncertain) {
        out(`Capture outcome remains unresolved for ${state.recordId}. Open Recovery with the original request; association is blocked until its receipt is inspected.`);
        if (!confirmedRecovery.has(state.requestId)) {
          const action = await choose("Capture recovery", ["Recovery (exact original request)", "Keep draft and return"]);
          if (action === 1) await recovery();
        }
        if (confirmedRecovery.has(state.requestId)) {
          captureDrafts.delete(key);
          out(state.created ? `Association confirmed by the original receipt for ${state.recordId}.`
            : `Creation confirmed for ${state.recordId}. Resume using Link existing record; the original record is retained.`);
        }
        return;
      }
      while (true) {
        const mapped = state.runtime === selection.runtimeFingerprint ? await verifiedStart(project, state.cwd) : null;
        if (!mapped) return;
        const draft = state.created ? state.association : { version: 1, stage: "create", intent_record_id: state.intentId, author: state.author, record: state.record };
        const file = path.join(path.dirname(selection.configPath ?? selection.database), `.capture-${randomUUID()}.json`);
        let prepared;
        try {
          await revalidateSelection(selection);
          await writeFile(file, `${JSON.stringify(draft)}\n`, { flag: "wx" });
          prepared = await read("work.prepare-capture", ["work", "prepare-capture", "--cwd", state.cwd, "--file", file]);
        } catch (error) { out(`Capture preparation blocked: ${error.message}`); return; }
        finally { await unlink(file).catch(error => { if (error.code !== "ENOENT") out(`Draft file retained at ${file}: ${error.message}`); }); }
        if (!prepared) { out(`Draft retained for ${state.recordId}. Correct the named input or link the existing record; no replacement creation was dispatched.`); return; }
        const data = prepared.data;
        if (!capturePreparation(data, draft, prepared, state.cwd, mapped.data.project.scope)) { out("Capture preparation is malformed or unsupported; Save is disabled. Inspect the exact public response."); out(display(prepared)); return; }
        out(`Capture ${draft.stage} for ${state.recordId} · original project ${state.projectId} · original brief: ${state.brief}`);
        out(`Original active branch: ${state.activeRequirementIds.join(", ") || "none recorded"}; selected purpose: ${display({ context_target: state.association.context_target, acceptance_result: state.association.acceptance_result ?? null })}`);
        out(`Reviewed core changes:\n${display(data.review)}`);
        if (data.review.noop) { out("Already linked; no save is required."); captureDrafts.delete(key); return; }
        const action = await choose("Capture review", ["Save reviewed stage", "Prepare again", "Keep draft and return", "Discard draft"]);
        if (action === 2 || action === 0) continue;
        if (action === 4) captureDrafts.delete(key);
        if (action !== 1) return;
        if (!await saveHumanAction("put", data.input, data.write_basis, state.author, { cwd: state.cwd, projectId: state.projectId })) {
          // A dispatched failure has an exact journal. Only Recovery may resolve it.
          if (lastHumanOutcome === "unresolved") { state.uncertain = true; state.requestId = lastHumanRequestId; }
          out(state.created ? `Record ${state.recordId} retained; association not saved. Resume with Link existing record.` : `Draft ${state.recordId} retained; inspect any saved request in Recovery.`);
          return;
        }
        if (!state.created) {
          state.created = true;
          out(`Record saved; association not yet saved. Retained ID ${state.recordId}; resume with Link existing record if attachment is cancelled.`);
          const exact = await read("get", ["get", "--", state.recordId]);
          if (!exact || exact.data?.id !== state.recordId) { out("Created record read is unavailable; association is blocked. Inspect this ID before linking it."); return; }
          out(`Confirmed record revision ${exact.data.revision}; preparing fresh association.`);
          continue;
        }
        captureDrafts.delete(key); out("Association saved. Recorded result remains an operator assertion requiring evidence inspection."); return;
      }
    } finally { activeCapture = null; }
  };
  const projectAttention = async (project, cwd) => {
    if (!supportsRead("work.attention")) { out("Selected core does not support this action: Project attention."); return; }
    const intent = await selectIntent(project, cwd, "Select attention intent", true);
    while (true) {
      try { await revalidateSelection(selection); }
      catch (error) { out(`Attention read blocked: ${error.message}`); return; }
      const start = await verifiedStart(project, cwd);
      if (!start) return;
      const scopes = operatorProjectScopes(start.data.project);
      const args = ["work", "attention", "--cwd", cwd, ...(intent ? ["--", intent.id] : [])];
      const answer = await read("work.attention", args), readAt = new Date().toISOString();
      const data = answer?.data;
      const attentionScopes = operatorProjectScopes(data?.project);
      if (!data || data.version !== 1 || !projectIdentityMatches(project, data.project) ||
        !scopes || !attentionScopes || data.project.scope !== start.data.project.scope ||
        !same([...scopes].sort(), [...attentionScopes].sort()) ||
        !sameMachinePath(data.project?.cwd ?? "", cwd) || data.selected_intent_id !== (intent?.id ?? null) ||
        typeof data.complete !== "boolean" || !Array.isArray(data.read_required) || !isObject(data.sections) ||
        !["work", "pending", "acceptance", "context"].every(key => {
          const section = data.sections[key]; return isObject(section) && ["observed", "partial", "unavailable", "not_selected"].includes(section.state) &&
            typeof section.complete === "boolean" && typeof section.more === "boolean" && Array.isArray(section.items) && Array.isArray(section.issues) && Array.isArray(section.read_args);
        })) { out("Project attention returned missing, malformed or unsupported metadata; inspect the public response."); return; }
      out(`Project attention · ${project.id} · intent ${data.selected_intent_id ?? "not_selected"} · read ${readAt} · database revision ${answer.revision}`);
      out(`Observed database instance ${answer.database_instance_id}; epoch ${answer.database_epoch}`);
      const reads = new Map();
      const addRead = (label, follow) => {
        if (operatorReadOperation(follow, cwd, scopes)) reads.set(JSON.stringify(follow), { label, args: follow });
        else out(`Unsupported attention read; inspect the exact response: ${JSON.stringify(follow)}`);
      };
      const addReads = (label, args) => {
        const candidates = Array.isArray(args) && !args.every(token => typeof token === "string") ? args : [args];
        for (const follow of candidates) addRead(`${label}: ${JSON.stringify(follow)}`, follow);
      };
      for (const [name, section] of Object.entries(data.sections)) {
        out(`${name}: ${section.state} · coverage ${section.complete ? "complete" : "incomplete"} · more ${section.more}`);
        if (!section.items.length) out(section.complete ? "No recorded items." : "No loaded items; coverage incomplete.");
        out(display({ items: section.items, issues: section.issues }));
        addReads(name, section.read_args);
        for (const item of section.items) {
          if (typeof item?.key === "string") addRead(`Decision: ${item.key}`, ["decision", "show", "--cwd", cwd, "--", item.key]);
          else if (typeof item?.id === "string") addRead(`Record: ${item.id}`, ["get", "--", item.id]);
        }
      }
      for (const item of data.read_required ?? []) if (isObject(item)) addReads(`Required: ${item.target_id ?? item.code}`, item.read_args);
      if (isObject(data.intent_inventory)) {
        out(`Intent inventory coverage:\n${display(data.intent_inventory)}`);
        if (!data.intent_inventory.complete) addReads("Full intent inventory", data.intent_inventory.read_args);
      }
      const recoveryAt = new Date().toISOString();
      try {
        const observed = await listRecovery(selection);
        const relevant = [];
        for (const item of observed.journals) {
          let scope = "scope unknown";
          if (path.dirname(item.folder) === journalRoot(selection)) {
            try { scope = (await readJournal(selection, path.basename(item.folder))).context.project_id ?? scope; }
            catch { /* Retain uncertain or unreadable attribution in the global-access view. */ }
          }
          relevant.push({ ...item, observedScope: scope });
        }
        out(`Recovery · read ${recoveryAt} · runtime ${selection.runtimeFingerprint} · separate coverage ${observed.complete ? "complete" : "incomplete"}; not part of the database snapshot`);
        out(display({ requests: relevant.map(item => ({ request_id: item.request_id, issue: item.issue,
          scope: item.observedScope, selected_project: item.observedScope === project.id,
          folder: item.folder })), errors: observed.errors }));
      } catch (error) { out(`Recovery · read ${recoveryAt} · runtime ${selection.runtimeFingerprint} · coverage unavailable: ${error.message}. Global Recovery remains available.`); }
      const options = [...reads.values()];
      while (true) {
        const picked = await choose("Project attention actions", ["Refresh", "Intent / continuity", "Capture / link", "Pending", "Recovery (all original requests)", ...options.map(item => item.label), "Back"]);
        if (picked < 0 || picked === options.length + 6) return;
        if (picked === 0) continue;
        if (picked === 1) break;
        if (picked === 2) await intentContinuity(project, cwd);
        if (picked === 3) await captureLink(project, cwd);
        if (picked === 4) await domainReads(project, cwd, "Pending", [["List pending", "pending.list"]]);
        if (picked === 5) await recovery();
        if (picked >= 6) {
          const follow = options[picked - 6];
          try { await revalidateSelection(selection); }
          catch (error) { out(`Attention follow-up blocked: ${error.message}`); return; }
          const currentStart = follow ? await verifiedStart(project, cwd) : null;
          if (follow && currentStart) {
            const currentScopes = operatorProjectScopes(currentStart.data.project);
            const operation = operatorReadOperation(follow.args, cwd, currentScopes);
            if (operation) { out(`Literal read arguments: ${JSON.stringify(follow.args)}`); const exact = await read(operation, follow.args); if (exact) out(display(exact.data)); }
            else out("Attention follow-up blocked: the read no longer belongs to the verified project scopes.");
          }
        }
        out("Attention snapshot unchanged; use Refresh to observe current state.");
      }
    }
  };
  const intentContinuity = async (project, cwd) => {
    if (!cwd) { out("Intent read requires a verified project root."); return; }
    const described = operations.find(operation => operation.id === "work.check");
    if (described?.effect !== "read" || !same(described.argv, ["work", "check"]) ||
      described.context?.project !== true || described.context?.actor !== false ||
      !Array.isArray(described.parameters) || !described.parameters.some(parameter => parameter?.name === "intent_record_id" && parameter.binding === "positional" && parameter.index === 0)) {
      out("The selected core does not describe the supported work.check read. Refresh Connection capabilities or select a current core."); return;
    }
    const intent = await selectIntent(project, cwd, "Select current intent", false,
      { autoSingle: true, readableOnly: true });
    if (!intent) return;
    const id = intent.id;
    while (true) {
      try { await revalidateSelection(selection); }
      catch (error) { out(`Intent read blocked: ${error.message}`); return; }
      const mapped = await read("start", ["start", "--cwd", cwd]);
      if (!projectIdentityMatches(project, mapped?.data?.project)) { out("Intent read blocked: project root mapping changed."); return; }
      const scopes = operatorProjectScopes(mapped.data.project);
      const selected = await read("get", ["get", "--", id]);
      if (selected?.data?.id !== id || selected.data.kind !== "knowledge" || !scopes?.has(selected.data.scope) ||
        ["historical", "superseded"].includes(selected.data.semantics?.lifecycle) ||
        ["unavailable", "stale"].includes(selected.data.availability) || !isObject(selected.data.data?.intent)) {
        out("Selected intent is no longer current and readable in this project. Reopen Intent / continuity to refresh selection."); return;
      }
      const answer = await read("work.check", ["work", "check", "--cwd", cwd, "--", id]);
      if (!answer) return;
      if (!isObject(answer.data)) { out("Intent projection is unavailable: work.check returned malformed data. Inspect the exact public response and refresh the selected core."); out(display(answer)); return; }
      const data = answer.data, context = data.continuity;
      out(`Intent ${id} · project ${project.id} · read revision ${answer.revision ?? "unknown"}`);
      out(`ACCEPTANCE MAPPING: ${data.ready_to_review === true ? "ready for human review" : "needs attention"}; referenced evidence readable: ${data.complete === true ? "yes" : "no"}. Supplied results remain assertions.`);
      out(`Recorded plan / evidence:\n${display({ plan: data.plan, actual: data.actual, delta: data.delta, continuation: data.continuation, issues: data.issues })}`);
      const supported = context?.version === 1 && Array.isArray(context.records) && Array.isArray(context.decisions) &&
        Array.isArray(context.issues) && Array.isArray(context.read_required) && Array.isArray(context.active_requirement_ids) &&
        context.active_requirement_ids.every(id => typeof id === "string") &&
        context.records.every(row => isObject(row) && typeof row.id === "string" && isObject(row.selection)) &&
        context.decisions.every(row => isObject(row) && typeof row.key === "string" && ["current", "conflict", "unavailable"].includes(row.resolution)) &&
        context.issues.every(isObject) && context.read_required.every(row => isObject(row) && typeof row.target_id === "string" && literalContinuityRead(row.read_args)) &&
        typeof context.complete === "boolean" && typeof context.truncated === "boolean";
      const reads = new Map();
      if (!supported) {
        out("RECORDED CONTEXT COVERAGE: unknown. This core returned missing, malformed or unsupported continuity metadata/read arrays; the plan/evidence read remains available. Inspect the exact public response before acting.");
        out(`Exact public response:\n${display(answer)}`);
      }
      else {
        out(`RECORDED CONTEXT COVERAGE: ${context.complete ? "selection resolved" : "incomplete"}${context.truncated ? " · truncated" : ""}`);
        out(`Active requirements: ${context.active_requirement_ids_omitted ? "omitted by context bound; inspect the intent" : context.active_requirement_ids.join(", ") || "explicitly none"}`);
        out(`Current context records / selection reasons:\n${display(context.records)}`);
        out(`Resolved decisions / reasons:\n${display(context.decisions)}`);
        out(`Named context gaps:\n${display(context.issues)}`);
        out(`Required reads:\n${display(context.read_required)}`);
        out(`Context limits / omissions:\n${display({ limits: context.limits, omitted: context.omitted })}`);
        const add = (label, args) => {
          if (!continuityReadOperation(args, cwd)) { out(`Unsupported continuity read: ${display(args)}. Inspect the exact public response; no command is dispatched.`); return; }
          const key = JSON.stringify(args); if (!reads.has(key)) reads.set(key, { label, args });
        };
        for (const item of context.read_required) add(`Required: ${item.target_id} · ${item.code}`, item.read_args);
        for (const item of context.records) add(`Record: ${item.id}`, ["get", "--", item.id]);
        for (const item of context.decisions) add(`Decision: ${item.key}`, ["decision", "show", "--cwd", cwd, "--", item.key]);
      }
      out("This is current recorded context. It does not prove what context a past agent was delivered or establish acceptance.");
      const options = [...reads.values()];
      while (true) {
        const action = await choose("Intent / continuity actions", ["Refresh selected intent", ...options.map(item => item.label), "Back"]);
        if (action < 0 || action === options.length + 2) return;
        if (action === 1) break;
        if (action === 0) continue;
        const selectedRead = options[action - 2];
        try { await revalidateSelection(selection); }
        catch (error) { out(`Follow-up blocked: ${error.message}`); return; }
        const mapping = await read("start", ["start", "--cwd", cwd]);
        if (!projectIdentityMatches(project, mapping?.data?.project)) { out("Follow-up blocked: project root mapping changed."); return; }
        const operation = continuityReadOperation(selectedRead.args, cwd);
        if (!operation) { out("Unsupported continuity read; no command dispatched."); continue; }
        out(`Literal read arguments: ${JSON.stringify(selectedRead.args)}`);
        const follow = await read(operation, selectedRead.args);
        if (follow) out(display(follow.data));
        out("The continuity projection above is unchanged; refresh it to resolve current coverage after this read.");
      }
    }
  };
  const projectMenu = async (project, library, requestedCwd = null) => {
    const scopes = new Set(explicitScopes(project));
    const root = rootOf(project);
    const selectedCwd = requestedCwd ?? root;
    let trustedRoot = false;
    if (selectedCwd) {
      const orientation = await read("start", ["start", "--cwd", selectedCwd]);
      trustedRoot = projectIdentityMatches(project, orientation?.data?.project);
      if (trustedRoot && orientation?.data?.project?.scope) {
        scopes.add(orientation.data.project.scope);
        for (const historic of orientation.data.project.historical_scopes ?? []) scopes.add(historic);
      }
    }
    if (!trustedRoot) out(`Stale or missing project root for ${project.id}. Root-scoped reads and context launch are disabled.`);
    let records, sorted;
    const updateRecords = () => {
      const associations = projectAssociations(library.catalog.records, library.current.records,
        trustedRoot ? new Map([[project.id, scopes]]) : new Map());
      records = [project, ...(associations.assigned.get(project.id) ?? [])];
      sorted = [...records].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) ||
        a.id.localeCompare(b.id));
    };
    updateRecords();
    while (true) {
      const choice = await choose(`${project.name} (${project.id})`, ["Overview", "Records", "Recorded activity",
        "Work", "Handoff", "Decisions", "Pending", "Rejections", "Open Loader", "Human actions", "Intent / continuity", "Back", "Capture / link", "Project attention"]);
      if (choice < 0 || choice === 12) return;
      if (choice === 0) continue;
      if (choice === 1) {
        out(`Recorded status: ${typeof project.data?.status === "string" ? project.data.status : "No project status recorded"}`);
        out(`Roots: ${display(project.data?.roots ?? (root ? [root] : []))}`);
        out(`Current associated records loaded: ${records.length}; library complete: ${library.catalog.complete && library.current.complete}`);
        out(`Latest current-record update: ${sorted[0] ? `${sorted[0].updated_at} (${sorted[0].id})` : "unknown"}`);
        out(`Recorded open work: ${records.filter((record) => record.kind === "work" && record.data?.status === "open").length}`);
        out(`Read ${library.current.readAt}; database revision ${library.current.revision}`);
      }
      const emptyMessage = library.catalog.complete && library.current.complete ? "no recorded matches" : partialEmpty;
      if (choice === 2) await listRecords(records, "Current associated records", emptyMessage);
      if (choice === 3) await listRecords(sorted, "Recorded activity by current update time", emptyMessage);
      if (choice === 11) await intentContinuity(project, trustedRoot ? selectedCwd : null);
      if (choice === 13) await captureLink(project, trustedRoot ? selectedCwd : null);
      if (choice === 14) await projectAttention(project, trustedRoot ? selectedCwd : null);
      if ([4, 5, 6, 7, 8].includes(choice)) {
        const kind = { 4: "work", 5: "handoff", 6: "decision-event", 7: "pending", 8: "rejection" }[choice];
        await listRecords(records.filter((record) => record.kind === kind), `${kind} records`, emptyMessage);
        if ([4, 5, 6, 7].includes(choice)) {
          const routes = { 4: [["Current status", "work.status"], ["Full history", "work.history"]],
            5: [["Current status", "handoff.status"], ["Full history", "handoff.history"]],
            6: [["Show decisions", "decision.show"]], 7: [["List pending", "pending.list"]] };
          await domainReads(project, selectedCwd, `${kind} domain reads`, routes[choice]);
        }
      }
      if (choice === 9) {
        const resolved = selectedCwd ? await read("start", ["start", "--cwd", selectedCwd]) : null;
        if (projectIdentityMatches(project, resolved?.data?.project)) await openLoader(project.id);
        else out("Context launch blocked until this project root resolves to the selected record.");
      }
      if (choice === 10 && await projectActions(project, selectedCwd)) {
        const refreshed = await loadLibrary();
        if (refreshed) {
          library = refreshed;
          project = library.catalog.records.find((item) => item.id === project.id) ?? project;
          updateRecords();
          out(`Project records refreshed at revision ${library.current.revision}.`);
        }
      }
    }
  };
  const jumpProject = async () => {
    const library = await loadLibrary(); if (!library) return null;
    const projects = library.catalog.records.filter(project => project.kind === "project" &&
      !["historical", "superseded"].includes(project.semantics?.lifecycle));
    const picked = await choose("Jump to project", [...projects.map(project => `${project.id} | ${short(project.name)}`), "Cancel"], [], false);
    const project = projects[picked - 1]; if (!project) return null;
    const cwd = rootOf(project);
    if (!cwd || !projectIdentityMatches(project, (await read("start", ["start", "--cwd", cwd]))?.data?.project)) {
      out("Project jump blocked: selected root does not resolve to that project."); return null;
    }
    return { project, library, cwd };
  };
  try {
    out("Lodestar Manager");
    out(`Node: ${selection.node}\nCLI: ${selection.cli}\nDatabase: ${selection.database}`);
    const discovery = await read("help", ["--help"]);
    operations = discovery?.data?.capability_version === 1 && Array.isArray(discovery.data.operations)
      ? discovery.data.operations : [];
    support = discovery?.data ?? {};
    if (!operations.length) out("Capability discovery is unavailable; command execution is disabled.");
    let initialContextTrusted = true;
    const selectedExact = initialProject ? await read("get", ["get", "--", initialProject]) : null;
    if (initialProject || initialCwd) out(`Selected context: ${initialProject ?? ""} ${initialCwd ?? ""}`);
    if (initialProject && initialCwd) {
      const resolved = await read("start", ["start", "--cwd", initialCwd]);
      initialContextTrusted = projectIdentityMatches(selectedExact?.data, resolved?.data?.project);
      if (!initialContextTrusted) out(`Stale selection: ${initialProject} does not own ${initialCwd}. Root-scoped actions and context launch are blocked.`);
    }
    let routed = null;
    if (selectedExact?.data?.kind === "project") {
      const library = await loadLibrary();
      if (library) routed = { project: selectedExact.data, library, cwd: initialCwd };
    }
    while (true) {
      try {
        if (routed) {
          const current = routed; routed = null;
          await projectMenu(current.project, current.library, current.cwd);
        }
        const choice = await choose("Main menu", ["Projects", "Global knowledge", "Search", "Commands",
          "Connection", "Open Loader", "Recovery", "New project", "Quit"], ["f: Find an action by question"]);
        if (choice < 0 || choice === 9) return 0;
        if (choice === 0) continue;
        if ([1, 2].includes(choice)) {
          const library = await loadLibrary();
          if (!library) continue;
          if (choice === 1) {
            const projects = [...library.catalog.records, ...library.catalog.recordErrors
              .filter((error) => typeof error.identifiers?.id === "string" &&
                !library.catalog.records.some((record) => record.id === error.identifiers.id))
              .map((error) => ({ id: error.identifiers.id, damaged: true, error }))];
            while (true) {
              const selected = await choose("Projects, including recorded historical entries", [...projects.map((project) =>
                project.damaged ? `${project.id} | NEEDS CORRECTION | ${short(project.error.message)}`
                  : `${project.id} | ${short(project.name)} | ${short(project.data?.status ?? "status unknown", 24)} | ${project.updated_at}`), "Back"]);
              if (selected < 0 || selected === projects.length + 1) break;
              if (selected === 0) continue;
              const project = projects[selected - 1];
              if (project.damaged) {
                out(`Project ${project.id} needs correction: ${project.error.message}`);
                const detail = await choose("Correction evidence", ["Raw stored row", "Retained history", "Back"]);
                if (detail === 1 || detail === 2) {
                  const envelope = await read("get", ["get", detail === 1 ? "--raw" : "--history", "--", project.id]);
                  if (envelope) out(display(envelope.data));
                }
              } else await projectMenu(project, library,
                project.id === initialProject ? initialCwd : null);
            }
          } else {
            const grouped = projectAssociations(library.catalog.records, library.current.records);
            await listRecords(grouped.global, "Global knowledge", library.catalog.complete && library.current.complete
              ? "no recorded matches" : partialEmpty);
            if (grouped.unassigned.length) {
              out(`Unassigned / ambiguous records: ${grouped.unassigned.length}`);
              for (const entry of grouped.unassigned) out(`${entry.record.id} | scope ${entry.scope} | candidate projects ${entry.candidateProjects.join(", ") || "none"}`);
              await listRecords(grouped.unassigned.map(({ record }) => record), "Unassigned / ambiguous evidence");
            }
          }
        }
        if (choice === 3) {
          const query = await ask("Search text: ");
          if (!query) continue;
          const searchArgs = ["--limit", "250", "--", query];
          const result = await loadPages(selection, searchArgs, { execute: perform });
          if (result.kind === "ReadSnapshot") {
            if (!result.complete) out("Search is partial; counts cover loaded matches only.");
            presentDiagnostics(result, searchArgs, "Search read");
            await listRecords(result.records, result.complete ? `Search: ${query}`
              : `Search: ${query} (loaded matches; partial)`, result.complete
              ? "no recorded matches" : partialEmpty);
          } else out(`Search failed: ${result.message ?? result.kind}`);
        }
        if (choice === 4) await commandCatalog(operations);
        if (choice === "f") {
          const query = await ask("Question or action words (recovery opens saved-request inspection): ");
          if (!query?.trim()) continue;
          const words = query.trim().toLowerCase();
          if (words === "recovery") { await recovery(); continue; }
          const matches = operations.filter((op) => [op.id, op.summary, ...(Array.isArray(op.questions) ? op.questions : [])]
            .some((entry) => typeof entry === "string" && entry.toLowerCase().includes(words)));
          if (!matches.length) { out("No matching typed action. Refine the question or inspect Commands; the question remains unresolved."); continue; }
          await commandCatalog(matches);
        }
        if (choice === 5) out(display({ config: selection.configPath, generation: selection.generation,
          node: selection.node, cli: selection.cli, database: selection.database,
          fingerprint: selection.fingerprint, runtimeFingerprint: selection.runtimeFingerprint,
          release: support.version ?? "unavailable", capability_version: support.capability_version ?? "unavailable",
          contract_version: support.contract_version ?? "unavailable", schema_version: support.schema_version ?? "unavailable",
          coreSourceDigest: selection.coreSourceDigest ?? "unavailable", coreSourceBasis: selection.coreSourceBasis ?? "unavailable",
          coreSourceNotice: selection.coreSourceNotice ?? "unavailable/not checked",
          database_instance_id: databaseObservation?.instance ?? "not checked", database_epoch: databaseObservation?.epoch ?? "not checked",
          observed_revision: databaseObservation?.revision ?? "not checked", database_observation_time: databaseObservation?.readAt ?? "not checked",
          database_observation_operation: databaseObservation?.operation ?? "not checked", installer_provenance: "unavailable/not checked" }));
        if (choice === 6) {
          const resolved = initialProject && initialCwd
            ? await read("start", ["start", "--cwd", initialCwd]) : null;
          if (initialContextTrusted && (!initialProject || !initialCwd ||
            projectIdentityMatches(selectedExact?.data, resolved?.data?.project))) await openLoader(initialProject);
          else out("Context launch blocked because the selected project and root no longer match.");
        }
        if (choice === 7) await recovery();
        if (choice === 8) await createProject();
      } catch (error) {
        if (!(error instanceof ProjectJump)) throw error;
        routed = await jumpProject();
      }
    }
  } catch (error) {
    if (error?.name !== "ManagerInputError") throw error;
    out("Manager terminal_input_failed: terminal input failed; Manager stopped before accepting another answer.");
    out("Action: Restore terminal input and reopen Manager. Review any draft shown above before closing this terminal.");
    return 1;
  } finally { reader?.close(); }
}
