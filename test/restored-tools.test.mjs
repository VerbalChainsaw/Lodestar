import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  CODEX_BOOTSTRAP,
  installCodex,
  updateManagedBlock,
} from "../tools/install-codex.mjs";
import { inventoryCodex } from "../tools/inventory-codex.mjs";
import {
  migrateRegistry,
  normalizeProjectRoot,
} from "../tools/migrate-projects.mjs";
import {
  nativePath,
  profileProjects,
} from "../tools/profile-projects.mjs";
import { refreshProjects } from "../tools/refresh-projects.mjs";
import { rollbackCodex } from "../tools/rollback-codex.mjs";
import { run } from "../agentctx.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { initializeStateHome } from "../lib/state-home.mjs";
import { withStoreFixture } from "./helpers/store-fixture.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

async function withTemp(prefix, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Codex installer replaces only its managed block and preserves memories", async () => {
  await withTemp("lodestar-install-", async (root) => {
    const stateHome = path.join(root, "state");
    const codexHome = path.join(root, "codex");
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateHome, { recursive: true });
    const before = [
      "# Personal instructions",
      "KEEP=this-byte-for-byte",
      "",
      "<!-- lodestar:start v1 -->",
      "old managed text",
      "<!-- lodestar:end -->",
      "",
      "# Tail",
      "",
    ].join("\n");
    await writeFile(path.join(codexHome, "AGENTS.md"), before);
    const config = [
      "[memories]",
      "generate_memories = true",
      "use_memories = true",
      "",
    ].join("\n");
    await writeFile(path.join(codexHome, "config.toml"), config);

    const result = await installCodex({
      homes: [codexHome],
      stateHome,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });

    const after = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");
    assert.match(after, /KEEP=this-byte-for-byte/);
    assert.match(after, /# Tail/);
    assert.match(after, new RegExp(CODEX_BOOTSTRAP.split("\n")[0]));
    assert.equal(after.includes("old managed text"), false);
    assert.equal(
      await readFile(path.join(codexHome, "config.toml"), "utf8"),
      config,
    );
    assert.equal(result.installed.length, 1);
    assert.equal(
      JSON.parse(await readFile(result.manifest, "utf8")).files[0].existed,
      true,
    );
  });
});

test("Codex installer upgrades the exact legacy bootstrap without duplication", () => {
  const updated = updateManagedBlock(`${CODEX_BOOTSTRAP}\n`);
  assert.equal(updated.match(/BOOT=agentctx/g).length, 1);
  assert.match(updated, /<!-- lodestar:start v1 -->/);
  assert.match(updated, /<!-- lodestar:end -->/);
});

test("Codex managed block prefers exact linked retrieval before scoped search", () => {
  assert.match(
    CODEX_BOOTSTRAP,
    /LOOKUP=agentctx\.get\|agentctx\.resolve>agentctx\.find>repo\.targeted>repo\.broad/,
  );
  assert.doesNotMatch(CODEX_BOOTSTRAP, /LOOKUP=agentctx\.find>/);
});

test("Codex installer rejects duplicate managed blocks", () => {
  const block = [
    "<!-- lodestar:start v1 -->",
    "old",
    "<!-- lodestar:end -->",
  ].join("\n");
  assert.throws(
    () => updateManagedBlock(`${block}\n${block}\n`),
    /invalid Lodestar managed block/,
  );
});

test("Codex installer preflights every home before modifying any home", async () => {
  await withTemp("lodestar-install-preflight-", async (root) => {
    const stateHome = path.join(root, "state");
    const firstHome = path.join(root, "first");
    const secondHome = path.join(root, "second");
    await mkdir(firstHome, { recursive: true });
    await mkdir(secondHome, { recursive: true });
    await mkdir(stateHome, { recursive: true });
    const first = "KEEP=first\n";
    await writeFile(path.join(firstHome, "AGENTS.md"), first);
    await writeFile(
      path.join(secondHome, "AGENTS.md"),
      "<!-- lodestar:start v1 -->\nbroken\n",
    );

    await assert.rejects(
      installCodex({
        homes: [firstHome, secondHome],
        stateHome,
        now: () => new Date("2026-07-29T12:00:00.000Z"),
      }),
      /invalid Lodestar managed block/,
    );
    assert.equal(
      await readFile(path.join(firstHome, "AGENTS.md"), "utf8"),
      first,
    );
  });
});

