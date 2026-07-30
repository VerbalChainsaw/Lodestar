import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { run } from "../agentctx.mjs";
import {
  diagnoseStore,
  repairCurrentGeneration,
  repairWriterLock,
} from "../lib/doctor.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { withStoreFixture } from "./helpers/store-fixture.mjs";

async function source(home) {
  const projectRoot = path.join(home, "project");
  await mkdir(projectRoot);
  return {
    catalog: {
      v: 1,
      projects: [{
        id: "p:doctor",
        name: "Doctor",
        roots: [projectRoot],
      }],
    },
    schema: { v: 1, record_kinds: ["command"] },
    globalRecords: [],
    projectRecords: {
      "p:doctor": [{
        v: 1,
        id: "p:doctor:commands",
        kind: "command",
        priority: 900,
        scope: ["project:p:doctor"],
        links: [],
        commands: { test: "node --test" },
      }],
    },
    projectRoot,
  };
}

test("doctor fails closed when a required search index is missing", async () => {
  await withStoreFixture(source, async ({ home, generation, source: value }) => {
    await unlink(path.join(
      generation.root,
      "indexes",
      "search",
      "p-doctor.json",
    ));
    const report = await diagnoseStore({ home, cwd: value.projectRoot });
    assert.equal(report.ok, false);
    assert.ok(report.issues.some(({ code, generation: id }) =>
      code === "generation-invalid" && id === generation.id));

    const stdout = [];
    const stderr = [];
    const exit = await run([
      "doctor",
      "--home",
      home,
      "--cwd",
      value.projectRoot,
    ], {
      stdout: (line) => stdout.push(JSON.parse(line)),
      stderr: (line) => stderr.push(JSON.parse(line)),
    });
    assert.equal(exit, 1);
    assert.equal(stdout[0].ok, false);
    assert.deepEqual(stderr, []);
  });
});

test("doctor diagnoses and explicitly repairs an invalid current pointer", async () => {
  await withStoreFixture(source, async ({ home, generation, source: value }) => {
    await writeFile(path.join(home, "current.json"), "{not json");
    const before = await diagnoseStore({ home, cwd: value.projectRoot });
    assert.equal(before.ok, false);
    assert.deepEqual(before.valid_generations, [generation.id]);
    assert.ok(before.issues.some(({ code }) =>
      ["invalid-json", "active-generation-invalid"].includes(code)));

    const repaired = await repairCurrentGeneration({
      home,
      generation: generation.id,
    });
    assert.equal(repaired.generation, generation.id);
    const after = await diagnoseStore({ home, cwd: value.projectRoot });
    assert.equal(after.ok, true);
    assert.equal(
      (await ContextStore.open({ home, cwd: value.projectRoot })).generation.id,
      generation.id,
    );
  });
});

test("doctor treats blocker-level root failures as unhealthy", async () => {
  await withStoreFixture(source, async ({ home, generation, source: value }) => {
    const catalogPath = path.join(generation.root, "catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    catalog.projects[0].status = "blocked-missing-root";
    catalog.projects[0].roots = [path.join(home, "missing")];
    await writeFile(catalogPath, JSON.stringify(catalog));
    const store = await ContextStore.open({
      home,
      cwd: value.projectRoot,
      project: "p:doctor",
    });
    const report = await store.doctor();
    assert.equal(report.blockers, 1);
    assert.equal(report.ok, false);
  });
});

test("stale lock repair requires force and quarantines instead of deleting", async () => {
  await withStoreFixture(source, async ({ home }) => {
    const lock = path.join(home, ".write-lock");
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      v: 1,
      nonce: "abandoned",
      pid: 42,
      hostname: "Gigaflex",
      runtime: "linux",
      started_at: 0,
    }));
    await writeFile(path.join(lock, "heartbeat.json"), JSON.stringify({
      v: 1,
      nonce: "abandoned",
      at: 0,
    }));
    await assert.rejects(
      repairWriterLock({ home, now: () => 60_000 }),
      { code: "repair-force-required" },
    );
    const repaired = await repairWriterLock({
      home,
      force: true,
      now: () => 60_000,
    });
    await assert.rejects(access(lock));
    await access(repaired.quarantine);
    assert.match(repaired.quarantine, /\.write-lock\.repaired-/);
  });
});
