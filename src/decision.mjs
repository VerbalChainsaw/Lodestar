import { transaction } from "./database.mjs";
import { lodestarError } from "./errors.mjs";
import { hash, normalizedRows, recordInput } from "./project.mjs";
import { getRecordById, normalizeRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision } from "./revisions.mjs";

const KEY = /^[a-z0-9][a-z0-9./-]*$/u;
const FORBIDDEN = [/-----BEGIN/iu,
  /\b(?:password|secret|access[-_ ]?token|refresh[-_ ]?token)\b/iu,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/u, /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/u];
function oneLine(value, label, maximum, required = true) {
  if (typeof value !== "string") throw lodestarError("invalid_input", `${label} must be text.`);
  const text = value.replace(/\s+/gu, " ").trim();
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
  if ((required && !text) || Buffer.byteLength(text, "utf8") > maximum || control) {
    throw lodestarError("invalid_input", `${label} is empty, unsafe, or too long.`);
  }
  if (FORBIDDEN.some((pattern) => pattern.test(text))) throw lodestarError("invalid_input",
    `${label} appears to contain secret material.`);
  return text;
}
export function normalizeDecisionKey(value) {
  const key = oneLine(value, "Decision key", 64).toLowerCase().replace(/_/gu, "-")
    .replace(/[^a-z0-9./-]+/gu, "-").replace(/^[./-]+|[./-]+$/gu, "");
  if (!KEY.test(key)) throw lodestarError("invalid_input",
    "Decision key is not stable or narrow.");
  return key;
}
function normalizeValue(value) {
  const text = oneLine(value, "Decision value", 240);
  if (/[()={}\[\];]/u.test(text)) throw lodestarError("invalid_input",
    "Decision value must be a bare canonical value; put qualifiers in --reason.");
  return text;
}
const normalizeReason = (value) => value === undefined ? ""
  : oneLine(value, "Decision reason", 240, false);
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
    const prior = current.get(event.key);
    if (event.event === "set") {
      if (prior && prior.value !== event.value) dead.push({ key: event.key,
        value: prior.value, replacement: event.value, reason: event.reason,
        event_id: event.event_id });
      current.set(event.key, { key: event.key, value: event.value,
        reason: event.reason, event_id: event.event_id });
    } else if (event.event === "drop" && prior) {
      current.delete(event.key);
      dead.push({ key: event.key, value: prior.value, replacement: null,
        reason: event.reason, event_id: event.event_id });
    }
  }
  const facts = [...current.values()].sort((left, right) => left.key.localeCompare(right.key));
  const live = new Set(facts.map(({ key, value }) => `${key}\0${value}`)), seen = new Set();
  const kept = dead.reverse().filter((item) => {
    const pair = `${item.key}\0${item.value}`, retain = !live.has(pair) && !seen.has(pair);
    if (retain) seen.add(pair);
    return retain;
  }).reverse();
  return { enabled, facts, dead: kept };
}
export function renderDecisions(state) {
  if (!state.enabled || (!state.facts.length && !state.dead.length)) return "";
  const lines = ["## FACTS", ...state.facts.map(({ key, value }) => `${key}: ${value}`)];
  if (state.dead.length) lines.push("", "## DEAD — DO NOT USE");
  for (const item of state.dead) {
    let line = `${item.key}: ${item.value} is DEAD; do not propose, use, or restore it.`;
    line += item.replacement ? ` Use ${item.replacement}.` : " It has no replacement.";
    if (item.reason) line += ` Reason: ${item.reason}.`;
    lines.push(line);
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
export function decisionSet(db, project, identity, rawKey, rawValue, options = {}) {
  const key = normalizeDecisionKey(rawKey), value = normalizeValue(rawValue);
  const prior = replayDecisions(events(db, project)).facts.find((item) => item.key === key);
  if (prior?.value === value) return { changed: false, current: prior };
  return { changed: true, record: append(db, project, identity,
    { event: "set", key, value, reason: normalizeReason(options.reason) }, options) };
}
export function decisionDrop(db, project, identity, rawKey, options = {}) {
  const key = normalizeDecisionKey(rawKey);
  const prior = replayDecisions(events(db, project)).facts.find((item) => item.key === key);
  if (!prior) return { changed: false, current: null };
  return { changed: true, record: append(db, project, identity,
    { event: "drop", key, value: null, reason: normalizeReason(options.reason) }, options) };
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
    else if (data.event !== "injection" || typeof data.enabled !== "boolean") throw new Error();
    normalizeReason(data.reason);
  } catch { invalid.push(row.id); }
  return { events: records.length, invalid, healthy: invalid.length === 0 };
}