test("Codex installer uses collision-safe backup directories", async () => {
  await withTemp("lodestar-install-collision-", async (root) => {
    const stateHome = path.join(root, "state");
    const codexHome = path.join(root, "codex");
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateHome, { recursive: true });
    const options = {
      homes: [codexHome],
      stateHome,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    };
    const first = await installCodex(options);
    const second = await installCodex(options);
    assert.notEqual(first.manifest, second.manifest);
  });
});

test("Codex rollback restores only an unchanged adapter-managed file", async () => {
  await withTemp("lodestar-rollback-", async (root) => {
    const stateHome = path.join(root, "state");
    const codexHome = path.join(root, "codex");
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateHome, { recursive: true });
    const original = "KEEP=original\n";
    await writeFile(path.join(codexHome, "AGENTS.override.md"), original);
    const installed = await installCodex({
      homes: [codexHome],
      stateHome,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });
    assert.match(
      await readFile(path.join(codexHome, "AGENTS.override.md"), "utf8"),
      /BOOT=agentctx/,
    );

    const result = await rollbackCodex({
      stateHome,
      manifestPath: installed.manifest,
    });
    assert.equal(result.restored, 1);
    assert.equal(
      await readFile(path.join(codexHome, "AGENTS.override.md"), "utf8"),
      original,
    );
  });
});

test("Codex rollback rejects manifests outside the state-home backup tree", async () => {
  await withTemp("lodestar-rollback-confinement-", async (root) => {
    const stateHome = path.join(root, "state");
    const outside = path.join(root, "outside-manifest.json");
    await mkdir(path.join(stateHome, "backups"), { recursive: true });
    await writeFile(outside, JSON.stringify({ v: 1, files: [] }));
    await assert.rejects(
      rollbackCodex({ stateHome, manifestPath: outside }),
      /manifest must be inside the Lodestar backup tree/,
    );
  });
});

test("Codex rollback validates every backup before restoring any file", async () => {
  await withTemp("lodestar-rollback-preflight-", async (root) => {
    const stateHome = path.join(root, "state");
    const firstHome = path.join(root, "first");
    const secondHome = path.join(root, "second");
    await mkdir(firstHome, { recursive: true });
    await mkdir(secondHome, { recursive: true });
    await mkdir(stateHome, { recursive: true });
    await writeFile(path.join(firstHome, "AGENTS.md"), "first-before\n");
    await writeFile(path.join(secondHome, "AGENTS.md"), "second-before\n");
    const installed = await installCodex({
      homes: [firstHome, secondHome],
      stateHome,
    });
    const manifest = JSON.parse(await readFile(installed.manifest, "utf8"));
    await writeFile(manifest.files[1].backup, "corrupted backup\n");
    const firstInstalled = await readFile(
      path.join(firstHome, "AGENTS.md"),
      "utf8",
    );

    await assert.rejects(
      rollbackCodex({
        stateHome,
        manifestPath: installed.manifest,
      }),
      /backup hash mismatch/,
    );
    assert.equal(
      await readFile(path.join(firstHome, "AGENTS.md"), "utf8"),
      firstInstalled,
    );
  });
});

test("Codex rollback refuses active-file drift without force", async () => {
  await withTemp("lodestar-rollback-drift-", async (root) => {
    const stateHome = path.join(root, "state");
    const codexHome = path.join(root, "codex");
    await mkdir(codexHome, { recursive: true });
    await mkdir(stateHome, { recursive: true });
    const agents = path.join(codexHome, "AGENTS.md");
    await writeFile(agents, "before\n");
    const installed = await installCodex({
      homes: [codexHome],
      stateHome,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });
    await writeFile(agents, "user changed this after install\n");
    await assert.rejects(
      rollbackCodex({
        stateHome,
        manifestPath: installed.manifest,
      }),
      /active file changed after installation/,
    );
    assert.equal(
      await readFile(agents, "utf8"),
      "user changed this after install\n",
    );
  });
});

