import {
  boundedText,
  continuityMutation,
  exactKeys,
  identifier,
  newWorkerClaim,
  optionalIdentifier,
  requireArmedOwner,
  requireLane,
} from "./continuity-common.mjs";
import { lodestarError } from "./errors.mjs";

const LEGAL_TRANSITIONS = Object.freeze({
  claimed: "creating",
  creating: "created",
  created: "injecting",
  injecting: "injected",
  injected: "continuing",
});

function requireTransfer(db, transferId) {
  const id = identifier(transferId, "transfer_id");
  const transfer = db.prepare(
    "SELECT transfer_id, operation_id, lane_id, source_session_id, "
      + "source_turn_id, packet_id, phase, worker_claim_id, "
      + "target_session_id, target_turn_id, target_turn_status, error, "
      + "created_at, updated_at FROM continuity_transfers "
      + "WHERE transfer_id = ?",
  ).get(id);
  if (!transfer) {
    throw lodestarError(
      "continuity_transfer_not_found",
      "The continuity transfer does not exist.",
      { identifiers: { transfer_id: id } },
    );
  }
  return transfer;
}

function workerReceipt(transfer, status) {
  return {
    lane_id: transfer.lane_id,
    session_id: transfer.source_session_id,
    turn_id: transfer.source_turn_id,
    role: "worker",
    status,
  };
}

export function continuityClaimTransfer(db, input, options = {}) {
  return continuityMutation(db, {
    ...options,
    operation: "continuity_claim_transfer",
    eventType: "transfer.claimed",
    input,
  }, (args, context) => {
    exactKeys(args, [
      "transfer_id",
      "source_session_id",
      "source_turn_id",
    ]);
    const transfer = requireTransfer(db, args.transfer_id);
    const sourceSession = identifier(
      args.source_session_id,
      "source_session_id",
    );
    const sourceTurn = identifier(args.source_turn_id, "source_turn_id");
    if (
      transfer.phase !== "scheduled"
      || transfer.source_session_id !== sourceSession
      || transfer.source_turn_id !== sourceTurn
    ) {
      throw lodestarError(
        "continuity_transfer_conflict",
        "The transfer cannot be claimed by this source turn.",
        {
          identifiers: {
            transfer_id: transfer.transfer_id,
            phase: transfer.phase,
          },
        },
      );
    }
    requireArmedOwner(db, transfer.lane_id, sourceSession);
    const workerClaimId = newWorkerClaim(options.randomBytes);
    db.prepare(
      "UPDATE continuity_transfers SET phase = 'claimed', "
        + "worker_claim_id = ?, updated_at = ? WHERE transfer_id = ?",
    ).run(workerClaimId, context.createdAt, transfer.transfer_id);
    return {
      payload: {
        transfer_id: transfer.transfer_id,
        worker_claim_id: workerClaimId,
        phase: "claimed",
      },
      receipt: workerReceipt(transfer, "claimed"),
    };
  });
}

export function continuityUpdateTransfer(db, input, options = {}) {
  const nextPhase = input?.next_phase;
  if (!Object.values(LEGAL_TRANSITIONS).includes(nextPhase)) {
    throw lodestarError(
      "invalid_input",
      "The requested transfer phase is not a legal worker target.",
    );
  }
  return continuityMutation(db, {
    ...options,
    operation: "continuity_update_transfer",
    eventType: `transfer.${nextPhase}`,
    input,
  }, (args, context) => {
    exactKeys(args, [
      "transfer_id",
      "worker_claim_id",
      "expected_phase",
      "next_phase",
      "target_session_id",
      "error",
    ]);
    const transfer = requireTransfer(db, args.transfer_id);
    const claim = identifier(args.worker_claim_id, "worker_claim_id");
    const expected = boundedText(args.expected_phase, "expected_phase", 64);
    const next = boundedText(args.next_phase, "next_phase", 64);
    if (transfer.worker_claim_id !== claim) {
      throw lodestarError(
        "continuity_claim_conflict",
        "The worker claim does not own this transfer.",
        { identifiers: { transfer_id: transfer.transfer_id } },
      );
    }
    if (transfer.phase !== expected) {
      const indeterminate = ["creating", "injecting", "continuing"]
        .includes(transfer.phase);
      throw lodestarError(
        indeterminate
          ? "continuity_transfer_indeterminate"
          : "continuity_transfer_conflict",
        indeterminate
          ? "A prior worker may have performed an App Server side effect."
          : "The transfer is not in the expected phase.",
        {
          identifiers: {
            transfer_id: transfer.transfer_id,
            expected_phase: expected,
            actual_phase: transfer.phase,
          },
          action: indeterminate
            ? "Stop automatic replay and reconcile the transfer manually."
            : undefined,
        },
      );
    }
    if (LEGAL_TRANSITIONS[expected] !== next) {
      throw lodestarError(
        "continuity_phase_conflict",
        "The transfer phase transition is not legal.",
        { identifiers: { expected_phase: expected, next_phase: next } },
      );
    }
    const targetSession = optionalIdentifier(
      args.target_session_id,
      "target_session_id",
    );
    if ((next === "created") !== (targetSession !== null)) {
      throw lodestarError(
        "invalid_input",
        "Only the created transition requires a target session ID.",
      );
    }
    const redactedError = args.error === undefined
      ? null
      : boundedText(args.error, "error", 65_536, {
        allowEmpty: true,
        allowControl: true,
      });
    db.prepare(
      "UPDATE continuity_transfers SET phase = ?, "
        + "target_session_id = COALESCE(?, target_session_id), error = ?, "
        + "updated_at = ? WHERE transfer_id = ?",
    ).run(
      next,
      targetSession,
      redactedError,
      context.createdAt,
      transfer.transfer_id,
    );
    return {
      payload: {
        transfer_id: transfer.transfer_id,
        phase: next,
        target_session_id: targetSession ?? transfer.target_session_id,
      },
      receipt: workerReceipt(transfer, next),
    };
  });
}

