import { boundedDiagnosticValue } from "./diagnostics.mjs";

const DEFAULT_ACTION =
  "Review the identifiers and retry with valid Lodestar input.";
const INTERNAL_ACTION =
  "Retry the command. If it fails again, run lodestar doctor.";
const ERROR_CODE = /^[a-z][a-z0-9_]{0,127}$/u;
const LODESTAR_ERRORS = new WeakSet();

function property(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function knownCode(error) {
  if (!LODESTAR_ERRORS.has(error)) return null;
  const code = property(error, "code");
  return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
}

function boundedText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const bounded = boundedDiagnosticValue(value, { maximumBytes: 2048 });
  return typeof bounded === "string" ? bounded : fallback;
}

function boundedIdentifiers(value) {
  const bounded = boundedDiagnosticValue(value);
  return bounded !== null
    && typeof bounded === "object"
    && !Array.isArray(bounded)
    ? bounded
    : {};
}

export function lodestarError(
  code,
  message,
  {
    identifiers = {},
    action,
    cause,
  } = {},
) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "LodestarError";
  error.code = code;
  error.identifiers = boundedDiagnosticValue(identifiers);
  if (action) error.action = action;
  LODESTAR_ERRORS.add(error);
  return error;
}

export function wrapError(
  error,
  code,
  message,
  {
    identifiers = {},
    action,
  } = {},
) {
  if (LODESTAR_ERRORS.has(error)) return error;
  return lodestarError(code, message, {
    identifiers,
    action,
    cause: error,
  });
}

export function errorPayload(error) {
  const code = knownCode(error);
  const known = code !== null;
  return {
    code: known ? code : "internal_error",
    message: known
      ? boundedText(
        property(error, "message"),
        "Lodestar could not complete the operation.",
      )
      : "Lodestar could not complete the operation.",
    identifiers: known
      ? boundedIdentifiers(property(error, "identifiers"))
      : {},
    action: known && property(error, "action")
      ? boundedText(property(error, "action"), DEFAULT_ACTION)
      : known
        ? DEFAULT_ACTION
        : INTERNAL_ACTION,
  };
}

export function errorEnvelope(error) {
  return {
    ok: false,
    error: errorPayload(error),
  };
}

function exitCodeForCode(code) {
  if (
    code.endsWith("_not_found")
    || code.endsWith("_conflict")
    || code === "record_not_found"
  ) {
    return 3;
  }
  if (
    code.includes("integrity")
    || code.includes("schema")
    || code === "invalid_database"
  ) {
    return 4;
  }
  if (
    code.startsWith("database_")
    || code.endsWith("_unreadable")
    || code.endsWith("_write_failed")
    || code === "import_cleanup_failed"
    || code === "import_commit_outcome_unknown"
  ) {
    return 5;
  }
  if (
    code.startsWith("invalid_")
    || code === "resource_limit"
    || code === "unknown_command"
    || code === "unknown_option"
    || code === "missing_argument"
  ) {
    return 2;
  }
  return 1;
}

export function exitCodeFor(error) {
  return exitCodeForCode(knownCode(error) ?? "internal_error");
}

export function internalErrorResult() {
  return {
    envelope: {
      ok: false,
      error: {
        code: "internal_error",
        message: "Lodestar could not complete the operation.",
        identifiers: {},
        action: INTERNAL_ACTION,
      },
    },
    exitCode: 1,
  };
}

export function errorResult(error) {
  try {
    const envelope = errorEnvelope(error);
    return {
      envelope,
      exitCode: exitCodeForCode(envelope.error.code),
    };
  } catch {
    return internalErrorResult();
  }
}
