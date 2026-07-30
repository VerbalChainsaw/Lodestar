import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireWriteLock,
  probeWriteSemantics,
  withWriteLock,
} from "../lib/write-lock.mjs";

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lodestar-lock-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function options(home, overrides = {}) {
  return {
    home,
    timeoutMs: 0,
    staleGraceMs: 1_000,
    retryMs: 1,
    now: () => 10_000,
    sleep: async () => {},
    hostname: "test-host",
    pid: 100,
    isProcessAlive: () => true,
    nonce: () => "owner-nonce",
    ...overrides,
  };
}

test("acquires an atomic directory lock and records its owner", async () => {
  await fixture(async (home) => {
    const lock = await acquireWriteLock(options(home));
    const owner = JSON.parse(
      await readFile(path.join(home, ".write-lock", "owner.json"), "utf8"),
    );
    assert.deepEqual(owner, {
      v: 1,
      nonce: "owner-nonce",
      pid: 100,
      hostname: "test-host",
      runtime: process.platform,
      started_at: 10_000,
    });
    assert.equal(
      JSON.parse(
        await readFile(path.join(home, ".write-lock", "heartbeat.json"), "utf8"),
      ).at,
      10_000,
    );
    await lock.release();
    assert.deepEqual(await readdir(home), []);
  });
});

test("an old lock owned by a live process is never reclaimed", async () => {
  await fixture(async (home) => {
    const owner = await acquireWriteLock(options(home, {
      now: () => 0,
    }));
    await assert.rejects(
      acquireWriteLock(options(home, {
        now: () => 1_000_000,
        pid: 200,
        nonce: () => "contender",
        isProcessAlive: () => true,
      })),
      (error) => error.code === "store-write-locked"
        && error.detail.owner.pid === 100,
    );
    await owner.release();
  });
});

test("a lock timeout reports safe recovery without inventing a command", async () => {
  await fixture(async (home) => {
    const owner = await acquireWriteLock(options(home, {
      now: () => 0,
    }));
    await assert.rejects(
      acquireWriteLock(options(home, {
        now: () => 5_000,
        pid: 200,
        nonce: () => "contender",
        isProcessAlive: () => true,
      })),
      (error) => {
        assert.equal(error.code, "store-write-locked");
        assert.match(error.detail.repair, /active writer/i);
        assert.match(error.detail.repair, /automatically/i);
        assert.doesNotMatch(error.detail.repair, /--repair-lock/);
        return true;
      },
    );
    await owner.release();
  });
});

test("reclaims only a dead same-host lock with an expired heartbeat", async () => {
  await fixture(async (home) => {
    await acquireWriteLock(options(home, {
      now: () => 0,
      pid: 100,
      nonce: () => "abandoned",
    }));
    const contender = await acquireWriteLock(options(home, {
      now: () => 5_000,
      pid: 200,
      nonce: () => "new-owner",
      isProcessAlive: (pid) => pid === 200,
    }));
    assert.equal(contender.nonce, "new-owner");
    assert.deepEqual(
      (await readdir(home)).filter((entry) => entry.includes("stale")),
      [],
    );
    await contender.release();
  });
});

test("same-machine hostnames compare case-insensitively", async () => {
  await fixture(async (home) => {
    await acquireWriteLock(options(home, {
      hostname: "Gigaflex",
      now: () => 0,
      nonce: () => "abandoned",
    }));
    const contender = await acquireWriteLock(options(home, {
      hostname: "GIGAFLEX",
      now: () => 5_000,
      pid: 200,
      nonce: () => "new-owner",
      isProcessAlive: () => false,
    }));
    assert.equal(contender.nonce, "new-owner");
    await contender.release();
  });
});

