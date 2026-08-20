import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The runtime is part of the contract, not an implementation detail. Below the engine
// floor node:sqlite is experimental and Node writes an ExperimentalWarning to stderr,
// which corrupts the error envelope every consumer parses. A suite run on an older Node
// therefore proves nothing about the shipped product, so refuse to look green there.
test("the test runtime satisfies the published engine floor", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  const range = packageJson.engines.node;
  const floor = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(range);
  assert.ok(floor, `engines.node must be a simple >=x.y.z floor, found ${range}`);
  const required = floor.slice(1, 4).map(Number);
  const running = process.versions.node.split(".").map(Number);
  const ordered = running[0] - required[0]
    || running[1] - required[1]
    || running[2] - required[2];
  assert.ok(
    ordered >= 0,
    `Lodestar declares node ${range} but this suite is running on v${process.versions.node}. `
      + "Run the suite on the pinned runtime so it exercises the shipped semantics.",
  );
});

// cli.test.mjs drives runCli() in process with a fake io object, which cannot observe
// anything the runtime itself writes to the real streams. The machine-readable promise
// is only actually testable across a process boundary.
test("the installed entry point keeps both streams machine-readable", () => {
  const entry = path.join(ROOT, "lodestar.mjs");
  const missing = path.join(ROOT, "tmp", "lodestar-absent-registry.db");

  const success = spawnSync(process.execPath, [entry, "--version"], {
    encoding: "utf8",
  });
  assert.equal(success.status, 0);
  assert.equal(success.stderr, "", "a successful command must leave stderr empty");
  assert.equal(JSON.parse(success.stdout).ok, true);

  const failure = spawnSync(process.execPath, [entry, "get", "absent", "--db", missing], {
    encoding: "utf8",
  });
  assert.notEqual(failure.status, 0);
  assert.equal(failure.stdout, "", "a failed command must leave stdout empty");
  const envelope = JSON.parse(failure.stderr);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "database_not_found");
});

test("release metadata and publication workflow agree on the package version", async () => {
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
    'release_hero="docs/assets/lodestar-launch-hero.png"',
    '"${release_assets[@]}"',
    'docs/releases/${GITHUB_REF_NAME}.md',
    'git merge-base --is-ancestor "${GITHUB_SHA}" origin/main',
  ]) {
    assert.ok(workflow.includes(contract), `missing release contract: ${contract}`);
  }
});
