import { createHash } from "node:crypto";

import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { getRecordById, normalizeRecord, writeBasis } from "./records.mjs";
import { validateIdentifier } from "./validate.mjs";
import { continuityProjection } from "./context-projection.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const filled = (value) => typeof value === "string" && value.trim().length > 0;
const digest = (value) => createHash("sha256").update(canonicalStringify(value)).digest("hex");
const hexHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const distinct = (values) => new Set(values).size === values.length;
const textList = (value) => Array.isArray(value) && value.every(filled);
function invalid(pointer, message, id = undefined) {
  throw lodestarError("invalid_intent_contract", message, {
    identifiers: { pointer, ...(id ? { id } : {}) },
    action: "Correct the named intent or acceptance field with a checked put, then run work check again; see docs/intent-evidence.md.",
  });
}

function validateIntent(value) {
  if (!object(value) || !exact(value, ["version", "brief", "user_reference", "requirements", "boundaries", "non_goals"])
    || value.version !== 1 || !filled(value.brief) || !filled(value.user_reference)
    || !textList(value.boundaries) || !textList(value.non_goals)
    || !Array.isArray(value.requirements) || value.requirements.length === 0) {
    invalid("/data/intent", "Intent needs version 1, a brief, a user reference, and at least one requirement.");
  }
  for (const [index, requirement] of value.requirements.entries()) {
    if (!object(requirement) || !exact(requirement, ["id", "text", "acceptance", "parent_id"])
      || !filled(requirement.id) || !filled(requirement.text) || !filled(requirement.acceptance)) {
      invalid(`/data/intent/requirements/${index}`, "Each requirement needs a distinct ID, text, and an acceptance procedure.");
    }
  }
  if (!distinct(value.requirements.map(({ id }) => id))) {
    invalid("/data/intent/requirements", "Requirement IDs must be distinct.");
  }
  const byId = new Map(value.requirements.map((requirement) => [requirement.id, requirement]));
  for (const [index, requirement] of value.requirements.entries()) {
    if (requirement.parent_id !== undefined
      && (!filled(requirement.parent_id) || !byId.has(requirement.parent_id)
        || requirement.parent_id === requirement.id)) {
      invalid(`/data/intent/requirements/${index}/parent_id`,
        "A parent ID must name a different requirement in the current intent.");
    }
  }
  const checked = new Set();
  for (const [index, requirement] of value.requirements.entries()) {
    if (checked.has(requirement.id)) continue;
    const visited = new Set([requirement.id]);
    let parentId = requirement.parent_id;
    while (parentId !== undefined && !checked.has(parentId)) {
      if (visited.has(parentId)) invalid(`/data/intent/requirements/${index}/parent_id`,
        "Requirement parent relationships cannot contain a cycle.");
      visited.add(parentId);
      parentId = byId.get(parentId).parent_id;
    }
    for (const id of visited) checked.add(id);
  }
  return value;
}

function validateContinuation(value, requirementIds, intentId) {
  if (value === undefined) return null;
  if (!object(value) || !exact(value, ["active_requirement_ids", "next_action", "context"])
    || !textList(value.active_requirement_ids) || !distinct(value.active_requirement_ids)
    || value.active_requirement_ids.some((id) => !requirementIds.has(id))
    || !filled(value.next_action)) {
    invalid("/data/continuation",
      "Continuation needs distinct existing active requirement IDs and a nonempty next action.");
  }
  if (value.context !== undefined) {
    const pointer = "/data/continuation/context", context = value.context;
    if (!object(context) || !exact(context, ["version", "mission_record_ids", "requirements"])) {
      invalid(pointer, "Context needs a version, mission record IDs and requirement associations.", intentId);
    }
    if (context.version !== 1) invalid(`${pointer}/version`, "Context version must be 1.", intentId);
    const ids = (list, field) => {
      if (!Array.isArray(list) || !distinct(list)) invalid(field, "Context record IDs must be a distinct array.", intentId);
      for (const [index, id] of list.entries()) {
        try { validateIdentifier(id, `${field}/${index}`); }
        catch { invalid(`${field}/${index}`, "Context needs an exact valid record ID.", intentId); }
      }
    };
    ids(context.mission_record_ids, `${pointer}/mission_record_ids`);
    if (!Array.isArray(context.requirements)) invalid(`${pointer}/requirements`, "Context requirements must be an array.", intentId);
    const seen = new Set();
    for (const [index, association] of context.requirements.entries()) {
      const field = `${pointer}/requirements/${index}`;
      if (!object(association) || !exact(association, ["id", "record_ids"])) invalid(field, "Context association needs only id and record_ids.", intentId);
      if (!requirementIds.has(association.id) || seen.has(association.id)) invalid(`${field}/id`, "Context association needs a unique known requirement ID.", intentId);
      seen.add(association.id);
      ids(association.record_ids, `${field}/record_ids`);
    }
  }
  return value;
}

