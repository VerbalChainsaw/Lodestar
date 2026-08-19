import { createHash } from "node:crypto";

import { transaction } from "./database.mjs";
import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { hash, recordInput } from "./project.mjs";
import { getRecordById, normalizeRecord, writeRecordSnapshot } from "./records.mjs";
import { allocateRevision } from "./revisions.mjs";

const STATES = new Set(["fact", "trap", "ask", "unsure", "dead"]);
const PROVENANCE = new Set(["user", "tool", "repo", "agent", "decision"]);
export const HANDOFF_ENTRY_KEY_PATTERN = "^[a-z0-9][a-z0-9.-]*$";
const HANDOFF_ENTRY_KEY = new RegExp(HANDOFF_ENTRY_KEY_PATTERN, "u");
const SECRET_FIELD = /(?:^|[-_])(?:api[-_]?key|authorization|credential|password|secret|token)/iu;
const SECRET_TEXT = [
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,})\b/gu,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
  new RegExp(
    "\\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*\\s*=\\s*)"
      + "(?:\"[^\"]*\"|'[^']*'|\\S+)",
    "giu",
  ),
];
const PACKET_BYTES = 64 * 1024;
const TAIL_ITEMS = 12;
const TAIL_TEXT_BYTES = 4 * 1024;

const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

function safe(value, label, maximum = 16_384) {
  if (typeof value !== "string" || !value.trim()
      || Buffer.byteLength(value, "utf8") > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw lodestarError("invalid_input", `Invalid ${label}.`);
  }
  return value;
}

function finite(value) {
  try { return Number.isFinite(Buffer.byteLength(canonicalStringify(value), "utf8")); }
  catch { return false; }
}
function entryError(index, field, message, identifiers = {}) {
  return lodestarError("invalid_input", `Handoff packet entry ${index} ${message}.`, {
    identifiers: { entry: index, ...(field ? { field } : {}), ...identifiers },
  });
}
export function redactHandoff(value, report = { count: 0, categories: new Set() }) {
  if (typeof value === "string") {
    let text = value;
    for (const pattern of SECRET_TEXT) text = text.replace(pattern, (...match) => {
      report.count += 1;
      report.categories.add("secret-text");
      return match[1] ? `${match[1]}[REDACTED]` : "[REDACTED]";
    });
    return { value: text, report };
  }
  if (Array.isArray(value)) {
    return { value: value.map((item) => redactHandoff(item, report).value), report };
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return { value: Object.fromEntries(Object.entries(value).map(([field, item]) => {
      if (SECRET_FIELD.test(field) && typeof item === "string") {
        report.count += 1;
        report.categories.add("secret-field");
        return [field, "[REDACTED]"];
      }
      return [field, redactHandoff(item, report).value];
    })), report };
  }
  return { value, report };
}

