import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setup } from "../src/setup.mjs";
import { manageSkills } from "../src/skills.mjs";
import { renderWindowsPosixShim } from "../src/windows-install.mjs";

async function homeFor(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lodestar-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("packaged setup plans read-only, installs, and repeats without creating conflicting copies", async (t) => {
  const home = await homeFor(t);
  const options = { home, hermesHome: path.join(home, ".hermes"), target: "all" };
  const plan = await setup(options);
  assert.equal(plan.applied, false);
  assert.deepEqual(await readdir(home), []);
  assert.ok(plan.plans.every(({ action }) => action === "install"));
  const applied = await setup({ ...options, apply: true });
  assert.equal(applied.verified, true);
  const again = await setup({ ...options, apply: true });
  assert.ok(again.results.every(({ action, backup }) => action === "current" && backup === null));
  assert.equal((await manageSkills("verify", options)).verified, true);
});

test("setup preserves unknown/local changes and preflights the whole selection before replacement", async (t) => {
  const home = await homeFor(t);
  const file = path.join(home, ".agents", "skills", "lodestar", "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "local instructions");
  await assert.rejects(setup({ home, target: "codex", apply: true }), { code: "install_local_changes" });
  assert.equal(await readFile(file, "utf8"), "local instructions");
  assert.deepEqual(await readdir(path.dirname(path.dirname(file))), ["lodestar"]);
  const installed = await setup({ home, target: "codex", apply: true, replaceLocal: true });
  const changed = installed.results.find(({ backup }) => backup);
  assert.equal(await readFile(path.join(changed.backup, "SKILL.md"), "utf8"), "local instructions");
  await writeFile(file, "edited after installation");
  await assert.rejects(setup({ home, target: "codex", apply: true }), { code: "install_local_changes" });
  assert.equal(await readFile(file, "utf8"), "edited after installation");
});

test("interrupted tree replacement recovers the old tree and remains retryable", async (t) => {
  const home = await homeFor(t);
  const target = path.join(home, ".agents", "skills", "lodestar");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "old payload to preserve");
  await assert.rejects(setup({ home, target: "codex", apply: true, replaceLocal: true,
    onProgress: ({ target: current }) => { if (current === target) throw new Error("simulated interruption"); },
  }), /simulated interruption/u);
  const plan = await setup({ home, target: "codex" });
  assert.ok(plan.plans.some(({ action }) => action === "recover"));
  const retry = await setup({ home, target: "codex", apply: true, replaceLocal: true });
  assert.equal(retry.verified, true);
  const restored = retry.results.find(({ target: current }) => current === target);
  assert.equal(await readFile(path.join(restored.backup, "SKILL.md"), "utf8"), "old payload to preserve");
});

test("setup repairs divergent OpenCode-discovered mirrors only with explicit replacement", async (t) => {
  const home = await homeFor(t);
  await setup({ home, target: "opencode", apply: true });
  const alternate = path.join(home, ".agents", "skills", "lodestar");
  await mkdir(alternate, { recursive: true });
  await writeFile(path.join(alternate, "SKILL.md"), "obsolete instructions");
  await assert.rejects(setup({ home, target: "opencode", apply: true }), { code: "install_local_changes" });
  assert.equal((await setup({ home, target: "opencode", apply: true, replaceLocal: true })).verified, true);
});

test("concurrent setups serialize by destination ownership and failed attempt can retry", async (t) => {
  const home = await homeFor(t);
  let resume;
  const held = new Promise((resolve) => { resume = resolve; });
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const first = setup({ home, target: "codex", apply: true,
    onProgress: async () => { started(); await held; },
  });
  await startedPromise;
  try { await assert.rejects(setup({ home, target: "codex", apply: true }), { code: "install_busy" }); }
  finally { resume(); }
  assert.equal((await first).verified, true);
  assert.equal((await setup({ home, target: "codex", apply: true })).verified, true);
});

test("interrupted replacement of a discovered alternate is recovered even while it is absent", async (t) => {
  const home = await homeFor(t);
  await setup({ home, target: "opencode", apply: true });
  const alternate = path.join(home, ".agents", "skills", "lodestar");
  await mkdir(alternate, { recursive: true });
  await writeFile(path.join(alternate, "SKILL.md"), "old alternate user content");
  await assert.rejects(setup({ home, target: "opencode", apply: true, replaceLocal: true,
    onProgress: ({ target }) => { if (target === alternate) throw new Error("alternate interruption"); },
  }), /alternate interruption/u);
  const plan = await setup({ home, target: "opencode" });
  assert.ok(plan.plans.some(({ target, action }) => target === alternate && action === "recover"));
  const result = await setup({ home, target: "opencode", apply: true, replaceLocal: true });
  assert.equal(result.verified, true);
  const replaced = result.results.find(({ target }) => target === alternate);
  assert.ok(replaced?.backup, "The alternate must be restored and its old content retained during replacement");
  assert.equal(await readFile(path.join(replaced.backup, "SKILL.md"), "utf8"), "old alternate user content");
});

async function interrupted(t) {
  const home = await homeFor(t);
  const target = path.join(home, ".agents", "skills", "lodestar");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "original user content");
  await assert.rejects(setup({ home, target: "codex", apply: true, replaceLocal: true,
    onProgress: ({ target: current }) => { if (current === target) throw new Error("interrupt"); },
  }), /interrupt/u);
  const { state } = (await setup({ home, target: "codex" })).plans.find((item) => item.target === target);
  const journal = path.join(state, "pending.json");
  return { home, target, state, journal, pending: JSON.parse(await readFile(journal, "utf8")) };
}

