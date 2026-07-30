import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ContextStore } from "../lib/context-store.mjs";
import {
  comparablePath,
  pathContains,
  resolveProjectAt,
} from "../lib/project-roots.mjs";
import { withStoreFixture } from "./helpers/store-fixture.mjs";

function globalRecord() {
  return {
    v: 1,
    id: "g:rules",
    kind: "rule",
    priority: 1000,
    scope: ["global"],
    action: ["use exact context"],
    links: [],
  };
}

function projectRecord(projectId, suffix = "commands") {
  return {
    v: 1,
    id: `${projectId}:${suffix}`,
    kind: "command",
    priority: 800,
    scope: [`project:${projectId}`],
    commands: { test: "npm test" },
    links: [],
  };
}

async function sourceWithProjects(home) {
  const workspace = path.join(home, "workspace");
  const parent = path.join(workspace, "parent");
  const child = path.join(parent, "nested");
  const childSource = path.join(child, "src");
  const other = path.join(workspace, "other");
  await Promise.all([
    mkdir(childSource, { recursive: true }),
    mkdir(other, { recursive: true }),
  ]);
  return {
    catalog: {
      v: 1,
      projects: [{
        id: "p:parent",
        name: "Parent",
        roots: [parent],
      }, {
        id: "p:child",
        name: "Child",
        roots: [child],
      }, {
        id: "p:other",
        name: "Other",
        roots: [other],
      }],
    },
    schema: { v: 1, record_kinds: ["rule", "command"] },
    globalRecords: [globalRecord()],
    projectRecords: {
      "p:parent": [projectRecord("p:parent")],
      "p:child": [projectRecord("p:child")],
      "p:other": [projectRecord("p:other")],
    },
    workspace,
    parent,
    child,
    childSource,
    other,
  };
}

test("selects the longest canonical project-root match", async () => {
  await withStoreFixture(sourceWithProjects, async ({ home, source }) => {
    const store = await ContextStore.open({
      home,
      cwd: source.childSource,
    });
    assert.equal(store.project.id, "p:child");
  });
});

test("returns global scope when cwd matches no project", async () => {
  await withStoreFixture(sourceWithProjects, async ({ home }) => {
    const outside = path.join(home, "outside");
    await mkdir(outside);
    const store = await ContextStore.open({ home, cwd: outside });
    assert.equal(store.project, null);
    assert.equal((await store.get("g:rules")).id, "g:rules");
  });
});

test("uses platform-correct path comparison", () => {
  assert.equal(
    comparablePath(String.raw`C:\Work\Project`, { platform: "win32" }),
    "c:/work/project",
  );
  assert.equal(
    pathContains(
      String.raw`C:\WORK\Project`,
      String.raw`c:\work\project\src`,
      { platform: "win32" },
    ),
    true,
  );
  assert.equal(
    pathContains("/Work/Project", "/work/project/src", { platform: "linux" }),
    false,
  );
});

test("project resolution recognizes differently-cased paths only when physically identical", async () => {
  const root = "/mnt/c/Users/Alex/Project";
  const cwd = "/mnt/c/users/alex/project/src";
  const rootIdentity = { dev: 7, ino: 42 };
  const fsApi = {
    realpath: async (value) => value,
    stat: async (value) => {
      if (
        value === root
        || value === "/mnt/c/users/alex/project"
      ) {
        return rootIdentity;
      }
      return { dev: 7, ino: value.length };
    },
  };
  const result = await resolveProjectAt({
    catalog: {
      projects: [{ id: "p:demo", roots: [root] }],
    },
    cwd,
    fsApi,
    platform: "linux",
  });
  assert.equal(result.project.id, "p:demo");
});

test("get uses the route index and opens exactly one owning shard", async () => {
  await withStoreFixture(sourceWithProjects, async ({ home, source }) => {
    const reads = [];
    const fsApi = {
      realpath,
      async readFile(file, encoding) {
        reads.push(file);
        return readFile(file, encoding);
      },
    };
    const store = await ContextStore.open({
      home,
      cwd: source.child,
      fsApi,
    });
    const beforeGet = reads.length;
    assert.equal((await store.get("p:child:commands")).id, "p:child:commands");
    const getReads = reads.slice(beforeGet);
    assert.equal(getReads.length, 1);
    assert.match(getReads[0], /records[\\/]projects[\\/]p-child\.jsonl$/);
  });
});

test("denies cross-project IDs before opening their shard", async () => {
  await withStoreFixture(sourceWithProjects, async ({ home, source }) => {
    const reads = [];
    const fsApi = {
      realpath,
      async readFile(file, encoding) {
        reads.push(file);
        return readFile(file, encoding);
      },
    };
    const store = await ContextStore.open({
      home,
      cwd: source.child,
      fsApi,
    });
    const beforeGet = reads.length;
    await assert.rejects(
      store.get("p:other:commands"),
      { code: "scope-denied" },
    );
    assert.deepEqual(reads.slice(beforeGet), []);
  });
});

test("allows explicit visible cross-project selection", async () => {
  await withStoreFixture(sourceWithProjects, async ({ home, source }) => {
    const store = await ContextStore.open({
      home,
      cwd: source.child,
      project: "p:other",
    });
    assert.equal((await store.get("p:other:commands")).id, "p:other:commands");
  });
});

test("rejects an index from a different generation", async () => {
  await withStoreFixture(sourceWithProjects, async ({ home, generation, source }) => {
    const indexPath = path.join(generation.root, "indexes", "routes.json");
    const routes = JSON.parse(await readFile(indexPath, "utf8"));
    routes.generation = "f".repeat(64);
    await writeFile(indexPath, JSON.stringify(routes));
    await assert.rejects(
      ContextStore.open({ home, cwd: source.child }),
      { code: "index-generation-mismatch" },
    );
  });
});

test("a store stays on its captured generation after pointer replacement", async () => {
  await withStoreFixture(sourceWithProjects, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.child });
    const before = store.generation.id;
    assert.equal((await store.get("p:child:commands")).id, "p:child:commands");
    assert.equal(store.generation.id, before);
  });
});