function semantic(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) {
    throw lodestarError("invalid_input", "A handoff packet object is required.");
  }
  safe(input.goal, "packet.goal", 4_096);
  safe(input.nextMove, "packet.nextMove", 16_384);
  if (!Array.isArray(input.rules) || input.rules.length > 10) {
    throw lodestarError("invalid_input", "packet.rules must contain at most ten rules.");
  }
  for (const rule of input.rules) safe(rule, "packet.rules", 4_096);
  if (!Array.isArray(input.entries) || input.entries.length > 35) {
    throw lodestarError("invalid_input", "packet.entries must contain at most 35 entries.");
  }
  if (!input.work || Object.getPrototypeOf(input.work) !== Object.prototype
      || !finite(input.work) || !Array.isArray(input.evidence)
      || input.evidence.length > 50 || !finite(input.evidence)) {
    throw lodestarError("invalid_input", "packet.work or packet.evidence is invalid.");
  }
  const keys = new Set();
  for (const [index, entry] of input.entries.entries()) {
    if (!entry || Object.getPrototypeOf(entry) !== Object.prototype) {
      throw entryError(index, null, "must be an object");
    }
    if (typeof entry.key !== "string" || !HANDOFF_ENTRY_KEY.test(entry.key)) {
      throw entryError(index, "key", `key is invalid; entry keys must match `
        + HANDOFF_ENTRY_KEY_PATTERN, { pattern: HANDOFF_ENTRY_KEY_PATTERN });
    }
    if (keys.has(entry.key)) {
      throw entryError(index, "key", `duplicates key ${entry.key}`, { key: entry.key });
    }
    if (!STATES.has(entry.state) || !Number.isInteger(entry.generation)
        || entry.generation < 0 || !Array.isArray(entry.scope) || entry.scope.length > 10
        || !entry.provenance || Object.getPrototypeOf(entry.provenance) !== Object.prototype
        || !PROVENANCE.has(entry.provenance.kind)) {
      throw entryError(index, null, "is invalid");
    }
    keys.add(entry.key);
    safe(entry.text, `entry ${entry.key}`, 8_192);
    safe(entry.provenance.sourceRef, `entry ${entry.key} provenance`, 4_096);
    safe(entry.provenance.observedAt, `entry ${entry.key} timestamp`, 100);
    if (entry.state === "dead") {
      const evidence = input.evidence.find((item) => item
        && Object.getPrototypeOf(item) === Object.prototype
        && item.key === `dead:${entry.key}`
        && item.sourceRef === entry.provenance.sourceRef
        && ["user", "decision"].includes(item.kind));
      if (!evidence) throw lodestarError("invalid_input",
        `Dead entry ${entry.key} requires matching auditable evidence.`);
    }
  }
  const copy = structuredClone(input);
  const bytes = Buffer.byteLength(canonicalStringify(copy), "utf8");
  if (bytes > PACKET_BYTES) throw lodestarError("resource_limit",
    "The semantic handoff packet exceeds its byte limit.",
    { identifiers: { bytes, maximum: PACKET_BYTES } });
  return copy;
}

export function validateHandoffTransition(previous, next) {
  if (!previous) return next;
  const prior = new Map(previous.entries.map((entry) => [entry.key, entry]));
  const current = new Map(next.entries.map((entry) => [entry.key, entry]));
  for (const [key, entry] of prior) {
    const replacement = current.get(key);
    if (!replacement) throw lodestarError("invalid_input", `Handoff entry ${key} was omitted.`);
    if (canonicalStringify(entry) === canonicalStringify(replacement)) continue;
    if (replacement.generation !== entry.generation + 1
        || replacement.provenance.observedAt === entry.provenance.observedAt) {
      throw lodestarError("invalid_input", `Handoff entry ${key} lacks a fresh generation.`);
    }
    if (entry.state === "dead" && replacement.state !== "dead") {
      throw lodestarError("invalid_input", `Dead handoff entry ${key} cannot resurrect.`);
    }
  }
  return next;
}

export const validateHandoff = (input) => ({ valid: true, packet: semantic(input) });

const laneId = (project, session) => `handoff-lane:${hash(project.scope, 16)}:${hash(session, 16)}`;
const stateId = (project) => `handoff-state:${hash(project.scope, 24)}`;
const packetRecordId = (packetId) => `handoff-packet:${hash(packetId, 40)}`;
const tailId = (project, session, turn, role) =>
  `handoff-tail:${hash(`${project.scope}\0${session}\0${turn}\0${role}`, 40)}`;

function optionalRecord(db, id) {
  const row = db.prepare("SELECT id FROM records WHERE id=?").get(id);
  return row ? normalizeRecord(getRecordById(db, row.id)) : null;
}

const value = (record) => record?.data ?? null;
const packetById = (db, id) => id ? value(optionalRecord(db, packetRecordId(id)))?.packet : null;

function activeRecovery(db, project) {
  const pointer = value(optionalRecord(db, stateId(project)));
  return pointer?.active_recovery_id ? optionalRecord(db, pointer.active_recovery_id) : null;
}

