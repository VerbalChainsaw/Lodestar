import { transaction } from "./database.mjs";
import { safeText } from "./decision.mjs";
import { lodestarError } from "./errors.mjs";
import { hash, normalizedRows, recordInput } from "./project.mjs";
import { getRecordById, normalizeRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision } from "./revisions.mjs";

// Candidates live outside normal global/project startup scope until explicitly promoted.
// This is a semantic quarantine boundary, not a byte-budget mechanism.
export const pendingScope = (project) => `pending:${project.scope}`;

const LIST = "SELECT id FROM records WHERE type='pending' AND scope=? "
  + "ORDER BY json_extract(content_json,'$._lodestar.revision') DESC,id";

export const pendingCount = (db, project) => Number(db
  .prepare("SELECT count(*) AS count FROM records WHERE type='pending' AND scope=?")
  .get(pendingScope(project)).count);

export function pendingList(db, project, limit = null) {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
    throw lodestarError("invalid_input", "Pending limit must be a positive safe integer.");
  const records = limit === null ? normalizedRows(db, LIST, pendingScope(project))
    : normalizedRows(db, `${LIST} LIMIT ?`, pendingScope(project), limit);
  return { scope: pendingScope(project), count: pendingCount(db, project), records };
}

export function pendingAdd(db, project, identity, rawText, options = {}) {
  const text = safeText(rawText, "Pending text");
  const source = options.source === undefined
    ? "agent"
    : safeText(options.source, "Pending source");
  const now = (options.now ?? (() => new Date()))().toISOString();
  return transaction(db, () => {
    // Identical text from the same source is one candidate, so a retried or repeated
    // turn cannot flood the queue.
    const key = hash(`${source}\0${text}`, 20);
    const id = `pending:${hash(project.scope, 16)}:${key}`;
    const prior = db.prepare("SELECT id FROM records WHERE id=?").get(id);
    if (prior) return { added: false, record: normalizeRecord(getRecordById(db, id)) };
    const revision = allocateRevision(db);
    writeRecordSnapshot(db, recordInput(id, "pending", text,
      pendingScope(project), 0, { v: 1, required: false, text, source,
        actor: identity.actor, session: identity.session, captured_at: now }),
    { createdAt: now, updatedAt: now, revision });
    return { added: true, evicted: [], record: normalizeRecord(getRecordById(db, id)) };
  }, options.database);
}

function candidate(db, project, id) {
  const row = db.prepare("SELECT id,scope FROM records WHERE id=?").get(String(id));
  if (!row || row.scope !== pendingScope(project)) {
    throw lodestarError("pending_not_found", "No pending candidate with that id in this project.",
      { identifiers: { id, scope: pendingScope(project) } });
  }
  return getRecordById(db, row.id);
}

// Promotion moves the candidate into project scope and never marks it required.
export function pendingPromote(db, project, identity, id, options = {}) {
  const record = candidate(db, project, id);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const promoted = `note:${record.id.slice("pending:".length)}`;
  return transaction(db, () => {
    const value = record.content.value;
    writeRecordSnapshot(db, recordInput(promoted, "note", record.name, project.scope, 0,
      { v: 1, required: false, text: value.text, source: value.source,
        captured_at: value.captured_at, promoted_at: now, promoted_by: identity.actor }),
    { createdAt: value.captured_at ?? now, updatedAt: now, revision: allocateRevision(db) });
    // Deleted inline rather than through deleteRecord: transactions are not nestable,
    // and dependent rows cascade from the records row.
    db.prepare("DELETE FROM records WHERE id=?").run(record.id);
    return { promoted: true, id: promoted, scope: project.scope,
      record: normalizeRecord(getRecordById(db, promoted)) };
  }, options.database);
}

export function pendingDrop(db, project, id, options = {}) {
  const record = candidate(db, project, id);
  return transaction(db, () => {
    allocateRevision(db);
    db.prepare("DELETE FROM records WHERE id=?").run(record.id);
    return { dropped: true, id: record.id };
  }, options.database);
}
