import { mkdir, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { executeContinuityOperation } from "./continuity.mjs";
import {
  openOrInitializeWriteDatabase,
  readMetadata,
} from "./database.mjs";
import { errorEnvelope, lodestarError } from "./errors.mjs";
import {
  canonicalStringify,
  parseJsonText,
  readStreamBounded,
} from "./json.mjs";
import { defaultServiceDiscoveryPath } from "./paths.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import { LODESTAR_VERSION } from "./version.mjs";

export const LODESTAR_API_VERSION = 1;
export const SERVICE_BODY_LIMIT = 512 * 1024;
export const DEFAULT_SERVICE_IDLE_TIMEOUT_MS = 60_000;

function statusForError(error) {
  const code = String(error?.code ?? "");
  if (code === "resource_limit") return 413;
  if (code.includes("not_found")) return 404;
  if (code.includes("conflict") || code.includes("indeterminate")) return 409;
  if (code.startsWith("database_") || code.startsWith("migration_")) return 503;
  return 400;
}

function sendJson(response, status, value) {
  const text = canonicalStringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text, "utf8"),
    "cache-control": "no-store",
  });
  response.end(text);
}

async function writeDiscovery(file, discovery) {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${canonicalStringify(discovery)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, file);
}

function healthPayload(metadata, packageVersion) {
  return {
    ok: true,
    apiVersion: LODESTAR_API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    packageVersion,
    databaseInstanceId: metadata.database_instance_id,
  };
}

export async function startLodestarService({
  database,
  port = 0,
  discoveryPath = defaultServiceDiscoveryPath(),
  idleTimeoutMs = DEFAULT_SERVICE_IDLE_TIMEOUT_MS,
  packageVersion = LODESTAR_VERSION,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw lodestarError("invalid_input", "The service port is invalid.");
  }
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw lodestarError(
      "invalid_input",
      "The service idle timeout is invalid.",
    );
  }
  const db = await openOrInitializeWriteDatabase(database);
  const metadata = readMetadata(db, database);
  const health = healthPayload(metadata, packageVersion);
  let idleTimer = null;
  let closed = false;
  let closeResolve;
  const completed = new Promise((resolve) => {
    closeResolve = resolve;
  });
  const server = http.createServer(async (request, response) => {
    clearTimeout(idleTimer);
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, health);
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/continuity") {
        sendJson(response, 404, {
          ok: false,
          error: { code: "not_found", message: "Route not found." },
        });
        return;
      }
      if (request.headers["x-lodestar-api-version"] !== "1") {
        throw lodestarError(
          "api_version_mismatch",
          "The Lodestar API version header is missing or unsupported.",
          {
            identifiers: {
              expected: LODESTAR_API_VERSION,
              actual: request.headers["x-lodestar-api-version"] ?? null,
            },
          },
        );
      }
      const text = await readStreamBounded(request, {
        maximum: SERVICE_BODY_LIMIT,
        resource: "continuity_request",
      });
      const body = parseJsonText(text, {
        maximum: SERVICE_BODY_LIMIT,
        resource: "continuity_request",
      });
      if (
        body === null
        || typeof body !== "object"
        || Array.isArray(body)
        || typeof body.operation !== "string"
        || body.input === undefined
      ) {
        throw lodestarError(
          "invalid_input",
          "The continuity service request envelope is invalid.",
        );
      }
      const data = executeContinuityOperation(
        db,
        body.operation,
        body.input,
        { database },
      );
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, statusForError(error), errorEnvelope(error));
      } else response.destroy();
    } finally {
      if (!closed) {
        idleTimer = setTimeout(() => server.close(), idleTimeoutMs);
        idleTimer.unref();
      }
    }
  });
  server.on("close", () => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    db.close();
    closeResolve();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    server.on("error", () => {
      if (!closed && server.listening) server.close();
    });
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}`;
    const discovery = {
      endpoint,
      pid: process.pid,
      apiVersion: LODESTAR_API_VERSION,
      schemaVersion: SCHEMA_VERSION,
      packageVersion,
      databaseInstanceId: metadata.database_instance_id,
    };
    await writeDiscovery(discoveryPath, discovery);
    idleTimer = setTimeout(() => server.close(), idleTimeoutMs);
    idleTimer.unref();
    return {
      ...discovery,
      completed,
      close: () => new Promise((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
      }),
    };
  } catch (error) {
    if (!closed && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    } else if (!closed) {
      closed = true;
      db.close();
    }
    throw error;
  }
}