function lane(db, project, identity) {
  return identity.session ? optionalRecord(db, laneId(project, identity.session)) : null;
}

function tailSince(db, project, identity, revision) {
  const all = db.prepare("SELECT id FROM records WHERE type='handoff-tail' AND scope=? "
    + "AND json_extract(content_json,'$.value.session')=? "
    + "AND json_extract(content_json,'$._lodestar.revision')>? "
    + "ORDER BY json_extract(content_json,'$._lodestar.revision'),id")
    .all(project.scope, identity.session, revision).map(({ id }) => optionalRecord(db, id));
  const selected = all.slice(-TAIL_ITEMS);
  return { items: selected.map((record) => ({ role: record.data.role,
    text: record.data.text, observed_at: record.data.observed_at,
    event_id: record.id })), omitted: all.length - selected.length,
  cursor: all.at(-1)?.revision ?? revision };
}

function packetDigest(packet) {
  const copy = structuredClone(packet);
  copy.integrity.digest = "";
  return sha(canonicalStringify(copy));
}

export function createHandoffPacket(project, identity, input, previous, tail, now) {
  const redacted = redactHandoff(semantic(input));
  const next = validateHandoffTransition(previous, redacted.value);
  const semanticDigest = sha(canonicalStringify(next));
  const generation = Number(previous?.generation ?? 0) + 1;
  const id = `HOF-${sha(`${project.scope}\0${identity.session}\0${generation}\0`
    + `${previous?.id ?? ""}\0${semanticDigest}\0${tail.cursor}`).slice(0, 40)}`;
  const packet = {
    format: "lodestar-handoff/v1", id, generation,
    predecessor: previous?.id ?? null, project: project.scope,
    source: { session: identity.session, actor: identity.actor, cwd: project.cwd },
    ...next, recentTail: tail, semantic_digest: semanticDigest,
    integrity: { algorithm: "sha256", digest: "", schema_version: 1,
      created_at: now, redaction: { count: redacted.report.count,
        categories: [...redacted.report.categories].sort() } },
  };
  packet.integrity.digest = packetDigest(packet);
  return packet;
}

export function validateStoredHandoffPacket(packet) {
  if (!packet || packet.format !== "lodestar-handoff/v1"
      || !/^HOF-[a-f0-9]{40}$/u.test(packet.id) || packet.integrity?.algorithm !== "sha256"
      || packet.integrity?.schema_version !== 1
      || packet.integrity.digest !== packetDigest(packet)) {
    throw lodestarError("database_integrity", "A stored Lodestar handoff packet is invalid.");
  }
  semantic(packet);
  return packet;
}

function write(db, input, revision, now) {
  return writeRecordSnapshot(db, input, { createdAt: now, updatedAt: now, revision });
}

function persistPacket(db, project, packet, revision, now) {
  const id = packetRecordId(packet.id), existing = optionalRecord(db, id);
  if (existing) {
    validateStoredHandoffPacket(existing.data.packet);
    if (canonicalStringify(existing.data.packet) !== canonicalStringify(packet)) {
      throw lodestarError("handoff_conflict", "A handoff packet ID has conflicting content.");
    }
    return existing;
  }
  write(db, recordInput(id, "handoff-packet", `Handoff packet ${packet.id}`,
    project.scope, 1000, { packet }), revision, now);
  return optionalRecord(db, id);
}

function persistLane(db, project, identity, data, revision, now, createdAt = now) {
  const id = laneId(project, identity.session);
  writeRecordSnapshot(db, recordInput(id, "handoff-lane",
    `Lodestar continuity lane for ${identity.actor}`, project.scope, 1000, data),
  { createdAt, updatedAt: now, revision });
  return optionalRecord(db, id);
}

