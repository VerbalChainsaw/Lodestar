import { Buffer } from "node:buffer";
import { canonicalStringify } from "./json.mjs";
import { decisionProjection } from "./decision.mjs";
import { normalizedForRows } from "./queries.mjs";
import { sameMachinePath } from "./project.mjs";

export const CONTINUITY_LIMITS = Object.freeze({ nodes: 256, edges: 1024, bytes: 128 * 1024 });
const excluded = new Set(["mutation-receipt", "migration-source", "startup-snapshot", "pending", "decision-event", "work-event", "handoff-packet"]);
const bytes = value => Buffer.byteLength(canonicalStringify(value), "utf8");
const sorted = values => [...values].sort();

// One bounded, operation-local projection over existing records. Its targets are
// returned separately so global revisions never enter the semantic checkpoint.
export function continuityProjection(db, project, { contract, plan, actual, delta, continuation, evidenceCache = new Map() }) {
  const scopes = new Set([project.scope, ...(project.historical_scopes ?? [])]);
  const byId = new Map(plan.requirements.map(row => [row.id, row]));
  const status = new Map(delta.requirements.map(row => [row.id, row]));
  const active = continuation ? continuation.active_requirement_ids : delta.requirements
    .filter(row => !row.subtree_ready_to_review).map(row => row.id);
  const selectedRequirements = new Set(active);
  for (const id of active) {
    let parent = byId.get(id)?.parent_id;
    while (parent !== null && parent !== undefined && !selectedRequirements.has(parent)) {
      selectedRequirements.add(parent); parent = byId.get(parent)?.parent_id;
    }
  }
  const descendants = [...active];
  for (let index = 0; index < descendants.length; index++) {
    for (const child of byId.get(descendants[index])?.child_ids ?? []) {
      if (status.get(child)?.subtree_ready_to_review || selectedRequirements.has(child)) continue;
      selectedRequirements.add(child); descendants.push(child);
    }
  }
  const projection = { version: 1, association_mode: continuation?.context ? "explicit" : "legacy_defaults",
    active_requirement_ids: [...active], records: [], decisions: [], issues: [], read_required: [],
    complete: true, truncated: false, limits: { ...CONTINUITY_LIMITS, inspected_nodes: 0, inspected_edges: 0, serialized_bytes: 0 },
    omitted: { known_ids: [], deeper_count_unknown: false } };
  const targets = new Map();
  const entries = new Map(), queue = [], loaded = new Map(), edges = new Map();
  const problemKeys = new Set(), reads = new Map();
  const recordRead = id => ["get", "--", id];
  const decisionRead = key => ["decision", "show", "--cwd", project.cwd, "--", key];
  function problem(code, id, message, action, identifiers = {}, readArgs = recordRead(id)) {
    projection.complete = false;
    const key = canonicalStringify([code, id, identifiers]);
    if (!problemKeys.has(key)) {
      problemKeys.add(key);
      projection.issues.push({ code, message, action, identifiers: { id, ...identifiers } });
    }
    const readKey = canonicalStringify([code, id, readArgs]);
    if (!reads.has(readKey)) reads.set(readKey, { target_id: id, requirement_ids: [], code, action, read_args: readArgs });
  }
  function cutoff(code, id, reason) {
    projection.truncated = true; projection.omitted.deeper_count_unknown = true;
    if (!projection.omitted.known_ids.includes(id)) projection.omitted.known_ids.push(id);
    problem(code, id, reason, "Read the named record and its explicit dependencies before dependent work.");
  }
  function seed(id, reason, requirementIds = [], band = 2) {
    let entry = entries.get(id);
    if (!entry) {
      // Bound even unresolved references; a wide missing frontier cannot create
      // an unbounded queue or read-error catalog.
      if (entries.size >= CONTINUITY_LIMITS.nodes) {
        cutoff("continuity_node_limit", contract.id, "Context node limit reached; further dependency counts are unknown.");
        return;
      }
      entry = { reasons: new Set(), requirement_ids: new Set(), band };
      entries.set(id, entry); queue.push(id);
    }
    entry.reasons.add(reason);
    entry.band = Math.min(entry.band, band);
    for (const requirementId of requirementIds) entry.requirement_ids.add(requirementId);
  }
  const associations = continuation?.context;
  const phases = [[], [], [], []];
  for (const id of associations?.mission_record_ids ?? []) phases[2].push([id, "mission", [], 2]);
  for (const association of associations?.requirements ?? []) if (selectedRequirements.has(association.id)) {
    const band = active.includes(association.id) ? 0 : 1;
    for (const id of association.record_ids) phases[band].push([id, "requirement", [association.id], band]);
  }
  for (const requirement of actual.requirements) if (selectedRequirements.has(requirement.id)) {
    const band = active.includes(requirement.id) ? 0 : 1;
    for (const evidence of requirement.current_evidence) phases[band].push([evidence.id, "current_evidence", [requirement.id], band]);
  }
  for (const link of contract.links) {
    if (!["requires", "depends-on"].includes(link.relationship)) continue;
    if (projection.limits.inspected_edges >= CONTINUITY_LIMITS.edges) {
      cutoff("continuity_edge_limit", contract.id, "Intent dependency edge limit reached; deeper coverage is unknown."); break;
    }
    projection.limits.inspected_edges++;
    phases[2].push([link.to_id, "intent_dependency", [], 2]);
  }

  const scopeValues = [...scopes], placeholders = scopeValues.map(() => "?").join(",");
  // Look ahead by one row to disclose unknown wider coverage without loading it.
  const orientation = db.prepare("SELECT * FROM records WHERE (scope IN (" + placeholders + ") OR "
    + "(scope='global' AND json_extract(content_json,'$._lodestar.semantics.applicability.project') IN (" + placeholders + "))) "
    + "AND json_extract(content_json,'$._lodestar.semantics.context_role')='orientation' "
    + "AND COALESCE(json_extract(content_json,'$._lodestar.semantics.lifecycle'),'current') IN ('current','unresolved') "
    + "AND type NOT IN (" + [...excluded].map(() => "?").join(",") + ") "
    + "ORDER BY CASE WHEN type='rejection' THEN 0 ELSE 1 END,json_extract(content_json,'$._lodestar.priority') DESC,id LIMIT ?")
    .all(...scopeValues, ...scopeValues, ...excluded, CONTINUITY_LIMITS.nodes + 1);
  for (const row of orientation.slice(0, CONTINUITY_LIMITS.nodes)) phases[3].push([row.id, "orientation", [], 3]);
  if (orientation.length > CONTINUITY_LIMITS.nodes) cutoff("continuity_node_limit", contract.id,
    "Orientation exceeds the context node limit; wider coverage is unknown.");
  const rowCache = new Map(orientation.slice(0, CONTINUITY_LIMITS.nodes).map(row => [row.id, row]));
  const admitted = record => scopes.has(record.scope) || (record.scope === "global"
    && scopes.has(record.semantics?.applicability?.project));
  const checkoutApplies = record => !record.semantics?.applicability?.checkout
    || sameMachinePath(record.semantics.applicability.checkout, project.checkout_root);
  const selections = entry => ({ reasons: sorted(entry.reasons), requirement_ids: sorted(entry.requirement_ids) });
  let decisionState = null;
  const decisionSelections = new Map();
  const accepted = new Map();
  let index = 0;
  // Complete each explicit relevance band's dependency closure before admitting
  // the next band. Orientation can no longer exhaust the active node frontier.
  for (const phase of phases) {
    // Shortlist roots using persisted kind/priority before node admission. This
    // reads ranking columns only; full record inspections remain node-bounded.
    const seedMetadata = new Map();
    const ids = [...new Set(phase.map(([id]) => id))];
    for (let offset = 0; offset < ids.length; offset += CONTINUITY_LIMITS.nodes) {
      const part = ids.slice(offset, offset + CONTINUITY_LIMITS.nodes);
      for (const row of db.prepare("SELECT id,type,CASE WHEN json_valid(content_json) THEN json_extract(content_json,'$._lodestar.priority') ELSE 0 END AS priority FROM records WHERE id IN ("
        + part.map(() => "?").join(",") + ")").all(...part)) seedMetadata.set(row.id, row);
    }
    const meaning = row => ["rejection", "decision-event"].includes(row?.type) ? 0 : 1;
    phase.sort((left, right) => meaning(seedMetadata.get(left[0])) - meaning(seedMetadata.get(right[0]))
      || (seedMetadata.get(right[0])?.priority ?? 0) - (seedMetadata.get(left[0])?.priority ?? 0)
      || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    for (const args of phase) seed(...args);
    while (index < queue.length) {
      const frontier = queue.slice(index), rowsNeeded = frontier.filter(id => !evidenceCache.has(id) && !rowCache.has(id));
      if (rowsNeeded.length) {
        for (const row of db.prepare("SELECT * FROM records WHERE id IN (" + rowsNeeded.map(() => "?").join(",") + ")").all(...rowsNeeded)) rowCache.set(row.id, row);
      }
      const normalized = normalizedForRows(db, frontier.filter(id => !evidenceCache.has(id)).map(id => rowCache.get(id)).filter(Boolean));
      for (const record of normalized.records) loaded.set(record.id, record);
      for (const error of normalized.record_errors) loaded.set(error.identifiers.id, { error });
      for (const id of frontier) if (evidenceCache.has(id)) loaded.set(id, evidenceCache.get(id));
      for (const id of frontier) {
        index++; projection.limits.inspected_nodes++;
        targets.set(`record:${id}`, { kind: "record", id });
        const record = loaded.get(id), selection = entries.get(id);
        if (!record || record.error) {
          const error = record?.error;
          problem(error?.code ?? "context_record_missing", id, error?.message ?? "Selected context cannot be read.",
            error?.action ?? "Inspect or restore the selected record with a checked put.", error?.identifiers ?? {},
            error?.code === "record_requires_source_correction" ? ["get", "--raw", "--", id] : recordRead(id));
          continue;
        }
        if (!admitted(record)) { problem("context_scope_mismatch", id, "Selected context is outside the admitted project scopes.", "Inspect its applicability and correct the association before dependent work."); continue; }
        if (!checkoutApplies(record)) { problem("context_checkout_mismatch", id, "Selected context applies to another checkout.", "Inspect and correct checkout applicability before dependent work."); continue; }
        if (record.kind === "decision-event") {
          if (!decisionState) decisionState = decisionProjection(db, project);
          const key = record.data?.key;
          if (typeof key !== "string" || !key.length) { problem("context_decision_invalid", id, "Selected decision has no usable key.", "Inspect and correct the decision source record."); continue; }
          let group = decisionSelections.get(key);
          if (!group) { group = { selected_event_ids: [], reasons: new Set(), requirement_ids: new Set() }; decisionSelections.set(key, group); }
          group.selected_event_ids.push(id);
          for (const reason of selection.reasons) group.reasons.add(reason);
          for (const requirementId of selection.requirement_ids) group.requirement_ids.add(requirementId);
          continue;
        }
        if (!["current", "unresolved"].includes(record.semantics.lifecycle) || record.semantics.retirement_reason) {
          problem("context_record_retired", id, "Selected context is historical or retired.", "Inspect its history and explicitly correct the association or retirement before dependent work."); continue;
        }
        if (!["known", "known_empty"].includes(record.availability)) {
          problem("context_record_unavailable", id, "Selected context is not marked available.", "Inspect and refresh its recorded availability before dependent work."); continue;
        }
        accepted.set(id, record);
        for (const source of record.sources) if (source.freshness !== "current") {
          problem(source.freshness === "stale" ? "context_source_stale" : "context_source_unknown", id,
            "A selected context source has unresolved recorded freshness.",
            "Inspect and refresh the named source before relying on its claim.", { origin: source.origin, freshness: source.freshness });
        }
        const dependencies = [];
        for (const link of record.links) {
          if (!["requires", "depends-on"].includes(link.relationship)) continue;
          if (projection.limits.inspected_edges >= CONTINUITY_LIMITS.edges) {
            cutoff("continuity_edge_limit", id, "Dependency edge limit reached; deeper coverage is unknown."); break;
          }
          projection.limits.inspected_edges++;
          dependencies.push(link.to_id);
          seed(link.to_id, `dependency:${id}`, selection.requirement_ids, selection.band);
        }
        edges.set(id, dependencies);
      }
    }
  }
  // Propagate relevance over the inspected graph without additional record reads.
  const propagation = [...entries.keys()], enqueued = new Set(propagation);
  for (let cursor = 0; cursor < propagation.length; cursor++) {
    const id = propagation[cursor]; enqueued.delete(id);
    for (const target of edges.get(id) ?? []) {
      const peer = entries.get(target);
      if (!peer) continue;
      let changed = false;
      if (entries.get(id).band < peer.band) { peer.band = entries.get(id).band; changed = true; }
      for (const requirementId of entries.get(id).requirement_ids) if (!peer.requirement_ids.has(requirementId)) {
        peer.requirement_ids.add(requirementId); changed = true;
      }
      if (changed && !enqueued.has(target)) { propagation.push(target); enqueued.add(target); }
    }
  }
  if (decisionState) {
    // Match the domain owner's fail-closed basis: an unreadable causal stream
    // cannot supply a safe decision guard. Individual source revisions remain.
    if (decisionState.complete) targets.set("injection", { kind: "decision", scope: project.scope, key: "lodestar:agent-decision-presentation" });
    for (const [key, selection] of decisionSelections) {
      for (const id of selection.selected_event_ids) {
        for (const requirementId of entries.get(id).requirement_ids) selection.requirement_ids.add(requirementId);
        for (const reason of entries.get(id).reasons) selection.reasons.add(reason);
      }
      const conflict = decisionState.conflicts.find(item => item.key === key);
      const current = [...decisionState.facts, ...decisionState.blocked].find(item => item.key === key) ?? null;
      const candidates = conflict?.candidates ?? [];
      const resolution = conflict ? "conflict" : current && decisionState.complete ? "current" : "unavailable";
      projection.decisions.push({ key, resolution, current: resolution === "current" ? current : null,
        candidates, selected_event_ids: sorted(selection.selected_event_ids), selection: selections(selection) });
      if (decisionState.complete) for (const origin of scopes) {
        // An appended historical event can replace a selected choice or create
        // a conflict even when every previously read event record is unchanged.
        const target = { kind: "decision", scope: origin, key };
        targets.set(canonicalStringify(target), target);
      }
      const headIds = new Set([decisionState.heads[key]?.event_id, current?.event_id, ...candidates.map(item => item.event_id)].filter(Boolean));
      for (const headId of headIds) targets.set(`record:${headId}`, { kind: "record", id: headId });
      if (resolution !== "current") problem(resolution === "conflict" ? "context_decision_conflict" : "context_decision_unavailable",
        selection.selected_event_ids[0], "Selected decision cannot be resolved to one current choice.",
        "Read and reconcile the current decision stream before dependent work.", { key }, decisionRead(key));
      else for (const id of selection.selected_event_ids) if (id !== current.event_id) problem("context_decision_superseded", id,
        "The selected event is not the current decision head.", "Read the current decision and explicitly refresh the association.", { key, current_event_id: current.event_id }, decisionRead(key));
    }
    for (const error of decisionState.record_errors) {
      const id = error.identifiers?.id ?? contract.id;
      targets.set(`record:${id}`, { kind: "record", id });
      problem("context_decision_unreadable", id, error.message,
        error.action ?? "Correct the named decision source before relying on the selected choice.", error.identifiers ?? {},
        error.identifiers?.raw_read_args ?? recordRead(id));
    }
  }
  const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const bandOf = entry => entry.requirement_ids.size
    ? [...entry.requirement_ids].some(id => active.includes(id)) ? 0 : Math.min(entry.band, 1) : entry.band;
  const reasonOf = entry => {
    const band = bandOf(entry), dependency = [...entry.reasons].some(reason => reason.startsWith("dependency:"));
    return `${["active_requirement", "selected_branch", "mission", "orientation"][band]}${dependency ? "_dependency" : ""}`;
  };
  projection.records = [...accepted]
    .map(([id, record]) => ({ ...record, selection: selections(entries.get(id)) }));
  const ranked = [
    ...projection.records.map(row => ({ row, entry: entries.get(row.id), id: row.id, decision: false })),
    ...projection.decisions.map(row => ({ row, entry: { ...decisionSelections.get(row.key),
      band: Math.min(...row.selected_event_ids.map(id => entries.get(id).band)) }, id: row.key, decision: true })),
  ].sort((left, right) => bandOf(left.entry) - bandOf(right.entry)
    || Number(!(left.decision || left.row.kind === "rejection")) - Number(!(right.decision || right.row.kind === "rejection"))
    || (right.row.priority ?? 0) - (left.row.priority ?? 0) || ordinal(left.id, right.id));
  ranked.forEach(({ row, entry }, order) => { row.selection.order = order; row.selection.reason = reasonOf(entry); });
  projection.records.sort((a,b) => a.selection.order - b.selection.order);
  projection.decisions.sort((a,b) => a.selection.order - b.selection.order);
  const rowOrder = new Map(ranked.map(({ row, id }) => [id, row.selection.order]));
  for (const { row, decision } of ranked) if (decision) {
    for (const id of row.selected_event_ids) rowOrder.set(id, row.selection.order);
  }
  const updateReads = () => {
    for (const read of reads.values()) {
      const entry = entries.get(read.target_id);
      read.requirement_ids = sorted(entry?.requirement_ids ?? []);
      if (entry) read.selection = { order: rowOrder.get(read.target_id) ?? ranked.length, reason: reasonOf(entry) };
    }
    projection.read_required = [...reads.values()].sort((left,right) =>
      (left.selection?.order ?? ranked.length) - (right.selection?.order ?? ranked.length)
      || ordinal(left.target_id, right.target_id) || ordinal(canonicalStringify(left.read_args), canonicalStringify(right.read_args)));
  };
  updateReads();
  // Whole bodies only. Reserve space for a single root read when the detailed
  // frontier itself is too large, and explicitly leave deeper counts unknown.
  // Reserve the final counter's maximum digit width. Each whole-row admission
  // uses the serialized projection as the bound, including current coverage.
  projection.limits.serialized_bytes = CONTINUITY_LIMITS.bytes;
  projection.records = []; projection.decisions = [];
  const retained = [];
  const omitForBytes = candidate => {
    const id = candidate.decision ? candidate.row.selected_event_ids[0] : candidate.row.id;
    projection.truncated = true; projection.complete = false;
    if (!projection.omitted.known_ids.includes(id)) projection.omitted.known_ids.push(id);
    // Repeating the same omission explanation for every body can consume the
    // entire budget. Keep one issue and retain each exact executable read.
    if (!projection.issues.some(issue => issue.code === "continuity_byte_limit")) projection.issues.push({
      code: "continuity_byte_limit", message: "Whole context rows were omitted for the byte budget.",
      action: "Run the exact required reads before relying on omitted evidence.", identifiers: { id: contract.id } });
    const readArgs = candidate.decision ? decisionRead(candidate.row.key) : recordRead(id);
    const key = canonicalStringify(["continuity_byte_limit", id, readArgs]);
    if (!reads.has(key)) reads.set(key, { target_id: id, requirement_ids: [], code: "continuity_byte_limit",
      action: "Read this omitted whole context row before dependent work.", read_args: readArgs });
    updateReads();
  };
  // Admit whole rows in the same core order. An oversized early body yields an
  // exact read without preventing smaller later evidence from fitting.
  for (const candidate of ranked) {
    const collection = candidate.decision ? projection.decisions : projection.records;
    collection.push(candidate.row);
    if (bytes(projection) <= CONTINUITY_LIMITS.bytes - 2048) retained.push(candidate);
    else {
      collection.pop();
      omitForBytes(candidate);
    }
  }
  while (bytes(projection) > CONTINUITY_LIMITS.bytes && retained.length) {
    const candidate = retained.pop(), collection = candidate.decision ? projection.decisions : projection.records;
    collection.pop();
    omitForBytes(candidate);
  }
  if (bytes(projection) > CONTINUITY_LIMITS.bytes) {
    projection.decisions = []; projection.issues = []; projection.read_required = [];
    projection.omitted = { known_ids: [], deeper_count_unknown: true };
    projection.truncated = true; projection.complete = false;
    if (projection.active_requirement_ids.length) {
      projection.active_requirement_ids_omitted = projection.active_requirement_ids.length;
      projection.active_requirement_ids = [];
    }
    projection.issues.push({ code: "continuity_byte_limit", message: "Detailed context coverage exceeds the byte limit; omitted counts are unknown.",
      action: "Read the intent associations, then use the named record and decision reads before dependent work.", identifiers: { id: contract.id } });
    projection.read_required.push({ target_id: contract.id, requirement_ids: [], code: "continuity_byte_limit",
      action: projection.issues[0].action, read_args: recordRead(contract.id) });
  }
  if (bytes(projection) > CONTINUITY_LIMITS.bytes) {
    // An individually unrepresentable identifier remains on the enclosing work
    // check result. Never clip it into a different record or malformed command.
    projection.read_required = [];
    projection.issues = [{ code: "continuity_byte_limit", message: "The intent identifier itself cannot fit in this bounded contribution.",
      action: "Use the enclosing intent_record_id with the public get read, then inspect its associations before dependent work.", identifiers: {} }];
  }
  // The count includes its own decimal representation.
  let size = bytes(projection);
  do { projection.limits.serialized_bytes = size; const next = bytes(projection); if (next === size) break; size = next; } while (true);
  return { projection, targets: [...targets.values()] };
}
