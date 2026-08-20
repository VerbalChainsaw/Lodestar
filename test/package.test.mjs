import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_BOOTSTRAP } from "../src/bootstrap.mjs";
import { LODESTAR_VERSION } from "../src/cli.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

test("the minimal agent stub is the canonical package bootstrap", async () => {
  const stub = await readFile(path.join(ROOT,
    "codex-plugin/skills/lodestar/assets/templates/_stub-pattern.AGENTS.md"), "utf8");
  assert.equal(stub, AGENT_BOOTSTRAP.text);
});

test("the package publishes one executable and the canonical managed assets", async () => {
  const artifact = packageArtifact();
  const files = new Set(artifact.files.map(({ path: file }) => file));
  for (const required of [
    "lodestar.mjs", "src/bootstrap.mjs", "src/skills.mjs",
    "managed-assets/manifest.json", "managed-assets/bootstrap.json",
    "managed-assets/governance.json",
  ]) assert.ok(files.has(required), `missing packaged canonical file: ${required}`);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "managed-assets", "manifest.json"), "utf8"));
  for (const skill of manifest.skills)
    assert.ok(files.has(`managed-assets/skills/${skill}/SKILL.md`), `missing canonical skill: ${skill}`);
  assert.ok(!files.has("src/skills-payload.json"), "retired semantic payload must not ship");
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
  const retiredHandoff = /lodestar handoff (?:save|validate|clear)\b/u;
  const artifact = packageArtifact();
  const contaminated = [];
  const staleCommands = [];
  for (const { path: file } of artifact.files) {
    if (!/\.(?:json|md|mjs)$/u.test(file) && file !== "package.json") continue;
    const text = await readFile(path.join(ROOT, file), "utf8");
    if (pattern.test(text)) contaminated.push(file);
    if (retiredHandoff.test(text)) staleCommands.push(file);
  }
  assert.deepEqual(contaminated, []);
  assert.deepEqual(staleCommands, [], "published files must not name retired handoff commands");
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

test("canonical managed assets are runtime authority without a semantic compiler", async () => {
  const checked = spawnSync(process.execPath,
    [path.join(ROOT, "scripts", "build-managed-assets.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.stack);
  const bootstrap = JSON.parse(await readFile(path.join(ROOT, "managed-assets", "bootstrap.json"), "utf8"));
  const governance = JSON.parse(await readFile(path.join(ROOT, "managed-assets", "governance.json"), "utf8"));
  assert.deepEqual(AGENT_BOOTSTRAP, bootstrap);
  assert.equal(governance.id, "g:lodestar:required-governance");
  assert.equal(governance.data.required, true);
  assert.equal(typeof governance.data.text, "string");
  for (const sentinel of [
    "## Anti-Certainty Psychosis",
    "## Work Modes",
    "## Repository Conduct",
    "## Debugging Method",
    "## Verification Standard",
    "## Testing Philosophy",
    "## Architecture and Refactoring",
    "## Completion and Stop Standard",
    "Never stack governance on governance",
    "Governance requires a critical need",
    "Limits require provenance",
    "Completeness is atomic",
    "Attempts remain retryable",
    "Transport adapts to the contract",
    "Canonical content is not source material for a semantic compiler",
    "Reality Anchoring and Surface Integrity",
  ]) assert.ok(governance.data.text.includes(sentinel), `missing canonical behavior: ${sentinel}`);
  const runtimeBootstrap = await readFile(path.join(ROOT, "src", "bootstrap.mjs"), "utf8");
  const runtimeSkills = await readFile(path.join(ROOT, "src", "skills.mjs"), "utf8");
  assert.doesNotMatch(runtimeBootstrap, /skills-payload\.json/u);
  assert.doesNotMatch(runtimeSkills, /skills-payload\.json/u);
  assert.match(runtimeBootstrap, /managed-assets\/\$\{name\}/u);
  assert.match(runtimeSkills, /\.\.\/managed-assets/u);
  const builder = await readFile(path.join(ROOT, "scripts", "build-managed-assets.mjs"), "utf8");
  assert.doesNotMatch(builder, /historical-source-transformations|entry\.action\s*=|skills-payload\.json/u);
  assert.match(builder, /Human-readable view of the exact canonical rule body/u);
  const codeplan = await readFile(path.join(ROOT, "managed-assets", "skills", "codeplan", "SKILL.md"), "utf8");
  const center = await readFile(path.join(ROOT, "managed-assets", "skills", "center-audit", "SKILL.md"), "utf8");
  assert.match(codeplan, /PLAN-OUT/u);
  assert.match(codeplan, /EXEC-OUT/u);
  assert.match(codeplan, /conservative baseline/iu);
  assert.match(center, /CENTER-AUDIT/u);
  assert.match(center, /Evidence-Gated Goalpost \/ Delta \/ Fusion Method/u);
});
