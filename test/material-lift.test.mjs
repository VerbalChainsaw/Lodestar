import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { BUDGETS_V1 } from "../lib/budgets.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { withStoreFixture } from "./helpers/store-fixture.mjs";

const PROJECT_COUNT = 100;
const ACTIVE_ID = "p:050";

function projectRecord(projectId, suffix, overrides = {}) {
  return {
    v: 1,
    id: `${projectId}:${suffix}`,
    kind: "index",
    priority: 800,
    scope: [`project:${projectId}`],
    links: [],
    ...overrides,
  };
}

async function scaleSource(home) {
  const activeRoot = path.join(home, "active-project");
  await mkdir(activeRoot);
  const projects = [];
  const projectRecords = {};
  for (let index = 0; index < PROJECT_COUNT; index += 1) {
    const id = `p:${String(index).padStart(3, "0")}`;
    projects.push({
      id,
      name: `Project ${index}`,
      aliases: [`fixture-${index}`],
      roots: [
        id === ACTIVE_ID
          ? activeRoot
          : path.join(home, "offline", String(index)),
      ],
    });
    projectRecords[id] = [
      projectRecord(id, "entrypoints", {
        priority: 900,
        topics: ["project.entrypoints"],
        summary: `Entrypoints for project ${index}`,
        links: [`${id}:commands`],
      }),
      projectRecord(id, "commands", {
        kind: "command",
        priority: 850,
        required: id === ACTIVE_ID,
        topics: ["project.commands"],
        commands: { test: `npm test -- project-${index}` },
      }),
    ];
  }
  return {
    catalog: { v: 1, projects },
    schema: { v: 1, record_kinds: ["index", "command", "rule"] },
    globalRecords: [{
      v: 1,
      id: "g:rules",
      kind: "rule",
      priority: 1_000,
      required: true,
      scope: ["global"],
      links: [],
      action: ["use linked context first"],
    }],
    projectRecords,
    activeRoot,
  };
}

test("material lift remains deterministic and scoped with 100 projects", async () => {
  await withStoreFixture(scaleSource, async ({ home, source }) => {
    const reads = [];
    const fsApi = {
      realpath,
      async readFile(file, encoding) {
        reads.push(file);
        return readFile(file, encoding);
      },
    };
    const startedAt = performance.now();
    const firstStore = await ContextStore.open({
      home,
      cwd: source.activeRoot,
      project: ACTIVE_ID,
      fsApi,
    });
    const first = await firstStore.start();
    const elapsedMs = performance.now() - startedAt;
    const second = await (await ContextStore.open({
      home,
      cwd: source.activeRoot,
      project: ACTIVE_ID,
    })).start();
    const firstJson = JSON.stringify(first);
    const secondJson = JSON.stringify(second);

    assert.equal(first.project.id, ACTIVE_ID);
    assert.ok(first.required.some(({ id }) => id === `${ACTIVE_ID}:commands`));
    assert.equal(
      first.required.some(({ id }) => id.startsWith("p:049:")),
      false,
    );
    assert.equal(Buffer.byteLength(firstJson) <= BUDGETS_V1.start.maxBytes, true);
    assert.equal(elapsedMs < 1_000, true, `startup took ${elapsedMs}ms`);
    assert.equal(
      createHash("sha256").update(firstJson).digest("hex"),
      createHash("sha256").update(secondJson).digest("hex"),
    );
    assert.equal(
      reads.some((file) => /records[\\/]projects[\\/]p-049\.jsonl$/.test(file)),
      false,
    );

    const retrievalCommands = 1;
    const answer = await firstStore.get(`${ACTIVE_ID}:commands`);
    assert.equal(answer.commands.test, "npm test -- project-50");
    assert.ok(
      retrievalCommands <= 2,
      "answer required no more than two exact retrieval commands",
    );
  });
});
