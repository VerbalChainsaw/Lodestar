import {
  continuityAppendEvent,
  continuityArm,
  continuityCheckpoint,
  continuityDisarm,
  continuityRequestTransfer,
  continuityStatus,
} from "./continuity-core.mjs";
import {
  continuityAcceptTarget,
  continuityClaimTransfer,
  continuityCompleteTarget,
  continuityUpdateTransfer,
} from "./continuity-transfer.mjs";
import { lodestarError } from "./errors.mjs";

export {
  continuityOperationId,
  prepareContinuityRequest,
} from "./continuity-request.mjs";

export const CONTINUITY_OPERATIONS = Object.freeze({
  continuity_arm: continuityArm,
  continuity_status: continuityStatus,
  continuity_append_event: continuityAppendEvent,
  continuity_checkpoint: continuityCheckpoint,
  continuity_request_transfer: continuityRequestTransfer,
  continuity_claim_transfer: continuityClaimTransfer,
  continuity_update_transfer: continuityUpdateTransfer,
  continuity_accept_target: continuityAcceptTarget,
  continuity_complete_target: continuityCompleteTarget,
  continuity_disarm: continuityDisarm,
});

export function executeContinuityOperation(
  db,
  operation,
  input,
  options = {},
) {
  const execute = CONTINUITY_OPERATIONS[operation];
  if (!execute) {
    throw lodestarError(
      "unknown_continuity_operation",
      "The continuity operation is not supported.",
      { identifiers: { operation } },
    );
  }
  return execute(db, input, options);
}
