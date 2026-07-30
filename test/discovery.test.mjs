import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverProjects } from "../lib/discovery.mjs";

async function makeProject(root, relative, markers = ["package.json"]) {
  const project = path.join(root, relative);
  await mkdir(project, { recursive: true });
  for (const marker of markers) {
    if (marker === ".git") {
      await mkdir(path.join(project, marker));
    } else {
      await writeFile(path.join(project, marker), '{"private":true}');
    }
  }
  return project;
}

async function withFixture(run) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lodestar-discovery-"));
  try {
    await run(fixture);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("discovers projects at depths zero through four but not five", async () => {
  await withFixture(async (fixture) => {
    const roots = [];
    for (let depth = 0; depth <= 5; depth += 1) {
      const scanRoot = path.join(fixture, `scan-${depth}`);
      await mkdir(scanRoot);
      roots.push(scanRoot);
      await makeProject(
        scanRoot,
        [...Array(depth)].map((_, index) => `level-${index}`).join(path.sep),
      );
    }
    const result = await discoverProjects({ roots });
    assert.deepEqual(
      result.projects.map(({ name }) => name).sort(),
      ["level-0", "level-1", "level-2", "level-3", "scan-0"].sort(),
    );
  });
});

test("stops below a discovered project and ignores generated directories", async () => {
  await withFixture(async (fixture) => {
    const parent = await makeProject(fixture, "application", [".git"]);
    await makeProject(parent, "packages/child");
    await makeProject(fixture, "node_modules/dependency");
    await makeProject(fixture, "dist/generated");

    const result = await discoverProjects({ roots: [fixture] });
    assert.deepEqual(
      result.projects.map(({ name }) => name),
      ["application"],
    );
  });
});

test("never follows directory symlinks", async () => {
  await withFixture(async (fixture) => {
    const outside = path.join(fixture, "outside");
    const scanRoot = path.join(fixture, "scan");
    await makeProject(outside, "secret");
    await mkdir(scanRoot);
    await symlink(outside, path.join(scanRoot, "linked"), "dir");

    const result = await discoverProjects({ roots: [scanRoot] });
    assert.deepEqual(result.projects, []);
  });
});

test("reports unreadable directories and continues", async () => {
  await withFixture(async (fixture) => {
    const unreadable = path.join(fixture, "blocked");
    await mkdir(unreadable);
    await makeProject(fixture, "healthy");
    const fsApi = {
      lstat,
      realpath,
      async readdir(target, options) {
        if (target === unreadable) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return readdir(target, options);
      },
    };

    const result = await discoverProjects({ roots: [fixture], fsApi });
    assert.deepEqual(result.projects.map(({ name }) => name), ["healthy"]);
    assert.deepEqual(result.warnings, [{
      code: "directory-unreadable",
      path: unreadable,
      detail: "EACCES",
    }]);
  });
});

test("sorts normalized roots and collapses duplicate physical projects", async () => {
  await withFixture(async (fixture) => {
    const alpha = await makeProject(fixture, "z-parent/alpha");
    const beta = await makeProject(fixture, "a-parent/beta", ["go.mod", ".git"]);
    const result = await discoverProjects({
      roots: [path.dirname(alpha), path.dirname(beta), path.dirname(alpha)],
    });
    assert.deepEqual(
      result.projects.map(({ root }) => root),
      [beta, alpha].sort((a, b) => a.localeCompare(b)),
    );
    assert.deepEqual(
      result.projects.find(({ root }) => root === beta).markers,
      [".git", "go.mod"],
    );
  });
});

test("uses metadata operations only and enforces the hard depth maximum", async () => {
  await withFixture(async (fixture) => {
    await makeProject(fixture, "project");
    let contentReads = 0;
    const fsApi = {
      lstat,
      readdir,
      realpath,
      async readFile(...args) {
        contentReads += 1;
        return readFile(...args);
      },
    };
    await assert.rejects(
      discoverProjects({ roots: [fixture], maxDepth: 9, fsApi }),
      { code: "depth-too-large" },
    );
    const result = await discoverProjects({ roots: [fixture], fsApi });
    assert.equal(result.projects.length, 1);
    assert.equal(contentReads, 0);
  });
});
