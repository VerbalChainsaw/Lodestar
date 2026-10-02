import { randomUUID } from "node:crypto";
import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { getRecordById, normalizeRecord, preparePutEvidence, writeBasis } from "./records.mjs";
import { sameMachinePath } from "./project.mjs";
import { validateIdentifier } from "./validate.mjs";
import { buildOperatorRecord } from "./operator-actions.mjs";
import { evidenceDataHash, inspectWorkIntent } from "./work-evidence.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0 && !value.includes("\0");

function invalid(pointer, message, id, code = "invalid_input") {
  throw lodestarError(code, message, {
    identifiers: { pointer, ...(id ? { id } : {}) },
    action: "Correct the named capture field, then prepare again using a fresh get and work check read of the selected intent. No capture was saved.",
  });
}
function shape(value, keys, required, pointer) {
  if (!object(value)) invalid(pointer, "An exact capture object is required.");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, "Unknown capture field.");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${pointer}/${key}`, "Required capture field is missing.");
  }
}
function identifier(value, pointer) {
  try { validateIdentifier(value, pointer); }
  catch { invalid(pointer, "An exact valid record identifier is required."); }
}
function suppliedText(value, pointer) {
  if (!text(value)) invalid(pointer, "Nonempty text is required.");
}
function plainText(value, pointer) {
  suppliedText(value, pointer);
  if (/[\u0000-\u001f\u007f]/u.test(value)) invalid(pointer, "Supply this field as plain text without control characters.");
}
function requirementList(value, pointer) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    invalid(pointer, "Requirement IDs must be a nonempty distinct array.");
  }
  value.forEach((entry, index) => suppliedText(entry, `${pointer}/${index}`));
}

export function validateCaptureDraft(draft) {
  const common = ["version", "stage", "intent_record_id", "author"];
  if (!object(draft)) invalid("/", "A version 1 capture draft is required.");
  if (draft.version !== 1) invalid("/version", "Capture draft version must be 1.");
  if (!["create", "associate"].includes(draft.stage)) invalid("/stage", "Capture stage must be create or associate.");
  const creating = draft.stage === "create";
  shape(draft, [...common, ...(creating ? ["record"]
    : ["record_id", "context_target", "acceptance_result", "initialize_continuation"])],
  [...common, ...(creating ? ["record"] : ["record_id", "context_target"])], "");
  identifier(draft.intent_record_id, "/intent_record_id");
  plainText(draft.author, "/author");

  if (creating) {
    const record = draft.record;
    if (!object(record) || !["knowledge", "research", "result"].includes(record.type)) {
      invalid("/record/type", "Capture type must be knowledge, research or result.");
    }
    const extra = record.type === "research" ? ["source", "claim", "limitations"]
      : record.type === "result" ? ["observed_outcome", "evidence_reference", "limitations"] : [];
    const fields = ["id", "type", "name", "body", ...extra];
    shape(record, fields, fields, "/record");
    identifier(record.id, "/record/id");
    plainText(record.name, "/record/name");
    if (record.type === "research") plainText(record.source, "/record/source");
    for (const field of fields.filter(key => !["id", "type"].includes(key))) {
      suppliedText(record[field], `/record/${field}`);
    }
    return draft;
  }

  identifier(draft.record_id, "/record_id");
  const target = draft.context_target;
  if (target !== null) {
    if (!object(target) || !["mission", "requirements"].includes(target.kind)) {
      invalid("/context_target", "Choose null, mission or requirements as the context purpose.");
    }
    const fields = target.kind === "mission" ? ["kind"] : ["kind", "requirement_ids"];
    shape(target, fields, fields, "/context_target");
    if (target.kind === "requirements") requirementList(target.requirement_ids, "/context_target/requirement_ids");
  }
  if (Object.hasOwn(draft, "acceptance_result")) {
    const result = draft.acceptance_result;
    shape(result, ["requirement_id", "status", "notes"], ["requirement_id", "status", "notes"], "/acceptance_result");
    suppliedText(result.requirement_id, "/acceptance_result/requirement_id");
    suppliedText(result.notes, "/acceptance_result/notes");
    if (!["passed", "failed", "unverified"].includes(result.status)) {
      invalid("/acceptance_result/status", "Choose an explicit passed, failed or unverified status; a save does not establish acceptance.");
    }
  }
  if (target === null && !draft.acceptance_result) invalid("/context_target", "Select at least one context or acceptance purpose.");
  if (Object.hasOwn(draft, "initialize_continuation")) {
    const initial = draft.initialize_continuation;
    shape(initial, ["active_requirement_ids", "next_action"], ["active_requirement_ids", "next_action"], "/initialize_continuation");
    if (!Array.isArray(initial.active_requirement_ids)
      || new Set(initial.active_requirement_ids).size !== initial.active_requirement_ids.length) {
      invalid("/initialize_continuation/active_requirement_ids", "Active IDs must be a distinct array.");
    }
    initial.active_requirement_ids.forEach((entry, index) => suppliedText(entry, `/initialize_continuation/active_requirement_ids/${index}`));
    suppliedText(initial.next_action, "/initialize_continuation/next_action");
  }
  return draft;
}

export function prepareCapture(db, project, rawDraft) {
  const draft = validateCaptureDraft(rawDraft);
  const { contract, intentHash, acceptance, continuation, requirementIds } = inspectWorkIntent(db, project, draft.intent_record_id);
  const checkoutApplies = record => !record.semantics.applicability.checkout
    || sameMachinePath(record.semantics.applicability.checkout, project.checkout_root);
  if (!checkoutApplies(contract)) {
    invalid("/intent_record_id", "The selected intent belongs to another checkout.", contract.id, "invalid_intent_contract");
  }
  if (contract.availability !== "known") {
    invalid("/intent_record_id", "Inspect and correct the selected intent availability before preparing capture.", contract.id, "invalid_intent_contract");
  }
  const creating = draft.stage === "create";
  const recordId = creating ? draft.record.id : draft.record_id;
  if (recordId === contract.id) {
    invalid(creating ? "/record/id" : "/record_id", "Choose a separate record; an intent cannot link to itself.", recordId);
  }
  let input, recordRevision = null;
  const changes = [];

  if (creating) {
    if (db.prepare("SELECT id FROM records WHERE id=?").get(recordId)) {
      throw lodestarError("record_conflict", "This record ID already exists; resume by linking the existing record.", {
        identifiers: { id: recordId },
        action: `Read get -- ${recordId}, then use stage associate with the retained ID. No new record was saved.`,
      });
    }
    const fields = { ...draft.record, author: draft.author, scope: project.scope, checkout: project.checkout_root };
    const built = buildOperatorRecord(draft.record.type === "research" ? "research" : "note", fields);
    built.kind = draft.record.type === "research" ? "research" : "knowledge";
    built.semantics.context_role = "on_demand";
    if (draft.record.type === "result") {
      built.data.result = {
        observed_outcome: draft.record.observed_outcome,
        evidence_reference: draft.record.evidence_reference,
        limitations: draft.record.limitations,
      };
    }
    input = { mode: "create", record: built };
    changes.push("record");
  } else {
    const target = normalizeRecord(getRecordById(db, recordId));
    recordRevision = target.revision;
    const scopes = new Set([project.scope, ...(project.historical_scopes ?? [])]);
    const applies = scopes.has(target.scope)
      || (target.scope === "global" && scopes.has(target.semantics.applicability.project));
    const workResult = target.kind === "work-event"
      || (target.kind === "work" && text(target.data?.last_outcome?.outcome));
    if (!["knowledge", "research", "rejection"].includes(target.kind) && !workResult) {
      invalid("/record_id", "Choose ordinary knowledge, research, rejection or an existing recorded work result; system and pending records cannot be linked.", recordId);
    }
    if (!applies || !checkoutApplies(target)) {
      invalid("/record_id", "The record is outside this project or belongs to another checkout; inspect its applicability.", recordId);
    }
    if (target.semantics.retirement_reason || target.semantics.lifecycle === "superseded"
      || (target.semantics.lifecycle === "historical" && target.kind !== "work-event")) {
      invalid("/record_id", "The selected record is retired; inspect history and explicitly restore or choose another record.", recordId);
    }
    if (target.availability !== "known") {
      invalid("/record_id", "The selected record is unavailable; inspect and correct its availability.", recordId);
    }
    const selectedRequirements = [
      ...(draft.context_target?.requirement_ids ?? []).map((id, index) => [id, `/context_target/requirement_ids/${index}`]),
      ...(draft.acceptance_result ? [[draft.acceptance_result.requirement_id, "/acceptance_result/requirement_id"]] : []),
      ...(draft.initialize_continuation?.active_requirement_ids ?? []).map((id, index) => [id, `/initialize_continuation/active_requirement_ids/${index}`]),
    ];
    for (const [id, pointer] of selectedRequirements) {
      if (!requirementIds.has(id)) invalid(pointer, "The selected requirement is absent from the current intent.", id);
    }

    // put shallow-merges data members. Each changed member below is a complete
    // preserved-and-merged object, including unrelated branch associations.
    const data = {};
    if (draft.context_target !== null) {
      if (!continuation && !draft.initialize_continuation) {
        invalid("/initialize_continuation", "The first context link needs explicit active_requirement_ids and next_action; read work check and supply the intended continuation.", contract.id, "invalid_intent_contract");
      }
      if (continuation && draft.initialize_continuation) {
        invalid("/initialize_continuation", "Existing continuation must be preserved; omit initialization.", contract.id);
      }
      const merged = structuredClone(continuation ?? draft.initialize_continuation);
      merged.context ??= { version: 1, mission_record_ids: [], requirements: [] };
      if (draft.context_target.kind === "mission") {
        if (!merged.context.mission_record_ids.includes(recordId)) {
          merged.context.mission_record_ids.push(recordId);
          changes.push("continuation.context.mission_record_ids");
        }
      } else {
        for (const requirement of draft.context_target.requirement_ids) {
          let association = merged.context.requirements.find(row => row.id === requirement);
          if (!association) {
            association = { id: requirement, record_ids: [] };
            merged.context.requirements.push(association);
          }
          if (!association.record_ids.includes(recordId)) {
            association.record_ids.push(recordId);
            changes.push(`continuation.context.requirements/${requirement}`);
          }
        }
      }
      if (canonicalStringify(merged) !== canonicalStringify(continuation)) data.continuation = merged;
    } else if (draft.initialize_continuation) {
      invalid("/initialize_continuation", "Continuation initialization applies only to a first context link.", contract.id);
    }

    if (draft.acceptance_result) {
      if (acceptance && acceptance.intent_sha256 !== intentHash) {
        invalid("/data/acceptance/intent_sha256", "Acceptance names a stale intent hash; inspect the changed intent and explicitly revise acceptance before linking a result.", contract.id, "invalid_intent_contract");
      }
      const merged = structuredClone(acceptance ?? { intent_sha256: intentHash, results: [], blockers: [] });
      const supplied = draft.acceptance_result;
      const prior = merged.results.find(row => row.requirement_id === supplied.requirement_id);
      const result = {
        requirement_id: supplied.requirement_id, status: supplied.status, notes: supplied.notes,
        evidence: structuredClone(prior?.evidence ?? []),
      };
      const reference = { id: recordId, revision: target.revision, data_sha256: evidenceDataHash(target.data) };
      const referenceIndex = result.evidence.findIndex(row => row.id === recordId);
      if (referenceIndex < 0) result.evidence.push(reference);
      else result.evidence[referenceIndex] = reference;
      if (canonicalStringify(prior ?? null) !== canonicalStringify(result)) {
        const resultIndex = merged.results.findIndex(row => row.requirement_id === result.requirement_id);
        if (resultIndex < 0) merged.results.push(result);
        else merged.results[resultIndex] = result;
        data.acceptance = merged;
        changes.push(`acceptance.results/${result.requirement_id}`);
      }
    }
    input = Object.keys(data).length ? { mode: "update", id: contract.id, set: { data }, remove: [] } : null;
  }

  let basis = writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root,
    targets: [{ kind: "record", id: contract.id }, { kind: "record", id: recordId }] });
  if (input) {
    const prepared = preparePutEvidence(db, input, {
      v: 5, request_id: `prepare:${randomUUID()}`, write_basis: basis, input,
    });
    if (prepared.sourceBindings?.length) {
      basis = writeBasis(db, { projectScope: project.scope, checkout: project.checkout_root,
        targets: [...basis.targets.map(({ expected_revision, ...target }) => target),
          ...prepared.sourceBindings.map(binding => binding.target)] });
    }
  }
  const summary = !input ? "Already linked" : creating ? `Create ${draft.record.type} record`
    : `Link ${recordId}${draft.acceptance_result ? `; record ${draft.acceptance_result.status} result` : ""}`;
  return {
    version: 1, stage: draft.stage, intent_record_id: contract.id, record_id: recordId,
    operation: "put", input, write_basis: basis,
    review: { summary, intent_sha256: intentHash, intent_revision: contract.revision,
      record_revision: recordRevision, changes, noop: input === null },
    read_after: [["get", "--", creating ? recordId : contract.id],
      ["work", "check", "--cwd", project.cwd, "--", contract.id]],
  };
}