export function handoffArm(db, project, identity, input, options = {}) {
  const now = (options.now ?? (() => new Date()))().toISOString();
  let result;
  transaction(db, () => {
    const owned = lane(db, project, identity), prior = packetById(db, owned?.data.active_packet_id);
    if (owned?.data.state === "armed") {
      if (prior?.semantic_digest === sha(canonicalStringify(semantic(input)))) {
        result = { changed: false, lane: owned, packet: prior };
        return;
      }
      // Naming the exit matters more here than the refusal does. An agent that reads
      // only "already armed" concludes the lane is unusable and stops asking Lodestar.
      throw lodestarError("handoff_conflict", "This session already owns an armed lane.", {
        identifiers: { lane: owned.id, packet: prior?.id ?? null },
        action: "Use handoff checkpoint to update the armed packet, or handoff disarm "
          + "to retire the lane first.",
      });
    }
    const revision = allocateRevision(db), tail = { items: [], omitted: 0, cursor: revision };
    const packet = createHandoffPacket(project, identity, input, prior, tail, now);
    persistPacket(db, project, packet, revision, now);
    const updated = persistLane(db, project, identity, { state: "armed",
      project: project.scope, owner_session: identity.session,
      active_packet_id: packet.id, tail_cursor: tail.cursor,
      generation: Number(owned?.data.generation ?? 0) + 1,
    }, revision, now, owned?.updated_at ?? now);
    result = { changed: true, lane: updated, packet };
  }, options.database);
  return result;
}

export function handoffTail(db, project, identity, role, turn, text, options = {}) {
  if (!["user", "assistant"].includes(role)) {
    throw lodestarError("invalid_input", "Handoff tail role must be user or assistant.");
  }
  safe(turn, "turn", 256);
  const owned = lane(db, project, identity);
  if (owned?.data.state !== "armed") return { captured: false };
  const clipped = Array.from(safe(text, "tail text", 64 * 1024))
    .slice(-TAIL_TEXT_BYTES).join("");
  const redacted = redactHandoff(clipped), id = tailId(project, identity.session, turn, role);
  const now = (options.now ?? (() => new Date()))().toISOString();
  let result;
  transaction(db, () => {
    const existing = optionalRecord(db, id);
    if (existing) {
      if (existing.data.text !== redacted.value) {
        throw lodestarError("handoff_replay",
          "A handoff tail event was replayed with new content.");
      }
      result = { captured: true, repeated: true, record: existing };
      return;
    }
    const revision = allocateRevision(db);
    write(db, recordInput(id, "handoff-tail", `Handoff ${role} tail`, project.scope, 0, {
      role, text: redacted.value, session: identity.session, turn,
      observed_at: now, redaction: { count: redacted.report.count,
        categories: [...redacted.report.categories].sort() },
    }), revision, now);
    result = { captured: true, repeated: false, record: optionalRecord(db, id) };
  }, options.database);
  return result;
}

function updateLanePacket(db, project, identity, input, options, operation) {
  const now = (options.now ?? (() => new Date()))().toISOString();
  let result;
  transaction(db, () => {
    const owned = lane(db, project, identity);
    if (owned?.data.state !== "armed") {
      throw lodestarError("handoff_not_armed", "This session does not own an armed lane.", {
        identifiers: { project: project.scope, session: identity.session },
        action: "Use handoff arm to open a lane for this session, or handoff now to "
          + "save a baton without one.",
      });
    }
    const previous = validateStoredHandoffPacket(packetById(db, owned.data.active_packet_id));
    const tail = tailSince(db, project, identity, owned.data.tail_cursor ?? 0);
    const nextSemantic = semantic(input), unchanged = previous.semantic_digest
      === sha(canonicalStringify(nextSemantic)) && tail.items.length === 0;
    if (unchanged && operation === "checkpoint") {
      result = { changed: false, lane: owned, packet: previous };
      return;
    }
    const revision = allocateRevision(db);
    const packet = createHandoffPacket(project, identity, nextSemantic, previous, tail, now);
    persistPacket(db, project, packet, revision, now);
    const updated = persistLane(db, project, identity, { ...owned.data,
      active_packet_id: packet.id, tail_cursor: tail.cursor,
    }, revision, now, owned.updated_at);
    result = { changed: true, lane: updated, packet };
  }, options.database);
  return result;
}

