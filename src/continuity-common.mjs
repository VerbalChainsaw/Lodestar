import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";

import { transaction } from "./database.mjs";
import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import {
  continuityDigest,
  validateContinuityMutation,
} from "./continuity-request.mjs";

const CONTROL = /[\u0000-\u001f\u007f]/u;

export function plainObject(value, field) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw lodestarError(
      "invalid_input",
      `${field} must be a JSON object.`,
      { identifiers: { field } },
    );
  }
  return value;
}

export function exactKeys(value, allowed, field = "input") {
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unexpected.length > 0) {
    throw lodestarError(
      "invalid_input",
      `${field} contains unsupported fields.`,
      { identifiers: { field, unsupported: unexpected } },
    );
  }
}

export function boundedText(
  value,
  field,
  maximum,
  { allowEmpty = false, allowControl = false } = {},
) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
    || (!allowControl && CONTROL.test(value))
    || value.normalize("NFC") !== value
  ) {
    throw lodestarError(
      "invalid_input",
      `${field} is invalid.`,
      { identifiers: { field, maximum } },
    );
  }
  return value;
}

export function identifier(value, field) {
  return boundedText(value, field, 256);
}

export function optionalIdentifier(value, field) {
  return value === null || value === undefined ? null : identifier(value, field);
}

export function packetJson(value) {
  plainObject(value, "packet_json");
  const text = canonicalStringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > 262_144) {
    throw lodestarError(
      "resource_limit",
      "packet_json exceeds its byte limit.",
      { identifiers: { bytes, maximum: 262_144 } },
    );
  }
  return { text, digest: continuityDigest(value) };
}

export function identifierArray(value, field, maximum = 512) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw lodestarError(
      "invalid_input",
      `${field} must be a bounded array.`,
      { identifiers: { field, maximum } },
    );
  }
  const result = value.map((entry, index) =>
    identifier(entry, `${field}[${index}]`)
  );
  if (new Set(result).size !== result.length) {
    throw lodestarError(
      "invalid_input",
      `${field} cannot contain duplicates.`,
      { identifiers: { field } },
    );
  }
  return result;
}

export function nowTimestamp(now) {
  const timestamp = now().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) {
    throw lodestarError("invalid_input", "The continuity clock is invalid.");
  }
  return timestamp;
}

export function newContinuityId(prefix, uuid = randomUUID) {
  return `${prefix}:${uuid()}`;
}

export function newWorkerClaim(bytes = randomBytes) {
  return bytes(32).toString("hex");
}

export function parseStoredObject(text, identifiers = {}) {
  try {
    const value = JSON.parse(text);
    return plainObject(value, "stored_json");
  } catch (error) {
    throw lodestarError(
      "database_integrity",
      "The continuity database contains invalid stored JSON.",
      { identifiers, cause: error },
    );
  }
}

export function requireLane(db, laneId) {
  const row = db.prepare(
    "SELECT lane_id, project_key, owner_session_id, state, active_packet_id, "
      + "version, created_at, updated_at FROM continuity_lanes "
      + "WHERE lane_id = ?",
  ).get(identifier(laneId, "lane_id"));
  if (!row) {
    throw lodestarError(
      "continuity_lane_not_found",
      "The continuity lane does not exist.",
      { identifiers: { lane_id: laneId } },
    );
  }
  return row;
}

export function requireArmedOwner(db, laneId, sessionId) {
  const lane = requireLane(db, laneId);
  identifier(sessionId, "session_id");
  if (lane.state !== "armed" || lane.owner_session_id !== sessionId) {
    throw lodestarError(
      "continuity_owner_conflict",
      "The session does not own the armed continuity lane.",
      {
        identifiers: {
          lane_id: laneId,
          owner_session_id: lane.owner_session_id,
          session_id: sessionId,
          state: lane.state,
        },
      },
    );
  }
  return lane;
}

export function insertPacket(db, {
  packetId,
  laneId,
  predecessorPacketId,
  operationId,
  packet,
  sessionId,
  turnId,
  createdAt,
}) {
  db.prepare(
    "INSERT INTO continuity_packets("
      + "packet_id, lane_id, predecessor_packet_id, operation_id, "
      + "packet_json, integrity_digest, created_by_session, "
      + "created_by_turn, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    packetId,
    laneId,
    predecessorPacketId,
    operationId,
    packet.text,
    packet.digest,
    sessionId,
    turnId,
    createdAt,
  );
}

function replayReceipt(db, operationId, eventType, requestDigest) {
  const receipt = db.prepare(
    "SELECT event_type, request_digest, payload_json "
      + "FROM continuity_events WHERE operation_id = ?",
  ).get(operationId);
  if (!receipt) return null;
  if (
    receipt.event_type !== eventType
    || receipt.request_digest !== requestDigest
  ) {
    throw lodestarError(
      "operation_conflict",
      "The operation ID was already used for a different request.",
      {
        identifiers: {
          operation_id: operationId,
          event_type: receipt.event_type,
        },
      },
    );
  }
  return { ...parseStoredObject(receipt.payload_json), duplicate: true };
}

export function continuityMutation(
  db,
  {
    operation,
    eventType,
    input,
    database = null,
    now = () => new Date(),
    uuid = randomUUID,
  },
  execute,
) {
  return transaction(db, () => {
    const replay = replayReceipt(
      db,
      input?.operation_id,
      eventType,
      input?.request_digest,
    );
    if (replay) return replay;
    const args = validateContinuityMutation(operation, input);
    const createdAt = nowTimestamp(now);
    const eventId = newContinuityId("event", uuid);
    const result = execute(args, { createdAt, eventId, uuid });
    const payload = plainObject(result.payload, "receipt.payload");
    const receipt = plainObject(result.receipt, "receipt");
    db.prepare(
      "INSERT INTO continuity_events("
        + "event_id, operation_id, request_digest, lane_id, session_id, "
        + "turn_id, event_type, role, status, redacted_text, payload_json, "
        + "absorbed_packet_id, created_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      eventId,
      input.operation_id,
      input.request_digest,
      receipt.lane_id,
      receipt.session_id,
      receipt.turn_id,
      eventType,
      receipt.role ?? null,
      receipt.status,
      receipt.redacted_text ?? "",
      canonicalStringify(payload),
      receipt.absorbed_packet_id ?? null,
      createdAt,
    );
    return { ...payload, duplicate: false };
  }, database);
}
