import assert from "node:assert/strict";
import {
  access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { BOOTSTRAP_TEXT } from "../src/bootstrap.mjs";
import { runCli } from "../src/cli.mjs";
import { manageSkills } from "../src/skills.mjs";

const APPROVED = [
  "director-protocol",
  "codeplan",
  "center-multigeometry",
  "center-audit",
  "ladder-audit",
  "lodestar",
];

async function temporaryHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lodestar-skills-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const skillPath = (home, target, skill, codexRoot = "agents") => {
  if (target === "hermes") return path.join(home, "skills", skill);
  if (target === "opencode") return path.join(home, ".config", "opencode", "skills", skill);
  return path.join(home, target === "codex" ? `.${codexRoot}` : ".claude", "skills", skill);
};

test("managed skills install, verify, repeat, back up, and remove", async (t) => {
  const home = await temporaryHome(t);
  const hermesHome = path.join(home, "portable-hermes");
  const occupied = skillPath(home, "codex", "director-protocol");
  await mkdir(occupied, { recursive: true });
  await writeFile(path.join(occupied, "unrelated.txt"), "preserve me");

  const preview = await manageSkills("install", {
    home,
    target: "all",
    hermesHome,
    dryRun: true,
    now: () => Date.parse("2026-08-13T10:00:00.000Z"),
  });
  assert.equal(preview.results.length, APPROVED.length * 4);
  assert.equal(await readFile(path.join(occupied, "unrelated.txt"), "utf8"), "preserve me");

  const installed = await manageSkills("install", {
    home,
    target: "all",
    hermesHome,
    now: () => Date.parse("2026-08-13T10:00:00.000Z"),
  });
  assert.deepEqual(installed.skills, APPROVED);
  const replacement = installed.results.find(({ target, skill }) =>
    target === "codex" && skill === "director-protocol"
  );
  assert.equal(replacement.action, "replaced");
  assert.ok(replacement.backup.includes(path.join(".lodestar", "skill-backups")));
  assert.equal(replacement.backup.includes(path.join(".agents", "skills")), false);
  assert.equal(
    await readFile(path.join(replacement.backup, "unrelated.txt"), "utf8"),
    "preserve me",
  );
  for (const target of ["codex", "claude", "hermes", "opencode"]) {
    const targetHome = target === "hermes" ? hermesHome : home;
    for (const skill of APPROVED) {
      await access(path.join(skillPath(targetHome, target, skill), "SKILL.md"));
    }
    await access(path.join(skillPath(targetHome, target, "lodestar"),
      "assets", "templates", "AGENTS.template.md"));
    await assert.rejects(access(skillPath(targetHome, target, "retired-skill")), { code: "ENOENT" });
  }

  const verified = await manageSkills("verify", { home, hermesHome, target: "all" });
  assert.equal(verified.verified, true);
  assert.ok(verified.results.every(({ action }) => action === "verified"));

  const repeated = await manageSkills("install", { home, hermesHome, target: "all" });
  assert.ok(repeated.results.every(({ action }) => action === "unchanged"));

  await writeFile(
    path.join(skillPath(home, "claude", "lodestar"), "local-note.txt"),
    "keep local change",
  );
  const removed = await manageSkills("remove", {
    home,
    target: "all",
    hermesHome,
    now: () => Date.parse("2026-08-13T11:00:00.000Z"),
  });
  const changedRemoval = removed.results.find(({ target, skill }) =>
    target === "claude" && skill === "lodestar"
  );
  assert.ok(changedRemoval.backup.includes(path.join(".lodestar", "skill-backups")));
  assert.equal(
    await readFile(path.join(changedRemoval.backup, "local-note.txt"), "utf8"),
    "keep local change",
  );
  for (const target of ["codex", "claude", "hermes", "opencode"]) {
    const targetHome = target === "hermes" ? hermesHome : home;
    for (const skill of APPROVED) {
      await assert.rejects(access(skillPath(targetHome, target, skill)), { code: "ENOENT" });
    }
  }

  const after = await manageSkills("verify", { home, hermesHome, target: "all" });
  assert.equal(after.verified, false);
});

test("Hermes lifecycle preserves unrelated skills and keeps backups outside discovery", async (t) => {
  const home = await temporaryHome(t);
  const hermesHome = path.join(home, "explicit-hermes");
  const unrelated = path.join(hermesHome, "skills", "software-forensics", "local-runtime");
  const replaced = skillPath(hermesHome, "hermes", "director-protocol");
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, "SKILL.md"), "unrelated category skill");
  await mkdir(replaced, { recursive: true });
  await writeFile(path.join(replaced, "local.txt"), "replace and back up");

  const installed = await manageSkills("install", {
    home, target: "hermes", hermesHome,
    now: () => Date.parse("2026-08-13T13:00:00.000Z"),
  });
  assert.equal(installed.hermes.home, path.resolve(hermesHome));
  assert.deepEqual(installed.targets, ["hermes"]);
  assert.equal(installed.results.length, APPROVED.length);
  const replacement = installed.results.find(({ skill }) => skill === "director-protocol");
  assert.ok(replacement.backup.startsWith(path.join(home, ".lodestar", "skill-backups")));
  assert.equal(replacement.backup.startsWith(path.join(hermesHome, "skills")), false);
  assert.equal(await readFile(path.join(replacement.backup, "local.txt"), "utf8"),
    "replace and back up");
  assert.equal(await readFile(path.join(unrelated, "SKILL.md"), "utf8"),
    "unrelated category skill");

  const repeated = await manageSkills("install", { home, target: "hermes", hermesHome });
  assert.ok(repeated.results.every(({ action }) => action === "unchanged"));
  await rm(skillPath(hermesHome, "hermes", "codeplan"), { recursive: true });
  await writeFile(path.join(skillPath(hermesHome, "hermes", "lodestar"), "stale.txt"), "stale");
  const verification = await manageSkills("verify", { home, target: "hermes", hermesHome });
  assert.equal(verification.results.find(({ skill }) => skill === "codeplan").action, "missing");
  assert.equal(verification.results.find(({ skill }) => skill === "lodestar").action, "stale");

  await manageSkills("remove", { home, target: "hermes", hermesHome });
  assert.equal(await readFile(path.join(unrelated, "SKILL.md"), "utf8"),
    "unrelated category skill");
  for (const skill of APPROVED) {
    await assert.rejects(access(skillPath(hermesHome, "hermes", skill)), { code: "ENOENT" });
  }
});