export const handoffCheckpoint = (db, project, identity, input, options = {}) =>
  updateLanePacket(db, project, identity, input, options, "checkpoint");

export function handoffNow(db, project, identity, input, options = {}) {
  const now = (options.now ?? (() => new Date()))().toISOString();
  let result;
  transaction(db, () => {
    const active = activeRecovery(db, project), activeData = value(active);
    const inputDigest = sha(canonicalStringify(semantic(input)));
    const existingPacket = packetById(db, activeData?.packet_id);
    if (activeData?.state === "pending" && activeData.source_session === identity.session
        && existingPacket?.semantic_digest === inputDigest) {
      result = { changed: false, recovery: active, packet: existingPacket };
      return;
    }
    // Only an undelivered baton is worth protecting, and only from a session that did not
    // write it. A claimed baton has already been handed to a successor, so guarding it
    // protects nothing: if that successor never saves its own, the project can never save
    // continuity again, because a claimed recovery is also unclaimable by anyone else.
    if (activeData?.state === "pending" && activeData.source_session !== identity.session) {
      throw lodestarError("handoff_conflict",
        "An unclaimed project recovery is owned by another session.", {
          identifiers: { recovery: active.id, generation: activeData.generation },
          action: "Start a session in this project to claim it, then save the next baton.",
        });
    }
    const owned = lane(db, project, identity);
    const previous = owned?.data.state === "armed"
      ? validateStoredHandoffPacket(packetById(db, owned.data.active_packet_id)) : null;
    const tail = owned?.data.state === "armed"
      ? tailSince(db, project, identity, owned.data.tail_cursor ?? 0)
      : { items: [], omitted: 0, cursor: 0 };
    const revision = allocateRevision(db);
    const packet = createHandoffPacket(project, identity, input, previous, tail, now);
    persistPacket(db, project, packet, revision, now);
    if (owned?.data.state === "armed") persistLane(db, project, identity,
      { ...owned.data, active_packet_id: packet.id, tail_cursor: tail.cursor },
      revision, now, owned.updated_at);
    const generation = Number(activeData?.generation ?? 0) + 1;
    const recoveryId = `handoff-recovery:${hash(project.scope, 24)}:${generation}`;
    write(db, recordInput(recoveryId, "handoff-recovery",
      `Lodestar recovery ${generation} for ${project.name}`, project.scope, 1000, {
        state: "pending", generation, project: project.scope,
        source_session: identity.session, source_actor: identity.actor,
        packet_id: packet.id, saved_at: now, claimed_by: null, claimed_at: null,
      }), revision, now);
    write(db, recordInput(stateId(project), "handoff-state",
      `Active Lodestar recovery for ${project.name}`, project.scope, 1000,
      { active_recovery_id: recoveryId, generation }), revision, now);
    result = { changed: true, recovery: optionalRecord(db, recoveryId), packet };
  }, options.database);
  return result;
}

export function handoffStatus(db, project, identity) {
  const owned = lane(db, project, identity), active = activeRecovery(db, project);
  const visible = active && [active.data.source_session, active.data.claimed_by]
    .includes(identity.session) ? active : null;
  return { lane: owned, packet: packetById(db, owned?.data.active_packet_id),
    recovery: visible, recovery_packet: packetById(db, visible?.data.packet_id) };
}

