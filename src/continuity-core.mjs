import {
  boundedText,
  continuityMutation,
  exactKeys,
  identifier,
  identifierArray,
  insertPacket,
  newContinuityId,
  packetJson,
  parseStoredObject,
  plainObject,
  requireArmedOwner,
  requireLane,
} from "./continuity-common.mjs";
import { lodestarError } from "./errors.mjs";

function receipt(laneId, sessionId, turnId, status, extra = {}) {
  return {
    lane_id: laneId,
    session_id: sessionId,
    turn_id: turnId,
    status,
    ...extra,
  };
}

function assertNoArmedLane(db, sessionId) {
  const existing = db.prepare(
    "SELECT lane_id FROM continuity_lanes "
      + "WHERE owner_session_id = ? AND state = 'armed'",
  ).get(sessionId);
  if (existing) {
    throw lodestarError(
      "continuity_owner_conflict",
      "The session already owns an armed continuity lane.",
      {
        identifiers: {
          session_id: sessionId,
          lane_id: existing.lane_id,
        },
      },
    );
  }
}

export function continuityArm(db, input, options = {}) {
  return continuityMutation(db, {
    ...options,
    operation: "continuity_arm",
    eventType: "lane.armed",
    input,
  }, (args, context) => {
    exactKeys(args, [
      "project_key",
      "session_id",
      "turn_id",
      "packet_json",
    ]);
    const projectKey = boundedText(args.project_key, "project_key", 512);
    const sessionId = identifier(args.session_id, "session_id");
    const turnId = identifier(args.turn_id, "turn_id");
    const packet = packetJson(args.packet_json);
    assertNoArmedLane(db, sessionId);
    const laneId = newContinuityId("lane", context.uuid);
    const packetId = newContinuityId("packet", context.uuid);
    db.prepare(
      "INSERT INTO continuity_lanes("
        + "lane_id, project_key, owner_session_id, state, active_packet_id, "
        + "version, created_at, updated_at) "
        + "VALUES (?, ?, ?, 'armed', NULL, 1, ?, ?)",
    ).run(laneId, projectKey, sessionId, context.createdAt, context.createdAt);
    insertPacket(db, {
      packetId,
      laneId,
      predecessorPacketId: null,
      operationId: input.operation_id,
      packet,
      sessionId,
      turnId,
      createdAt: context.createdAt,
    });
    db.prepare(
      "UPDATE continuity_lanes SET active_packet_id = ? WHERE lane_id = ?",
    ).run(packetId, laneId);
    return {
      payload: {
        lane_id: laneId,
        packet_id: packetId,
        integrity_digest: packet.digest,
        lane_version: 1,
      },
      receipt: receipt(laneId, sessionId, turnId, "armed"),
    };
  });
}

function eventRows(db, laneId) {
  const rows = db.prepare(
    "SELECT event_id, session_id, turn_id, event_type, role, redacted_text, "
      + "created_at FROM continuity_events WHERE lane_id = ? "
      + "AND absorbed_packet_id IS NULL "
      + "AND event_type IN ('prompt.tail', 'assistant.tail') "
      + "ORDER BY created_at, event_id LIMIT 101",
  ).all(laneId);
  if (rows.length > 100) {
    throw lodestarError(
      "continuity_tail_overflow",
      "The unabsorbed continuity tail exceeds its status bound.",
      { identifiers: { lane_id: laneId, maximum: 100 } },
    );
  }
  return rows;
}

