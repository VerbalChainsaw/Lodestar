import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setup } from "../src/setup.mjs";
import { manageSkills } from "../src/skills.mjs";

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
