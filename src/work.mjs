import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { normalizedRowsResult, recordInput } from "./project.mjs";
import { getRecordById, mutate, normalizeRecord, writeBasis, writeRecordSnapshot } from "./records.mjs";
import { validateDomainInput } from "./cli-commands.mjs";
import { safeText } from "./decision.mjs";

const recordTarget = (id) => ({ kind: "record", id });
const optionalWork = (db, id) => db.prepare("SELECT id FROM records WHERE id=?").get(id)
  ? getRecordById(db, id) : null;
export function workStatus(db, project, history = false, limit = null) {
  const scopes = [...new Set([project.scope, ...(project.historical_scopes ?? [])])];
  const result = normalizedRowsResult(db, "SELECT id FROM records WHERE scope IN ("
    + scopes.map(() => "?").join(",") + ") AND "
    + (history ? "type IN ('work','work-event') " : "type='work' AND json_extract(content_json,'$.value.status')='open' ")
    + "ORDER BY json_extract(content_json,'$._lodestar.revision') DESC,id", ...scopes);
  const selected = limit === null ? result.records : result.records.slice(0, limit);
  return { advisory: true, notice: "Work reports describe observed progress; they confer no project lock or ownership.",
    records: selected, record_errors: result.record_errors, complete: result.record_errors.length === 0,
    more: selected.length < result.records.length,
    write_basis: writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root,
      targets: [...selected.filter(({ kind }) => kind === "work").map(({ id }) => recordTarget(id)),
        ...(project.binding_preconditions ?? []).map(({ target }) => target)] }) };
}
export function workMutation(db, project, identity, action, request, options = {}) {
  const input = validateDomainInput(`work.${action}`, request?.input);
  if (!identity.actor) throw lodestarError("identity_required", "A work write needs the actual actor identity.");
  const ids = action === "expire" ? input.targets : [input.id];
  if (!ids.length || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw lodestarError("invalid_input", "Work targets must be distinct exact IDs.");
  }
  return mutate(db, `work.${action}`, request, ({ revision, timestamp }) => {
    const changed = [], results = [];
    for (const [index, id] of ids.entries()) {
      const existing = optionalWork(db, id);
      if (existing && (existing.type !== "work" || existing.scope !== project.scope)) {
        throw lodestarError("work_conflict", "The target is not a work record in this project.", { identifiers: { id } });
      }
      if (!existing && action !== "start") throw lodestarError("work_not_found", "The work record does not exist.", { identifiers: { id } });
      const prior = existing?.content.value ?? {};
      const description = safeText(action === "expire" ? input.reason : input.description, "Work description");
      if (action === "start") {
        const data = { ...prior, status: "open", actor: identity.actor, agent: identity.agent,
          harness: identity.harness, session: identity.session, description,
          artifacts: input.artifacts ?? prior.artifacts ?? [], decision_ids: input.decision_ids ?? prior.decision_ids ?? [],
          checkout: project.checkout_root, started_at: prior.started_at ?? timestamp };
        if (canonicalStringify(data) === canonicalStringify(prior)) { results.push({ changed: false, record: normalizeRecord(existing) }); continue; }
        writeRecordSnapshot(db, { ...recordInput(id, "work", description, project.scope, 0, data),
          ...(existing ? { aliases: existing.aliases, links: normalizeRecord(existing).links, sources: existing.sources, semantics: existing.semantics } : {}) },
        { createdAt: existing?.created_at ?? timestamp, updatedAt: timestamp, revision });
        changed.push(id); results.push({ changed: true, record: normalizeRecord(getRecordById(db, id)) });
        continue;
      }
      const outcome = action === "expire" ? "interrupted" : input.outcome;
      const evidence = input.evidence ?? [];
      if (outcome === "verified" && evidence.length === 0) throw lodestarError("invalid_input", "Verified outcomes require claim-relevant evidence.");
      if (input.observed_at !== undefined && !Number.isFinite(Date.parse(input.observed_at))) throw lodestarError("invalid_input", "observed_at must identify a valid time.");
      const event = { work_id: id, action_id: action === "expire" ? request.request_id : input.action_id,
        outcome, description, evidence, artifacts: input.artifacts ?? [], decision_ids: input.decision_ids ?? [],
        checkpoint_ids: input.checkpoint_ids ?? [], unresolved_consequence: input.unresolved_consequence ?? null,
        checkout: project.checkout_root, actor: identity.actor, observed_at: input.observed_at ?? null };
      if (canonicalStringify(prior.last_outcome ?? null) === canonicalStringify(event)) {
        results.push({ changed: false, record: normalizeRecord(existing) }); continue;
      }
      const eventId = `work-event:${revision}:${index}`;
      writeRecordSnapshot(db, recordInput(eventId, "work-event", description, project.scope, 0,
        { ...event, observed_at: input.observed_at ?? null, recorded_at: timestamp,
          session: identity.session, event_sequence: index }),
      { createdAt: timestamp, updatedAt: timestamp, revision });
      const data = { ...prior, status: ["completed", "verified", "interrupted", "failed"].includes(outcome) ? "closed" : "open",
        description, last_outcome: event, last_event_id: eventId, last_seen_at: timestamp };
      writeRecordSnapshot(db, { ...recordInput(id, "work", existing.name, project.scope, existing.priority, data),
        aliases: existing.aliases, links: normalizeRecord(existing).links, sources: existing.sources, semantics: existing.semantics },
      { createdAt: existing.created_at, updatedAt: timestamp, revision });
      changed.push(id, eventId); results.push({ changed: true, record: normalizeRecord(getRecordById(db, id)), event_id: eventId });
    }
    return { data: action === "expire" ? { results } : results[0], changed_ids: changed };
  }, { ...options, requiredTargets: [...ids.map(recordTarget), ...(project.binding_preconditions ?? []).map(({ target }) => target)] });
}