function statusForLane(db, lane) {
  const packet = lane.active_packet_id === null ? null : db.prepare(
    "SELECT packet_id, predecessor_packet_id, packet_json, integrity_digest, "
      + "created_by_session, created_by_turn, created_at "
      + "FROM continuity_packets WHERE lane_id = ? AND packet_id = ?",
  ).get(lane.lane_id, lane.active_packet_id);
  if (lane.active_packet_id !== null && !packet) {
    throw lodestarError(
      "database_integrity",
      "The continuity lane references a missing active packet.",
      { identifiers: { lane_id: lane.lane_id } },
    );
  }
  const transfer = db.prepare(
    "SELECT transfer_id, source_session_id, source_turn_id, packet_id, phase, "
      + "worker_claim_id, target_session_id, target_turn_id, "
      + "target_turn_status, error, created_at, updated_at "
      + "FROM continuity_transfers WHERE lane_id = ? "
      + "ORDER BY created_at DESC, transfer_id DESC LIMIT 1",
  ).get(lane.lane_id) ?? null;
  const indeterminate = transfer
    && ["creating", "injecting", "continuing"].includes(transfer.phase)
      ? `app_server_${transfer.phase}_outcome_unknown`
      : null;
  return {
    found: true,
    lane: {
      lane_id: lane.lane_id,
      project_key: lane.project_key,
      owner_session_id: lane.owner_session_id,
      state: lane.state,
      active_packet_id: lane.active_packet_id,
      version: Number(lane.version),
      created_at: lane.created_at,
      updated_at: lane.updated_at,
    },
    active_packet: packet === null ? null : {
      ...packet,
      packet_json: parseStoredObject(packet.packet_json, {
        packet_id: packet.packet_id,
      }),
    },
    unabsorbed_tail: eventRows(db, lane.lane_id),
    latest_transfer: transfer,
    blocked_reason: transfer?.error ?? null,
    indeterminate_reason: indeterminate,
  };
}

export function continuityStatus(db, input) {
  plainObject(input, "continuity_status");
  exactKeys(input, ["session_id", "project_key", "lane_id", "all"]);
  if (input.all === true) {
    if (Object.keys(input).length !== 1) {
      throw lodestarError(
        "invalid_input",
        "Administrative status cannot be combined with another selector.",
      );
    }
    const lanes = db.prepare(
      "SELECT lane_id, project_key, owner_session_id, state, active_packet_id, "
        + "version, created_at, updated_at FROM continuity_lanes "
        + "ORDER BY updated_at DESC, lane_id",
    ).all();
    return { lanes: lanes.map((lane) => statusForLane(db, lane)) };
  }
  let lane;
  if (input.lane_id !== undefined) {
    if (Object.keys(input).length !== 1) {
      throw lodestarError(
        "invalid_input",
        "Lane status cannot be combined with another selector.",
      );
    }
    lane = requireLane(db, input.lane_id);
  } else {
    exactKeys(input, ["session_id", "project_key"]);
    const sessionId = identifier(input.session_id, "session_id");
    const projectKey = boundedText(input.project_key, "project_key", 512);
    lane = db.prepare(
      "SELECT lane_id, project_key, owner_session_id, state, "
        + "active_packet_id, version, created_at, updated_at "
        + "FROM continuity_lanes WHERE owner_session_id = ? "
        + "AND project_key = ? ORDER BY state = 'armed' DESC, "
        + "updated_at DESC, lane_id DESC LIMIT 1",
    ).get(sessionId, projectKey);
    if (!lane) return { found: false };
  }
  return statusForLane(db, lane);
}

