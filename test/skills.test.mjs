import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.mjs";
import { manageSkills } from "../src/skills.mjs";
import { temporaryDirectory } from "./helpers/contract.mjs";

const MANAGED_ROOT = fileURLToPath(new URL("../managed-assets/skills", import.meta.url));
const APPROVED = JSON.parse(
  await readFile(new URL("../managed-assets/manifest.json", import.meta.url), "utf8"),
).skills.map(({ name }) => name);

async function temporaryHome(t) {
  return temporaryDirectory(t, "lodestar-skills-readonly-");
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

test("Codex verification permits identical mirrors and detects divergent roots without migrating either", async (t) => {
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
  assert.equal(duplicate.codex.conflict, false);
  assert.equal(duplicate.results.find(({ skill }) => skill === "director-protocol").action,
    "verified");
  assert.deepEqual(duplicate.results.find(({ skill }) => skill === "director-protocol").warnings,
    ["identical-mirrors"]);
  assert.equal(await treeDigest(home), duplicateBefore);
  await writeFile(path.join(skillPath(home, "codex", "director-protocol", "codex"), "SKILL.md"), "old instructions");
  const conflict = await manageSkills("verify", { home, target: "codex" });
  assert.equal(conflict.codex.conflict, true);
  assert.equal(conflict.results.find(({ skill }) => skill === "director-protocol").action, "conflict");
});

test("OpenCode checks every global discovery root and exposes missing primary destinations", async (t) => {
  const home = await temporaryHome(t);
  for (const skill of APPROVED) await copySkill(skillPath(home, "opencode", skill), skill);
  const alternate = skillPath(home, "codex", "lodestar");
  await copySkill(alternate, "lodestar");
  await writeFile(path.join(alternate, "SKILL.md"), "conflicting old instructions");
  const before = await treeDigest(home);
  const conflict = await manageSkills("verify", { home, target: "opencode" });
  assert.equal(conflict.verified, false);
  const lodestar = conflict.results.find(({ skill }) => skill === "lodestar");
  assert.equal(lodestar.action, "conflict");
  assert.equal(lodestar.copies.find(({ path: candidate }) => candidate === alternate).action, "stale");
  assert.equal(await treeDigest(home), before);
  await rm(skillPath(home, "opencode", "lodestar"), { recursive: true });
  const missing = (await manageSkills("verify", { home, target: "opencode" }))
    .results.find(({ skill }) => skill === "lodestar");
  assert.equal(missing.action, "missing");
  assert.equal(missing.copies[0].action, "missing");
  assert.equal(missing.copies[1].path, alternate);
});

test("Codex aliases to one physical skill are not duplicate installations", async (t) => {
  const home = await temporaryHome(t);
  const primary = skillPath(home, "codex", "lodestar");
  const alias = skillPath(home, "codex", "lodestar", "codex");
  await copySkill(primary, "lodestar");
  await mkdir(path.dirname(alias), { recursive: true });
  await symlink(primary, alias, process.platform === "win32" ? "junction" : "dir");
  const result = (await manageSkills("verify", { home, target: "codex" }))
    .results.find(({ skill }) => skill === "lodestar");
  assert.equal(result.action, "verified");
  assert.equal(result.copies.length, 2);
  assert.equal(result.copies[0].physicalPath, result.copies[1].physicalPath);
  assert.deepEqual(result.warnings, []);
});

test("host environment roots are explicit, and an explicit home isolates inherited environment", async (t) => {
  const home = await temporaryHome(t);
  const env = { CODEX_HOME: path.join(home, "custom-codex"),
    CLAUDE_CONFIG_DIR: path.join(home, "custom-claude"), XDG_CONFIG_HOME: path.join(home, "xdg"),
    OPENCODE_CONFIG_DIR: path.join(home, "custom-opencode"), HERMES_HOME: path.join(home, "custom-hermes") };
  const result = await manageSkills("verify", { home, env, target: "all", codexRoot: "codex" });
  assert.equal(result.codex.path, path.join(env.CODEX_HOME, "skills"));
  assert.equal(result.claude.path, path.join(env.CLAUDE_CONFIG_DIR, "skills"));
  assert.equal(result.opencode.path, path.join(env.OPENCODE_CONFIG_DIR, "skills"));
  assert.ok(result.scope.roots.opencode.includes(path.join(env.XDG_CONFIG_HOME, "opencode", "skills")));
  assert.equal(result.hermes.home, env.HERMES_HOME);
  const explicit = await manageSkills("verify", { home, env, target: "all", codexRoot: "codex",
    codexHome: path.join(home, "explicit-codex"), claudeHome: path.join(home, "explicit-claude"),
    xdgConfigHome: path.join(home, "explicit-xdg"), opencodeRoot: path.join(home, "explicit-opencode", "skills") });
  assert.equal(explicit.codex.path, path.join(home, "explicit-codex", "skills"));
  assert.equal(explicit.claude.path, path.join(home, "explicit-claude", "skills"));
  assert.equal(explicit.opencode.path, path.join(home, "explicit-opencode", "skills"));
  assert.ok(explicit.scope.roots.opencode.includes(path.join(home, "explicit-xdg", "opencode", "skills")));
  // Restore environment even when an assertion fails; no child process changes it.
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const isolated = await manageSkills("verify", { home, target: "all", codexRoot: "codex", platform: "linux" });
    assert.equal(isolated.codex.path, path.join(home, ".codex", "skills"));
    assert.equal(isolated.claude.path, path.join(home, ".claude", "skills"));
    assert.equal(isolated.opencode.path, path.join(home, ".config", "opencode", "skills"));
    assert.equal(isolated.hermes.home, path.join(home, ".hermes"));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("physical skill identity survives a displaced target behind an alias", async (t) => {
  const home = await temporaryHome(t);
  const physical = path.join(home, "shared", "lodestar");
  const alias = skillPath(home, "codex", "lodestar");
  await copySkill(physical, "lodestar");
  await mkdir(path.dirname(alias), { recursive: true });
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const lookup = async () => (await manageSkills("verify", { home, target: "codex" }))
    .results.find(({ skill }) => skill === "lodestar").copies[0];
  assert.equal((await lookup()).physicalPath, physical);
  await rename(physical, `${physical}.backup`);
  const missing = await lookup();
  assert.equal(missing.action, "missing");
  assert.equal(missing.physicalPath, physical);

  // A missing skill below a whole-directory alias also keeps its real target.
  const linkedHome = path.join(home, "linked-home");
  const sharedSkills = path.join(home, "shared-skills");
  await mkdir(path.join(linkedHome, ".agents"), { recursive: true });
  await mkdir(sharedSkills);
  await symlink(sharedSkills, path.join(linkedHome, ".agents", "skills"), process.platform === "win32" ? "junction" : "dir");
  const rootAlias = (await manageSkills("verify", { home: linkedHome, target: "codex" }))
    .results.find(({ skill }) => skill === "lodestar").copies[0];
  assert.equal(rootAlias.physicalPath, path.join(sharedSkills, "lodestar"));
});

test("Hermes refuses identical nested name collisions and ignores support archives and physical aliases", async (t) => {
  const home = await temporaryHome(t);
  const hermesHome = path.join(home, ".hermes");
  const root = path.join(hermesHome, "skills");
  for (const skill of APPROVED) await copySkill(path.join(root, skill), skill);
  const nested = path.join(root, "software-development", "codeplan");
  await copySkill(nested, "codeplan");
  const before = await treeDigest(home);
  const conflict = await manageSkills("verify", { home, hermesHome, target: "hermes" });
  const codeplan = conflict.results.find(({ skill }) => skill === "codeplan");
  assert.equal(conflict.verified, false);
  assert.equal(codeplan.action, "ambiguous");
  assert.equal(codeplan.copies.length, 2);
  assert.ok(codeplan.copies.every(({ action }) => action === "verified"));
  assert.equal(await treeDigest(home), before);
  await rm(nested, { recursive: true });
  const alias = path.join(root, "software-development", "alias-codeplan");
  await symlink(path.join(root, "codeplan"), alias, process.platform === "win32" ? "junction" : "dir");
  await symlink(root, path.join(root, "software-development", "loop"), process.platform === "win32" ? "junction" : "dir");
  await copySkill(path.join(root, "codeplan", "references", "archive", "codeplan"), "codeplan");
  const aliases = await manageSkills("verify", { home, hermesHome, target: "hermes" });
  assert.notEqual(aliases.results.find(({ skill }) => skill === "codeplan").action, "ambiguous");
  // Frontmatter names are loadable even when the directory has another name.
  const named = path.join(root, "category", "different-directory");
  await mkdir(named, { recursive: true });
  await writeFile(path.join(named, "SKILL.md"), "---\nname: 'lodestar' # native name\ndescription: retained alias\n---\nold instructions\n");
  const frontmatter = await manageSkills("verify", { home, hermesHome, target: "hermes" });
  assert.equal(frontmatter.results.find(({ skill }) => skill === "lodestar").action, "ambiguous");
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
