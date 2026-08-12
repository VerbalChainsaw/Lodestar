import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;

export function continuityDigest(value) {
  return createHash("sha256")
    .update(canonicalStringify(value))
    .digest("hex");
}

function identityFields(argumentsValue) {
  return {
    session_id: argumentsValue.session_id
      ?? argumentsValue.source_session_id
      ?? argumentsValue.target_session_id
      ?? null,
    turn_id: argumentsValue.turn_id
      ?? argumentsValue.source_turn_id
      ?? argumentsValue.target_turn_id
      ?? null,
    identity: argumentsValue.lane_id
      ?? argumentsValue.transfer_id
      ?? null,
  };
}

export function continuityOperationId(operation, argumentsValue, requestDigest) {
  return continuityDigest({
    v: 1,
    operation,
    ...identityFields(argumentsValue),
    argument_digest: requestDigest,
  });
}

export function prepareContinuityRequest(operation, argumentsValue) {
  if (
    typeof operation !== "string"
    || operation.length === 0
    || Buffer.byteLength(operation, "utf8") > 64
  ) {
    throw lodestarError(
      "invalid_input",
      "The continuity operation name is invalid.",
    );
  }
  if (
    argumentsValue === null
    || typeof argumentsValue !== "object"
    || Array.isArray(argumentsValue)
    || Object.getPrototypeOf(argumentsValue) !== Object.prototype
  ) {
    throw lodestarError(
      "invalid_input",
      "Continuity arguments must be a JSON object.",
    );
  }
  const requestDigest = continuityDigest(argumentsValue);
  return {
    ...argumentsValue,
    operation_id: continuityOperationId(
      operation,
      argumentsValue,
      requestDigest,
    ),
    request_digest: requestDigest,
  };
}

export function validateContinuityMutation(operation, input) {
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw lodestarError(
      "invalid_input",
      "The continuity mutation input must be a JSON object.",
    );
  }
  if (!DIGEST.test(input.request_digest ?? "")) {
    throw lodestarError(
      "invalid_request_digest",
      "The continuity request digest is invalid.",
    );
  }
  if (!DIGEST.test(input.operation_id ?? "")) {
    throw lodestarError(
      "invalid_operation_id",
      "The continuity operation ID is invalid.",
    );
  }
  const argumentsValue = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => key !== "operation_id" && key !== "request_digest",
    ),
  );
  const requestDigest = continuityDigest(argumentsValue);
  if (requestDigest !== input.request_digest) {
    throw lodestarError(
      "invalid_request_digest",
      "The continuity request digest does not match its arguments.",
      {
        identifiers: {
          expected: requestDigest,
          actual: input.request_digest,
        },
      },
    );
  }
  const operationId = continuityOperationId(
    operation,
    argumentsValue,
    requestDigest,
  );
  if (operationId !== input.operation_id) {
    throw lodestarError(
      "invalid_operation_id",
      "The continuity operation ID is not deterministic for this request.",
      {
        identifiers: {
          expected: operationId,
          actual: input.operation_id,
        },
      },
    );
  }
  return argumentsValue;
}