export function continuityAppendEvent(db, input, options = {}) {
  const eventType = input?.event_type;
  if (!["prompt.tail", "assistant.tail"].includes(eventType)) {
    throw lodestarError(
      "invalid_input",
      "The continuity tail event type is invalid.",
    );
  }
  return continuityMutation(db, {
    ...options,
    operation: "continuity_append_event",
    eventType,
    input,
  }, (args, context) => {
    exactKeys(args, [
      "lane_id",
      "session_id",
      "turn_id",
      "event_type",
      "role",
      "redacted_text",
    ]);
    const laneId = identifier(args.lane_id, "lane_id");
    const sessionId = identifier(args.session_id, "session_id");
    const turnId = identifier(args.turn_id, "turn_id");
    requireArmedOwner(db, laneId, sessionId);
    if (
      (eventType === "prompt.tail" && args.role !== "user")
      || (eventType === "assistant.tail" && args.role !== "assistant")
    ) {
      throw lodestarError(
        "invalid_input",
        "The continuity tail role does not match its event type.",
      );
    }
    const redactedText = boundedText(
      args.redacted_text,
      "redacted_text",
      262_144,
      { allowEmpty: true, allowControl: true },
    );
    const collision = db.prepare(
      "SELECT event_id FROM continuity_events WHERE lane_id = ? "
        + "AND session_id = ? AND turn_id = ? AND event_type = ?",
    ).get(laneId, sessionId, turnId, eventType);
    if (collision) {
      throw lodestarError(
        "operation_conflict",
        "The continuity tail event already exists with another operation ID.",
        { identifiers: { event_id: collision.event_id } },
      );
    }
    return {
      payload: {
        event_id: context.eventId,
        lane_id: laneId,
        event_type: eventType,
      },
      receipt: receipt(laneId, sessionId, turnId, "recorded", {
        role: args.role,
        redacted_text: redactedText,
      }),
    };
  });
}

function checkpointInside(db, args, context, operationId) {
  const laneId = identifier(args.lane_id, "lane_id");
  const sessionId = identifier(args.session_id, "session_id");
  const turnId = identifier(args.turn_id, "turn_id");
  const predecessor = identifier(
    args.predecessor_packet_id,
    "predecessor_packet_id",
  );
  const lane = requireArmedOwner(db, laneId, sessionId);
  if (lane.active_packet_id !== predecessor) {
    throw lodestarError(
      "continuity_predecessor_conflict",
      "The checkpoint predecessor is not the active packet.",
      {
        identifiers: {
          lane_id: laneId,
          expected: lane.active_packet_id,
          actual: predecessor,
        },
      },
    );
  }
  const packet = packetJson(args.packet_json);
  const absorbed = identifierArray(args.absorbed_event_ids, "absorbed_event_ids");
  for (const eventId of absorbed) {
    const event = db.prepare(
      "SELECT absorbed_packet_id, event_type FROM continuity_events "
        + "WHERE event_id = ? AND lane_id = ?",
    ).get(eventId, laneId);
    if (
      !event
      || event.absorbed_packet_id !== null
      || !["prompt.tail", "assistant.tail"].includes(event.event_type)
    ) {
      throw lodestarError(
        "continuity_event_conflict",
        "A supplied tail event cannot be absorbed by this checkpoint.",
        { identifiers: { lane_id: laneId, event_id: eventId } },
      );
    }
  }
  const packetId = newContinuityId("packet", context.uuid);
  insertPacket(db, {
    packetId,
    laneId,
    predecessorPacketId: predecessor,
    operationId,
    packet,
    sessionId,
    turnId,
    createdAt: context.createdAt,
  });
  const absorb = db.prepare(
    "UPDATE continuity_events SET absorbed_packet_id = ? WHERE event_id = ?",
  );
  for (const eventId of absorbed) absorb.run(packetId, eventId);
  const version = Number(lane.version) + 1;
  db.prepare(
    "UPDATE continuity_lanes SET active_packet_id = ?, version = ?, "
      + "updated_at = ? WHERE lane_id = ?",
  ).run(packetId, version, context.createdAt, laneId);
  return {
    laneId,
    sessionId,
    turnId,
    packetId,
    integrityDigest: packet.digest,
    absorbedCount: absorbed.length,
    version,
  };
}

export function continuityCheckpoint(db, input, options = {}) {
  return continuityMutation(db, {
    ...options,
    operation: "continuity_checkpoint",
    eventType: "packet.checkpointed",
    input,
  }, (args, context) => {
    exactKeys(args, [
      "lane_id",
      "session_id",
      "turn_id",
      "predecessor_packet_id",
      "packet_json",
      "absorbed_event_ids",
    ]);
    const result = checkpointInside(db, args, context, input.operation_id);
    return {
      payload: {
        packet_id: result.packetId,
        integrity_digest: result.integrityDigest,
        absorbed_count: result.absorbedCount,
        lane_version: result.version,
      },
      receipt: receipt(
        result.laneId,
        result.sessionId,
        result.turnId,
        "checkpointed",
        { absorbed_packet_id: result.packetId },
      ),
    };
  });
}