test("Codex inventory is explicit-root, content-free, and project-aware", async () => {
  await withTemp("lodestar-inventory-", async (root) => {
    const stateHome = path.join(root, "state");
    const projectRoot = path.join(root, "projects", "demo");
    const codexHome = path.join(root, "codex");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(codexHome, "memories"), { recursive: true });
    await writeFile(path.join(projectRoot, "AGENTS.md"), "private rule text");
    await writeFile(path.join(codexHome, "config.toml"), "secret config text");
    await writeFile(
      path.join(codexHome, "memories", "MEMORY.md"),
      "private memory text",
    );

    const inventory = await inventoryCodex({
      roots: [path.join(root, "projects")],
      codexHomes: [codexHome],
      stateHome,
      catalog: {
        v: 1,
        projects: [{ id: "p:demo", name: "Demo", roots: [projectRoot] }],
      },
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });

    assert.equal(inventory.sources.length, 3);
    assert.equal(
      inventory.sources.find(({ kind }) => kind === "repo-instructions")
        .project,
      "p:demo",
    );
    const serialized = JSON.stringify(inventory);
    assert.equal(serialized.includes("private rule text"), false);
    assert.equal(serialized.includes("private memory text"), false);
    assert.equal(serialized.includes("secret config text"), false);
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(stateHome, "inventory", "codex-sources.json"),
          "utf8",
        ),
      ).sources.length,
      3,
    );
  });
});

test("Codex inventory enforces traversal depth and entry budgets", async () => {
  await withTemp("lodestar-inventory-bounds-", async (root) => {
    const stateHome = path.join(root, "state");
    const deep = path.join(root, "one", "two", "three");
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "AGENTS.md"), "too deep");
    const inventory = await inventoryCodex({
      roots: [root],
      codexHomes: [],
      stateHome,
      catalog: { v: 1, projects: [] },
      maxDepth: 1,
      maxEntries: 10,
    });
    assert.equal(inventory.sources.length, 0);
    assert.ok(
      inventory.warnings.some(({ code }) => code === "inventory-depth-limit"),
    );
  });
});

test("registry migration imports universal paths through a new generation", async () => {
  await withTemp("lodestar-migrate-", async (root) => {
    const home = path.join(root, "state");
    const projectRoot = path.join(root, "demo");
    const registry = path.join(root, "projects.json");
    await mkdir(projectRoot);
    await initializeStateHome({ destination: home });
    await writeFile(registry, JSON.stringify({
      projects: [{
        name: "Demo App",
        path: projectRoot,
        aliases: ["demo"],
        test_cmd: "node --test",
      }],
    }));

    const result = await migrateRegistry({
      home,
      sourcePath: registry,
      idFactory: () => "00000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });
    const store = await ContextStore.open({ home, cwd: projectRoot });
    assert.equal(store.project.id, "p:00000000-0000-4000-8000-000000000001");
    assert.equal(store.project.commands.test, "node --test");
    assert.equal(result.imported, 1);
    assert.match(await readFile(path.join(home, "events.jsonl"), "utf8"),
      /"op":"migrate-registry"/);
  });
});

test("native project paths remain portable and translate only under WSL", () => {
  const windowsRoot = ["D:", "Work", "Demo"].join("\\");
  assert.equal(
    normalizeProjectRoot(windowsRoot, {
      platform: "linux",
      env: {},
      release: "6.8.0-generic",
    }),
    "D:/Work/Demo",
  );
  assert.equal(
    normalizeProjectRoot(windowsRoot, {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Example" },
      release: "6.8.0-microsoft-standard",
    }),
    "/mnt/d/Work/Demo",
  );
  assert.equal(
    nativePath(windowsRoot, {
      platform: "linux",
      env: {},
      release: "6.8.0-generic",
    }),
    windowsRoot,
  );
  assert.equal(
    nativePath(windowsRoot, {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Example" },
      release: "6.8.0-microsoft-standard",
    }),
    "/mnt/d/Work/Demo",
  );
  assert.equal(
    nativePath(String.raw`\\wsl.localhost\Ubuntu\home\alex\Demo`, {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      release: "6.8.0-microsoft-standard",
    }),
    "/home/alex/Demo",
  );
  assert.equal(
    nativePath(String.raw`\\wsl$\Ubuntu\home\alex\Demo`, {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      release: "6.8.0-microsoft-standard",
    }),
    "/home/alex/Demo",
  );
});

test("bounded profiler preserves curated records and never reads env values", async () => {
  await withStoreFixture(async (home) => {
    const projectRoot = path.join(home, "demo");
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "demo",
      description: "Demo package",
      scripts: { test: "node --test" },
      main: "src/index.js",
    }));
    await writeFile(path.join(projectRoot, ".env.example"), "TOKEN=do-not-read");
    await writeFile(path.join(projectRoot, "src", "index.js"), "secret-source");
    return {
      catalog: {
        v: 1,
        projects: [{
          id: "p:demo",
          name: "Demo",
          aliases: [],
          roots: [projectRoot],
        }],
      },
      schema: { v: 1 },
      globalRecords: [],
      projectRecords: {
        "p:demo": [{
          v: 1,
          id: "p:demo:curated",
          kind: "decision",
          priority: 900,
          scope: ["project:p:demo"],
          links: [],
          facts: { keep: true },
        }],
      },
      projectRoot,
    };
  }, async ({ home, source }) => {
    const result = await profileProjects({ home });
    const store = await ContextStore.open({ home, cwd: source.projectRoot });
    assert.equal((await store.get("p:demo:curated")).facts.keep, true);
    assert.equal(
      (await store.get("p:demo:profile:commands")).commands.test,
      "node --test",
    );
    const environment = await store.get("p:demo:profile:environment");
    assert.deepEqual(
      environment.facts.configuration_locators,
      [".env.example"],
    );
    const snapshot = JSON.stringify(await store.sourceSnapshot());
    assert.equal(snapshot.includes("do-not-read"), false);
    assert.equal(snapshot.includes("secret-source"), false);
    assert.equal(result.profiled, 1);
  });
});

