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
  "codex-plugin/skills/lodestar/SKILL.md",
  "codex-plugin/skills/lodestar/agents/openai.yaml",
  "codex-plugin/skills/lodestar/assets/templates/AGENTS.template.md",
  "codex-plugin/skills/lodestar/assets/templates/CLAUDE.template.md",
  "codex-plugin/skills/lodestar/assets/templates/SOUL.template.md",
  "codex-plugin/skills/lodestar/assets/templates/_stub-pattern.AGENTS.md",
  "codex-plugin/skills/lodestar/references/bootstrap-and-failures.md",
  "codex-plugin/skills/lodestar/references/continuity.md",
  "codex-plugin/skills/lodestar/references/decisions.md",
  "codex-plugin/skills/lodestar/references/governance-package.md",
  "codex-plugin/skills/lodestar/references/knowledge.md",
  "codex-plugin/skills/lodestar/references/templates.md",
  "codex-plugin/skills/lodestar/references/toolchain.md",
  "codex-plugin/skills/lodestar/references/work-presence.md",
  "docs/README.md",
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
  "src/continuity.mjs",
  "src/database.mjs",
  "src/database-schema.mjs",
  "src/diagnostics.mjs",
  "src/decision.mjs",
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
  "src/legacy-v070/unified.mjs",
  "src/paths.mjs",
  "src/project.mjs",
  "src/queries.mjs",
  "src/records.mjs",
  "src/revisions.mjs",
  "src/schema.mjs",
  "src/schema-migration.mjs",
  "src/skills-payload.json",
  "src/skills.mjs",
  "src/stored-semantics.mjs",
  "src/validate.mjs",
  "src/version.mjs",
  "src/windows-install.mjs",
  "src/work.mjs",
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

test("published model-facing surfaces contain only the Lodestar brand", async () => {
  const pattern = /Context Buddy|context_buddy|Glimpse|Keel|Durable Handoff|DriftGuard|drift_guard/iu;
  const artifact = packageArtifact();
  const contaminated = [];
  for (const { path: file } of artifact.files) {
    if (!/\.(?:json|md|mjs)$/u.test(file) && file !== "package.json") continue;
    const text = await readFile(path.join(ROOT, file), "utf8");
    if (pattern.test(text)) contaminated.push(file);
  }
  assert.deepEqual(contaminated, []);
});

// A published tarball is permanent: npm mirrors it and unpublishing does not erase
// copies. Templates authored against a real machine carried an absolute home path and
// a private repository name into the artifact once already, so the artifact itself is
// the thing under test rather than the source tree it was built from.
test("the published artifact leaks no local machine or private project detail", async () => {
  const homePath = /C:[\\/]Users[\\/][^"'\\/\s]+|\/home\/[a-z][a-z0-9_-]*|\/Users\/[^"'/\s]+/u;
  const artifact = packageArtifact();
  const leaked = [];
  for (const { path: file } of artifact.files) {
    if (!/\.(?:json|md|mjs|ya?ml)$/u.test(file)) continue;
    const text = await readFile(path.join(ROOT, file), "utf8");
    const found = homePath.exec(text);
    if (found) leaked.push(`${file}: ${found[0]}`);
  }
  assert.deepEqual(leaked, [], "published files must not contain absolute home paths");

  // Project-specific agent instructions are user content and belong in the registry,
  // not in the package every consumer installs.
  const templates = artifact.files
    .map(({ path: file }) => file)
    .filter((file) => file.includes("/assets/templates/"))
    .map((file) => path.basename(file));
  const generic = templates.filter(
    (name) => !/\.template\.md$/u.test(name) && !name.startsWith("_"),
  );
  assert.deepEqual(generic, [], "only generic templates may ship");

  // Removing a template is not enough: 1.2.0 shipped a reference table still listing
  // three deleted ones, which named private projects and pointed at missing files. The
  // link check above misses this because the table cites them as code, not as links.
  const shipped = new Set(artifact.files.map(({ path: file }) => file));
  const dangling = [];
  for (const { path: file } of artifact.files) {
    if (!file.endsWith(".md")) continue;
    const text = await readFile(path.join(ROOT, file), "utf8");
    for (const [, cited] of text.matchAll(/`(assets\/templates\/[^`]+)`/gu)) {
      const resolved = path.posix.join(path.posix.dirname(file), "..", cited);
      if (!shipped.has(path.posix.normalize(resolved))) dangling.push(`${file} -> ${cited}`);
    }
  }
  assert.deepEqual(dangling, [], "packaged docs must not cite templates that do not ship");
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

test("managed assets generate the complete unified skill, bootstrap, and rule payload", async () => {
  const checked = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "build-managed-assets.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.stack);
  const payload = JSON.parse(await readFile(path.join(ROOT, "src", "skills-payload.json"), "utf8"));
  assert.equal(payload.schema, 2);
  assert.deepEqual(payload.skills.map(({ name }) => name), [
    "director-protocol", "codeplan", "center-multigeometry", "center-audit",
    "ladder-audit", "lodestar",
  ]);
  assert.match(payload.bootstrap.text, /truncated or incomplete/u);
  assert.equal(payload.governance.id, "g:lodestar:required-governance");
  assert.equal(payload.governance.data.required, true);
  const lodestar = payload.skills.find(({ name }) => name === "lodestar");
  assert.ok(lodestar.files.some(({ path: file }) =>
    file === "assets/templates/AGENTS.template.md"));
  assert.ok(lodestar.files.some(({ path: file }) => file === "agents/openai.yaml"));
  for (const skill of payload.skills) {
    for (const file of skill.files) {
      assert.doesNotMatch(file.content, /(?:^|\n)\d+\|/u);
    }
    assert.match(skill.files.find(({ path: file }) => file === "SKILL.md").content,
      /^---\r?\nname: /u);
  }
  assert.doesNotMatch(JSON.stringify(payload),
    /Context Buddy|context_buddy|Glimpse|Keel|Durable Handoff|DriftGuard|drift_guard/u);
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
    const text = await readFile(file, "utf8");
    const lines = text.split("\n").length;
    assert.ok(lines <= 500, `${path.relative(ROOT, file)} has ${lines} lines`);
    const relative = path.relative(source, file);
    // A line budget alone is satisfied by joining statements, which buys headroom by
    // making the densest modules the least readable ones. Capping line width removes
    // that escape so the budget can only be met by writing less, not by writing tighter.
    // windows-install.mjs is exempt because it is mostly embedded shell inside template
    // literals, where a wrap would change the emitted script rather than the JavaScript.
    if (relative !== "windows-install.mjs") {
      for (const [index, line] of text.split("\n").entries()) {
        assert.ok(
          line.length <= 100,
          `${path.relative(ROOT, file)}:${index + 1} is ${line.length} characters`,
        );
      }
    }
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
  // Raised from 4,500 for the v1.1 contract change that absorbed the work and handoff
  // domains into this core, and to pay for the width cap above: the same logic spread
  // to a readable width costs more lines than it did compressed. Raised again for
  // v1.2, which added the decision, managed-skill, and continuity command families.
  // The previous ceiling had gone saturated enough to block a cross-platform
  // correctness fix, and a budget that rejects correctness is measuring the wrong thing.
  assert.ok(
    registryCoreLines < 5_600,
    `registry core runtime has ${registryCoreLines} lines`,
  );
  assert.ok(
    continuityLines < 4_000,
    `continuity runtime has ${continuityLines} lines`,
  );
});
