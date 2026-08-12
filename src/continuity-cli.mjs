import path from "node:path";

import { lodestarError } from "./errors.mjs";
import {
  parseJsonText,
  readStreamBounded,
  readTextFileBounded,
} from "./json.mjs";
import {
  createLodestarServiceClient,
  ensureServiceViaPowerShell,
} from "./service-client.mjs";
import {
  LODESTAR_API_VERSION,
  SERVICE_BODY_LIMIT,
  startLodestarService,
} from "./service.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import { LODESTAR_VERSION } from "./version.mjs";

export const CONTINUITY_COMMAND = Object.freeze({
  usage: "lodestar continuity <operation> [--json-input <json-or-path>]",
  summary: "Call one Lodestar continuity-domain operation.",
  values: ["--json-input", "--session", "--project", "--lane"],
  booleans: ["--all"],
  positionals: 1,
});

export const SERVE_COMMAND = Object.freeze({
  usage: "lodestar serve [--port <n>] [--db <path>]",
  summary: "Run the internal Windows loopback service.",
  values: ["--port"],
  booleans: [],
  positionals: 0,
});

const OPERATIONS = Object.freeze({
  arm: "continuity_arm",
  status: "continuity_status",
  append_event: "continuity_append_event",
  checkpoint: "continuity_checkpoint",
  request_transfer: "continuity_request_transfer",
  claim_transfer: "continuity_claim_transfer",
  update_transfer: "continuity_update_transfer",
  accept_target: "continuity_accept_target",
  complete_target: "continuity_complete_target",
  disarm: "continuity_disarm",
});

async function continuityInput(operation, options, io) {
  const selectors = ["--session", "--project", "--lane", "--all"]
    .filter((key) => options[key] !== undefined);
  if (operation === "continuity_status" && options["--json-input"] === undefined) {
    if (options["--all"] === true && selectors.length === 1) return { all: true };
    if (options["--lane"] !== undefined && selectors.length === 1) {
      return { lane_id: options["--lane"] };
    }
    if (
      options["--session"] !== undefined
      && options["--project"] !== undefined
      && selectors.length === 2
    ) {
      return {
        session_id: options["--session"],
        project_key: options["--project"],
      };
    }
    throw lodestarError(
      "invalid_input",
      "Continuity status requires --lane, --session with --project, or --all.",
    );
  }
  if (selectors.length !== 0 || options["--json-input"] === undefined) {
    throw lodestarError(
      "invalid_input",
      "The continuity operation requires only --json-input.",
    );
  }
  const selected = options["--json-input"];
  let text;
  if (selected === "-") {
    text = await readStreamBounded(io.stdin, {
      maximum: SERVICE_BODY_LIMIT,
      resource: "continuity_json_input",
    });
  } else if (selected.trimStart().startsWith("{")) text = selected;
  else {
    text = await readTextFileBounded(path.resolve(selected), {
      maximum: SERVICE_BODY_LIMIT,
      resource: "continuity_json_input",
    });
  }
  return parseJsonText(text, {
    maximum: SERVICE_BODY_LIMIT,
    resource: "continuity_json_input",
  });
}

function ensureFunction() {
  const endpoint = process.env.LODESTAR_SERVICE_ENDPOINT;
  const databaseInstanceId = process.env.LODESTAR_DATABASE_INSTANCE_ID;
  if (endpoint !== undefined || databaseInstanceId !== undefined) {
    return async () => ({
      endpoint,
      apiVersion: LODESTAR_API_VERSION,
      schemaVersion: SCHEMA_VERSION,
      packageVersion: LODESTAR_VERSION,
      databaseInstanceId,
    });
  }
  return () => ensureServiceViaPowerShell();
}

export async function executeContinuityCli(positionals, options, io) {
  const requested = positionals[0];
  const operation = OPERATIONS[requested]
    ?? (requested.startsWith("continuity_") ? requested : null);
  if (operation === null) {
    throw lodestarError(
      "unknown_continuity_operation",
      "The continuity operation is not supported.",
      { identifiers: { operation: requested } },
    );
  }
  const input = await continuityInput(operation, options, io);
  const client = createLodestarServiceClient({ ensure: ensureFunction() });
  return await client.call(operation, input);
}

export async function runCliService(database, options, onStarted) {
  const rawPort = options["--port"] ?? "0";
  if (!/^\d{1,5}$/u.test(rawPort)) {
    throw lodestarError("invalid_input", "The service port is invalid.");
  }
  const service = await startLodestarService({
    database,
    port: Number(rawPort),
  });
  await onStarted({
    endpoint: service.endpoint,
    pid: service.pid,
    apiVersion: service.apiVersion,
    schemaVersion: service.schemaVersion,
    packageVersion: service.packageVersion,
    databaseInstanceId: service.databaseInstanceId,
  });
  await service.completed;
}