test("refresh discovery adds only explicit-root projects and profiles them", async () => {
  await withTemp("lodestar-refresh-", async (root) => {
    const home = path.join(root, "state");
    const projectRoot = path.join(root, "new-project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "new-project",
      scripts: { test: "node --test" },
    }));
    await initializeStateHome({ destination: home });

    const preview = await refreshProjects({
      home,
      discoverRoots: [projectRoot],
      confirm: false,
    });
    assert.equal(preview.dry_run, true);
    assert.equal(preview.discovered.length, 1);
    assert.equal(
      (await ContextStore.open({ home, cwd: projectRoot })).project,
      null,
    );

    const result = await refreshProjects({
      home,
      discoverRoots: [projectRoot],
      confirm: true,
      idFactory: () => "00000000-0000-4000-8000-000000000002",
    });
    assert.equal(result.added, 1);
    assert.equal(result.profile.profiled, 1);
    const store = await ContextStore.open({ home, cwd: projectRoot });
    assert.equal(store.project.name, "new-project");
    assert.equal(
      (await store.get(`${store.project.id}:profile:commands`)).commands.test,
      "node --test",
    );
  });
});

test("refresh dry-run profiles without changing the active generation", async () => {
  await withTemp("lodestar-refresh-dry-", async (root) => {
    const home = path.join(root, "state");
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "dry-run-project",
      scripts: { test: "node --test" },
    }));
    await initializeStateHome({ destination: home });
    await refreshProjects({
      home,
      discoverRoots: [projectRoot],
      confirm: true,
      idFactory: () => "00000000-0000-4000-8000-000000000003",
    });
    const before = (await ContextStore.open({ home, cwd: projectRoot }))
      .generation.id;
    const output = [];
    const errors = [];
    const code = await run([
      "refresh",
      "--dry-run",
      "--home",
      home,
      "--project",
      "p:00000000-0000-4000-8000-000000000003",
    ], {
      stdout: (line) => output.push(JSON.parse(line)),
      stderr: (line) => errors.push(JSON.parse(line)),
    });
    assert.equal(code, 0, JSON.stringify(errors));
    assert.equal(output[0].dry_run, true);
    assert.equal(
      (await ContextStore.open({ home, cwd: projectRoot })).generation.id,
      before,
    );
  });
});

test("refresh discovery deduplicates Windows and WSL roots by physical identity", async () => {
  await withStoreFixture(async (home) => {
    const projectRoot = path.join(home, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "same-project",
    }));
    return {
      catalog: {
        v: 1,
        projects: [{
          id: "p:existing",
          name: "Existing",
          roots: [String.raw`C:\Users\Alex\Project`],
        }],
      },
      schema: { v: 1, record_kinds: [] },
      globalRecords: [],
      projectRecords: { "p:existing": [] },
      projectRoot,
    };
  }, async ({ home, source }) => {
    const result = await refreshProjects({
      home,
      discoverRoots: [source.projectRoot],
      confirm: true,
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      release: "6.8.0-microsoft-standard-WSL2",
      fsApi: {
        realpath: async (value) =>
          value === "/mnt/c/Users/Alex/Project"
            || (
              process.platform === "win32"
              && String(value).startsWith("/mnt/c/")
            )
            ? source.projectRoot
            : import("node:fs/promises").then(({ realpath }) =>
              realpath(value)),
      },
    });
    assert.equal(result.added, 0);
    assert.equal(result.profile.profiled, 0);
  });
});

