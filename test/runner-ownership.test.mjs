import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("maintained test command executes owned tests without importing archived baselines", async (t) => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const prefix = "npm run assets:check && node --test";
  assert.ok(packageJson.scripts.test.startsWith(prefix));
  const pattern = packageJson.scripts.test.slice(prefix.length).trim().replace(/^"(.*)"$/u, "$1");
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-test-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "test")); await mkdir(path.join(root, "work"));
  await writeFile(path.join(root, "test", "owned.test.mjs"),
    'import test from "node:test"; test("OWNED_CASE", () => {});\n');
  await writeFile(path.join(root, "work", "preserved.test.mjs"),
    'throw new Error("ARCHIVED_BASELINE_MUST_NOT_EXECUTE");\n');
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run = (arguments_) => spawnSync(process.execPath, ["--test", ...arguments_],
    { cwd: root, env: childEnv, encoding: "utf8", timeout: 10000, windowsHide: true });
  const baseline = run([]);
  assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout + baseline.stderr, /ARCHIVED_BASELINE_MUST_NOT_EXECUTE/u);
  const result = run(pattern ? [pattern] : []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OWNED_CASE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /ARCHIVED_BASELINE_MUST_NOT_EXECUTE/u);
});