test("managed state stays on the client filesystem when .lodestar crosses roots", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lodestar-skill-cross-root-home-"));
  const shared = await mkdtemp(path.join(os.tmpdir(), "lodestar-skill-cross-root-shared-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(shared, { recursive: true, force: true }));
  await symlink(shared, path.join(home, ".lodestar"), process.platform === "win32" ? "junction" : "dir");

  await manageSkills("sync", { target: "claude", home });
  await access(path.join(home, ".claude", "skills", "lodestar", "SKILL.md"));
  await assert.rejects(
    access(path.join(home, ".local", "state", ".claude", "skills", "lodestar")),
    { code: "ENOENT" },
  );
  await writeFile(path.join(home, ".claude", "skills", "lodestar", "SKILL.md"), "stale");
  const claude = await manageSkills("sync", { target: "claude", home });
  const claudeReplacement = claude.results.find(({ skill }) => skill === "lodestar");
  assert.match(claudeReplacement.backup, /[\\/]\.local[\\/]state[\\/]\.lodestar[\\/]/u);

  await manageSkills("sync", { target: "codex", home });
  await writeFile(path.join(home, ".agents", "skills", "lodestar", "SKILL.md"), "stale");
  const result = await manageSkills("sync", { target: "codex", home });
  const replacement = result.results.find(({ skill }) => skill === "lodestar");

  assert.match(replacement.backup, /[\\/]\.local[\\/]state[\\/]\.lodestar[\\/]/u);
  assert.equal(replacement.backup.startsWith(shared), false);
});

test("configured bootstrap files share the managed transaction and verification", async (t) => {
  const home = await temporaryHome(t);
  const bootstrap = path.join(home, "AGENTS.md");
  await writeFile(bootstrap, "preserve original bootstrap\n");
  const bootstrapFiles = { "--codex-bootstrap": bootstrap };
  const installed = await manageSkills("install", {
    home, target: "codex", bootstrapFiles,
    now: () => Date.parse("2026-08-13T15:00:00.000Z"),
  });
  const result = installed.results.find(({ target }) => target === "codex-bootstrap");
  assert.equal(result.action, "replaced");
  assert.equal(await readFile(result.backup, "utf8"), "preserve original bootstrap\n");
  assert.equal(await readFile(bootstrap, "utf8"), BOOTSTRAP_TEXT);
  const verified = await manageSkills("verify", { home, target: "codex", bootstrapFiles });
  assert.equal(verified.verified, true);
  assert.equal(verified.results.find(({ target }) => target === "codex-bootstrap").action,
    "verified");
  const repeated = await manageSkills("sync", { home, target: "codex", bootstrapFiles });
  assert.equal(repeated.results.find(({ target }) => target === "codex-bootstrap").action,
    "unchanged");
  await manageSkills("remove", { home, target: "codex", bootstrapFiles });
  await assert.rejects(access(bootstrap), { code: "ENOENT" });
});

test("a failed client batch restores every earlier skill destination", async (t) => {
  const home = await temporaryHome(t);
  const hermesHome = path.join(home, "portable-hermes");
  const original = skillPath(home, "codex", "director-protocol");
  await mkdir(original, { recursive: true });
  await writeFile(path.join(original, "local.txt"), "restore this exact directory");
  const bootstrap = path.join(home, "AGENTS.md");
  await writeFile(bootstrap, "restore this exact bootstrap\n");
  let injected = false;
  const move = async (source, destination) => {
    if (!injected && source.startsWith(hermesHome)) {
      injected = true;
      const error = new Error("injected later-target failure");
      error.code = "EACCES";
      throw error;
    }
    await rename(source, destination);
  };

  await assert.rejects(
    manageSkills("install", { home, target: "all", hermesHome, move,
      bootstrapFiles: { "--codex-bootstrap": bootstrap } }),
    { code: "skills_write_failed" },
  );
  assert.equal(injected, true);
  assert.equal(await readFile(path.join(original, "local.txt"), "utf8"),
    "restore this exact directory");
  assert.equal(await readFile(bootstrap, "utf8"), "restore this exact bootstrap\n");
  for (const skill of APPROVED.filter((name) => name !== "director-protocol")) {
    await assert.rejects(access(skillPath(home, "codex", skill)), { code: "ENOENT" });
  }
  for (const skill of APPROVED) {
    await assert.rejects(access(skillPath(home, "claude", skill)), { code: "ENOENT" });
    await assert.rejects(access(skillPath(hermesHome, "hermes", skill)), { code: "ENOENT" });
  }
});

test("a failed removal batch restores all already removed clients", async (t) => {
  const home = await temporaryHome(t);
  const hermesHome = path.join(home, "portable-hermes");
  await manageSkills("install", { home, target: "all", hermesHome });
  let injected = false;
  const move = async (source, destination) => {
    if (!injected && source.startsWith(hermesHome)) {
      injected = true;
      const error = new Error("injected removal failure");
      error.code = "EACCES";
      throw error;
    }
    await rename(source, destination);
  };

  await assert.rejects(
    manageSkills("remove", { home, target: "all", hermesHome, move }),
    { code: "skills_write_failed" },
  );
  assert.equal(injected, true);
  const verified = await manageSkills("verify", { home, target: "all", hermesHome });
  assert.equal(verified.verified, true);
});

test("Hermes home resolution follows override, environment, then platform default", async (t) => {
  const home = await temporaryHome(t);
  const environmentHome = path.join(home, "environment-hermes");
  const fromEnvironment = await manageSkills("verify", {
    home, target: "hermes", env: { HERMES_HOME: environmentHome }, platform: "linux",
  });
  assert.equal(fromEnvironment.hermes.home, path.resolve(environmentHome));
  const windowsDefault = await manageSkills("verify", {
    home, target: "hermes", env: {}, platform: "win32",
  });
  assert.equal(windowsDefault.hermes.home, path.resolve(home, "AppData", "Local", "hermes"));
  const portableDefault = await manageSkills("verify", {
    home, target: "hermes", env: {}, platform: "linux",
  });
  assert.equal(portableDefault.hermes.home, path.resolve(home, ".hermes"));
});

test("OpenCode lifecycle resolves its root and preserves unrelated skills", async (t) => {
  const home = await temporaryHome(t);
  const defaultRoot = path.join(home, ".config", "opencode", "skills");
  const unrelated = path.join(defaultRoot, "unrelated-skill");
  const replaced = path.join(defaultRoot, "director-protocol");
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, "SKILL.md"), "preserve unrelated OpenCode skill");
  await mkdir(replaced, { recursive: true });
  await writeFile(path.join(replaced, "local.txt"), "back up replacement");

  const installed = await manageSkills("install", {
    home, target: "opencode", now: () => Date.parse("2026-08-13T14:00:00.000Z"),
  });
  assert.deepEqual(installed.targets, ["opencode"]);
  assert.deepEqual(installed.opencode, { path: path.resolve(defaultRoot), reason: "default" });
  const replacement = installed.results.find(({ skill }) => skill === "director-protocol");
  assert.equal(replacement.action, "replaced");
  assert.ok(replacement.backup.startsWith(path.join(home, ".lodestar", "skill-backups")));
  assert.equal(replacement.backup.startsWith(defaultRoot), false);
  assert.equal(await readFile(path.join(replacement.backup, "local.txt"), "utf8"),
    "back up replacement");
  assert.equal(await readFile(path.join(unrelated, "SKILL.md"), "utf8"),
    "preserve unrelated OpenCode skill");

  const repeated = await manageSkills("install", { home, target: "opencode" });
  assert.ok(repeated.results.every(({ action }) => action === "unchanged"));
  assert.equal((await manageSkills("verify", { home, target: "opencode" })).verified, true);
  await rm(path.join(defaultRoot, "codeplan"), { recursive: true });
  await writeFile(path.join(defaultRoot, "lodestar", "stale.txt"), "stale");
  const verification = await manageSkills("verify", { home, target: "opencode" });
  assert.equal(verification.results.find(({ skill }) => skill === "codeplan").action, "missing");
  assert.equal(verification.results.find(({ skill }) => skill === "lodestar").action, "stale");

  await manageSkills("remove", { home, target: "opencode" });
  assert.equal(await readFile(path.join(unrelated, "SKILL.md"), "utf8"),
    "preserve unrelated OpenCode skill");
  for (const skill of APPROVED) {
    await assert.rejects(access(path.join(defaultRoot, skill)), { code: "ENOENT" });
  }

  const override = path.join(home, "portable-opencode-skills");
  const overridden = await manageSkills("install", {
    home, target: "opencode", opencodeRoot: override,
  });
  assert.deepEqual(overridden.opencode, { path: path.resolve(override), reason: "override" });
  assert.ok(overridden.results.every(({ path: resultPath }) => resultPath.startsWith(override)));
});