test("concurrent refresh discovery rechecks candidates inside the write lock", async () => {
  await withTemp("lodestar-refresh-race-", async (root) => {
    const home = path.join(root, "state");
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "one-project",
    }));
    await initializeStateHome({ destination: home });
    const results = await Promise.all([
      refreshProjects({
        home,
        discoverRoots: [projectRoot],
        confirm: true,
        idFactory: () => "00000000-0000-4000-8000-000000000004",
      }),
      refreshProjects({
        home,
        discoverRoots: [projectRoot],
        confirm: true,
        idFactory: () => "00000000-0000-4000-8000-000000000005",
      }),
    ]);
    assert.equal(results.reduce((sum, result) => sum + result.added, 0), 1);
    const store = await ContextStore.open({ home, cwd: projectRoot });
    assert.equal(store.catalog.projects.length, 1);
  });
});

test("public CLI exposes the restored universal operations", async () => {
  await withTemp("lodestar-tools-cli-", async (root) => {
    const stateHome = path.join(root, "state");
    const codexHome = path.join(root, "codex");
    await mkdir(codexHome);
    const output = [];
    const errors = [];
    const initCode = await run([
      "init",
      "--home",
      stateHome,
    ], {
      stdout: (line) => output.push(JSON.parse(line)),
      stderr: (line) => errors.push(JSON.parse(line)),
    });
    assert.equal(initCode, 0, JSON.stringify(errors));
    assert.equal(output[0].created, true);

    const code = await run([
      "install-codex",
      "--home",
      stateHome,
      "--codex-home",
      codexHome,
    ], {
      stdout: (line) => output.push(JSON.parse(line)),
      stderr: (line) => errors.push(JSON.parse(line)),
    });
    assert.equal(code, 0, JSON.stringify(errors));
    assert.equal(output[1].ok, true);
    assert.match(
      await readFile(path.join(codexHome, "AGENTS.md"), "utf8"),
      /BOOT=agentctx/,
    );
  });
});

test("guided init previews discovery and profiles only after confirmation", async () => {
  await withTemp("lodestar-guided-init-", async (root) => {
    const stateHome = path.join(root, "state");
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "guided-project",
      scripts: { test: "node --test" },
    }));
    const previewOutput = [];
    const previewCode = await run([
      "init",
      "--home",
      stateHome,
      "--discover",
      "--root",
      projectRoot,
      "--skip-codex",
    ], {
      stdout: (line) => previewOutput.push(JSON.parse(line)),
      stderr: () => {},
    });
    assert.equal(previewCode, 0);
    assert.equal(previewOutput[0].discovery.dry_run, true);
    assert.equal(previewOutput[0].discovery.discovered.length, 1);

    const confirmedOutput = [];
    const confirmedCode = await run([
      "init",
      "--home",
      stateHome,
      "--discover",
      "--root",
      projectRoot,
      "--yes",
      "--skip-codex",
    ], {
      stdout: (line) => confirmedOutput.push(JSON.parse(line)),
      stderr: () => {},
    });
    assert.equal(confirmedCode, 0);
    assert.equal(confirmedOutput[0].discovery.added, 1);
    assert.equal(confirmedOutput[0].discovery.profile.profiled, 1);
    const store = await ContextStore.open({ home: stateHome, cwd: projectRoot });
    assert.equal(store.project.name, "project");
  });
});

test("installed symlink entry points execute instead of silently exiting", {
  skip: process.platform === "win32"
    ? "npm uses command shims rather than symlinks on Windows"
    : false,
}, async () => {
  await withTemp("lodestar-bin-link-", async (root) => {
    const binary = path.join(root, "agentctx");
    const stateHome = path.join(root, "state");
    await symlink(path.join(packageRoot, "agentctx.mjs"), binary);
    const { stdout } = await execFileAsync(binary, [
      "init",
      "--home",
      stateHome,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
  });
});