test("different Windows and WSL PID namespaces are never auto-reclaimed", async () => {
  await fixture(async (home) => {
    const owner = await acquireWriteLock(options(home, {
      hostname: "Gigaflex",
      runtime: "linux",
      now: () => 0,
      nonce: () => "wsl-owner",
    }));
    await assert.rejects(
      acquireWriteLock(options(home, {
        hostname: "GIGAFLEX",
        runtime: "win32",
        now: () => 5_000,
        pid: 200,
        nonce: () => "windows-contender",
        isProcessAlive: () => false,
      })),
      (error) =>
        error.code === "store-write-locked"
        && error.detail.same_machine === true
        && error.detail.same_runtime === false
        && error.detail.liveness === null,
    );
    await owner.release();
  });
});

test("does not reclaim fresh, remote, or ambiguously live locks", async () => {
  for (const scenario of [
    {
      name: "fresh",
      contender: { now: () => 500, isProcessAlive: () => false },
    },
    {
      name: "remote",
      owner: { hostname: "remote-host" },
      contender: { now: () => 5_000, isProcessAlive: () => false },
    },
    {
      name: "ambiguous",
      contender: { now: () => 5_000, isProcessAlive: () => null },
    },
  ]) {
    await fixture(async (home) => {
      const owner = await acquireWriteLock(options(home, {
        now: () => 0,
        nonce: () => `${scenario.name}-owner`,
        ...scenario.owner,
      }));
      await assert.rejects(
        acquireWriteLock(options(home, {
          pid: 200,
          nonce: () => `${scenario.name}-contender`,
          ...scenario.contender,
        })),
        { code: "store-write-locked" },
      );
      await owner.release();
    });
  }
});

test("refresh and release require the original nonce", async () => {
  await fixture(async (home) => {
    const lock = await acquireWriteLock(options(home));
    const ownerPath = path.join(home, ".write-lock", "owner.json");
    await writeFile(ownerPath, JSON.stringify({
      v: 1,
      nonce: "replacement",
      pid: 999,
      hostname: "test-host",
      runtime: process.platform,
      started_at: 10_001,
    }));
    await assert.rejects(lock.refresh(), { code: "lock-ownership-lost" });
    await assert.rejects(lock.release(), { code: "lock-ownership-lost" });
  });
});

test("competing acquisitions produce one owner", async () => {
  await fixture(async (home) => {
    const attempts = await Promise.allSettled([
      acquireWriteLock(options(home, {
        nonce: () => "first",
        pid: 1,
      })),
      acquireWriteLock(options(home, {
        nonce: () => "second",
        pid: 2,
      })),
    ]);
    assert.equal(
      attempts.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    assert.equal(
      attempts.filter(
        ({ status, reason }) =>
          status === "rejected" && reason.code === "store-write-locked",
      ).length,
      1,
    );
    const acquired = attempts.find(({ status }) => status === "fulfilled").value;
    await acquired.release();
  });
});

test("default contention budget lets a healthy slow writer finish", async () => {
  await fixture(async (home) => {
    let time = 0;
    let released = false;
    const owner = await acquireWriteLock(options(home, {
      now: () => time,
      nonce: () => "slow-owner",
    }));
    const contender = await acquireWriteLock({
      home,
      staleGraceMs: 30_000,
      retryMs: 1_000,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
        if (time >= 3_000 && !released) {
          await owner.release();
          released = true;
        }
      },
      hostname: "test-host",
      pid: 200,
      isProcessAlive: () => true,
      nonce: () => "patient-contender",
    });
    assert.equal(contender.nonce, "patient-contender");
    assert.equal(time, 3_000);
    await contender.release();
  });
});

test("withWriteLock releases after success and failure", async () => {
  await fixture(async (home) => {
    assert.equal(
      await withWriteLock(options(home), async () => "done"),
      "done",
    );
    await assert.rejects(
      withWriteLock(options(home), async () => {
        throw new Error("operation failed");
      }),
      /operation failed/,
    );
    assert.deepEqual(await readdir(home), []);
  });
});

test("write-semantics probe leaves no files behind", async () => {
  await fixture(async (home) => {
    assert.deepEqual(
      await probeWriteSemantics(home, { nonce: () => "probe" }),
      { ok: true },
    );
    assert.deepEqual(await readdir(home), []);
  });
});
