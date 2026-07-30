import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicWriteFile } from "../lib/atomic-file.mjs";

test("atomic replacement recovers when direct overwrite is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-atomic-"));
  const destination = path.join(root, "current.json");
  let blocked = true;
  try {
    await writeFile(destination, "old");
    await atomicWriteFile(destination, "new", {
      fsApi: {
        writeFile,
        unlink,
        rename: async (from, to) => {
          if (blocked && to === destination && from.includes(".tmp-")) {
            blocked = false;
            throw Object.assign(new Error("simulated Windows collision"), {
              code: "EEXIST",
            });
          }
          return rename(from, to);
        },
      },
      nonce: () => "fixed",
    });
    assert.equal(await readFile(destination, "utf8"), "new");
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) =>
      readdir(root)), ["current.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed fallback restores the prior destination and cleans temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-atomic-fail-"));
  const destination = path.join(root, "current.json");
  let writesToDestination = 0;
  try {
    await writeFile(destination, "old");
    await assert.rejects(
      atomicWriteFile(destination, "new", {
        fsApi: {
          writeFile,
          unlink,
          rename: async (from, to) => {
            if (to === destination && from.includes(".tmp-")) {
              writesToDestination += 1;
              throw Object.assign(new Error("simulated failure"), {
                code: writesToDestination === 1 ? "EPERM" : "EIO",
              });
            }
            return rename(from, to);
          },
        },
        nonce: () => "fixed",
      }),
      (error) =>
        error.code === "atomic-replace-failed"
        && error.cause?.code === "EIO"
        && error.detail.phase === "fallback-replace",
    );
    assert.equal(await readFile(destination, "utf8"), "old");
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) =>
      readdir(root)), ["current.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