export function continuityRequestTransfer(db, input, options = {}) {
  return continuityMutation(db, {
    ...options,
    operation: "continuity_request_transfer",
    eventType: "transfer.scheduled",
    input,
  }, (args, context) => {
    exactKeys(args, [
      "lane_id",
      "source_session_id",
      "source_turn_id",
      "predecessor_packet_id",
      "packet_json",
      "absorbed_event_ids",
    ]);
    const laneId = identifier(args.lane_id, "lane_id");
    const active = db.prepare(
      "SELECT transfer_id FROM continuity_transfers WHERE lane_id = ? "
        + "AND phase NOT IN ('completed', 'failed')",
    ).get(laneId);
    if (active) {
      throw lodestarError(
        "continuity_transfer_conflict",
        "The lane already has an active transfer.",
        { identifiers: { lane_id: laneId, transfer_id: active.transfer_id } },
      );
    }
    const checkpointArgs = {
      ...args,
      session_id: args.source_session_id,
      turn_id: args.source_turn_id,
    };
    const result = checkpointInside(
      db,
      checkpointArgs,
      context,
      input.operation_id,
    );
    const transferId = newContinuityId("transfer", context.uuid);
    db.prepare(
      "INSERT INTO continuity_transfers("
        + "transfer_id, operation_id, lane_id, source_session_id, "
        + "source_turn_id, packet_id, phase, worker_claim_id, "
        + "target_session_id, target_turn_id, target_turn_status, error, "
        + "created_at, updated_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, NULL, NULL, "
        + "NULL, ?, ?)",
    ).run(
      transferId,
      input.operation_id,
      result.laneId,
      result.sessionId,
      result.turnId,
      result.packetId,
      context.createdAt,
      context.createdAt,
    );
    return {
      payload: {
        packet_id: result.packetId,
        transfer_id: transferId,
        integrity_digest: result.integrityDigest,
        absorbed_count: result.absorbedCount,
        lane_version: result.version,
      },
      receipt: receipt(
        result.laneId,
        result.sessionId,
        result.turnId,
        "scheduled",
        { absorbed_packet_id: result.packetId },
      ),
    };
  });
}

export function continuityDisarm(db, input, options = {}) {
  return continuityMutation(db, {
    ...options,
    operation: "continuity_disarm",
    eventType: "lane.disarmed",
    input,
  }, (args, context) => {
    exactKeys(args, ["lane_id", "session_id", "turn_id"]);
    const laneId = identifier(args.lane_id, "lane_id");
    const sessionId = identifier(args.session_id, "session_id");
    const turnId = identifier(args.turn_id, "turn_id");
    const lane = requireArmedOwner(db, laneId, sessionId);
    const active = db.prepare(
      "SELECT transfer_id FROM continuity_transfers WHERE lane_id = ? "
        + "AND phase NOT IN ('completed', 'failed')",
    ).get(laneId);
    if (active) {
      throw lodestarError(
        "continuity_transfer_conflict",
        "An active transfer blocks lane disarm.",
        { identifiers: { transfer_id: active.transfer_id } },
      );
    }
    const version = Number(lane.version) + 1;
    db.prepare(
      "UPDATE continuity_lanes SET state = 'inert', version = ?, "
        + "updated_at = ? WHERE lane_id = ?",
    ).run(version, context.createdAt, laneId);
    return {
      payload: { lane_id: laneId, state: "inert", lane_version: version },
      receipt: receipt(laneId, sessionId, turnId, "disarmed"),
    };
  });
}