export function continuityAcceptTarget(db, input, options = {}) {
  return continuityMutation(db, {
    ...options,
    operation: "continuity_accept_target",
    eventType: "transfer.accepted",
    input,
  }, (args, context) => {
    exactKeys(args, [
      "transfer_id",
      "worker_claim_id",
      "target_session_id",
      "target_turn_id",
    ]);
    const transfer = requireTransfer(db, args.transfer_id);
    const claim = identifier(args.worker_claim_id, "worker_claim_id");
    const targetSession = identifier(
      args.target_session_id,
      "target_session_id",
    );
    const targetTurn = identifier(args.target_turn_id, "target_turn_id");
    if (
      transfer.phase !== "continuing"
      || transfer.worker_claim_id !== claim
      || transfer.target_session_id !== targetSession
    ) {
      throw lodestarError(
        "continuity_transfer_conflict",
        "The target cannot accept this transfer.",
        {
          identifiers: {
            transfer_id: transfer.transfer_id,
            phase: transfer.phase,
          },
        },
      );
    }
    const lane = requireLane(db, transfer.lane_id);
    if (
      lane.state !== "armed"
      || lane.owner_session_id !== transfer.source_session_id
    ) {
      throw lodestarError(
        "continuity_owner_conflict",
        "The source session no longer owns the armed lane.",
        { identifiers: { lane_id: lane.lane_id } },
      );
    }
    const targetLane = db.prepare(
      "SELECT lane_id FROM continuity_lanes WHERE owner_session_id = ? "
        + "AND state = 'armed' AND lane_id <> ?",
    ).get(targetSession, lane.lane_id);
    if (targetLane) {
      throw lodestarError(
        "continuity_owner_conflict",
        "The target session already owns another armed lane.",
        { identifiers: { lane_id: targetLane.lane_id } },
      );
    }
    const version = Number(lane.version) + 1;
    db.prepare(
      "UPDATE continuity_transfers SET phase = 'accepted', "
        + "target_turn_id = ?, updated_at = ? WHERE transfer_id = ?",
    ).run(targetTurn, context.createdAt, transfer.transfer_id);
    db.prepare(
      "UPDATE continuity_lanes SET owner_session_id = ?, version = ?, "
        + "updated_at = ? WHERE lane_id = ?",
    ).run(targetSession, version, context.createdAt, lane.lane_id);
    return {
      payload: {
        transfer_id: transfer.transfer_id,
        owner_session_id: targetSession,
        target_session_id: targetSession,
        target_turn_id: targetTurn,
        lane_version: version,
        phase: "accepted",
      },
      receipt: {
        lane_id: lane.lane_id,
        session_id: targetSession,
        turn_id: targetTurn,
        role: "worker",
        status: "accepted",
      },
    };
  });
}

export function continuityCompleteTarget(db, input, options = {}) {
  const targetStatus = input?.target_turn_status;
  if (!["completed", "interrupted", "failed"].includes(targetStatus)) {
    throw lodestarError(
      "invalid_input",
      "The target turn status is invalid.",
    );
  }
  const eventType = targetStatus === "completed"
    ? "transfer.completed"
    : "transfer.failed";
  return continuityMutation(db, {
    ...options,
    operation: "continuity_complete_target",
    eventType,
    input,
  }, (args, context) => {
    exactKeys(args, [
      "transfer_id",
      "worker_claim_id",
      "target_turn_id",
      "target_turn_status",
      "redacted_error",
    ]);
    const transfer = requireTransfer(db, args.transfer_id);
    const claim = identifier(args.worker_claim_id, "worker_claim_id");
    const targetTurn = identifier(args.target_turn_id, "target_turn_id");
    if (
      transfer.phase !== "accepted"
      || transfer.worker_claim_id !== claim
      || transfer.target_turn_id !== targetTurn
      || transfer.target_session_id === null
    ) {
      throw lodestarError(
        "continuity_transfer_conflict",
        "The target turn cannot complete this transfer.",
        { identifiers: { transfer_id: transfer.transfer_id } },
      );
    }
    const redactedError = args.redacted_error === undefined
      ? null
      : boundedText(args.redacted_error, "redacted_error", 65_536, {
        allowEmpty: true,
        allowControl: true,
      });
    const phase = targetStatus === "completed" ? "completed" : "failed";
    db.prepare(
      "UPDATE continuity_transfers SET phase = ?, target_turn_status = ?, "
        + "error = ?, updated_at = ? WHERE transfer_id = ?",
    ).run(
      phase,
      targetStatus,
      redactedError,
      context.createdAt,
      transfer.transfer_id,
    );
    return {
      payload: {
        transfer_id: transfer.transfer_id,
        phase,
        target_turn_status: targetStatus,
      },
      receipt: {
        lane_id: transfer.lane_id,
        session_id: transfer.target_session_id,
        turn_id: targetTurn,
        role: "worker",
        status: phase,
      },
    };
  });
}