test("recovery rejects colliding journal paths without deleting the preserved original", async (t) => {
  const { home, target, journal, pending } = await interrupted(t);
  await cp(pending.stage, target, { recursive: true });
  pending.stage = pending.backup;
  await writeFile(journal, JSON.stringify(pending));
  await assert.rejects(setup({ home, target: "codex", apply: true, replaceLocal: true }), { code: "install_recovery_conflict" });
  assert.equal(await readFile(path.join(pending.backup, "SKILL.md"), "utf8"), "original user content");
  assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), pending);
});

test("recovery refuses a changed backup and preserves the staged and changed content", async (t) => {
  const { home, journal, pending } = await interrupted(t);
  await writeFile(path.join(pending.backup, "SKILL.md"), "newer backup edit");
  await assert.rejects(setup({ home, target: "codex", apply: true, replaceLocal: true }), { code: "install_recovery_conflict" });
  assert.equal(await readFile(path.join(pending.backup, "SKILL.md"), "utf8"), "newer backup edit");
  assert.ok((await readFile(path.join(pending.stage, "SKILL.md"))).length);
  assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), pending);
});

test("recovery preserves changed or partial staged content while remaining retryable", async (t) => {
  const { home, pending } = await interrupted(t);
  const sentinel = path.join(pending.stage, "unrecognized-user-file.txt");
  await writeFile(sentinel, "preserve this newer file");
  await writeFile(path.join(pending.stage, "SKILL.md"), "partial or changed copy");
  const recovered = await setup({ home, target: "codex", apply: true, replaceLocal: true });
  assert.equal(recovered.verified, true);
  assert.ok(recovered.recoveries.some((item) => item.retained_stage === pending.stage));
  assert.equal(await readFile(sentinel, "utf8"), "preserve this newer file");
  assert.equal(await readFile(path.join(pending.stage, "SKILL.md"), "utf8"), "partial or changed copy");
  const original = recovered.results.find((item) => item.target === pending.target);
  assert.equal(await readFile(path.join(original.backup, "SKILL.md"), "utf8"), "original user content");
});

