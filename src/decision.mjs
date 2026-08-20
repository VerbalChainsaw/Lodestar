import { transaction } from "./database.mjs";
import { lodestarError } from "./errors.mjs";
import { formatMarker } from "./markers.mjs";
import { hash, normalizedRows, recordInput } from "./project.mjs";
import { getRecordById, normalizeRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision } from "./revisions.mjs";

const KEY = /^[a-z0-9][a-z0-9./-]*$/u;
const FORBIDDEN = [/-----BEGIN/iu,
  /\b(?:password|secret|access[-_ ]?token|refresh[-_ ]?token)\b/iu,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/u, /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/u];
// Shared so every capture path rejects control characters and obvious secret material
// on the same terms, rather than each surface inventing its own guard.
export const safeText = (value, label) => oneLine(value, label);

function oneLine(value, label, required = true) {
  if (typeof value !== "string") throw lodestarError("invalid_input", `${label} must be text.`);
  const text = value.replace(/\s+/gu, " ").trim();
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
  if ((required && !text) || control) {
    throw lodestarError("invalid_input", `${label} is empty or unsafe.`);
  }
  if (FORBIDDEN.some((pattern) => pattern.test(text))) throw lodestarError("invalid_input",
    `${label} appears to contain secret material.`);
  return text;
}
export function normalizeDecisionKey(value) {
  const key = oneLine(value, "Decision key").toLowerCase().replace(/_/gu, "-")
    .replace(/[^a-z0-9./-]+/gu, "-").replace(/^[./-]+|[./-]+$/gu, "");
  if (!KEY.test(key)) throw lodestarError("invalid_input",
    "Decision key is not stable or narrow.");
  return key;
}
function normalizeValue(value) {
  const text = oneLine(value, "Decision value");
  if (/[()={}\[\];]/u.test(text)) throw lodestarError("invalid_input",
    "Decision value must be a bare canonical value; put qualifiers in --reason.");
  return text;
}
const normalizeReason = (value) => value === undefined ? ""
  : oneLine(value, "Decision reason", false);
