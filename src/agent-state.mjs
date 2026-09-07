import { AGENT_BOOTSTRAP, checkRecordSources, nativeInstructionSources, requiredSourceBundle } from "./bootstrap.mjs";
import { initializeDatabase, openDiagnosticDatabase, openReadDatabase, openWriteDatabase, readMetadata } from "./database.mjs";
import { migrationPreflight, migrateDatabase, promoteRecoveredDatabase, recoveryPreflight } from "./schema-migration.mjs";
import { diagnoseDatabase } from "./doctor.mjs";
import { decisionMutation, decisionProjection } from "./decision.mjs";
import { handoffMutation, handoffStatus } from "./continuity.mjs";
import { workMutation, workStatus } from "./work.mjs";
import { pendingList, pendingMutation } from "./pending.mjs";
import { decorateError, lodestarError } from "./errors.mjs";
import { canonicalStringify, parseJsonText, readStreamComplete, readTextFileComplete } from "./json.mjs";
import { resolveInputPath } from "./paths.mjs";
import { catalogProjection, catalogReconciliation, resolveIdentity, resolveProject, resolveProjectScope, sameMachinePath, scope } from "./project.mjs";
import { exportRegistry, findRecords, linkedRecords, normalizedForRows } from "./queries.mjs";
import { deleteRecord, getRecord, getRecordById, getRawRecord, getRecordHistory, normalizeRecord,
  normalizeMutationRequest, putRecord, writeBasis } from "./records.mjs";
import { currentRevision } from "./revisions.mjs";
import { validateLimit } from "./validate.mjs";
import { installationOptions, MUTATION_INPUTS, READ_OPERATIONS } from "./cli-commands.mjs";
import { installationStatus } from "./setup.mjs";
export { normalizeMachinePath, resolveIdentity, resolveProject } from "./project.mjs";

export const operationResult = (data, options = {}) => ({ data,
  revision: options.revision ?? null, scope: options.scope ?? scope(),
  database_instance_id: options.database_instance_id ?? null,
  database_epoch: options.database_epoch ?? null, request: options.request ?? null,
  ...(options.receipt_id ? { receipt_id: options.receipt_id } : {}),
  more: options.more ?? false, next: options.next ?? [] });
function dbResult(db, data, options = {}) {
  const metadata = readMetadata(db);
  return operationResult(data, { revision: currentRevision(db),
    database_instance_id: metadata.database_instance_id, database_epoch: metadata.database_epoch, ...options });
}
async function withDatabase(open, file, operation, { read = false } = {}) {
  const db = await open(file);
  try {
    if (read) db.exec("BEGIN");
    const result = operation(db);
    if (read) db.exec("COMMIT");
    return result;
  } catch (error) {
    if (read && db.isTransaction) db.exec("ROLLBACK");
    const identifiers = {};
    try {
      const metadata = readMetadata(db);
      identifiers.database_instance_id = metadata.database_instance_id;
      identifiers.database_epoch = metadata.database_epoch;
    } catch { /* The original database error remains authoritative. */ }
    try { identifiers.revision = currentRevision(db); }
    catch { /* Revision may be unavailable on a damaged database. */ }
    throw decorateError(error, identifiers);
  } finally { db.close(); }
}
const cwd = (options) => options["--cwd"] ?? process.cwd();
const callerIdentity = (options) => resolveIdentity({ session: options["--session"],
  agent: options["--agent"], harness: options["--harness"] });
const actorRecord = (identity) => identity.actor ? { id: identity.actor, agent: identity.agent,
  harness: identity.harness, session: identity.session } : null;
