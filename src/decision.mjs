import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { normalizedRowsResult, recordInput } from "./project.mjs";
import { getRecordById, mutate, normalizeRecord, writeBasis, writeRecordSnapshot } from "./records.mjs";
import { validateDomainInput } from "./cli-commands.mjs";

export function safeText(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw lodestarError("invalid_input", `${label} must be nonempty text without control characters.`);
  }
  return value;
}
export function normalizeDecisionKey(value) {
  safeText(value, "Decision key");
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw lodestarError("invalid_input", "Decision keys preserve exact case and punctuation; remove boundary whitespace/control characters.");
  }
  return value;
}
function events(db, projectScope) {
  const result = normalizedRowsResult(db, "SELECT id FROM records WHERE type='decision-event' AND scope=? "
    + "ORDER BY json_extract(content_json,'$._lodestar.revision'),id", projectScope);
  return { history: result.records.map((record) => ({ ...record.data, event_id: record.id, revision: record.revision,
      origin_scope: record.scope, provenance_status: record.data.direction ? "attributed" :
        record.data.authority === "director" ? "legacy_unverified" : "agent_assertion" })),
    record_errors: result.record_errors };
}
export function replayDecisions(history) {
  const current = new Map(), heads = new Map(), dead = [];
  let enabled = true;
  for (const event of history) {
    if (event.event === "injection") {
      enabled = event.include_agent_decisions ?? event.enabled;
      if (event.key) heads.set(event.key, event);
      continue;
    }
    const prior = current.get(event.key);
    heads.set(event.key, event);
    if (event.event === "set" || event.event === "status") {
      if (event.event === "status" && !prior) continue;
      if (prior && event.event === "set" && prior.value !== event.value) {
        dead.push({ ...prior, status: "superseded", replacement: event.value,
          superseded_by: event.event_id, replacement_reason: event.reason });
      }
      current.set(event.key, { ...prior, ...event,
        value: event.event === "status" ? prior.value : event.value,
        status: event.status ?? "accepted" });
    } else if (event.event === "drop") {
      if (prior) dead.push({ ...prior, ...event, value: prior.value,
        status: event.status ?? "dead" });
      current.delete(event.key);
    }
  }
  const all = [...current.values()];
  return { enabled, facts: all.filter(({ status }) => status === "accepted"),
    blocked: all.filter(({ status }) => status === "blocked"), dead,
    heads: Object.fromEntries(heads) };
}
export function renderDecisions(state) {
  const lines = [];
  for (const item of [...state.facts, ...state.blocked]) {
    lines.push(`${item.key}: ${JSON.stringify(item.value)} (${item.status}). ${item.reason ?? ""}`);
  }
  for (const item of state.dead) {
    lines.push(`Historical ${item.key}: ${JSON.stringify(item.value)} (${item.status}). ${item.reason ?? ""}`);
  }
  return lines.join("\n");
}
export function decisionProjection(db, project, key = null) {
  if (key !== null) normalizeDecisionKey(key);
  const scopes = [...new Set([project.scope, ...(project.historical_scopes ?? [])])];
  const streams = scopes.map((origin) => { const result = events(db, origin); return {
    scope: origin, record_errors: result.record_errors, ...replayDecisions(result.history) }; });
  const canonical = streams.find((stream) => stream.scope === project.scope);
  const candidates = new Map();
  for (const stream of streams) for (const item of [...stream.facts, ...stream.blocked]) {
    if (key !== null && item.key !== key) continue;
    const entries = candidates.get(item.key) ?? [];
    entries.push(item); candidates.set(item.key, entries);
  }
  const facts = [], blocked = [], conflicts = [];
  for (const [subject, choices] of candidates) {
    const selected = choices.find(({ origin_scope }) => origin_scope === project.scope);
    const resolved = selected && choices.every((choice) => choice === selected ||
      selected.resolved_heads?.includes(choice.event_id));
    if (choices.length > 1 && !resolved) { conflicts.push({ key: subject, candidates: choices }); continue; }
    const item = selected ?? choices[0];
    if (!canonical.enabled && !item.direction && item.provenance_status !== "legacy_unverified") continue;
    (item.status === "blocked" ? blocked : facts).push(item);
  }
  const targets = key === null ? Object.keys(canonical.heads).map((subject) =>
    ({ kind: "decision", scope: project.scope, key: subject }))
    : [{ kind: "decision", scope: project.scope, key }];
  const state = { enabled: canonical.enabled, facts, blocked, conflicts,
    dead: streams.flatMap((stream) => stream.dead).filter((item) => key === null || item.key === key),
    heads: canonical.heads };
  const recordErrors = streams.flatMap((stream) => stream.record_errors);
  const complete = recordErrors.length === 0;
  return { ...state, projection: renderDecisions(state),
    record_errors: recordErrors, complete,
    write_basis: writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root,
      targets: [...(complete ? targets : []),
        ...(project.binding_preconditions ?? []).map(({ target }) => target)] }),
    next: complete ? [] : ["Correct the named decision records before preparing a decision mutation."] };
}
function direction(value) {
  if (value === undefined || value === null) return null;
  if (value.kind !== "user" || !["asserted", "host_observed"].includes(value.attribution)) {
    throw lodestarError("invalid_input", "Direction must identify user attribution and evidence.");
  }
  safeText(value.reference, "Direction reference");
  safeText(value.instruction, "Direction instruction");
  return value;
}
export function decisionMutation(db, project, identity, action, request, options = {}) {
  const input = validateDomainInput(`decision.${action}`, request?.input);
  const key = action === "inject" ? "lodestar:agent-decision-presentation" : normalizeDecisionKey(input.key);
  const targets = [{ kind: "decision", scope: project.scope, key },
    ...(project.binding_preconditions ?? []).map(({ target }) => target)];
  return mutate(db, `decision.${action}`, request,
    (context) => applyDecision(db, project, identity, action, input, context),
    { ...options, requiredTargets: [...targets,
      ...(input.resolved_heads ?? []).map((id) => ({ kind: "record", id }))] });
}

