import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareContinuityRequest } from "../src/continuity.mjs";
import { createLodestarServiceClient } from "../src/service-client.mjs";
import {
  SERVICE_BODY_LIMIT,
  startLodestarService,
} from "../src/service.mjs";

async function directory(t) {
  const result = await mkdtemp(path.join(os.tmpdir(), "lodestar-service-"));
  t.after(() => rm(result, { recursive: true, force: true }));
  return result;
}

function discovery(service) {
  return {
    endpoint: service.endpoint,
    pid: service.pid,
    apiVersion: service.apiVersion,
    schemaVersion: service.schemaVersion,
    packageVersion: service.packageVersion,
    databaseInstanceId: service.databaseInstanceId,
  };
}

function request(endpoint, {
  method = "GET",
  pathname = "/healthz",
  body = null,
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(pathname, endpoint), {
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("service health, discovery, API version, and body cap are enforced", async (t) => {
  const root = await directory(t);
  const discoveryPath = path.join(root, "service.json");
  const service = await startLodestarService({
    database: path.join(root, "lodestar.db"),
    discoveryPath,
    idleTimeoutMs: 10_000,
  });
  t.after(() => service.close());
  assert.match(service.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const health = await request(service.endpoint);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), {
    ok: true,
    apiVersion: 1,
    schemaVersion: 2,
    packageVersion: "1.0.3",
    databaseInstanceId: service.databaseInstanceId,
  });
  assert.deepEqual(
    JSON.parse(await readFile(discoveryPath, "utf8")),
    discovery(service),
  );

  const missingVersion = await request(service.endpoint, {
    method: "POST",
    pathname: "/v1/continuity",
    body: JSON.stringify({ operation: "continuity_status", input: { all: true } }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(missingVersion.status, 400);
  assert.equal(JSON.parse(missingVersion.body).error.code, "api_version_mismatch");

  const oversized = await request(service.endpoint, {
    method: "POST",
    pathname: "/v1/continuity",
    body: Buffer.alloc(SERVICE_BODY_LIMIT + 1, 0x20),
    headers: {
      "content-type": "application/json",
      "x-lodestar-api-version": "1",
    },
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error.code, "resource_limit");
});

test("the client retries one refusal through ensure and preserves identity", async (t) => {
  const root = await directory(t);
  const database = path.join(root, "lodestar.db");
  const discoveryPath = path.join(root, "service.json");
  const first = await startLodestarService({
    database,
    discoveryPath,
    idleTimeoutMs: 10_000,
  });
  let second = null;
  let ensures = 0;
  const ensure = async () => {
    ensures += 1;
    if (ensures === 1) return discovery(first);
    second ??= await startLodestarService({
      database,
      discoveryPath,
      idleTimeoutMs: 10_000,
    });
    return discovery(second);
  };
  t.after(async () => {
    await first.close();
    await second?.close();
  });
  const client = createLodestarServiceClient({ ensure });
  const arm = await client.call(
    "continuity_arm",
    prepareContinuityRequest("continuity_arm", {
      project_key: "project:test",
      session_id: "session:source",
      turn_id: "turn:arm",
      packet_json: { state: "armed" },
    }),
  );
  await first.close();
  const status = await client.call("continuity_status", {
    lane_id: arm.lane_id,
  });
  assert.equal(status.lane.owner_session_id, "session:source");
  assert.equal(ensures, 2);
  assert.equal(second.databaseInstanceId, first.databaseInstanceId);
});

test("idle exit and restart retain database identity", async (t) => {
  const root = await directory(t);
  const database = path.join(root, "lodestar.db");
  const discoveryPath = path.join(root, "service.json");
  const first = await startLodestarService({
    database,
    discoveryPath,
    idleTimeoutMs: 30,
  });
  await first.completed;
  const second = await startLodestarService({
    database,
    discoveryPath,
    idleTimeoutMs: 10_000,
  });
  t.after(() => second.close());
  assert.notEqual(second.endpoint, first.endpoint);
  assert.equal(second.databaseInstanceId, first.databaseInstanceId);
});

test("the client rejects a changed database identity after refusal", async (t) => {
  const root = await directory(t);
  const first = await startLodestarService({
    database: path.join(root, "first.db"),
    discoveryPath: path.join(root, "first.json"),
    idleTimeoutMs: 10_000,
  });
  let replacement = null;
  let ensures = 0;
  const client = createLodestarServiceClient({
    ensure: async () => {
      ensures += 1;
      if (ensures === 1) return discovery(first);
      replacement ??= await startLodestarService({
        database: path.join(root, "replacement.db"),
        discoveryPath: path.join(root, "replacement.json"),
        idleTimeoutMs: 10_000,
      });
      return discovery(replacement);
    },
  });
  t.after(async () => {
    await first.close();
    await replacement?.close();
  });
  await client.refresh();
  await first.close();
  await assert.rejects(
    client.call("continuity_status", { all: true }),
    ({ code }) => code === "service_identity_mismatch",
  );
});
