import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { canonicalStringify } from "./canonical-json.mjs";
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
          await cleanupLockDirectory(lockPath, fsApi);
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const state = await readLock(lockPath, fsApi);
    const owner = state.owner;
    const heartbeatAt = state.heartbeat?.nonce === owner?.nonce
      ? state.heartbeat.at
      : null;
    let alive = null;
    if (owner?.hostname === hostname && Number.isInteger(owner.pid)) {
      alive = isProcessAlive(owner.pid);
    }
    const stale = owner?.hostname === hostname
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
        repair: "agentctx doctor --repair-lock",
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
  try {
    const result = await operationCallback(lock);
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(timer);
    await lock.release();
  }
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