export function applyDecision(db, project, identity, action, input, { revision, timestamp }) {
  validateDomainInput(`decision.${action}`, input);
  const key = action === "inject" ? "lodestar:agent-decision-presentation" : normalizeDecisionKey(input.key);
    const currentEvents = events(db, project.scope);
    if (currentEvents.record_errors.length) throw lodestarError("record_requires_source_correction",
      "The current decision stream contains records that cannot be safely replayed.",
      { identifiers: { key, record_errors: currentEvents.record_errors },
        action: "Correct the named decision records before changing this decision stream." });
    const state = replayDecisions(currentEvents.history);
    const head = state.heads[key] ?? null;
    const prior = [...state.facts, ...state.blocked].find((item) => item.key === key);
    const suppliedDirection = direction(input.direction);
    const priorBoundary = head?.direction ?? (head?.authority === "director" ? { legacy: true } : null);
    if (priorBoundary && !suppliedDirection && action !== "inject") {
      throw lodestarError("direction_required", "Changing this user-attributed decision needs current user direction.",
        { identifiers: { key, previous_event_id: head.event_id },
          action: "Use the actual current user instruction and reference; session identity is not authority." });
    }
    if (input.supersedes_event_id !== undefined && input.supersedes_event_id !== head?.event_id) {
      throw lodestarError("decision_conflict", "The supplied predecessor is not the current decision head.",
        { identifiers: { key, current_event_id: head?.event_id ?? null } });
    }
    if (action !== "inject") safeText(input.reason, "Decision reason");
    if (action === "set") {
      safeText(input.value, "Decision value");
      if (!["accepted", "blocked"].includes(input.status)) throw lodestarError("invalid_input", "Invalid decision status.");
    }
    if (action === "status" && !["accepted", "blocked"].includes(input.status)) throw lodestarError("invalid_input", "Invalid decision status.");
    if (action === "drop" && !["dead", "superseded"].includes(input.status)) throw lodestarError("invalid_input", "Drop status must be dead or superseded.");
    if (action === "drop" && input.status === "superseded" && !input.successor) throw lodestarError("invalid_input", "Supersession requires its successor.");
    if (["drop", "status"].includes(action) && !prior) throw lodestarError("decision_not_found", "No current decision exists for this key.", { identifiers: { key } });
    if (input.resolved_heads) {
      const actual = new Set((project.historical_scopes ?? []).filter((item) => item !== project.scope)
        .flatMap((origin) => { const result = events(db, origin);
          if (result.record_errors.length) throw lodestarError("record_requires_source_correction",
            "A historical decision stream contains records that cannot be safely replayed.",
            { identifiers: { key, scope: origin, record_errors: result.record_errors },
              action: "Correct the named decision records before resolving this stream." });
          const event = replayDecisions(result.history).heads[key]; return event ? [event.event_id] : []; }));
      if (input.resolved_heads.some((id) => !actual.has(id)) || input.resolved_heads.length !== actual.size) {
        throw lodestarError("decision_conflict", "Resolution must identify every current historical stream head.",
          { identifiers: { key, heads: [...actual] } });
      }
    }
    const data = action === "inject" ? { event: "injection", key,
      include_agent_decisions: input.include_agent_decisions } : {
      event: action === "status" ? "status" : action === "drop" ? "drop" : "set", key,
      value: action === "set" ? input.value : prior.value, status: input.status,
      reason: input.reason, direction: suppliedDirection ?? head?.direction ?? null,
      evidence: input.evidence ?? head?.evidence ?? [], conditions: input.conditions ?? head?.conditions ?? [],
      rejected_alternative: input.rejected_alternative ?? (action === "set" && prior && prior.value !== input.value ? prior.value : head?.rejected_alternative ?? null),
      successor: input.successor ?? null, resolved_heads: input.resolved_heads ?? head?.resolved_heads ?? [] };
    const comparable = (event) => Object.fromEntries(Object.keys(data).map((field) => [field, event?.[field] ?? null]));
    if (head && canonicalStringify(comparable(head)) === canonicalStringify(comparable(data))) {
      return { data: { changed: false, current: head }, changed_ids: [] };
    }
    const id = `decision:${revision}`;
    writeRecordSnapshot(db, recordInput(id, "decision-event", `Decision: ${key}`, project.scope, 0,
      { ...data, event_id: id, previous_event_id: head?.event_id ?? null,
        actor: identity.actor, session: identity.session, recorded_at: timestamp }),
    { createdAt: timestamp, updatedAt: timestamp, revision });
    return { data: { changed: true, record: normalizeRecord(getRecordById(db, id)) }, changed_ids: [id] };

}
export function diagnoseDecisions(db) {
  const rows = db.prepare("SELECT id,content_json FROM records WHERE type='decision-event'").all();
  const invalid = [], legacy = [];
  for (const row of rows) try {
    const data = JSON.parse(row.content_json).value;
    if (!data || !["set", "status", "drop", "injection"].includes(data.event)) throw new Error();
    if (data.event !== "injection") normalizeDecisionKey(data.key);
    if (data.authority !== undefined) legacy.push(row.id);
  } catch { invalid.push(row.id); }
  return { events: rows.length, invalid, legacy_unverified: legacy, healthy: invalid.length === 0 };
}
