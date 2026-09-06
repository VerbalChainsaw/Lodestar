import { canonicalStringify } from "./json.mjs";
import { lodestarError } from "./errors.mjs";
import { normalizedRowsResult, recordInput } from "./project.mjs";
import { getRecordById, mutate, normalizeRecord, writeBasis, writeRecordSnapshot } from "./records.mjs";
import { validateDomainInput } from "./cli-commands.mjs";
import { safeText } from "./decision.mjs";

const target = (id) => ({ kind: "record", id });
export function validateHandoff(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw lodestarError("invalid_input", "A structured checkpoint is required.");
  }
  const fields = ["objective", "current_state", "completed_results", "unresolved_work", "references"];
  if (Object.keys(checkpoint).some((field) => !fields.includes(field))) throw lodestarError("invalid_input", "Unknown checkpoint control field.");
  safeText(checkpoint.objective, "Checkpoint objective");
  safeText(checkpoint.current_state, "Checkpoint current state");
  for (const field of fields.slice(2)) if (!Array.isArray(checkpoint[field])) {
    throw lodestarError("invalid_input", `Checkpoint ${field} must be an array; an empty array is valid when truthful.`);
  }
  return { valid: true, checkpoint };
}
export function handoffStatus(db, project, identity = {}, { history = false } = {}) {
  const scopes = [...new Set([project.scope, ...(project.historical_scopes ?? [])])];
  const result = normalizedRowsResult(db, "SELECT id FROM records WHERE scope IN ("
    + scopes.map(() => "?").join(",") + ") AND "
    + (history ? "(type='handoff' OR type LIKE 'handoff-%') " : "type='handoff' AND json_extract(content_json,'$.value.state') IN ('open','claimed') ")
    + "ORDER BY json_extract(content_json,'$._lodestar.revision') DESC,id", ...scopes);
  return { advisory: true, records: result.records, record_errors: result.record_errors,
    complete: result.record_errors.length === 0,
    notice: "Reading does not claim a transfer. Use an explicit claim with its observed revision.",
    write_basis: writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root,
      targets: [...result.records.filter(({ kind }) => kind === "handoff").map(({ id }) => target(id)),
        ...(project.binding_preconditions ?? []).map(({ target: dependency }) => dependency)] }) };
}
export function handoffMutation(db, project, identity, action, request, options = {}) {
  const input = validateDomainInput(`handoff.${action}`, request?.input);
  if (!identity.actor) throw lodestarError("identity_required", "Continuity writes require the actual actor identity.");
  if (input.checkpoint) validateHandoff(input.checkpoint);
  return mutate(db, `handoff.${action}`, request, ({ revision, timestamp }) => {
    const row = db.prepare("SELECT id FROM records WHERE id=?").get(input.id);
    const existing = row ? getRecordById(db, input.id) : null;
    if (existing && (existing.type !== "handoff" || existing.scope !== project.scope)) {
      throw lodestarError("handoff_conflict", "The target is not a current-contract transfer in this project.", { identifiers: { id: input.id } });
    }
    if (!existing && !["arm", "checkpoint"].includes(action)) throw lodestarError("handoff_not_found", "Read or create the checkpoint before this operation.", { identifiers: { id: input.id } });
    const prior = existing?.content.value ?? {};
    let data = { ...prior };
    const changed = [];
    if (["arm", "checkpoint"].includes(action)) {
      const state = input.state ?? prior.state ?? "open";
      if (state === "closed" && !input.reason) throw lodestarError("invalid_input", "Closing continuity requires a reason.");
      if (canonicalStringify(prior.checkpoint ?? null) === canonicalStringify(input.checkpoint)
          && state === prior.state && (input.reason ?? prior.reason ?? null) === (prior.reason ?? null)) {
        return { data: { changed: false, record: normalizeRecord(existing) }, changed_ids: [] };
      }
      const packetId = `handoff-packet:${revision}`;
      writeRecordSnapshot(db, recordInput(packetId, "handoff-packet", input.checkpoint.objective, project.scope, 0,
        { checkpoint: input.checkpoint, transfer_id: input.id, previous_packet_id: prior.packet_id ?? null,
          actor: identity.actor, recorded_at: timestamp, reason: input.reason ?? null }),
      { createdAt: timestamp, updatedAt: timestamp, revision });
      changed.push(packetId);
      data = { ...prior, state, checkpoint: input.checkpoint, packet_id: packetId,
        checkout: project.checkout_root, source_actor: prior.source_actor ?? identity.actor,
        claimed_by: prior.claimed_by ?? null, reason: input.reason ?? prior.reason ?? null };
    } else if (action === "claim") {
      if (prior.state !== "open") throw lodestarError("handoff_conflict", "Only an open transfer can be claimed.",
        { identifiers: { id: input.id, state: prior.state, claimed_by: prior.claimed_by } });
      data = { ...prior, state: "claimed", claimed_by: identity.actor, claimed_at: timestamp };
    } else if (action === "now") {
      safeText(input.reason, "Transfer reason");
      data = { ...prior, state: "open", reason: input.reason, transfer_requested_by: identity.actor,
        claimed_by: null, claimed_at: null };
    } else if (action === "disarm") {
      safeText(input.reason, "Cancellation reason");
      data = { ...prior, state: "cancelled", reason: input.reason };
    }
    if (canonicalStringify(data) === canonicalStringify(prior)) return { data: { changed: false, record: normalizeRecord(existing) }, changed_ids: [] };
    writeRecordSnapshot(db, { ...recordInput(input.id, "handoff", data.checkpoint.objective, project.scope, 0, data),
      ...(existing ? { aliases: existing.aliases, links: normalizeRecord(existing).links, sources: existing.sources, semantics: existing.semantics } : {}) },
    { createdAt: existing?.created_at ?? timestamp, updatedAt: timestamp, revision });
    changed.push(input.id);
    return { data: { changed: true, record: normalizeRecord(getRecordById(db, input.id)) }, changed_ids: changed };
  }, { ...options, requiredTargets: [target(input.id), ...(project.binding_preconditions ?? []).map(({ target: dependency }) => dependency)] });
}
export function diagnoseHandoff(db) {
  const rows = db.prepare("SELECT id,type,content_json FROM records WHERE type='handoff' OR type LIKE 'handoff-%'").all();
  const invalid = [], historical = [];
  for (const row of rows) try {
    const data = JSON.parse(row.content_json).value;
    if (row.type === "handoff") {
      validateHandoff(data.checkpoint);
      if (!["open", "claimed", "closed", "cancelled"].includes(data.state)) throw new Error();
      if (data.state === "claimed" && !data.claimed_by) throw new Error();
    } else if (row.type === "handoff-packet" && data.checkpoint) validateHandoff(data.checkpoint);
    else historical.push(row.id);
  } catch { invalid.push(row.id); }
  return { records: rows.length, invalid, historical, healthy: invalid.length === 0 };
}