test("Codex selects either recognized root and diagnoses two-root states", async (t) => {
  const home = await temporaryHome(t);
  const codexSkill = skillPath(home, "codex", "director-protocol", "codex");
  await mkdir(codexSkill, { recursive: true });
  await writeFile(path.join(codexSkill, "old.txt"), "select this root");

  const installed = await manageSkills("install", { home, target: "codex" });
  assert.equal(installed.codex.selectedRoot, "codex");
  assert.equal(installed.codex.reason, "existing-managed-copy");
  for (const skill of APPROVED) {
    await access(path.join(skillPath(home, "codex", skill, "codex"), "SKILL.md"));
    await assert.rejects(access(skillPath(home, "codex", skill)), { code: "ENOENT" });
  }

  const wrongRoot = await manageSkills("verify", {
    home,
    target: "codex",
    codexRoot: "agents",
  });
  assert.equal(wrongRoot.verified, false);
  assert.ok(wrongRoot.results.every(({ action }) => action === "alternate-root-only"));

  const duplicate = skillPath(home, "codex", "director-protocol");
  await cp(codexSkill, duplicate, { recursive: true });
  const conflicted = await manageSkills("verify", { home, target: "codex" });
  assert.equal(conflicted.codex.conflict, true);
  assert.equal(
    conflicted.results.find(({ skill }) => skill === "director-protocol").action,
    "duplicate",
  );
  await assert.rejects(
    manageSkills("install", { home, target: "codex" }),
    { code: "codex_skill_root_conflict" },
  );
});

