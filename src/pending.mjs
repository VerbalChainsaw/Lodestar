import { transaction } from "./database.mjs";
import { safeText } from "./decision.mjs";
import { lodestarError } from "./errors.mjs";
import { hash, normalizedRows, recordInput } from "./project.mjs";
import { getRecordById, normalizeRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision } from "./revisions.mjs";

// Candidates live in a scope startup never selects. `start` reads scope IN ('global', the
// project scope), so a quarantined record costs the 16 KiB startup budget nothing until
// it is deliberately promoted. Capture can therefore be automatic and generous; only
// promotion spends budget, and only a person does that.
export const pendingScope = (project) => `pending:${project.scope}`;

const LIST = "SELECT id FROM records WHERE type='pending' AND scope=? "
  + "ORDER BY json_extract(content_json,'$._lodestar.revision') DESC,id";

export const pendingCount = (db, project) => Number(db
  .prepare("SELECT count(*) AS count FROM records WHERE type='pending' AND scope=?")
  .get(pendingScope(project)).count);

export function pendingList(db, project, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw lodestarError("invalid_input", "Pending limit must be from 1 to 200.");
  }
  return { scope: pendingScope(project), count: pendingCount(db, project),
    records: normalizedRows(db, `${LIST} LIMIT ?`, pendingScope(project), limit) };
}

export function pendingAdd(db, project, identity, rawText, options = {}) {
  const text = safeText(rawText, "Pending text", 4_096);
  const source = options.source === undefined
    ? "agent"
    : safeText(options.source, "Pending source", 64);
  const now = (options.now ?? (() => new Date()))().toISOString();
  return transaction(db, () => {
    // Identical text from the same source is one candidate, so a retried or repeated
    // turn cannot flood the queue.
    const key = hash(`${source}\0${text}`, 20);
    const id = `pending:${hash(project.scope, 16)}:${key}`;
    const prior = db.prepare("SELECT id FROM records WHERE id=?").get(id);
    if (prior) return { added: false, record: normalizeRecord(getRecordById(db, id)) };
    const revision = allocateRevision(db);
    writeRecordSnapshot(db, recordInput(id, "pending", text.slice(0, 120),
      pendingScope(project), 0, { v: 1, required: false, text, source,
        actor: identity.actor, session: identity.session, captured_at: now }),
    { createdAt: now, updatedAt: now, revision });
    return { added: true, record: normalizeRecord(getRecordById(db, id)) };
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

// Promotion moves the candidate into project scope and never marks it required, so it
// becomes findable by `get`/`find` without enlarging what every session must carry.
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
