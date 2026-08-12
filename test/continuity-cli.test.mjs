import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runCli } from "../src/cli.mjs";
import { prepareContinuityRequest } from "../src/continuity.mjs";
import { startLodestarService } from "../src/service.mjs";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: Readable.from([]),
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

test("continuity CLI operations proxy through the loopback service", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-cli-v2-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await startLodestarService({
    database: path.join(directory, "lodestar.db"),
    discoveryPath: path.join(directory, "service.json"),
    idleTimeoutMs: 10_000,
  });
  t.after(() => service.close());
  const previousEndpoint = process.env.LODESTAR_SERVICE_ENDPOINT;
  const previousIdentity = process.env.LODESTAR_DATABASE_INSTANCE_ID;
  process.env.LODESTAR_SERVICE_ENDPOINT = service.endpoint;
  process.env.LODESTAR_DATABASE_INSTANCE_ID = service.databaseInstanceId;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.LODESTAR_SERVICE_ENDPOINT;
    else process.env.LODESTAR_SERVICE_ENDPOINT = previousEndpoint;
    if (previousIdentity === undefined) {
      delete process.env.LODESTAR_DATABASE_INSTANCE_ID;
    } else process.env.LODESTAR_DATABASE_INSTANCE_ID = previousIdentity;
  });

  const input = prepareContinuityRequest("continuity_arm", {
    project_key: "project:cli",
    session_id: "session:cli",
    turn_id: "turn:arm",
    packet_json: { state: "armed" },
  });
  const armed = capture();
  assert.equal(await runCli([
    "continuity",
    "arm",
    "--json-input",
    JSON.stringify(input),
  ], armed.io), 0, armed.output().stderr);
  const laneId = JSON.parse(armed.output().stdout).data.lane_id;

  const status = capture();
  assert.equal(await runCli([
    "continuity",
    "status",
    "--lane",
    laneId,
  ], status.io), 0, status.output().stderr);
  assert.equal(
    JSON.parse(status.output().stdout).data.lane.owner_session_id,
    "session:cli",
  );
});
