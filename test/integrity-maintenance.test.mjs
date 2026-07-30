import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../agentctx.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { diagnoseStore } from "../lib/doctor.mjs";
import { maintainStore } from "../lib/maintenance.mjs";
import { assertCatalogLimits } from "../lib/resource-limits.mjs";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../lib/snapshot.mjs";
import { initializeStateHome } from "../lib/state-home.mjs";
import { validateRecord } from "../lib/validation.mjs";
import { profileProjects } from "../tools/profile-projects.mjs";

async function temporary(runTest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-integrity-"));
  try {
    await runTest(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(id) {
  return {
    v: 1,
    id,
    kind: "answer",
    priority: 100,
    scope: ["global"],
    links: [],
    facts: { value: id },
  };
}

test("new generations are sealed and deep doctor detects valid-JSON tampering", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await initializeStateHome({ destination: home });
    const current = JSON.parse(await readFile(
      path.join(home, "current.json"),
      "utf8",
    ));
    await readFile(path.join(
      home,
      "generations",
      current.generation,
      "integrity.json",
    ));
    assert.equal((await diagnoseStore({ home, deep: true })).ok, true);

    await appendFile(path.join(
      home,
      "generations",
      current.generation,
      "catalog.json",
    ), " ");
    const diagnosis = await diagnoseStore({ home, deep: true });
    assert.equal(diagnosis.ok, false);
    assert.ok(diagnosis.issues.some(({ reason }) =>
      reason === "integrity-checksum-mismatch"));
  });
});

test("deep doctor rejects a manifest that omits a changed generation file", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await initializeStateHome({ destination: home });
    const current = JSON.parse(await readFile(
      path.join(home, "current.json"),
      "utf8",
    ));
    const generation = path.join(
      home,
      "generations",
      current.generation,
    );
    const integrityFile = path.join(generation, "integrity.json");
    const integrity = JSON.parse(await readFile(integrityFile, "utf8"));
    delete integrity.files["indexes/locator-health.json"];
    await writeFile(integrityFile, `${JSON.stringify(integrity)}\n`);
    await writeFile(
      path.join(generation, "indexes", "locator-health.json"),
      `${JSON.stringify({
        v: 1,
        generation: current.generation,
        locators: { altered: { status: "unchecked" } },
      })}\n`,
    );

    const diagnosis = await diagnoseStore({ home, deep: true });
    assert.equal(diagnosis.ok, false);
    assert.ok(diagnosis.issues.some(({ reason }) =>
      reason === "integrity-file-set-mismatch"));
  });
});

test("deep doctor detects byte changes in every required generation file", async () => {
  await temporary(async (root) => {
    const required = [
      "catalog.json",
      "schema/store.json",
      "records/global.jsonl",
      "indexes/routes.json",
      "indexes/locator-health.json",
      "indexes/search/global.json",
    ];
    for (const [index, relative] of required.entries()) {
      const home = path.join(root, `store-${index}`);
      await initializeStateHome({ destination: home });
      const current = JSON.parse(await readFile(
        path.join(home, "current.json"),
        "utf8",
      ));
      await appendFile(path.join(
        home,
        "generations",
        current.generation,
        ...relative.split("/"),
      ), " ");
      const diagnosis = await diagnoseStore({ home, deep: true });
      assert.equal(diagnosis.ok, false, relative);
      assert.ok(
        diagnosis.issues.some(({ reason }) =>
          reason === "integrity-checksum-mismatch"),
        relative,
      );
    }
  });
});

test("record resource limits fail before oversized data reaches persistence", () => {
  assert.throws(
    () => validateRecord({
      ...record("g:oversized"),
      links: Array.from({ length: 129 }, (_, index) => `g:${index}`),
    }),
    { code: "resource-limit-exceeded" },
  );
  assert.throws(
    () => validateRecord({
      ...record("g:deep"),
      facts: { value: "x".repeat(33 * 1024) },
    }),
    { code: "resource-limit-exceeded" },
  );
});

test("catalog project limit matches the supported 500-project scale", () => {
  const projects = Array.from({ length: 500 }, (_, index) => ({
    id: `p:${index}`,
  }));
  assert.equal(
    assertCatalogLimits({ v: 1, projects }).projects.length,
    500,
  );
  assert.throws(
    () => assertCatalogLimits({
      v: 1,
      projects: [...projects, { id: "p:500" }],
    }),
    {
      code: "resource-limit-exceeded",
      detail: {
        resource: "catalog.projects",
        actual: 501,
        maximum: 500,
      },
    },
  );
});