test("Codex root migration is explicit and backed up outside discovery roots", async (t) => {
  const home = await temporaryHome(t);
  await manageSkills("install", { home, target: "codex", codexRoot: "agents" });

  await assert.rejects(
    manageSkills("install", { home, target: "codex", codexRoot: "codex" }),
    { code: "codex_skill_wrong_root" },
  );
  const migrated = await manageSkills("install", {
    home,
    target: "codex",
    codexRoot: "codex",
    migrate: true,
    now: () => Date.parse("2026-08-13T12:00:00.000Z"),
  });
  for (const result of migrated.results) {
    assert.ok(result.migrationBackup.includes(path.join(".lodestar", "skill-backups")));
    assert.equal(result.migrationBackup.includes(path.join(".codex", "skills")), false);
    assert.equal(result.migrationBackup.includes(path.join(".agents", "skills")), false);
    await access(path.join(result.path, "SKILL.md"));
    await access(path.join(result.migrationBackup, "SKILL.md"));
    await assert.rejects(access(skillPath(home, "codex", result.skill)), { code: "ENOENT" });
  }
  const verified = await manageSkills("verify", {
    home,
    target: "codex",
    codexRoot: "codex",
  });
  assert.equal(verified.verified, true);

  await writeFile(path.join(skillPath(home, "codex", "lodestar", "codex"), "stale.txt"), "stale");
  const stale = await manageSkills("verify", {
    home,
    target: "codex",
    codexRoot: "codex",
  });
  assert.equal(stale.results.find(({ skill }) => skill === "lodestar").action, "stale");
});

