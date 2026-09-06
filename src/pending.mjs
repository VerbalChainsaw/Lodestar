import { safeText, applyDecision, normalizeDecisionKey } from "./decision.mjs";
import { lodestarError } from "./errors.mjs";
import { normalizedRowsResult, recordInput } from "./project.mjs";
import { applyPutInput, getRecordById, mutate, normalizeRecord, preparePutEvidence, writeBasis, writeRecordSnapshot } from "./records.mjs";
import { validateDomainInput } from "./cli-commands.mjs";

export const pendingScope = (project) => `pending:${project.scope}`;
const candidateScopes = (project) => [...new Set([project.scope, pendingScope(project),
  ...(project.historical_scopes ?? []).flatMap((scope) => [scope, `pending:${scope}`])])];
export function pendingList(db, project, limit = null) {
  const scopes = candidateScopes(project);
  const result = normalizedRowsResult(db, "SELECT id FROM records WHERE type='pending' AND scope IN ("
    + scopes.map(() => "?").join(",") + ") AND COALESCE(json_extract(content_json,'$._lodestar.semantics.lifecycle'),'unresolved') NOT IN ('historical','superseded') "
    + "ORDER BY json_extract(content_json,'$._lodestar.revision') DESC,id", ...scopes);
  return { count: result.records.length,
    records: limit === null ? result.records : result.records.slice(0, limit),
    record_errors: result.record_errors, complete: result.record_errors.length === 0,
    write_basis: writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root,
      targets: [...result.records.map(({ id }) => ({ kind: "record", id })),
        ...(project.binding_preconditions ?? []).map(({ target }) => target)] }) };
}
export const pendingCount = (db, project) => pendingList(db, project).count;
export function pendingMutation(db, project, identity, action, request, options = {}) {
  const input = validateDomainInput(`pending.${action}`, request?.input);
  const putEvidence = input.destination?.operation === "put"
    ? preparePutEvidence(db, input.destination.input, request) : {};
  const targets = [{ kind: "record", id: input.id }, ...(project.binding_preconditions ?? []).map(({ target }) => target)];
  if (action === "promote") {
    const destination = input.destination;
    if (destination.operation === "put") {
      const id = destination.input?.id ?? destination.input?.record?.id;
      if (!id) throw lodestarError("invalid_input", "A promotion destination needs an exact record ID.");
      targets.push({ kind: "record", id });
    } else if (destination.operation === "decision.set") {
      validateDomainInput("decision.set", destination.input);
      targets.push({ kind: "decision", scope: project.scope, key: normalizeDecisionKey(destination.input.key) });
      targets.push(...(destination.input.resolved_heads ?? []).map((id) => ({ kind: "record", id })));
    } else throw lodestarError("invalid_input", "Promotion destination operation must be put or decision.set.");
  }
  return mutate(db, `pending.${action}`, request, (context) => {
    const { revision, timestamp } = context;
    const row = db.prepare("SELECT id FROM records WHERE id=?").get(input.id);
    const prior = row ? getRecordById(db, input.id) : null;
    if (prior && (prior.type !== "pending" || !candidateScopes(project).includes(prior.scope))) {
      throw lodestarError("pending_conflict", "The target is not a candidate in this project.", { identifiers: { id: input.id } });
    }
    if (action === "add") {
      if (prior) throw lodestarError("pending_conflict", "A candidate with this ID already exists.", { identifiers: { id: input.id } });
      const text = safeText(input.text, "Candidate text");
      writeRecordSnapshot(db, { ...recordInput(input.id, "pending", text, project.scope, 0,
        { text, source: input.source ?? null, actor: identity.actor, captured_at: timestamp }),
        semantics: { lifecycle: "unresolved", context_role: "on_demand", basis: "asserted",
          applicability: { project: project.scope, checkout: project.checkout_root ?? null } } },
      { createdAt: timestamp, updatedAt: timestamp, revision });
      return { data: { added: true, record: normalizeRecord(getRecordById(db, input.id)) }, changed_ids: [input.id] };
    }
    if (!prior) throw lodestarError("pending_not_found", "The candidate does not exist.", { identifiers: { id: input.id } });
    let promoted = null, changed = [input.id];
    if (action === "promote") {
      if (["historical", "superseded"].includes(prior.semantics?.lifecycle)) {
        throw lodestarError("pending_conflict", "This candidate has already been settled; inspect its history.");
      }
      const destination = input.destination;
      if (destination.operation === "put") {
        const destinationId = destination.input.id ?? destination.input.record?.id;
        const destinationScope = destination.input.record?.scope ?? db.prepare("SELECT scope FROM records WHERE id=?").get(destinationId)?.scope;
        if (destinationScope !== project.scope) throw lodestarError("project_binding_conflict", "Promotion must target this canonical project.");
        promoted = applyPutInput(db, destination.input, { ...context, ...putEvidence });
        if (promoted.revision === revision) changed.push(promoted.id);
      } else {
        const result = applyDecision(db, project, identity, "set", destination.input, context);
        promoted = result.data; changed.push(...result.changed_ids);
      }
    } else safeText(input.reason, "Candidate retirement reason");
    writeRecordSnapshot(db, { ...recordInput(prior.id, prior.type, prior.name, prior.scope, prior.priority,
      { ...prior.content.value, settlement: action, reason: input.reason ?? "Promoted through an explicit checked destination.",
        destination: action === "promote" ? input.destination : null }),
      aliases: prior.aliases, links: normalizeRecord(prior).links, sources: prior.sources,
      semantics: { ...prior.semantics, lifecycle: action === "promote" ? "superseded" : "historical", context_role: "on_demand" } },
    { createdAt: prior.created_at, updatedAt: timestamp, revision });
    return { data: { settled: true, record: normalizeRecord(getRecordById(db, input.id)), promoted }, changed_ids: changed };
  }, { ...options, requiredTargets: targets });
}
