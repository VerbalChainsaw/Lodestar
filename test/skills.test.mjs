import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.mjs";
import { manageSkills } from "../src/skills.mjs";

const MANAGED_ROOT = fileURLToPath(new URL("../managed-assets/skills", import.meta.url));
const APPROVED = JSON.parse(
  await readFile(new URL("../managed-assets/manifest.json", import.meta.url), "utf8"),
).skills;

async function temporaryHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lodestar-skills-readonly-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const skillPath = (home, target, skill, codexRoot = "agents") => {
  if (target === "hermes") return path.join(home, "skills", skill);
  if (target === "opencode") return path.join(home, ".config", "opencode", "skills", skill);
  return path.join(home, target === "codex" ? `.${codexRoot}` : ".claude", "skills", skill);
};

async function copySkill(destination, skill) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(MANAGED_ROOT, skill), destination, { recursive: true });
}

async function treeDigest(root) {
  if (!await import("node:fs/promises").then(({ access }) => access(root).then(() => true, () => false))) {
    return "missing";
  }
  const hash = createHash("sha256");
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      hash.update(relative).update("\0");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) hash.update(await readFile(absolute)).update("\0");
      else hash.update("special\0");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

test("skill verification is read-only and reports verified, stale, and missing copies", async (t) => {
  const home = await temporaryHome(t);
  const hermesHome = path.join(home, "portable-hermes");
  for (const target of ["codex", "claude", "hermes", "opencode"]) {
    const targetHome = target === "hermes" ? hermesHome : home;
    for (const skill of APPROVED) {
      await copySkill(skillPath(targetHome, target, skill), skill);
    }
  }

  const before = await treeDigest(home);
  const verified = await manageSkills("verify", { home, hermesHome, target: "all" });
  assert.equal(verified.readOnly, true);
  assert.equal(verified.verified, true);
  assert.ok(verified.results.every(({ action }) => action === "verified"));
  assert.equal(await treeDigest(home), before);

  const staleFile = path.join(skillPath(home, "claude", "codeplan"), "SKILL.md");
  await writeFile(staleFile, `${await readFile(staleFile, "utf8")}\nlocal drift\n`);
  await rm(skillPath(home, "opencode", "ladder-audit"), { recursive: true });
  const changedBefore = await treeDigest(home);
  const changed = await manageSkills("verify", { home, hermesHome, target: "all" });
  assert.equal(changed.verified, false);
  assert.equal(changed.results.find(({ target, skill }) =>
    target === "claude" && skill === "codeplan").action, "stale");
  assert.equal(changed.results.find(({ target, skill }) =>
    target === "opencode" && skill === "ladder-audit").action, "missing");
  assert.equal(await treeDigest(home), changedBefore);
});

test("all retired skill mutation operations fail before touching the filesystem", async (t) => {
  const home = await temporaryHome(t);
  const root = path.join(home, ".agents", "skills");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "preserve.txt"), "do not touch");
  const before = await treeDigest(home);
  for (const operation of ["install", "sync", "remove"]) {
    await assert.rejects(
      manageSkills(operation, { home, target: "all" }),
      ({ code }) => code === "skills_read_only",
    );
    assert.equal(await treeDigest(home), before);
  }
});

test("read-only verification resolves target roots without creating them", async (t) => {
  const home = await temporaryHome(t);
  const hermesHome = path.join(home, "explicit-hermes");
  const opencodeRoot = path.join(home, "explicit-opencode");
  const before = await treeDigest(home);
  const result = await manageSkills("verify", {
    home,
    target: "all",
    hermesHome,
    opencodeRoot,
  });
  assert.equal(result.verified, false);
  assert.equal(result.hermes.home, path.resolve(hermesHome));
  assert.equal(result.opencode.path, path.resolve(opencodeRoot));
  assert.equal(await treeDigest(home), before);
});

test("Codex verification detects alternate and duplicate roots without migrating either", async (t) => {
  const home = await temporaryHome(t);
  await copySkill(skillPath(home, "codex", "director-protocol", "codex"), "director-protocol");
  const oneRootBefore = await treeDigest(home);
  const oneRoot = await manageSkills("verify", { home, target: "codex" });
  assert.equal(oneRoot.codex.selectedRoot, "codex");
  assert.equal(oneRoot.codex.reason, "existing-copy");
  assert.equal(await treeDigest(home), oneRootBefore);

  await copySkill(skillPath(home, "codex", "director-protocol", "agents"), "director-protocol");
  const duplicateBefore = await treeDigest(home);
  const duplicate = await manageSkills("verify", { home, target: "codex" });
  assert.equal(duplicate.codex.conflict, true);
  assert.equal(duplicate.results.find(({ skill }) => skill === "director-protocol").action,
    "duplicate");
  assert.equal(await treeDigest(home), duplicateBefore);
});

test("the CLI exposes read-only verification and rejects retired write surfaces", async (t) => {
  const home = await temporaryHome(t);
  const invoke = async (args) => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(args, {
      stdin: Readable.from([]),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });
    return { exitCode, stdout, stderr };
  };

  const before = await treeDigest(home);
  const verification = await invoke(["skills", "verify", "--target", "codex", "--home", home]);
  assert.equal(verification.exitCode, 4, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).data.readOnly, true);
  assert.equal(await treeDigest(home), before);

  for (const operation of ["install", "sync", "remove"]) {
    const rejected = await invoke(["skills", operation, "--target", "codex", "--home", home]);
    assert.notEqual(rejected.exitCode, 0);
    assert.equal(JSON.parse(rejected.stderr).error.code, "skills_read_only");
    assert.equal(await treeDigest(home), before);
  }

  const bootstrap = path.join(home, "AGENTS.md");
  const retiredOption = await invoke([
    "skills", "verify", "--target", "codex", "--home", home,
    "--codex-bootstrap", bootstrap,
  ]);
  assert.notEqual(retiredOption.exitCode, 0);
  assert.equal(await treeDigest(home), before);
});