async function input(options, io, resource) {
  const text = options["--file"] ? await readTextFileComplete(resolveInputPath(options["--file"]), { resource })
    : await readStreamComplete(io.stdin, { resource });
  return parseJsonText(text, { resource });
}
function checkReadRevision(db, options) {
  const asked = options["--at-revision"];
  if (asked === undefined) return;
  const actual = currentRevision(db);
  if (!Number.isSafeInteger(Number(asked)) || Number(asked) < 0) throw lodestarError("invalid_input", "Read revision must be a nonnegative safe integer.");
  if (Number(asked) !== actual) throw lodestarError("read_revision_conflict", "The database changed between requested pages.",
    { identifiers: { expected_revision: Number(asked), current_revision: actual }, action: "Restart the read at the current revision; do not combine different projections." });
}
function sourceConfiguration(db) {
  if (!db.prepare("SELECT id FROM records WHERE id='config:lodestar:sources'").get()) return null;
  return normalizeRecord(getRecord(db, "config:lodestar:sources"));
}
function withBasis(db, record, project = null) {
  const applicability = record.semantics?.applicability ?? {};
  return { ...record, write_basis: writeBasis(db, {
    projectScope: project?.scope ?? applicability.project ?? record.scope,
    checkout: project?.checkout_root ?? applicability.checkout ?? null,
    targets: [{ kind: "record", id: record.id },
      ...(record.sources.some(({ metadata }) => metadata?.locator?.base === "source_root")
        ? [{ kind: "record", id: "config:lodestar:sources" }] : []),
      ...(project?.binding_preconditions ?? []).map(({ target }) => target)] }) };
}
function recordReadEvidence(db, records) {
  return records.filter((record) => record.sources.some(({ metadata }) =>
    ["local_file", "package_manifest"].includes(metadata?.kind))).map((record) => {
    const locators = record.sources.map(({ metadata }) => metadata?.locator);
    const applicability = record.semantics.applicability;
    const project = locators.some((locator) => ["project_root", "checkout_root"].includes(locator?.base))
      ? resolveProjectScope(db, applicability.project ?? record.scope, applicability.checkout) ?? {} : {};
    if (project.id) {
      const data = normalizeRecord(getRecordById(db, project.id)).data;
      project.root = data.roots?.[0] ?? data.root;
    }
    const config = locators.some((locator) => locator?.base === "source_root") ? sourceConfiguration(db)?.data ?? {} : {};
    const sourceRoots = Object.fromEntries((config.skill_source_roots ?? []).map(({ id, locator }) => [id, locator]));
    return { record, project, sourceRoots };
  });
}
function withProjectBoundary(db, cwdValue, identity, operation) {
  let project;
  try {
    project = resolveProject(db, cwdValue);
    return operation(project);
  } catch (error) {
    throw decorateError(error, { project: project?.scope ?? null,
      cwd: project?.cwd ?? cwdValue, session: identity?.session ?? null,
      actor: identity?.actor ?? null });
  }
}
export function startProjection(db, project, identity, { topic = null } = {}) {
  const scopes = [...new Set([project.scope, ...(project.historical_scopes ?? [])])];
  const appliesToCheckout = (record) => !record.semantics?.applicability?.checkout
    || sameMachinePath(record.semantics.applicability.checkout, project.checkout_root);
  const selected = normalizedForRows(db, db.prepare("SELECT * FROM records WHERE (scope IN ("
    + scopes.map(() => "?").join(",") + ") OR (scope='global' AND json_extract(content_json,'$._lodestar.semantics.applicability.project') IN ("
    + scopes.map(() => "?").join(",") + "))) "
    + "AND json_extract(content_json,'$._lodestar.semantics.context_role')='orientation' "
    + "AND COALESCE(json_extract(content_json,'$._lodestar.semantics.lifecycle'),'current') IN ('current','unresolved') "
    + "AND type NOT IN ('mutation-receipt','migration-source','startup-snapshot','pending','decision-event','work-event','handoff-packet') "
    + "ORDER BY json_extract(content_json,'$._lodestar.priority') DESC,id").all(...scopes, ...scopes));
  const context = new Map(selected.records.filter(appliesToCheckout)
    .map((record) => [record.id, { ...record, selection_reason: "orientation" }]));
  const recordErrors = [...(project.record_errors ?? []), ...selected.record_errors];
  const dependencyTargets = new Map();
  if (topic) for (const projectScope of scopes) {
    const found = findRecords(db, topic, { scope: projectScope });
    recordErrors.push(...found.record_errors);
    for (const record of found.records) {
      if (appliesToCheckout(record) && !context.has(record.id)) {
        context.set(record.id, { ...record, selection_reason: "topic" });
      }
    }
  }
  if (topic) {
    const global = findRecords(db, topic, { scope: "global" });
    recordErrors.push(...global.record_errors);
    for (const record of global.records) {
      if (!scopes.includes(record.semantics?.applicability?.project)
        || !appliesToCheckout(record) || context.has(record.id)) continue;
      context.set(record.id, { ...record, selection_reason: "topic" });
    }
  }
  // Follow only explicit dependency links. This is a graph of selected evidence,
  // not a second manually maintained orientation list.
  for (const record of context.values()) for (const link of record.links) {
    if (!["depends-on", "requires"].includes(link.relationship) || context.has(link.to_id)) continue;
    dependencyTargets.set(link.to_id, { kind: "record", id: link.to_id });
    const dependencyRows = db.prepare("SELECT * FROM records WHERE id=?").all(link.to_id);
    const dependency = normalizedForRows(db, dependencyRows);
    recordErrors.push(...dependency.record_errors);
    if (dependencyRows.length === 0) recordErrors.push({ code: "record_not_found",
      message: "A required context dependency does not exist.",
      identifiers: { id: link.to_id, required_by: record.id },
      action: "Restore the named dependency or correct the explicit relationship." });
    for (const peer of dependency.records) {
      if (!["current", "unresolved"].includes(peer.semantics.lifecycle)) {
        recordErrors.push({ code: "required_dependency_unavailable",
          message: "A required context dependency is not current or unresolved.",
          identifiers: { id: peer.id, required_by: record.id, lifecycle: peer.semantics.lifecycle },
          action: "Restore a current or unresolved dependency or correct the explicit relationship." });
        continue;
      }
      if (!appliesToCheckout(peer)) {
        recordErrors.push({ code: "required_dependency_unavailable",
          message: "A required context dependency does not apply to this checkout.",
          identifiers: { id: peer.id, required_by: record.id,
            checkout: peer.semantics.applicability.checkout },
          action: "Bind the dependency to this checkout or correct the explicit relationship." });
        continue;
      }
      context.set(peer.id, { ...peer, selection_reason: `dependency:${record.id}` });
    }
  }
  const applicable = [...context.values()].map((record) => withBasis(db, record, project));
  const subjects = new Map();
  for (const record of applicable) if (record.semantics?.subject) {
    const members = subjects.get(record.semantics.subject) ?? [];
    members.push(record.id); subjects.set(record.semantics.subject, members);
  }
  const config = sourceConfiguration(db);
  const decisions = decisionProjection(db, project);
  const work = workStatus(db, project);
  const handoff = handoffStatus(db, project, identity);
  const pending = pendingList(db, project);
  const catalog = catalogProjection(db, project, config);
  recordErrors.push(...decisions.record_errors, ...work.record_errors,
    ...handoff.record_errors, ...pending.record_errors, ...catalog.record_errors);
  const uniqueErrors = [...new Map(recordErrors.map((error) => [canonicalStringify(error), error])).values()];
  const targets = [...(project.binding_preconditions ?? []).map(({ target }) => target),
    ...dependencyTargets.values()];
  if (config) targets.push({ kind: "record", id: config.id });
  return dbResult(db, { project, required: [], context: applicable, record_errors: uniqueErrors,
    complete: uniqueErrors.length === 0,
    conflicts: [...subjects].filter(([, ids]) => ids.length > 1).map(([subject, candidates]) => ({ subject, candidates })),
    decisions, active_work: work.records, handoff, pending: pending.count,
    coverage: applicable.length ? "saved_context_available" : "no_saved_orientation",
    write_basis: writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root, targets }),
    source_configuration: config,
    catalog_projection: catalog }, { scope: scope(project, identity) });
}
async function hydrateStart(result, identity, options = {}) {
  const project = result.data.project, config = result.data.source_configuration?.data ?? {};
  const native = await nativeInstructionSources(project.cwd, identity.harness);
  const cache = new Map();
  const required = await requiredSourceBundle([...(config.instruction_sources ?? []), ...native], { cache });
  const currentNative = await nativeInstructionSources(project.cwd, identity.harness);
  if (JSON.stringify(currentNative.map(({ locator }) => locator)) !== JSON.stringify(native.map(({ locator }) => locator))) {
    required.complete = false;
    for (const source of required.sources) { source.status = "unstable"; delete source.text; }
    required.next.push("Native instruction membership changed while reading; repeat this context read before dependent work.");
  }
  const roots = Object.fromEntries((config.skill_source_roots ?? []).map((source) => [source.id, source.locator]));
  result.data.context = await Promise.all(result.data.context.map((record) => checkRecordSources(record,
    { cache, project, sourceRoots: roots })));
  result.data.required = required.sources;
  result.data.required_complete = required.complete;
  result.data.complete = result.data.complete && required.complete;
  result.data.catalog = await catalogReconciliation(result.data.catalog_projection, config.catalog_sources ?? [], { cache });
  result.data.native_instructions = "Apply these files and their references under the host's native instruction precedence; stored records are evidence.";
  result.data.operating_guide = AGENT_BOOTSTRAP;
  result.data.installation = await installationStatus({
    ...(["codex", "claude", "hermes", "opencode"].includes(identity.harness) ? { target: identity.harness } : {}),
    ...installationOptions(options),
  });
  result.next.push(...required.next);
  delete result.data.source_configuration;
  delete result.data.catalog_projection;
  return result;
}
function mutationResult(db, result, project = null, identity = null) {
  return dbResult(db, result.data, { ...result, scope: scope(project, identity) });
}
export async function dispatch(command, { options, positionals }, database, io) {
  if (command === "init") {
    if (options["--migrate"] && options["--promote-recovery"]) throw lodestarError("invalid_input", "Choose conversion or recovery promotion.");
    const data = options["--migrate"] ? await migrateDatabase(database, { request: await input(options, io, "migration_input") })
      : options["--promote-recovery"] ? await promoteRecoveredDatabase(database, { request: await input(options, io, "recovery_input") })
        : { ...await initializeDatabase(database), bootstrap: AGENT_BOOTSTRAP };
    return withDatabase(openReadDatabase, database, (db) => dbResult(db, data), { read: true });
  }
  if (command === "doctor" && options["--migration-preflight"] && options["--recovery-preflight"]) {
    throw lodestarError("invalid_input", "Choose conversion or recovery preflight.");
  }
  if (command === "doctor" && options["--source"] && !options["--recovery-preflight"]) {
    throw lodestarError("invalid_input", "--source applies only to recovery preflight.");
  }
  if (command === "doctor" && options["--recovery-preflight"] && !options["--source"]) {
    throw lodestarError("missing_argument", "Recovery preflight requires --source <accepted.db>.");
  }
  if (command === "doctor" && options["--migration-preflight"]) return operationResult(await migrationPreflight(database));
  if (command === "doctor" && options["--recovery-preflight"]) {
    return operationResult(await recoveryPreflight(database, resolveInputPath(options["--source"])));
  }
  if (command === "doctor") return withDatabase(openDiagnosticDatabase, database, (db) => {
    const result = diagnoseDatabase(db, { database });
    let metadata = {}, revision = null;
    try { metadata = readMetadata(db); revision = currentRevision(db); } catch { /* Doctor reports missing metadata. */ }
    return operationResult(result, { revision, database_instance_id: metadata.database_instance_id,
      database_epoch: metadata.database_epoch });
  }, { read: true });
  if (command === "start") {
    const identity = callerIdentity(options);
    const result = await withDatabase(openReadDatabase, database, (db) => withProjectBoundary(db,
      cwd(options), identity, (project) => startProjection(db, project, identity,
        { topic: options["--topic"] })), { read: true });
    return hydrateStart(result, identity, options);
  }
  if (["get", "find", "links", "export"].includes(command)) {
    let evidence = [];
    const result = await withDatabase(openReadDatabase, database, (db) => {
      checkReadRevision(db, options);
      if (command === "get") {
        if (options["--raw"] && options["--history"]) throw lodestarError("invalid_input", "Choose raw inspection or history for one get.");
        try {
          const data = options["--raw"] ? getRawRecord(db, positionals[0]) : options["--history"]
            ? getRecordHistory(db, positionals[0]) : withBasis(db, normalizeRecord(getRecord(db, positionals[0])));
          if (!options["--raw"] && !options["--history"]) evidence = recordReadEvidence(db, [data]);
          return dbResult(db, data);
        } catch (error) {
          throw decorateError(error, { write_basis: writeBasis(db,
            { targets: [{ kind: "record", id: positionals[0] }] }) });
        }
      }
      if (command === "find") {
        const result = findRecords(db, positionals[0], { scope: options["--scope"], type: options["--kind"],
          limit: options["--limit"], offset: options["--offset"], history: options["--history"] ?? false });
        result.records = result.records.map((record) => withBasis(db, record));
        if (!options["--history"]) evidence = recordReadEvidence(db, result.records);
        const revision = currentRevision(db);
        return dbResult(db, { query: result.query, records: result.records, record_errors: result.record_errors,
          complete: result.record_errors.length === 0 }, { more: result.truncated,
          next: result.truncated ? [{ command: "find", args: [result.query,
            ...(options["--scope"] === undefined ? [] : ["--scope", options["--scope"]]),
            ...(options["--kind"] === undefined ? [] : ["--kind", options["--kind"]]),
            ...(options["--history"] ? ["--history"] : []), "--limit", String(result.limit),
            "--offset", String(result.offset + result.limit), "--at-revision", String(revision)] }] : [] });
      }
      if (command === "links") {
        const result = linkedRecords(db, positionals[0], { limit: options["--limit"], offset: options["--offset"] });
        for (const link of result.links) if (link.peer) link.peer = withBasis(db, link.peer);
        evidence = recordReadEvidence(db, result.links.map(({ peer }) => peer).filter(Boolean));
        const revision = currentRevision(db);
        return dbResult(db, { id: result.id, links: result.links, record_errors: result.record_errors,
          complete: result.record_errors.length === 0 }, { more: result.truncated,
          next: result.truncated ? [{ command: "links", args: [positionals[0], "--limit", String(result.limit),
            "--offset", String(result.offset + result.limit), "--at-revision", String(revision)] }] : [] });
      }
      return dbResult(db, exportRegistry(db).document);
    }, { read: true });
    const cache = new Map();
    await Promise.all(evidence.map(async ({ record, project, sourceRoots }) => {
      Object.assign(record, await checkRecordSources(record, { cache, project, sourceRoots }));
    }));
    return result;
  }
  if (["put", "delete"].includes(command)) {
    const request = normalizeMutationRequest(await input(options, io, `${command}_input`));
    return withDatabase(openWriteDatabase, database, (db) => {
      try { return mutationResult(db, command === "put" ? putRecord(db, request, { database })
        : deleteRecord(db, request, { database })); }
      catch (error) { throw decorateError(error, { project: request.project_scope ?? null,
        actor: request.actor?.id ?? null, session: request.actor?.session ?? null }); }
    });
  }
  if (["work", "handoff", "decision", "pending"].includes(command)) {
    const action = positionals[0] ?? (command === "pending" ? "list" : "status");
    const operationName = `${command}.${action}`;
    const read = Object.hasOwn(READ_OPERATIONS, operationName);
    if (!read && !Object.hasOwn(MUTATION_INPUTS, operationName)) {
      throw lodestarError("unknown_operation", "Unsupported domain operation.", { identifiers: { operation: operationName },
        action: `Use lodestar ${command} --help for supported operations.` });
    }
    const caller = callerIdentity(options);
    if (read) return withDatabase(openReadDatabase, database, (db) => {
      checkReadRevision(db, options);
      return withProjectBoundary(db, cwd(options), caller, (project) => {
        const limit = options["--limit"] === undefined ? null : validateLimit(options["--limit"], {});
        const data = command === "decision" ? decisionProjection(db, project, positionals[1] ?? null)
          : command === "work" ? workStatus(db, project, action === "history", limit)
            : command === "handoff" ? handoffStatus(db, project, caller, { history: action === "history" })
              : pendingList(db, project, limit);
        return dbResult(db, data, { scope: scope(project, caller) });
      });
    }, { read: true });
    const request = normalizeMutationRequest(await input(options, io, `${command}_${action}_input`), { actor: actorRecord(caller) });
    if (positionals.length > 1) throw lodestarError("invalid_input", "Mutation arguments belong in the structured request input.");
    const actor = request.actor ? { actor: request.actor.id, agent: request.actor.agent ?? "agent",
      harness: request.actor.harness ?? null, session: request.actor.session ?? null } : caller;
    // A shell may report a user reference, but cannot authenticate a host message.
    if ([request.input.direction, request.input.destination?.input?.direction]
      .some((direction) => direction?.attribution === "host_observed") && !io.hostObservedDirection) {
      throw lodestarError("invalid_input", "Plain CLI direction may use asserted attribution only.");
    }
    return withDatabase(openWriteDatabase, database, (db) => {
      return withProjectBoundary(db, cwd(options), actor, (project) => {
        const operation = { decision: decisionMutation, work: workMutation, handoff: handoffMutation, pending: pendingMutation }[command];
        return mutationResult(db, operation(db, project, actor, action, request, { database, project }), project, actor);
      });
    });
  }
  throw lodestarError("unknown_command", "The requested command is not part of Lodestar.");
}
