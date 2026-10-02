import { checkWorkEvidence, inspectWorkIntent } from "./work-evidence.mjs";
import { workStatus } from "./work.mjs";
import { pendingList } from "./pending.mjs";
import { normalizedForRows } from "./queries.mjs";

// All callers admit this projection inside one read transaction. Recovery is a
// separate journal observation owned by the interface, never part of this DB view.
export function projectAttention(db, project, intentId = null) {
  const scopes = [...new Set([project.scope, ...(project.historical_scopes ?? [])])];
  const slots = scopes.map(() => "?").join(",");
  const inventory = normalizedForRows(db, db.prepare("SELECT * FROM records WHERE type='knowledge' AND scope IN ("
    + slots + ") ORDER BY id").all(...scopes));
  const intents = [];
  for (const record of inventory.records) {
    if (record.data?.intent === undefined || record.semantics.lifecycle !== "current") continue;
    try {
      // Selection uses the same persisted contract as work check and capture.
      inspectWorkIntent(db, project, record.id);
      intents.push(record);
    } catch (error) {
      if (error.code !== "invalid_intent_contract") throw error;
      inventory.record_errors.push({ code: error.code, message: error.message,
        identifiers: { ...error.identifiers, id: record.id, raw_read_args: ["get", "--", record.id] },
        action: error.action });
    }
  }
  const reads = [];
  const scoped = ["--cwd", project.cwd];
  const checkArgs = ["work", "check", ...scoped, ...(intentId ? ["--", intentId] : [])];
  const inventoryReads = scopes.map(scope => ["find", "--all", "--scope", scope, "--kind", "knowledge"]);
  const inventoryArgs = inventoryReads.length === 1 ? inventoryReads[0] : inventoryReads;
  const section = (items, issues, readArgs, more = false, complete = true) => ({
    state: complete && !more ? "observed" : "partial",
    complete: complete && !more, more, items, issues, read_args: readArgs,
  });

  const work = workStatus(db, project);
  const pending = pendingList(db, project);
  const sections = {
    work: section(work.records.slice(0, 50), work.record_errors,
      ["work", "status", ...scoped], work.records.length > 50, work.complete),
    pending: section(pending.records.slice(0, 50), pending.record_errors,
      ["pending", "list", ...scoped], pending.records.length > 50, pending.complete),
  };
  sections.work.omitted_count = Math.max(0, work.records.length - 50);
  sections.pending.omitted_count = Math.max(0, pending.records.length - 50);

  if (!intentId) {
    const missing = {
      state: "not_selected", complete: false, more: false, items: [],
      issues: [{ code: "intent_not_selected", message: "Select an intent to inspect recorded acceptance and context.",
        action: "Choose one exact intent record ID and refresh Project attention." }],
      read_args: inventoryArgs,
    };
    sections.acceptance = structuredClone(missing);
    sections.context = structuredClone(missing);
  } else {
    try {
      const checked = checkWorkEvidence(db, project, intentId);
      const context = checked.continuity;
      // Recorded failed/unverified assertions are findings in an observed read.
      // Coverage follows the owner's read completeness, separately from status.
      sections.acceptance = section(checked.delta.requirements,
        [...checked.issues, ...checked.record_errors], checkArgs, false, checked.complete);
      sections.context = section([...context.records, ...context.decisions],
        context.issues, checkArgs, context.truncated, context.complete);
      reads.push(...context.read_required);
    } catch (error) {
      // Store/schema/boundary failures retain whole-read admission semantics.
      if (!["invalid_intent_contract", "record_not_found", "record_requires_source_correction", "corrupt_record"].includes(error.code)) throw error;
      const issue = { code: error.code, message: error.message, action: error.action,
        identifiers: error.identifiers ?? { id: intentId } };
      const unavailable = { state: "unavailable", complete: false, more: false,
        items: [], issues: [issue], read_args: checkArgs };
      sections.acceptance = structuredClone(unavailable);
      sections.context = structuredClone(unavailable);
      reads.push({ target_id: intentId, code: error.code, action: error.action,
        read_args: ["get", "--", intentId] });
    }
  }

  for (const observed of Object.values(sections)) {
    if (!observed.complete) reads.push({ code: "attention_section_incomplete",
      action: "Run the exact full section read before relying on omitted or unresolved items.",
      read_args: observed.read_args });
  }
  const inventoryMore = intents.length > 20;
  if (inventoryMore || inventory.record_errors.length) {
    reads.push({ code: "attention_intent_inventory_incomplete",
      action: "Inspect the full project knowledge inventory and named raw records before choosing an intent.",
      read_args: inventoryArgs });
  }
  for (const error of [...inventory.record_errors, ...work.record_errors, ...pending.record_errors]) {
    const id = error.identifiers?.id ?? error.id;
    if (id) reads.push({ target_id: id, code: error.code,
      action: error.action ?? "Inspect the named raw record and correct its source before relying on this section.",
      read_args: error.identifiers?.raw_read_args ?? ["get", "--raw", "--", id] });
  }
  return {
    version: 1, project,
    intents: intents.slice(0, 20).map(record => ({ id: record.id, name: record.name, revision: record.revision })),
    selected_intent_id: intentId, sections,
    complete: !inventoryMore && inventory.record_errors.length === 0
      && Object.values(sections).every(observed => observed.complete),
    read_required: reads,
    intent_inventory: { complete: !inventoryMore && inventory.record_errors.length === 0,
      more: inventoryMore, omitted_count: Math.max(0, intents.length - 20),
      issues: inventory.record_errors, read_args: inventoryArgs },
  };
}
