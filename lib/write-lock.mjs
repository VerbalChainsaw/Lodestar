import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { canonicalStringify } from "./canonical-json.mjs";
import { LodestarError } from "./errors.mjs";
import { statePaths } from "./store-layout.mjs";
import { ContextError } from "./validation.mjs";

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

function normalizedHostname(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase()
    .replace(/\.$/, "");
}

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

async function readJson(file, fsApi) {
  try {
    return JSON.parse(await operation(fsApi, "readFile")(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readLock(lockPath, fsApi) {
  const [owner, heartbeat] = await Promise.all([
    readJson(path.join(lockPath, "owner.json"), fsApi),
    readJson(path.join(lockPath, "heartbeat.json"), fsApi),
  ]);
  return { owner, heartbeat };
}

async function cleanupLockDirectory(lockPath, fsApi) {
  const unlink = operation(fsApi, "unlink");
  const rmdir = operation(fsApi, "rmdir");
  for (const file of ["heartbeat.json", "owner.json"]) {
    await unlink(path.join(lockPath, file)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await rmdir(lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function assertOwner(lockPath, expectedNonce, fsApi) {
  const owner = await readJson(path.join(lockPath, "owner.json"), fsApi);
  if (owner?.nonce !== expectedNonce) {
    throw new ContextError("lock-ownership-lost", {
      expected_nonce: expectedNonce,
      actual_nonce: owner?.nonce ?? null,
    });
  }
  return owner;
}

export async function acquireWriteLock({
  home,
  timeoutMs = 2_000,
  staleGraceMs = 30_000,
  retryMs = 25,
  now = Date.now,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  hostname = os.hostname(),
  runtime = process.platform,
  pid = process.pid,
  isProcessAlive = defaultProcessAlive,
  nonce = randomUUID,
  fsApi = fs,
} = {}) {
  const lockPath = statePaths(home).lock;
  const ownerNonce = nonce();
  const deadline = now() + timeoutMs;
  const mkdir = operation(fsApi, "mkdir");
  const writeFile = operation(fsApi, "writeFile");
  const rename = operation(fsApi, "rename");

  while (true) {
    try {
      await mkdir(lockPath);
      const owner = {
        v: 1,
        nonce: ownerNonce,
        pid,
        hostname,
        runtime,
        started_at: now(),
      };
      try {
        await writeFile(
          path.join(lockPath, "owner.json"),
          `${canonicalStringify(owner)}\n`,
          "utf8",
        );
        await writeFile(
          path.join(lockPath, "heartbeat.json"),
          `${canonicalStringify({ v: 1, nonce: ownerNonce, at: now() })}\n`,
          "utf8",
        );
      } catch (error) {
        await cleanupLockDirectory(lockPath, fsApi);
        throw error;
      }

      return {
        path: lockPath,
        nonce: ownerNonce,
        owner,
        async refresh() {
          await assertOwner(lockPath, ownerNonce, fsApi);
          await writeFile(
            path.join(lockPath, "heartbeat.json"),
            `${canonicalStringify({
              v: 1,
              nonce: ownerNonce,
              at: now(),
            })}\n`,
            "utf8",
          );
        },
        async release() {
          await assertOwner(lockPath, ownerNonce, fsApi);
          const releasedPath = `${lockPath}.released-${ownerNonce}`;
          await rename(lockPath, releasedPath);
          try {
            await cleanupLockDirectory(releasedPath, fsApi);
            return { released: true, cleanup: { ok: true } };
          } catch (error) {
            // The atomic rename relinquishes ownership before cleanup. A stale
            // released directory is diagnosable but must not turn a completed
            // mutation into a reported failure or block the next writer.
            return {
              released: true,
              cleanup: {
                ok: false,
                path: releasedPath,
                code: error.code ?? "lock-cleanup-failed",
              },
            };
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const state = await readLock(lockPath, fsApi);
    const owner = state.owner;
    const heartbeatAt = state.heartbeat
      && owner
      && state.heartbeat.nonce === owner.nonce
      ? state.heartbeat.at
      : null;
    let alive = null;
    const sameHost = normalizedHostname(owner?.hostname)
      === normalizedHostname(hostname);
    const sameRuntime = owner?.runtime === undefined
      || owner.runtime === runtime;
    if (sameHost && sameRuntime && Number.isInteger(owner.pid)) {
      alive = isProcessAlive(owner.pid);
    }
    const stale = sameHost
      && sameRuntime
      && alive === false
      && typeof heartbeatAt === "number"
      && now() - heartbeatAt > staleGraceMs;

    if (stale) {
      const quarantine = `${lockPath}.stale-${ownerNonce}`;
      try {
        await rename(lockPath, quarantine);
        await cleanupLockDirectory(quarantine, fsApi);
        continue;
      } catch (error) {
        if (["ENOENT", "EEXIST"].includes(error.code)) continue;
        throw error;
      }
    }

    if (now() >= deadline) {
      throw new ContextError("store-write-locked", {
        path: lockPath,
        owner,
        heartbeat_at: heartbeatAt,
        liveness: alive,
        same_machine: sameHost,
        same_runtime: sameRuntime,
        repair: [
          "Wait for the active writer to finish and retry.",
          "A dead same-host writer is reclaimed automatically after the stale-lock grace period.",
          "Do not delete the lock while its owner process may still be running.",
        ].join(" "),
      });
    }
    await sleep(Math.min(retryMs, Math.max(0, deadline - now())));
  }
}

export async function withWriteLock(options, operationCallback) {
  const lock = await acquireWriteLock(options);
  const intervalMs = options.heartbeatIntervalMs ?? 1_000;
  let heartbeatError = null;
  const timer = setInterval(() => {
    lock.refresh().catch((error) => {
      heartbeatError ??= error;
    });
  }, intervalMs);
  timer.unref?.();
  let result;
  let operationError = null;
  try {
    result = await operationCallback(lock);
    if (heartbeatError) throw heartbeatError;
  } catch (error) {
    operationError = error;
  }
  clearInterval(timer);
  let releaseResult = null;
  let releaseError = null;
  try {
    releaseResult = await lock.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError && releaseError) {
    throw new LodestarError(
      "write-operation-and-lock-release-failed",
      "The operation failed and its writer lock could not be released",
      {
        cause: new AggregateError([operationError, releaseError]),
        detail: {
          operation_completed: false,
          operation_code: operationError.code ?? null,
          release_code: releaseError.code ?? null,
          lock: lock.path,
        },
      },
    );
  }
  if (operationError) throw operationError;
  if (releaseError) {
    throw new LodestarError(
      "write-lock-release-failed",
      "The operation completed but its writer lock could not be released",
      {
        cause: releaseError,
        detail: {
          operation_completed: true,
          release_code: releaseError.code ?? null,
          lock: lock.path,
        },
      },
    );
  }
  if (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && releaseResult?.cleanup?.ok === false
  ) {
    return {
      ...result,
      lock_release: releaseResult,
    };
  }
  return result;
}

export async function probeWriteSemantics(
  home,
  { nonce = randomUUID, fsApi = fs } = {},
) {
  const token = nonce();
  const original = path.join(home, `.write-probe-${token}`);
  const renamed = path.join(home, `.write-probe-${token}-renamed`);
  const mkdir = operation(fsApi, "mkdir");
  const writeFile = operation(fsApi, "writeFile");
  const rename = operation(fsApi, "rename");
  const unlink = operation(fsApi, "unlink");
  const rmdir = operation(fsApi, "rmdir");
  try {
    await mkdir(original);
    await writeFile(path.join(original, "probe"), token, "utf8");
    await rename(original, renamed);
    await unlink(path.join(renamed, "probe"));
    await rmdir(renamed);
    return { ok: true };
  } catch (error) {
    for (const directory of [renamed, original]) {
      await unlink(path.join(directory, "probe")).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
    return { ok: false, code: error.code ?? "unknown" };
  }
}
