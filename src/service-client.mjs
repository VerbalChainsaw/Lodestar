import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import http from "node:http";

import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import { LODESTAR_API_VERSION } from "./service.mjs";
import { LODESTAR_VERSION } from "./version.mjs";

const RESPONSE_LIMIT = 1024 * 1024;
const CONNECTION_LOST = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "service_timeout",
]);

function parseObject(text, field) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch (error) {
    throw lodestarError(
      "service_protocol_error",
      `The Lodestar ${field} is not a valid JSON object.`,
      { cause: error },
    );
  }
}

function httpJson(endpoint, {
  method,
  pathname,
  body = null,
  timeoutMs,
  headers = {},
}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : canonicalStringify(body);
    const request = http.request(new URL(pathname, endpoint), {
      method,
      headers: {
        accept: "application/json",
        ...headers,
        ...(payload === null ? {} : {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload, "utf8"),
        }),
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) {
          request.destroy(lodestarError(
            "service_protocol_error",
            "The Lodestar service response exceeds its byte limit.",
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const value = parseObject(Buffer.concat(chunks).toString("utf8"),
            "service response");
          resolve({ status: response.statusCode, value });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(lodestarError(
      "service_timeout",
      "The Lodestar service request timed out.",
    )));
    request.on("error", reject);
    if (payload !== null) request.end(payload);
    else request.end();
  });
}

function remoteError(response) {
  const remote = response.value?.error;
  if (!remote || typeof remote.code !== "string") {
    return lodestarError(
      "service_protocol_error",
      "The Lodestar service returned an invalid error envelope.",
      { identifiers: { status: response.status } },
    );
  }
  return lodestarError(
    remote.code,
    typeof remote.message === "string"
      ? remote.message
      : "The Lodestar service rejected the operation.",
    {
      identifiers: remote.identifiers ?? {},
      action: remote.action,
    },
  );
}

function validateIdentity(discovery, health, expectedPackageVersion) {
  if (
    discovery.apiVersion !== LODESTAR_API_VERSION
    || discovery.schemaVersion !== SCHEMA_VERSION
    || discovery.packageVersion !== expectedPackageVersion
    || health.ok !== true
    || health.apiVersion !== LODESTAR_API_VERSION
    || health.schemaVersion !== SCHEMA_VERSION
    || health.packageVersion !== expectedPackageVersion
    || !/^[0-9a-f]{64}$/u.test(discovery.databaseInstanceId ?? "")
    || health.databaseInstanceId !== discovery.databaseInstanceId
  ) {
    throw lodestarError(
      "service_identity_mismatch",
      "The Lodestar service identity does not match the required runtime.",
    );
  }
}

export function createLodestarServiceClient({
  ensure,
  timeoutMs = 5_000,
  packageVersion = LODESTAR_VERSION,
} = {}) {
  if (typeof ensure !== "function") {
    throw lodestarError(
      "invalid_input",
      "The Lodestar service client requires an ensure function.",
    );
  }
  let cached = null;
  let databaseInstanceId = null;
  async function refresh() {
    const discovery = await ensure();
    const healthResponse = await httpJson(discovery.endpoint, {
      method: "GET",
      pathname: "/healthz",
      timeoutMs,
    });
    if (healthResponse.status !== 200) throw remoteError(healthResponse);
    validateIdentity(discovery, healthResponse.value, packageVersion);
    if (
      databaseInstanceId !== null
      && discovery.databaseInstanceId !== databaseInstanceId
    ) {
      throw lodestarError(
        "service_identity_mismatch",
        "The Lodestar database instance changed during this client session.",
        {
          identifiers: {
            expected: databaseInstanceId,
            actual: discovery.databaseInstanceId,
          },
        },
      );
    }
    databaseInstanceId = discovery.databaseInstanceId;
    cached = discovery;
    return cached;
  }
  async function call(operation, input) {
    if (cached === null) await refresh();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await httpJson(cached.endpoint, {
          method: "POST",
          pathname: "/v1/continuity",
          body: { operation, input },
          timeoutMs,
          headers: { "x-lodestar-api-version": "1" },
        });
        if (response.status !== 200) throw remoteError(response);
        if (response.value.ok !== true || response.value.data === undefined) {
          throw lodestarError(
            "service_protocol_error",
            "The Lodestar service returned an invalid success envelope.",
          );
        }
        return response.value.data;
      } catch (error) {
        if (attempt !== 0 || !CONNECTION_LOST.has(error?.code)) throw error;
        await refresh();
      }
    }
    throw lodestarError("service_unavailable", "The Lodestar service failed.");
  }
  return { call, refresh };
}

export function ensureServiceViaPowerShell({
  powershell = "powershell.exe",
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      '& "$env:USERPROFILE\\.local\\bin\\lodestar-service.ps1" ensure --json',
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length <= 65_536) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length <= 65_536) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(lodestarError(
        "service_bootstrap_failed",
        "The Windows Lodestar bootstrap could not start.",
        { cause: error },
      ));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(lodestarError(
          "service_bootstrap_failed",
          "The Windows Lodestar bootstrap failed.",
          { identifiers: { status, stderr: stderr.trim().slice(0, 2048) } },
        ));
        return;
      }
      const line = stdout.trim().split(/\r?\n/u).at(-1) ?? "";
      try {
        resolve(parseObject(line, "bootstrap response"));
      } catch (error) {
        reject(error);
      }
    });
  });
}
