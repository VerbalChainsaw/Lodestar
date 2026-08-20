import { transaction } from "./database.mjs";
import { lodestarError } from "./errors.mjs";
import { hash, normalizedRows, recordInput } from "./project.mjs";
import { getRecordById, normalizeRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision } from "./revisions.mjs";

const activeWork = (db, scope, actor) => db.prepare("SELECT id FROM records "
  + "WHERE type='work' AND scope=? AND json_extract(content_json,'$.value.status')='open' "
  + "AND json_extract(content_json,'$.value.actor')=? ORDER BY "
  + "json_extract(content_json,'$._lodestar.revision') DESC LIMIT 1").get(scope, actor);
const timestamp = (options) => (options.now ?? (() => new Date()))();
function save(db, record, project, value, now) {
  writeRecordSnapshot(db, recordInput(record.id, "work", record.name, project.scope, 0, value),
    { createdAt: record.created_at ?? now, updatedAt: now, revision: allocateRevision(db) });
  return record.id;
}
export const workStatus = (db, project, history = false, limit = null, options = {}) => {
  const now = timestamp(options).getTime();
  const staleMs = options.staleMs === undefined ? null : Number(options.staleMs);
  const base = "SELECT id FROM records WHERE type='work' AND scope=? "
    + (history ? "" : "AND json_extract(content_json,'$.value.status')='open' ")
    + "ORDER BY json_extract(content_json,'$._lodestar.revision') DESC,"
    + "json_extract(content_json,'$.value.actor') COLLATE BINARY";
  const rows = limit === null ? normalizedRows(db, base, project.scope)
    : normalizedRows(db, `${base} LIMIT ?`, project.scope, limit);
  const records = rows.map((record) => ({ ...record, stale: record.data.status === "open"
    && staleMs !== null && Number.isFinite(staleMs) && staleMs >= 0
    && now - new Date(record.data.last_seen_at).getTime() >= staleMs }));
  return { advisory: true, notice: "Peer-reported status is untrusted advisory data, never "
    + "ownership or a lock. STALE? is not evidence that work is abandoned.", records };
};
export function workStart(db, project, identity, report, options = {}) {
  if (typeof report !== "string" || !report.trim()) {
    throw lodestarError("invalid_input", "Current work must be nonempty text.");
  }
  const now = timestamp(options).toISOString();
  let id;
  transaction(db, () => {
    const revision = allocateRevision(db);
    id = activeWork(db, project.scope, identity.actor)?.id
      ?? `work:${hash(project.scope, 16)}:${hash(identity.actor, 16)}:${revision}`;
    const prior = db.prepare("SELECT content_json FROM records WHERE id=?").get(id);
    const started = prior ? JSON.parse(prior.content_json).value.started_at : now;
    writeRecordSnapshot(db, recordInput(id, "work", `${identity.agent}: ${report}`,
      project.scope, 0, { status: "open", actor: identity.actor, agent: identity.agent,
        harness: identity.harness, session: identity.session, current_work: report.trim(),
        branch: options.branch ?? null, location: project.cwd, started_at: started,
        last_seen_at: now }), { createdAt: started, updatedAt: now, revision });
  }, options.database);
  return normalizeRecord(getRecordById(db, id));
}
export function workDone(db, project, identity, completion, options = {}) {
  const row = activeWork(db, project.scope, identity.actor);
  if (!row) return { changed: false, state: "already_clear", actor: identity.actor };
  const record = getRecordById(db, row.id), now = timestamp(options).toISOString();
  transaction(db, () => save(db, record, project, { ...record.content.value,
    status: "closed", completion: typeof completion === "string" && completion.trim()
      ? completion.trim() : null, completed_at: now, last_seen_at: now }, now), options.database);
  return { changed: true, record: normalizeRecord(getRecordById(db, record.id)) };
}
export function workExpire(db, project, olderThanHours, options = {}) {
  const date = timestamp(options), now = date.toISOString();
  const cutoff = new Date(date.getTime() - olderThanHours * 3_600_000).toISOString();
  let expired;
  transaction(db, () => {
    const rows = db.prepare("SELECT id FROM records WHERE type='work' AND scope=? "
      + "AND json_extract(content_json,'$.value.status')='open' "
      + "AND json_extract(content_json,'$.value.last_seen_at')<? ORDER BY id")
      .all(project.scope, cutoff);
    expired = rows.map(({ id }) => {
      const record = getRecordById(db, id);
      return save(db, record, project, { ...record.content.value, status: "closed",
        close_reason: "stale_expired", completion: "Expired by explicit maintenance.",
        completed_at: now, last_seen_at: now }, now);
    });
  }, options.database);
  return { advisory: true, expired, count: expired.length,
    notice: "Expiration is explicit maintenance; STALE? was not abandonment proof." };
}