function validateAcceptance(value) {
  if (value === undefined) return null;
  if (!object(value) || !exact(value, ["intent_sha256", "results", "blockers"])
    || !hexHash(value.intent_sha256) || !Array.isArray(value.results) || !textList(value.blockers)) {
    invalid("/data/acceptance", "Acceptance needs an intent SHA-256, results array, and blocker list.");
  }
  for (const [index, result] of value.results.entries()) {
    if (!object(result) || !exact(result, ["requirement_id", "status", "evidence", "notes"])
      || !filled(result.requirement_id) || !["passed", "failed", "unverified"].includes(result.status)
      || !Array.isArray(result.evidence) || typeof result.notes !== "string") {
      invalid(`/data/acceptance/results/${index}`, "Each result needs a requirement ID, status, evidence array, and notes.");
    }
    for (const [evidenceIndex, reference] of result.evidence.entries()) {
      if (!object(reference) || !exact(reference, ["id", "revision", "data_sha256"])
        || !filled(reference.id) || !Number.isSafeInteger(reference.revision) || reference.revision < 1
        || (reference.data_sha256 !== undefined && !hexHash(reference.data_sha256))) {
        invalid(`/data/acceptance/results/${index}/evidence/${evidenceIndex}`,
          "Each evidence reference needs an exact record ID and positive revision; its optional data SHA-256 must be lowercase hex.");
      }
    }
    if (!distinct(result.evidence.map(({ id }) => id))) {
      invalid(`/data/acceptance/results/${index}/evidence`, "Evidence IDs cannot repeat within one requirement result.");
    }
  }
  if (!distinct(value.results.map(({ requirement_id: id }) => id))) {
    invalid("/data/acceptance/results", "A requirement may have only one supplied result.");
  }
  return value;
}

function validateTasks(value, requirementIds) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("/data/tasks", "Task references must be an array.");
  for (const [index, task] of value.entries()) {
    if (!object(task) || !exact(task, ["runtime_task_id", "owner", "requirement_ids", "status"])
      || !filled(task.runtime_task_id) || !filled(task.owner) || !filled(task.status)
      || !textList(task.requirement_ids) || !distinct(task.requirement_ids)
      || task.requirement_ids.some((id) => !requirementIds.has(id))) {
      invalid(`/data/tasks/${index}`, "Task references need an owner, runtime task ID, status, and known requirement IDs.");
    }
  }
  return value;
}

// Preparation reuses the exact intent contract without requiring unrelated
// context or evidence reads to succeed before attaching one readable record.
export function inspectWorkIntent(db, project, intentId) {
  const contract = normalizeRecord(getRecordById(db, intentId));
  const admitted = new Set([project.scope, ...(project.historical_scopes ?? [])]);
  if (contract.kind !== "knowledge" || !admitted.has(contract.scope)
    || contract.semantics?.lifecycle !== "current") {
    throw lodestarError("invalid_intent_contract", "The intent must be a current knowledge record in this project.", {
      identifiers: { id: intentId, kind: contract.kind, scope: contract.scope },
      action: "Select a current project knowledge record containing data.intent; see docs/intent-evidence.md.",
    });
  }
  if (!object(contract.data) || !exact(contract.data, ["intent", "acceptance", "tasks", "continuation"])) {
    invalid("/data", "The intent knowledge record data may contain only intent, acceptance, tasks, and continuation.");
  }
  const intent = validateIntent(contract.data?.intent);
  const acceptance = validateAcceptance(contract.data?.acceptance);
  const requirementIds = new Set(intent.requirements.map(({ id }) => id));
  const tasks = validateTasks(contract.data?.tasks, requirementIds);
  const continuation = validateContinuation(contract.data?.continuation, requirementIds, intentId);
  return { contract, intent, acceptance, tasks, continuation, requirementIds, intentHash: digest(intent) };
}

export const evidenceDataHash = digest;

