import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../agentctx.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { diagnoseStore } from "../lib/doctor.mjs";
import {
  buildGeneration,
  promoteGeneration,
  readCurrentGeneration,
} from "../lib/generation.mjs";
import { buildIndexes } from "../lib/indexes.mjs";
import { probeLocatorHealth } from "../lib/locator-health.mjs";
import {
  maintainStore,
} from "../lib/maintenance.mjs";
import {
  createSnapshot,
  restoreSnapshot,
} from "../lib/snapshot.mjs";
import { withWriteLock } from "../lib/write-lock.mjs";
import { withStoreFixture } from "../test-support/store-fixture.mjs";

function record(id, overrides = {}) {
  return {
    v: 1,
    id,
    kind: "answer",
    priority: 100,
    scope: ["global"],
    links: [],
    ...overrides,
  };
}

function emptySource() {
  return {
    catalog: { v: 1, projects: [] },
    schema: { v: 1, record_kinds: ["answer", "index"] },
    globalRecords: [record("g:base")],
    projectRecords: {},
  };
}

async function temporary(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-security-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("locator health translates cataloged Windows roots under WSL", async () => {
  const root = "/mnt/c/Users/alex/project";
  const target = `${root}/docs/guide.md`;
  const result = await probeLocatorHealth({
    project: {
      id: "p:sample",
      roots: ["C:/Users/alex/project"],
    },
    locator: { type: "file", path: "docs/guide.md" },
  }, {
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    release: "6.8.0-microsoft-standard-WSL2",
    cwd: "/work",
    fsApi: {
      async realpath(value) {
        if (value === root || value === target) return value;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
  });
  assert.deepEqual(result, {
    status: "ok",
    checked_path: target,
  });
});

test("doctor reports one authoritative unhealthy issue per locator", async () => {
  await withStoreFixture(async (home) => {
    const projectRoot = path.join(home, "project");
    await mkdir(projectRoot);
    return {
      catalog: {
        v: 1,
        projects: [{
          id: "p:sample",
          name: "Sample",
          roots: [projectRoot],
        }],
      },
      schema: { v: 1, record_kinds: ["index"] },
      globalRecords: [],
      projectRecords: {
        "p:sample": [{
          ...record("p:sample:index", {
            kind: "index",
            scope: ["project:p:sample"],
          }),
          locators: [{ type: "file", path: "missing.md" }],
        }],
      },
      probeLocator: async () => ({ status: "missing" }),
    };
  }, async ({ home }) => {
    const report = await diagnoseStore({ home, deep: true });
    assert.equal(
      report.issues.filter(({ code, locator }) =>
        code === "locator-unhealthy"
        && locator === "p:sample:index#0").length,
      1,
    );
  });
});

test("curated writes and doctor reject physical locator escapes", {
  skip: process.platform === "win32"
    ? "directory symlink creation requires environment-specific privileges"
    : false,
}, async () => {
  await withStoreFixture(async (home) => {
    const projectRoot = path.join(home, "project");
    const outside = path.join(home, "outside");
    await Promise.all([mkdir(projectRoot), mkdir(outside)]);
    await symlink(outside, path.join(projectRoot, "escape"), "dir");
    return {
      catalog: {
        v: 1,
        projects: [{
          id: "p:sample",
          name: "Sample",
          roots: [projectRoot],
        }],
      },
      schema: { v: 1, record_kinds: ["index"] },
      globalRecords: [],
      projectRecords: {
        "p:sample": [{
          ...record("p:sample:legacy", {
            kind: "index",
            scope: ["project:p:sample"],
          }),
          locators: [{ type: "file", path: "escape/secret.md" }],
        }],
      },
      projectRoot,
    };
  }, async ({ home, source }) => {
    const report = await diagnoseStore({ home, deep: true });
    assert.equal(report.ok, false);
    assert.equal(
      report.issues.some(({ code }) => code === "locator-escape"),
      true,
    );
    const store = await ContextStore.open({ home, cwd: source.projectRoot });
    await assert.rejects(
      store.put({
        ...record("p:sample:new", {
          kind: "index",
          scope: ["project:p:sample"],
        }),
        locators: [{ type: "file", path: "escape/new.md" }],
      }),
      { code: "locator-escape" },
    );
  });
});

test("snapshot rejects a symlink alias that resolves inside its source", {
  skip: process.platform === "win32"
    ? "directory symlink creation requires environment-specific privileges"
    : false,
}, async () => {
  await withStoreFixture(emptySource(), async ({ home }) => {
    const parent = path.dirname(home);
    const alias = path.join(parent, `${path.basename(home)}-alias`);
    await symlink(home, alias, "dir");
    try {
      await assert.rejects(
        createSnapshot({
          home,
          destination: path.join(alias, "nested-snapshot"),
        }),
        { code: "snapshot-path-overlap" },
      );
      assert.equal((await diagnoseStore({ home, deep: true })).ok, true);
    } finally {
      await rm(alias, { force: true });
    }
  });
});

test("snapshot never replaces a destination created during publication", async () => {
  await temporary(async (root) => {
    await withStoreFixture(emptySource(), async ({ home }) => {
      const destination = path.join(root, "snapshot");
      let raced = false;
      const fsApi = {
        async mkdir(target, options) {
          if (target === destination && !raced) {
            raced = true;
            await mkdir(destination);
          }
          return mkdir(target, options);
        },
      };
      await assert.rejects(
        createSnapshot({ home, destination, fsApi }),
        { code: "snapshot-create-failed" },
      );
      assert.equal(raced, true);
      assert.deepEqual(await readdir(destination), []);
    });
  });
});

test("maintenance rolls back retention and audit rotation together", async () => {
  await withStoreFixture(emptySource(), async ({ home }) => {
    const store = await ContextStore.open({ home });
    for (let index = 0; index < 4; index += 1) {
      await store.put(record(`g:history:${index}`));
    }
    const before = (await readdir(path.join(home, "generations")))
      .filter((entry) => /^[a-f0-9]{64}$/.test(entry))
      .sort();
    const events = path.join(home, "events.jsonl");
    await writeFile(events, `${JSON.stringify({ op: "seed" })}\n`);
    const fsApi = {
      async writeFile(file, content, encoding) {
        if (
          file.startsWith(`${events}.tmp-`)
          && String(content).includes("\"op\":\"maintain\"")
        ) {
          throw Object.assign(new Error("audit append failed"), { code: "EIO" });
        }
        return writeFile(file, content, encoding);
      },
    };
    await assert.rejects(
      maintainStore({
        home,
        apply: true,
        retain: 2,
        auditMaxBytes: 1,
        checkDrift: false,
        fsApi,
      }),
    );
    const after = (await readdir(path.join(home, "generations")))
      .filter((entry) => /^[a-f0-9]{64}$/.test(entry))
      .sort();
    assert.deepEqual(after, before);
    assert.equal(
      (await readdir(home)).some((entry) =>
        /^events\..+\.jsonl$/.test(entry)),
      false,
    );
    assert.equal(
      JSON.parse((await readFile(events, "utf8")).trim()).op,
      "seed",
    );
  });
});

test("snapshot and restore preserve every referenced rotated audit file", async () => {
  await temporary(async (root) => {
    await withStoreFixture(emptySource(), async ({ home }) => {
      await writeFile(
        path.join(home, "events.jsonl"),
        `${JSON.stringify({ at: "2026-07-30T00:00:00.000Z", op: "seed" })}\n`,
      );
      await maintainStore({
        home,
        apply: true,
        retain: 10,
        auditMaxBytes: 1,
        checkDrift: false,
      });
      const snapshot = path.join(root, "snapshot");
      const restored = path.join(root, "restored");
      await createSnapshot({ home, destination: snapshot });
      await restoreSnapshot({ snapshot, destination: restored });
      const checkpoint = JSON.parse(
        (await readFile(path.join(restored, "events.jsonl"), "utf8"))
          .trim()
          .split(/\r?\n/)[0],
      );
      assert.equal(checkpoint.op, "audit-rotate");
      assert.equal(
        (await readFile(
          path.join(restored, checkpoint.previous_file),
          "utf8",
        )).includes("\"op\":\"seed\""),
        true,
      );
    });
  });
});

test("quarantined generations have a validated supported recovery command", async () => {
  await withStoreFixture(emptySource(), async ({ home }) => {
    const store = await ContextStore.open({ home });
    for (let index = 0; index < 3; index += 1) {
      await store.put(record(`g:recover:${index}`));
    }
    const applied = await maintainStore({
      home,
      apply: true,
      retain: 2,
      checkDrift: false,
    });
    const generation = applied.changes.quarantined[0].generation;
    const output = [];
    const code = await run(["recover", generation, "--home", home], {
      stdout: (line) => output.push(JSON.parse(line)),
      stderr: (line) => assert.fail(line),
    });
    assert.equal(code, 0);
    const recovered = output[0];
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.promoted, false);
    assert.equal(
      (await readdir(path.join(home, "generations"))).includes(generation),
      true,
    );
    assert.equal(
      (await readFile(path.join(home, "events.jsonl"), "utf8"))
        .includes("\"op\":\"recover-quarantine\""),
      true,
    );
  });
});

test("Windows-style atomic fallback keeps a readable displaced pointer", async () => {
  await temporary(async (home) => {
    await mkdir(path.join(home, "generations"));
    const first = await buildGeneration({
      home,
      source: emptySource(),
      indexBuilder: (id, persisted) => buildIndexes({
        generation: id,
        catalog: persisted.catalog,
        globalRecords: persisted.globalRecords,
        projectRecords: persisted.projectRecords,
      }),
    });
    await promoteGeneration({ home, generation: first });
    const nextSource = emptySource();
    nextSource.globalRecords.push(record("g:next"));
    const second = await buildGeneration({
      home,
      source: nextSource,
      indexBuilder: (id, persisted) => buildIndexes({
        generation: id,
        catalog: persisted.catalog,
        globalRecords: persisted.globalRecords,
        projectRecords: persisted.projectRecords,
      }),
    });
    const current = path.join(home, "current.json");
    let direct = true;
    let during = null;
    const fsApi = {
      async rename(from, to) {
        if (to === current && from.startsWith(`${current}.tmp-`) && direct) {
          direct = false;
          throw Object.assign(new Error("Windows replace denied"), {
            code: "EPERM",
          });
        }
        if (to === current && from.startsWith(`${current}.tmp-`)) {
          during = await readCurrentGeneration(home);
        }
        return rename(from, to);
      },
    };
    await promoteGeneration({ home, generation: second, fsApi });
    assert.equal(during.id, first.id);
    assert.equal((await readCurrentGeneration(home)).id, second.id);
  });
});

test("lock cleanup failure returns committed cleanup evidence", async () => {
  await temporary(async (home) => {
    const visible = path.join(home, "visible");
    const result = await withWriteLock({
      home,
      nonce: () => "fixed",
      fsApi: {
        async rmdir(target) {
          if (target.includes(".write-lock.released-")) {
            throw Object.assign(new Error("cleanup failed"), { code: "EIO" });
          }
          return rm(target, { recursive: false });
        },
      },
    }, async () => {
      await writeFile(visible, "yes");
      return { committed: true };
    });
    assert.equal(await readFile(visible, "utf8"), "yes");
    assert.equal(result.committed, true);
    assert.equal(result.lock_release.cleanup.ok, false);
  });
});

test("put rejects oversized stdin before JSON parsing or persistence", async () => {
  await withStoreFixture(emptySource(), async ({ home }) => {
    const errors = [];
    const code = await run(["put", "--home", home], {
      stdin: async () => "x".repeat(128 * 1024 + 1),
      stdout: () => assert.fail("oversized input must not produce output"),
      stderr: (line) => errors.push(JSON.parse(line)),
    });
    assert.equal(code, 1);
    assert.equal(errors[0].error.code, "resource-limit-exceeded");
    assert.equal(
      (await ContextStore.open({ home }).then((store) =>
        store.get("g:base"))).id,
      "g:base",
    );
  });
});

test("active generation pointers are read within a strict byte budget", async () => {
  await temporary(async (root) => {
    await writeFile(
      path.join(root, "current.json"),
      `{"v":1,"generation":"${"a".repeat(70 * 1024)}"}`,
    );
    await assert.rejects(
      readCurrentGeneration(root),
      {
        code: "resource-limit-exceeded",
      },
    );
  });
});