test("Codex treats junctioned recognized roots as one physical skill root", async (t) => {
  const home = await temporaryHome(t);
  const codexRoot = path.join(home, ".codex", "skills");
  await mkdir(codexRoot, { recursive: true });
  await mkdir(path.join(home, ".agents"), { recursive: true });
  await symlink(codexRoot, path.join(home, ".agents", "skills"), "junction");

  const installed = await manageSkills("install", {
    home, target: "codex", codexRoot: "codex", migrate: true,
  });
  assert.equal(installed.codex.conflict, false);
  assert.equal(installed.codex.reason, "aliased-roots");
  assert.ok(installed.results.every(({ migrationBackup }) => migrationBackup === null));

  const verified = await manageSkills("verify", { home, target: "codex" });
  assert.equal(verified.verified, true);
  assert.ok(verified.results.every(({ action }) => action === "verified"));
});

test("the CLI exposes dry-run, install, sync, verify, and removal", async (t) => {
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
  const bootstrap = path.join(home, "AGENTS.md");
  const base = ["--target", "codex", "--home", home,
    "--codex-bootstrap", bootstrap];
  const preview = await invoke(["skills", "install", ...base, "--dry-run"]);
  assert.equal(preview.exitCode, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).data.dryRun, true);
  await assert.rejects(access(skillPath(home, "codex", "lodestar")), { code: "ENOENT" });

  assert.equal((await invoke(["skills", "install", ...base])).exitCode, 0);
  assert.equal(await readFile(bootstrap, "utf8"), BOOTSTRAP_TEXT);
  const synchronized = await invoke(["skills", "sync", ...base]);
  assert.equal(synchronized.exitCode, 0, synchronized.stderr);
  assert.equal(JSON.parse(synchronized.stdout).data.action, "sync");
  assert.ok(JSON.parse(synchronized.stdout).data.results
    .every(({ action }) => action === "unchanged"));
  assert.equal((await invoke(["skills", "verify", ...base])).exitCode, 0);
  assert.equal((await invoke(["skills", "remove", ...base])).exitCode, 0);
  await assert.rejects(access(bootstrap), { code: "ENOENT" });
  assert.equal((await invoke(["skills", "verify", ...base])).exitCode, 4);

  const hermesHome = path.join(home, "cli-hermes");
  const hermes = ["--target", "hermes", "--home", home, "--hermes-home", hermesHome];
  assert.equal((await invoke(["skills", "install", ...hermes])).exitCode, 0);
  const hermesVerification = await invoke(["skills", "verify", ...hermes]);
  assert.equal(hermesVerification.exitCode, 0, hermesVerification.stderr);
  assert.equal(JSON.parse(hermesVerification.stdout).data.hermes.home, path.resolve(hermesHome));
  assert.equal((await invoke(["skills", "remove", ...hermes])).exitCode, 0);

  const opencodeRoot = path.join(home, "cli-opencode-skills");
  const opencode = ["--target", "opencode", "--home", home,
    "--opencode-root", opencodeRoot];
  assert.equal((await invoke(["skills", "install", ...opencode])).exitCode, 0);
  const opencodeVerification = await invoke(["skills", "verify", ...opencode]);
  assert.equal(opencodeVerification.exitCode, 0, opencodeVerification.stderr);
  assert.equal(JSON.parse(opencodeVerification.stdout).data.opencode.path,
    path.resolve(opencodeRoot));
  assert.equal((await invoke(["skills", "remove", ...opencode])).exitCode, 0);
});
