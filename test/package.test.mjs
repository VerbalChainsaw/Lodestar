import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_BOOTSTRAP } from "../src/bootstrap.mjs";
import { LODESTAR_VERSION } from "../src/cli.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_PACKAGE_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "codex-plugin/.codex-plugin/plugin.json",
  "codex-plugin/.mcp.json",
  "codex-plugin/hooks/hooks.json",
  "codex-plugin/scripts/lodestar-hook.mjs",
  "codex-plugin/scripts/lodestar-mcp.mjs",
  "codex-plugin/scripts/lodestar-runtime.mjs",
  "codex-plugin/skills/handoff/SKILL.md",
  "codex-plugin/skills/handoff/agents/openai.yaml",
  "docs/agent-bootstrap.json",
  "docs/limitations.md",
  "docs/migration-v0.7.md",
  "docs/schema.md",
  "lodestar.mjs",
  "package.json",
  "src/agent-state.mjs",
  "src/bootstrap.mjs",
  "src/cli-commands.mjs",
  "src/cli.mjs",
  "src/continuity-schema.mjs",
  "src/database.mjs",
  "src/database-schema.mjs",
  "src/diagnostics.mjs",
  "src/doctor.mjs",
  "src/errors.mjs",
  "src/import-v070.mjs",
  "src/json.mjs",
  "src/legacy-v070/convert.mjs",
  "src/legacy-v070/integrity.mjs",
  "src/legacy-v070/locator-health.mjs",
  "src/legacy-v070/mapping.mjs",
  "src/legacy-v070/parse.mjs",
  "src/legacy-v070/read.mjs",
  "src/paths.mjs",
  "src/project.mjs",
  "src/queries.mjs",
  "src/records.mjs",
  "src/revisions.mjs",
  "src/schema.mjs",
  "src/schema-migration.mjs",
  "src/stored-semantics.mjs",
  "src/validate.mjs",
  "src/version.mjs",
  "src/windows-install.mjs",
];

function packageArtifact() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const packed = spawnSync(
    command,
    npmCli ? [npmCli, ...args] : args,
    {
      cwd: ROOT,
      encoding: "utf8",
      shell: !npmCli && process.platform === "win32",
    },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.error?.stack);
  return JSON.parse(packed.stdout)[0];
}

function relativeMarkdownTargets(text) {
  const targets = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/gu,
    /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      const target = raw.startsWith("<") ? raw.slice(1, -1) : raw;
      if (!/^(?:#|\/|[a-z][a-z0-9+.-]*:)/iu.test(target)) {
        targets.push(target.split(/[?#]/u, 1)[0]);
      }
    }
  }
  return targets;
}

test("the package publishes one executable and only the reduced runtime", () => {
  const artifact = packageArtifact();
  assert.deepEqual(
    artifact.files.map(({ path: file }) => file).sort(),
    [...EXPECTED_PACKAGE_FILES].sort(),
  );
  assert.equal(
    artifact.files.find(({ path: file }) => file === "lodestar.mjs").mode,
    0o755,
  );
});

test("relative links in packaged Markdown resolve inside the artifact", async () => {
  const artifact = packageArtifact();
  const files = new Set(artifact.files.map(({ path: file }) => file));
  const broken = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const text = await readFile(path.join(ROOT, file), "utf8");
    for (const target of relativeMarkdownTargets(text)) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), target),
      );
      if (!files.has(resolved)) broken.push({ file, target, resolved });
    }
  }
  assert.deepEqual(broken, []);
});

test("package metadata and bootstrap have one source of truth", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  assert.deepEqual(packageJson.bin, { lodestar: "lodestar.mjs" });
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.equal(packageJson.version, LODESTAR_VERSION);
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
  ]) {
    assert.deepEqual(packageJson[field] ?? {}, {});
  }
  const documented = JSON.parse(
    await readFile(path.join(ROOT, "docs", "agent-bootstrap.json"), "utf8"),
  );
  assert.deepEqual(documented, AGENT_BOOTSTRAP);
});

test("runtime modules stay understandable in one sitting", async () => {
  const source = path.join(ROOT, "src");
  const files = [];
  async function collect(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.name.endsWith(".mjs")) files.push(absolute);
    }
  }
  await collect(source);
  let registryCoreLines = 0;
  let continuityLines = 0;
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n").length;
    assert.ok(lines <= 500, `${path.relative(ROOT, file)} has ${lines} lines`);
    const relative = path.relative(source, file);
    if (
      relative !== "import-v070.mjs"
      && relative !== "windows-install.mjs"
      && !relative.startsWith(`legacy-v070${path.sep}`)
    ) {
      if (
        relative.startsWith("continuity-")
        || relative === "continuity.mjs"
        || relative.startsWith("service")
        || relative === "schema-migration.mjs"
      ) continuityLines += lines;
      else registryCoreLines += lines;
    }
  }
  assert.ok(
    registryCoreLines < 4_500,
    `registry core runtime has ${registryCoreLines} lines`,
  );
  assert.ok(
    continuityLines < 4_000,
    `continuity runtime has ${continuityLines} lines`,
  );
});