export function checkWorkEvidence(db, project, intentId) {
  const { contract, intent, acceptance, tasks, continuation, requirementIds, intentHash } = inspectWorkIntent(db, project, intentId);
  const admitted = new Set([project.scope, ...(project.historical_scopes ?? [])]);
  const results = new Map((acceptance?.results ?? []).map((result) => [result.requirement_id, result]));
  const referencedIds = [...new Set((acceptance?.results ?? []).flatMap((result) => result.evidence.map(({ id }) => id)))];
  const issues = [], recordErrors = [], requirements = [];
  const issue = (code, message, action, details = {}) => issues.push({ code, message, action, ...details });
  if (!acceptance) issue("missing_acceptance", "No acceptance report is recorded.",
    "Add data.acceptance with the current intent hash and one result per requirement.");
  else if (acceptance.intent_sha256 !== intentHash) issue("intent_hash_mismatch",
    "The acceptance report names a different intent body.",
    "Review the changed intent and record a new acceptance report with its current intent SHA-256.");
  for (const blocker of acceptance?.blockers ?? []) issue("unresolved_blocker", blocker,
    `Resolve or explicitly revise the blocker: ${blocker}`);
  for (const result of acceptance?.results ?? []) if (!requirementIds.has(result.requirement_id)) {
    issue("unknown_requirement", "A result names a requirement absent from the current intent.",
      `Remove or correct result ${result.requirement_id} after reviewing the current intent.`,
      { requirement_id: result.requirement_id });
  }
  const evidenceCache = new Map();
  const evidenceHashes = new Map();
  for (const requirement of intent.requirements) {
    const result = results.get(requirement.id);
    const row = { id: requirement.id, supplied_status: result?.status ?? "missing",
      notes: result?.notes ?? "", supplied_evidence: result?.evidence ?? [], evidence: [] };
    requirements.push(row);
    if (!result) {
      issue("missing_result", "No supplied acceptance result covers this requirement.",
        `Record an explicit result and evidence for ${requirement.id}.`, { requirement_id: requirement.id });
      continue;
    }
    if (result.status !== "passed") issue("result_not_passed", "The supplied result is not passed.",
      `Resolve and record a passed result for ${requirement.id}, or keep it unverified.`,
      { requirement_id: requirement.id, status: result.status });
    if (!filled(result.notes)) issue("missing_claim_note", "The result does not explain how its evidence relates to acceptance.",
      `Explain the claim-evidence relationship in ${requirement.id}'s result notes.`, { requirement_id: requirement.id });
    if (result.evidence.length === 0) issue("missing_evidence", "The result has no referenced record evidence.",
      `Attach at least one relevant recorded evidence ID and revision to ${requirement.id}.`,
      { requirement_id: requirement.id });
    for (const reference of result.evidence) {
      const details = { requirement_id: requirement.id, evidence_id: reference.id,
        recorded_revision: reference.revision };
      let current = evidenceCache.get(reference.id);
      if (!current) {
        try { current = normalizeRecord(getRecordById(db, reference.id)); }
        catch (error) {
          current = { error };
          recordErrors.push({ id: reference.id, code: error.code ?? "evidence_unreadable",
            message: error.message });
        }
        evidenceCache.set(reference.id, current);
      }
      if (current.error) {
        issue(current.error.code === "record_not_found" ? "evidence_missing" : "evidence_unreadable",
          "The referenced evidence record cannot be read.",
          `Restore or replace evidence ${reference.id} and record its exact revision.`, details);
        continue;
      }
      if (reference.id === intentId || !admitted.has(current.scope)) {
        issue("evidence_out_of_scope", "The reference is the intent itself or belongs outside this project.",
          `Choose a separate evidence record in the current or an admitted historical project scope for ${requirement.id}.`, details);
        continue;
      }
      if (current.semantics?.retirement_reason || current.semantics?.lifecycle === "superseded"
        || (current.semantics?.lifecycle === "historical"
        && !["work-event", "decision-event", "handoff-packet"].includes(current.kind))) {
        issue("evidence_retired", "The current evidence record was retired or superseded.",
          `Replace or explicitly restore evidence ${reference.id}, then record its current revision.`, details);
        continue;
      }
      if (current.availability !== "known") {
        issue("evidence_unavailable", "The evidence record is not marked known.",
          `Inspect and correct the availability of evidence ${reference.id}.`, details);
        continue;
      }
      if (reference.revision !== current.revision) {
        issue("evidence_revision_stale", "The referenced evidence revision is no longer current.",
          `Reinspect ${reference.id} at revision ${current.revision} and record a new result for ${requirement.id}.`,
          { ...details, current_revision: current.revision });
        continue;
      }
      if (!evidenceHashes.has(reference.id)) evidenceHashes.set(reference.id, digest(current.data));
      const actualHash = evidenceHashes.get(reference.id);
      if (reference.data_sha256 && reference.data_sha256 !== actualHash) {
        issue("evidence_hash_mismatch", "The supplied evidence data hash differs from the recorded version.",
          `Reinspect ${reference.id} revision ${reference.revision} and correct the evidence mapping.`, details);
        continue;
      }
      row.evidence.push({ id: reference.id, revision: reference.revision,
        current_revision: current.revision, source: "current",
        data_sha256: actualHash, kind: current.kind });
    }
  }
  const childIds = new Map(intent.requirements.map(({ id }) => [id, []]));
  for (const requirement of intent.requirements) if (requirement.parent_id !== undefined) {
    childIds.get(requirement.parent_id).push(requirement.id);
  }
  const issuesById = new Map(intent.requirements.map(({ id }) => [id, []]));
  for (const found of issues) if (issuesById.has(found.requirement_id)) {
    issuesById.get(found.requirement_id).push(found.code);
  }
  const globalIssues = issues.filter(({ requirement_id }) => !requirement_id).map(({ code }) => code);
  const staleIntent = acceptance !== null && acceptance.intent_sha256 !== intentHash;
  const actualById = new Map(requirements.map((row) => [row.id, row]));
  const resolved = new Map();
  const parents = new Map(intent.requirements.map(({ id, parent_id }) => [id, parent_id]));
  const remaining = new Map([...childIds].map(([id, children]) => [id, children.length]));
  const pending = intent.requirements.filter(({ id }) => remaining.get(id) === 0).map(({ id }) => id);
  // Children resolve before their parents, without recursion or repeated ancestry.
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    const row = actualById.get(id);
    const own = row.supplied_status === "passed" && issuesById.get(id).length === 0 && !staleIntent;
    resolved.set(id, own && childIds.get(id).every(child => resolved.get(child)));
    const parent = parents.get(id);
    if (parent !== undefined) {
      const left = remaining.get(parent) - 1;
      remaining.set(parent, left);
      if (left === 0) pending.push(parent);
    }
  }
  const plan = {
    intent_record_id: intentId, intent_revision: contract.revision, intent_sha256: intentHash,
    brief: intent.brief, user_reference: intent.user_reference,
    boundaries: intent.boundaries, non_goals: intent.non_goals,
    root_ids: intent.requirements.filter(({ parent_id }) => parent_id === undefined).map(({ id }) => id),
    requirements: intent.requirements.map((requirement) => ({
      id: requirement.id, parent_id: requirement.parent_id ?? null,
      child_ids: childIds.get(requirement.id), text: requirement.text,
      acceptance: requirement.acceptance,
    })),
  };
  const actual = { requirements: requirements.map((row) => ({
    id: row.id, supplied_status: row.supplied_status, notes: row.notes,
    supplied_evidence: row.supplied_evidence, current_evidence: row.evidence,
  })), task_references: tasks };
  const delta = { ready_to_review: issues.length === 0,
    global_issue_codes: globalIssues,
    requirements: intent.requirements.map(({ id }) => {
      const row = actualById.get(id);
      const ownIssueCodes = issuesById.get(id);
      const ownReady = row.supplied_status === "passed" && ownIssueCodes.length === 0 && !staleIntent;
      const subtreeReady = resolved.get(id);
      const status = row.supplied_status === "missing" ? "not_started"
        : row.supplied_status === "failed" ? "failed"
          : row.supplied_status === "unverified" ? "unverified"
            : staleIntent ? "stale_intent"
            : !ownReady ? "reported_complete_needs_evidence"
              : !subtreeReady ? "awaiting_descendants" : "reported_complete_with_current_evidence";
      return { id, status, own_ready_to_review: ownReady,
        subtree_ready_to_review: subtreeReady, issue_codes: ownIssueCodes };
    }),
    issues, next: [...new Set(issues.map(({ action }) => action))],
  };
  const context = continuityProjection(db, project, { contract, plan, actual, delta, continuation, evidenceCache });
  return {
    intent_record_id: intentId, intent_revision: contract.revision,
    intent_sha256: intentHash, ready_to_review: issues.length === 0,
    complete: recordErrors.length === 0, issues, record_errors: recordErrors,
    requirements, task_references: tasks,
    plan, actual, delta, continuation, continuity: context.projection,
    next: [...new Set(issues.map(({ action }) => action))],
    notice: "This checks recorded mappings and identities only. Passed results and claim relevance are supplied assertions; review the evidence and run required acceptance checks yourself. Task references do not prove runtime status or identity.",
    write_basis: writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root,
      targets: [...[intentId, ...referencedIds].map((id) => ({ kind: "record", id })), ...context.targets] }),
  };
}
