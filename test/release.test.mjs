import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("release metadata and publication workflow agree on version 1.0.0", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  const version = packageJson.version;
  const changelog = await readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const releaseNote = await readFile(
    path.join(ROOT, "docs", "releases", `v${version}.md`),
    "utf8",
  );
  const workflow = await readFile(
    path.join(ROOT, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const escapedVersion = version.replaceAll(".", "\\.");

  assert.match(changelog, new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, "mu"));
  assert.doesNotMatch(changelog, new RegExp(`^## ${escapedVersion} - Unreleased$`, "mu"));
  assert.match(releaseNote, new RegExp(`^# Lodestar ${escapedVersion}$`, "mu"));
  assert.match(releaseNote, new RegExp(`lodestar-agent-context@${escapedVersion}`, "u"));

  const stages = [
    "needs:\n      - codeql\n      - verify",
    "Build release assets",
    "Publish exact package to npm",
    "Attest release package provenance",
    "Publish GitHub release",
  ];
  let previous = -1;
  for (const stage of stages) {
    const position = workflow.indexOf(stage);
    assert.ok(position > previous, `${stage} is missing or out of order`);
    previous = position;
  }
  for (const contract of [
    "registry-url: https://registry.npmjs.org",
    "registry_integrity()",
    'npm publish "./${PACKAGE}"',
    "--access public",
    "--provenance",
    'docs/releases/${GITHUB_REF_NAME}.md',
    'git merge-base --is-ancestor "${GITHUB_SHA}" origin/main',
  ]) {
    assert.ok(workflow.includes(contract), `missing release contract: ${contract}`);
  }
});
