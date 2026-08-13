import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
    'release_social="docs/assets/lodestar-v${version}-social.png"',
    '"${release_assets[@]}"',
    'docs/releases/${GITHUB_REF_NAME}.md',
    'git merge-base --is-ancestor "${GITHUB_SHA}" origin/main',
  ]) {
    assert.ok(workflow.includes(contract), `missing release contract: ${contract}`);
  }
});

test("the current release has valid launch graphics", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  const assets = [
    {
      file: path.join(ROOT, "docs", "assets", "lodestar-launch-hero.png"),
      width: 1_600,
      height: 900,
    },
    {
      file: path.join(
        ROOT,
        "docs",
        "assets",
        `lodestar-v${packageJson.version}-social.png`,
      ),
      width: 1_254,
      height: 1_254,
    },
  ];
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const allowedChunks = new Set(["IHDR", "pHYs", "IDAT", "IEND"]);

  for (const { file, width, height } of assets) {
    const bytes = await readFile(file);
    assert.ok(bytes.length > 100_000, `${file} is unexpectedly small`);
    assert.deepEqual(bytes.subarray(0, pngSignature.length), pngSignature);
    assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);

    let offset = pngSignature.length;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      assert.ok(
        allowedChunks.has(type),
        `${file} contains unexpected PNG metadata chunk ${type}`,
      );
      offset += 12 + length;
      assert.ok(offset <= bytes.length, `${file} has a truncated ${type} chunk`);
      if (type === "IEND") {
        ended = true;
        break;
      }
    }
    assert.equal(ended, true, `${file} is missing its IEND chunk`);
    assert.equal(offset, bytes.length, `${file} has trailing data`);
  }
});