test("abrupt installer process exit leaves reclaimable ownership and recovers the original", async (t) => {
  const home = await homeFor(t);
  const target = path.join(home, ".agents", "skills", "lodestar");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "preserve through process death");
  const source = `import { setup } from ${JSON.stringify(new URL("../src/setup.mjs", import.meta.url).href)};
    await setup({ home: ${JSON.stringify(home)}, target: "codex", apply: true, replaceLocal: true,
      onProgress: ({target}) => { if (target === ${JSON.stringify(target)}) process.exit(77); } });`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(child.status, 77, child.stderr);
  const plan = await setup({ home, target: "codex" });
  const entry = plan.plans.find((item) => item.target === target);
  assert.equal(entry.action, "recover");
  const owners = await readdir(path.join(entry.state, "lock"));
  assert.equal(owners.length, 1);
  assert.match(owners[0], /\.lock$/u);
  assert.equal(await readFile(path.join(entry.state, "lock", owners[0]), "utf8"), "");
  const result = await setup({ home, target: "codex", apply: true, replaceLocal: true });
  assert.equal(result.verified, true);
  const replacement = result.results.find((item) => item.target === target);
  assert.equal(await readFile(path.join(replacement.backup, "SKILL.md"), "utf8"), "preserve through process death");
});

test("a change to the displaced tree is restored instead of publishing over it", async (t) => {
  const home = await homeFor(t);
  const target = path.join(home, ".agents", "skills", "lodestar");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "old accepted content");
  const { state } = (await setup({ home, target: "codex" })).plans.find((item) => item.target === target);
  await assert.rejects(setup({ home, target: "codex", apply: true, replaceLocal: true,
    onProgress: async ({ target: current }) => {
      if (current !== target) return;
      const pending = JSON.parse(await readFile(path.join(state, "pending.json"), "utf8"));
      await writeFile(path.join(pending.backup, "SKILL.md"), "concurrent user change");
    },
  }), { code: "install_changed" });
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "concurrent user change");
});

test("launcher receipts permit owned upgrades while local edits still require review", async (t) => {
  const home = await homeFor(t);
  const target = path.join(home, ".local", "bin", "lodestar");
  const options = { home, target: "codex", posixShim: target, apply: true };
  await setup(options);
  const key = createHash("sha256").update(process.platform === "win32" ? target.toLowerCase() : target).digest("hex");
  const receiptPath = path.join(home, ".local", ".lodestar-install", key, "installed.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const old = Buffer.from("#!/bin/bash\n# prior owned launcher\n");
  await writeFile(target, old);
  receipt.fingerprint = { bytes: old.length, sha256: createHash("sha256").update(old).digest("hex") };
  await writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal((await setup(options)).verified, true);
  assert.equal(await readFile(target, "utf8"), renderWindowsPosixShim());
  assert.ok((await readdir(path.dirname(target))).some((name) => name.endsWith(".bak")));
  await writeFile(target, "user launcher edit");
  await assert.rejects(setup(options), { code: "install_local_changes" });
  assert.equal(await readFile(target, "utf8"), "user launcher edit");
});

test("launcher destinations cannot overwrite skills, recovery metadata, or each other", async (t) => {
  const home = await homeFor(t);
  await setup({ home, target: "codex", apply: true });
  const plan = await setup({ home, target: "codex" });
  const item = plan.plans.find(({ target }) => path.basename(target) === "lodestar");
  const skill = path.join(item.target, "SKILL.md");
  const original = await readFile(skill);
  for (const posixShim of [skill, path.join(item.state, "installed.json")]) {
    await assert.rejects(setup({ home, target: "codex", posixShim, replaceLocal: true }), { code: "install_layout_conflict" });
  }
  const launcher = path.join(home, "bin", "lodestar");
  await assert.rejects(setup({ home, target: "codex", posixShim: launcher, wslShim: launcher }), { code: "install_layout_conflict" });
  assert.deepEqual(await readFile(skill), original);
});