const DECISION_STATUSES = Object.freeze(["accepted", "blocked"]);
function normalizeStatus(value) {
  if (value === undefined) return "accepted";
  const status = oneLine(value, "Decision status").toLowerCase();
  if (!DECISION_STATUSES.includes(status)) throw lodestarError("invalid_input",
    "Decision status must be accepted or blocked.");
  return status;
}
// A direct CLI write is the Director acting; a hook-captured marker is the agent.
// Director-issued kills stay closed unless that same session revives them;
// agent-issued kills reopen by evidence (any later set).
const DECISION_AUTHORITIES = Object.freeze(["director", "agent"]);
function normalizeAuthority(value) {
  if (value === undefined) return "director";
  const authority = oneLine(value, "Decision authority").toLowerCase();
  if (!DECISION_AUTHORITIES.includes(authority)) throw lodestarError("invalid_input",
    "Decision authority must be director or agent.");
  return authority;
}
function events(db, project) {
  return normalizedRows(db, "SELECT id FROM records WHERE type='decision-event' AND scope=? "
    + "ORDER BY json_extract(content_json,'$._lodestar.revision'),id", project.scope)
    .map(({ data }) => data);
}
export function replayDecisions(history) {
  const current = new Map(), dead = [];
  let enabled = true;
  for (const event of history) {
    if (event.event === "injection") {
      enabled = event.enabled;
      continue;
    }
    if (event.event === "status") {
      const prior = current.get(event.key);
      if (prior) current.set(event.key, { ...prior, status: normalizeStatus(event.status),
        reason: event.reason ?? prior.reason, event_id: event.event_id });
      continue;
    }
    const prior = current.get(event.key);
    if (event.event === "set") {
      if (prior && prior.value !== event.value) dead.push({ key: event.key,
        value: prior.value, replacement: event.value, reason: event.reason,
        event_id: event.event_id, date: String(event.recorded_at ?? "").slice(0, 10),
        authority: event.authority ?? "agent", killed_by_session: event.session ?? null });
      current.set(event.key, { key: event.key, value: event.value,
        reason: event.reason, event_id: event.event_id,
        status: normalizeStatus(event.status),
        date: String(event.recorded_at ?? "").slice(0, 10) });
    } else if (event.event === "drop" && prior) {
      current.delete(event.key);
      dead.push({ key: event.key, value: prior.value, replacement: null,
        successor: event.successor ?? null, reason: event.reason,
        event_id: event.event_id, date: String(event.recorded_at ?? "").slice(0, 10),
        authority: event.authority ?? "agent", killed_by_session: event.session ?? null });
    }
  }
  const facts = [...current.values()].filter(({ status }) => status !== "blocked")
    .sort((left, right) => left.key.localeCompare(right.key));
  const blocked = [...current.values()].filter(({ status }) => status === "blocked")
    .sort((left, right) => left.key.localeCompare(right.key));
  const live = new Set([...facts, ...blocked].map(({ key, value }) => `${key}\0${value}`)),
    seen = new Set();
  const kept = dead.reverse().filter((item) => {
    const pair = `${item.key}\0${item.value}`, retain = !live.has(pair) && !seen.has(pair);
    if (retain) seen.add(pair);
    return retain;
  }).reverse();
  return { enabled, facts, blocked, dead: kept };
}
export function renderDecisions(state) {
  if (!state.enabled || (!state.facts.length && !state.blocked.length && !state.dead.length))
    return "";
  const lines = ["## FACTS"];
  for (const fact of state.facts) lines.push(formatMarker("DECISION",
    { key: fact.key, status: (fact.status ?? "accepted").toUpperCase(), value: fact.value,
      date: fact.date, reason: fact.reason }));
  if (state.blocked.length) {
    lines.push("", "## BLOCKED");
    for (const item of state.blocked) lines.push(formatMarker("DECISION",
      { key: item.key, status: "BLOCKED", value: item.value, date: item.date,
        reason: item.reason }));
  }
  if (state.dead.length) {
    lines.push("", "## DEAD — DO NOT USE");
    for (const item of state.dead) {
      // The marker is the machine form; the negation sentence is the product. DEAD is
      // the power-word: name the old value, prohibit its reuse, name the replacement
      // (or state there is none), and keep the reason that closes the record. A
      // Director-issued kill carries reopen=director: only that session may revive it.
      const reopen = item.authority === "director" ? { reopen: "director" } : {};
      // A kill names its successor when it has one: a replaced value (by=key) or a
      // captured SUPERSEDED marker's by= key. Only a kill with no successor is a DEAD.
      const successor = item.replacement ? item.key : item.successor ?? null;
      if (successor) {
        lines.push(formatMarker("SUPERSEDED",
          { key: item.key, by: successor, value: item.value, date: item.date,
            reason: item.reason, ...reopen }));
        let sentence = `${item.value} is DEAD; do not propose, use, or restore it.`;
        // A replaced value names its replacement value; a captured SUPERSEDED kill
        // names its successor key.
        sentence += item.replacement
          ? ` Use ${item.replacement}.`
          : ` Use ${item.successor}.`;
        if (item.reason) sentence += ` Reason: ${item.reason}.`;
        lines.push(sentence);
      } else {
        lines.push(formatMarker("DEAD", { key: item.key, value: item.value,
          date: item.date, reason: item.reason, ...reopen }));
        let sentence = `${item.value} is DEAD; do not propose, use, or restore it.`;
        sentence += " It has no replacement.";
        if (item.reason) sentence += ` Reason: ${item.reason}.`;
        lines.push(sentence);
      }
    }
  }
  return lines.join("\n");
}
export function decisionProjection(db, project) {
  const state = replayDecisions(events(db, project));
  return { ...state, projection: renderDecisions(state) };
}
function append(db, project, identity, data, options) {
  const now = (options.now ?? (() => new Date()))().toISOString();
  return transaction(db, () => {
    const revision = allocateRevision(db);
    const id = `decision:${hash(project.scope, 16)}:${revision}`;
    writeRecordSnapshot(db, recordInput(id, "decision-event", `Decision event ${revision}`,
      project.scope, 900, { v: 1, event_id: id, actor: identity.actor,
        session: identity.session, recorded_at: now, ...data }),
    { createdAt: now, updatedAt: now, revision });
    return normalizeRecord(getRecordById(db, id));
  }, options.database);
}
// The current value of a key may be an accepted fact or a blocked one; a status,
// replacement, or drop must see both or a blocked decision becomes unreachable.
function decisionState(db, project) {
  const state = replayDecisions(events(db, project));
  return { prior: [...state.facts, ...state.blocked], dead: state.dead };
}
export function decisionSet(db, project, identity, rawKey, rawValue, options = {}) {
  const key = normalizeDecisionKey(rawKey), value = normalizeValue(rawValue);
  const status = normalizeStatus(options.status);
  const state = decisionState(db, project);
  const prior = state.prior.find((item) => item.key === key) ?? null;
  if (prior?.value === value && (prior.status ?? "accepted") === status)
    return { changed: false, current: prior };
  // DEAD is the power-word: a Director-issued kill stays closed. Only the session
  // that issued the kill may revive the same value; agent-issued kills reopen by
  // evidence, and old kills without authority replay as agent-issued.
  const deadMatch = state.dead.find((item) => item.key === key && item.value === value);
  if (deadMatch?.authority === "director"
      && deadMatch.killed_by_session !== identity.session) {
    throw lodestarError("dead_decision_revival",
      `Decision "${key}" value "${value}" was killed by the Director and is closed to revival.`,
      {
        identifiers: { key, value, killer_session: deadMatch.killed_by_session },
        action: "Only the session that issued the kill may revive it. Use decision set "
          + "from that session, or choose a replacement value.",
      },
    );
  }
  return { changed: true, record: append(db, project, identity,
    { event: "set", key, value, reason: normalizeReason(options.reason),
      authority: normalizeAuthority(options.authority),
      ...(status !== "accepted" ? { status } : {}) }, options) };
}
export function decisionStatus(db, project, identity, rawKey, rawState, options = {}) {
  const key = normalizeDecisionKey(rawKey), status = normalizeStatus(rawState);
  const prior = decisionState(db, project).prior.find((item) => item.key === key) ?? null;
  if (!prior) return { changed: false, current: null };
  if ((prior.status ?? "accepted") === status) return { changed: false, current: prior };
  return { changed: true, record: append(db, project, identity,
    { event: "status", key, value: null, status,
      reason: normalizeReason(options.reason) }, options) };
}
export function decisionDrop(db, project, identity, rawKey, options = {}) {
  const key = normalizeDecisionKey(rawKey);
  const prior = decisionState(db, project).prior.find((item) => item.key === key) ?? null;
  if (!prior) return { changed: false, current: null };
  const successor = options.successor === undefined || options.successor === null
    || options.successor === "" ? null : normalizeDecisionKey(options.successor);
  return { changed: true, record: append(db, project, identity,
    { event: "drop", key, value: null, reason: normalizeReason(options.reason),
      authority: normalizeAuthority(options.authority),
      ...(successor ? { successor } : {}) }, options) };
}
export function decisionInjection(db, project, identity, enabled, options = {}) {
  if (typeof enabled !== "boolean") throw lodestarError("invalid_input",
    "Injection state is invalid.");
  if (replayDecisions(events(db, project)).enabled === enabled) return { changed: false, enabled };
  return { changed: true, record: append(db, project, identity,
    { event: "injection", enabled, reason: normalizeReason(options.reason) }, options) };
}
export function diagnoseDecisions(db) {
  const records = db.prepare("SELECT id,content_json FROM records "
    + "WHERE type='decision-event' ORDER BY id").all(), invalid = [];
  for (const row of records) try {
    const data = JSON.parse(row.content_json).value;
    if (data.event === "set") normalizeValue(data.value);
    if (["set", "drop"].includes(data.event)) normalizeDecisionKey(data.key);
    else if (data.event === "status") {
      normalizeDecisionKey(data.key);
      normalizeStatus(data.status);
    } else if (data.event !== "injection" || typeof data.enabled !== "boolean") {
      throw new Error();
    }
    if (data.status !== undefined) normalizeStatus(data.status);
    if (data.authority !== undefined) normalizeAuthority(data.authority);
    if (data.successor !== undefined && data.successor !== null) {
      normalizeDecisionKey(data.successor);
    }
    normalizeReason(data.reason);
  } catch { invalid.push(row.id); }
  return { events: records.length, invalid, healthy: invalid.length === 0 };
}