export function handoffDisarm(db, project, identity, options = {}) {
  const now = (options.now ?? (() => new Date()))().toISOString();
  let result;
  transaction(db, () => {
    const owned = lane(db, project, identity);
    if (!owned || owned.data.state === "inert") {
      result = { changed: false, state: "inert" };
      return;
    }
    const active = activeRecovery(db, project);
    if (active?.data.state === "pending"
        && active.data.source_session === identity.session
        && active.data.packet_id === owned.data.active_packet_id) {
      throw lodestarError("handoff_pending", "Cannot disarm while recovery is pending.", {
        identifiers: { recovery: active.id, packet: active.data.packet_id },
        action: "The saved baton is waiting for the next session to claim it. Use "
          + "handoff checkpoint to revise it, or leave the lane armed and let the next "
          + "session claim it.",
      });
    }
    const revision = allocateRevision(db);
    result = { changed: true, lane: persistLane(db, project, identity,
      { ...owned.data, state: "inert" }, revision, now, owned.updated_at) };
  }, options.database);
  return result;
}

export function claimHandoffInside(db, project, identity, options = {}) {
  if (!identity.session) return null;
  const active = activeRecovery(db, project);
  if (!active) return null;
  const data = active.data;
  if (data.state === "claimed") {
    if (data.claimed_by !== identity.session) return null;
    return { recovery: active, packet: validateStoredHandoffPacket(
      packetById(db, data.packet_id)) };
  }
  if (data.state !== "pending" || data.source_session === identity.session) return null;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const revision = allocateRevision(db);
  writeRecordSnapshot(db, recordInput(active.id, "handoff-recovery", active.data.name,
    project.scope, 1000, { ...data, state: "claimed", claimed_by: identity.session,
      claimed_at: now }), { createdAt: active.updated_at, updatedAt: now, revision });
  return { recovery: optionalRecord(db, active.id), packet: validateStoredHandoffPacket(
    packetById(db, data.packet_id)) };
}

export function handoffStartupView(claim) {
  if (!claim) return null;
  const packet = claim.packet, full = { recovery: claim.recovery, packet };
  if (Buffer.byteLength(canonicalStringify(full), "utf8") <= 6 * 1024) return full;
  const bounded = (text, maximum) => {
    const points = Array.from(text);
    while (Buffer.byteLength(points.join(""), "utf8") > maximum) points.pop();
    return { text: points.join(""), truncated: points.length < Array.from(text).length };
  };
  return { recovery: claim.recovery, packet: { format: packet.format, id: packet.id,
    generation: packet.generation, goal: bounded(packet.goal, 1_024),
    nextMove: bounded(packet.nextMove, 2_048),
    integrity: packet.integrity, summary: true,
    omitted: { rules: packet.rules.length, entries: packet.entries.length,
      evidence: packet.evidence.length, tail: packet.recentTail.items.length } } };
}

export function diagnoseHandoff(db) {
  const invalid = [];
  const records = db.prepare("SELECT id,type,content_json FROM records "
    + "WHERE type LIKE 'handoff-%' ORDER BY id").all();
  const ids = new Set(records.map(({ id }) => id));
  for (const row of records) {
    try {
      const data = JSON.parse(row.content_json).value;
      if (row.type === "handoff-packet") validateStoredHandoffPacket(data.packet);
      else if (row.type === "handoff-lane") {
        if (!data.owner_session || !["armed", "inert"].includes(data.state)
            || !ids.has(packetRecordId(data.active_packet_id))) throw new Error();
      } else if (row.type === "handoff-recovery") {
        if (!["pending", "claimed"].includes(data.state)
            || !ids.has(packetRecordId(data.packet_id))
            || (data.state === "claimed") !== Boolean(data.claimed_by)) throw new Error();
      } else if (row.type === "handoff-state") {
        if (!ids.has(data.active_recovery_id)) throw new Error();
      } else if (row.type === "handoff-tail") {
        if (!["user", "assistant"].includes(data.role) || !data.session || !data.turn) {
          throw new Error();
        }
      } else throw new Error();
    } catch { invalid.push(row.id); }
  }
  return { records: records.length, invalid, healthy: invalid.length === 0 };
}
