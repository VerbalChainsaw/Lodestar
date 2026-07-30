import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { AGENTCTX_VERSION } from "../agentctx.mjs";
import { INSTALLER_VERSION } from "../install.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("public package metadata and MIT license are release-ready", async () => {
  const metadata = JSON.parse(await text("package.json"));
  const license = await text("LICENSE");

  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.repository.url, "git+https://github.com/VerbalChainsaw/Lodestar.git");
  assert.equal(metadata.bugs.url, "https://github.com/VerbalChainsaw/Lodestar/issues");
  assert.equal(
    Object.values(metadata.bin).some((target) => target.startsWith("./")),
    false,
  );
  assert.equal(metadata.bin["lodestar-benchmark"], "tools/benchmark-lift.mjs");
  assert.equal(
    metadata.bin["lodestar-performance"],
    "tools/benchmark-performance.mjs",
  );
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 VerbalChainsaw/);
  assert.match(license, /Permission is hereby granted, free of charge/);
});

test("versioned docs and package smoke checks match the package version", async () => {
  const metadata = JSON.parse(await text("package.json"));
  const version = metadata.version;
  const tarball = `lodestar-agent-context-${version}.tgz`;
  const releaseNotes = await text(`docs/releases/v${version}.md`);
  const readme = await text("README.md");
  const ci = await text(".github/workflows/ci.yml");
  const releaseWorkflow = await text(".github/workflows/release.yml");
  const security = await text("SECURITY.md");
  const dependabot = await text(".github/dependabot.yml");

  assert.equal(AGENTCTX_VERSION, version);
  assert.equal(INSTALLER_VERSION, version);
  assert.match(releaseNotes, new RegExp(`Lodestar v${version.replaceAll(".", "\\.")}`));
  assert.match(readme, new RegExp(tarball.replaceAll(".", "\\.")));
  assert.doesNotMatch(readme, /current worktree is .*release candidate/i);
  assert.doesNotMatch(releaseNotes, /publication still requires/i);
  assert.doesNotMatch(readme, /\bunlicensed\b/i);
  assert.match(security, /private vulnerability reporting/i);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.match(ci, /PACKAGE=lodestar-agent-context-\$version\.tgz/);
  assert.match(ci, /"\.\/\$\{\{ env\.PACKAGE \}\}"/);
  assert.match(ci, /npm --prefix \.package-smoke exec -- lodestar-performance/);
  assert.doesNotMatch(ci, /lodestar-agent-context-\d+\.\d+\.\d+\.tgz/);
  assert.match(releaseWorkflow, /sha256sum/);
  assert.match(releaseWorkflow, /gh release create/);
});