test("snapshot verifies, restores to a new home, and detects tampering", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    const snapshot = path.join(root, "missing-parent", "snapshot");
    const restored = path.join(root, "restored");
    await initializeStateHome({ destination: home });
    const created = await createSnapshot({ home, destination: snapshot });
    assert.equal(created.ok, true);
    assert.equal((await verifySnapshot({ snapshot })).generation, created.generation);
    const dryRun = await restoreSnapshot({
      snapshot,
      destination: restored,
      dryRun: true,
    });
    assert.equal(dryRun.restored, false);
    await restoreSnapshot({ snapshot, destination: restored });
    assert.equal((await diagnoseStore({ home: restored, deep: true })).ok, true);

    await appendFile(path.join(snapshot, "current.json"), " ");
    await assert.rejects(
      verifySnapshot({ snapshot }),
      { code: "snapshot-checksum-mismatch" },
    );
  });
});

test("maintenance is dry-run first and quarantines only excess history", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await initializeStateHome({ destination: home });
    for (let index = 0; index < 4; index += 1) {
      const store = await ContextStore.open({ home });
      await store.put(record(`g:history:${index}`));
    }
    const before = JSON.parse(await readFile(
      path.join(home, "current.json"),
      "utf8",
    )).generation;
    const preview = await maintainStore({
      home,
      retain: 2,
      checkDrift: false,
    });
    assert.equal(preview.applied, false);
    assert.equal(preview.plan.quarantine.length, 3);
    assert.equal(
      (await readdir(path.join(home, "generations"))).length,
      5,
    );

    const applied = await maintainStore({
      home,
      retain: 2,
      apply: true,
      checkDrift: false,
    });
    assert.deepEqual(applied.plan, preview.plan);
    assert.equal(applied.changes.quarantined.length, 3);
    assert.equal(
      (await readdir(path.join(home, "generations"))).length,
      2,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(home, "current.json"), "utf8"))
        .generation,
      before,
    );
    assert.equal((await diagnoseStore({ home, deep: true })).ok, true);
  });
});

test("maintenance quarantines corrupt history only while valid recovery points remain", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await initializeStateHome({ destination: home });
    const oldest = JSON.parse(await readFile(
      path.join(home, "current.json"),
      "utf8",
    )).generation;
    await (await ContextStore.open({ home })).put(record("g:middle"));
    const corrupt = JSON.parse(await readFile(
      path.join(home, "current.json"),
      "utf8",
    )).generation;
    await (await ContextStore.open({ home })).put(record("g:newest"));
    const active = JSON.parse(await readFile(
      path.join(home, "current.json"),
      "utf8",
    )).generation;
    await appendFile(path.join(
      home,
      "generations",
      corrupt,
      "catalog.json",
    ), " ");

    const result = await maintainStore({
      home,
      retain: 2,
      apply: true,
      checkDrift: false,
    });
    assert.deepEqual(
      new Set(await readdir(path.join(home, "generations"))),
      new Set([oldest, active]),
    );
    assert.ok(result.plan.quarantine.includes(corrupt));
  });
});

test("maintenance rotates a valid oversized audit log with a hash checkpoint", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await initializeStateHome({ destination: home });
    await writeFile(
      path.join(home, "events.jsonl"),
      `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", op: "test" })}\n`,
    );
    const result = await maintainStore({
      home,
      retain: 10,
      auditMaxBytes: 1,
      apply: true,
      checkDrift: false,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });
    assert.equal(result.changes.audit.events, 1);
    const checkpoint = JSON.parse(
      await readFile(path.join(home, "events.jsonl"), "utf8"),
    );
    assert.equal(checkpoint.op, "audit-rotate");
    assert.match(checkpoint.previous_sha256, /^[a-f0-9]{64}$/);
    await readFile(path.join(home, checkpoint.previous_file), "utf8");
  });
});

test("maintenance detects bounded project-source drift", async () => {
  await temporary(async (root) => {
    const projectRoot = path.join(root, "project");
    const home = path.join(root, "store");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "drift-fixture",
      scripts: { test: "node --test" },
    }));
    await initializeStateHome({
      destination: home,
      source: {
        catalog: {
          v: 1,
          projects: [{
            id: "p:drift",
            name: "Drift",
            roots: [projectRoot],
          }],
        },
        schema: { v: 1, record_kinds: ["answer"] },
        globalRecords: [],
        projectRecords: { "p:drift": [] },
      },
    });
    await profileProjects({ home });
    const current = await maintainStore({ home });
    assert.equal(current.drift.current, 1);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "drift-fixture",
      scripts: {
        test: "node --test",
        build: "node build.mjs",
      },
    }));
    const changed = await maintainStore({ home });
    assert.equal(changed.drift.drifted, 1);
    assert.equal(changed.drift.projects[0].status, "drifted");
  });
});

test("unimplemented schema migration and destructive purge stay off the CLI", async () => {
  const errors = [];
  assert.equal(await run(["migrate-store"], {
    stderr: (line) => errors.push(JSON.parse(line)),
  }), 1);
  assert.equal(errors[0].error.code, "unknown-command");

  const maintainErrors = [];
  assert.equal(await run(["maintain", "--purge-quarantine"], {
    stderr: (line) => maintainErrors.push(JSON.parse(line)),
  }), 1);
  assert.equal(maintainErrors[0].error.code, "invalid-option");
});
