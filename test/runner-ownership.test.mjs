import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("maintained test command executes owned tests without importing archived baselines", async (t) => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.test, "npm run assets:check && node scripts/run-tests.mjs");
  const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
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
  const result = spawnSync(process.execPath, [runner],
    { cwd: root, env: childEnv, encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OWNED_CASE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /ARCHIVED_BASELINE_MUST_NOT_EXECUTE/u);
  assert.match(result.stdout, /\[test-file\].*START test[\\/]owned.test.mjs/u);
  assert.match(result.stdout, /\[test-file\].*COMPLETE test[\\/]owned.test.mjs passed=true/u);
});

test("healthy sequential cases finish beyond the former scaled total window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-test-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "test", "progress.test.mjs"),
    'import test from "node:test"; for(let i=1;i<=6;i++)test(`HEALTHY_CASE_${i}`,async()=>{await new Promise(resolve=>setTimeout(resolve,600));});\n');
  const invocation = path.join(root, "invoke.mjs");
  // Scale the corrected five-minute ceiling to six seconds. The cases alone
  // take 3.6 seconds, beyond the former two-minute ceiling scaled to 2.4 seconds.
  await writeFile(invocation, `import { runOwnedTests } from ${JSON.stringify(new URL("../scripts/run-tests.mjs", import.meta.url).href)}; process.exitCode = await runOwnedTests({ deadlineMs: 6000 });\n`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const result = spawnSync(process.execPath, [invocation],
    { cwd: root, env, encoding: "utf8", timeout: 12000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started >= 3600);
  for (let i = 1; i <= 6; i++) assert.match(result.stdout, new RegExp(`✔ HEALTHY_CASE_${i}`));
  assert.match(result.stdout, /COMPLETE test[\\/]progress.test.mjs passed=true/u);
  assert.doesNotMatch(result.stderr, /DEADLINE/u);
});

test("parent file deadline interrupts a finite synchronous child and retains failure evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-test-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "test", "blocked.test.mjs"),
    'import test from "node:test"; test("FINITE_BLOCK", () => { const until = Date.now() + 1500; while (Date.now() < until) {} });\n');
  const invocation = path.join(root, "invoke.mjs");
  await writeFile(invocation, `import { runOwnedTests } from ${JSON.stringify(new URL("../scripts/run-tests.mjs", import.meta.url).href)}; process.exitCode = await runOwnedTests({ deadlineMs: 200 });\n`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [invocation],
    { cwd: root, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /COMPLETE test[\\/]blocked.test.mjs passed=false/u);
  assert.match(result.stderr, /DEADLINE test[\\/]blocked.test.mjs after 200ms/u);
  assert.match(result.stdout + result.stderr, /Test file deadline exceeded/u);
  assert.doesNotMatch(result.stdout, /✔ FINITE_BLOCK/u);
});

test("maintained runner preserves assertion failures and rejects an empty owned selection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-test-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "test"));
  const file = path.join(root, "test", "failure.test.mjs");
  await writeFile(file, 'import test from "node:test"; test("OWNED_ASSERTION_FAILURE", () => { throw new Error("preserved failure"); });\n');
  const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const invoke = () => spawnSync(process.execPath, [runner],
    { cwd: root, env, encoding: "utf8", timeout: 10000, windowsHide: true });
  const failed = invoke();
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /preserved failure/u);
  await rm(file);
  const empty = invoke();
  assert.equal(empty.status, 1, empty.stdout + empty.stderr);
  assert.match(empty.stderr, /No owned test\/\*\.test.mjs files selected/u);
});

test("deadline exits its runner while a finite fixture descendant still holds response pipes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-test-pipe-deadline-"));
  const ready = path.join(root, "ready"), done = path.join(root, "done");
  t.after(async () => {
    const until = Date.now() + 5000;
    while (Date.now() < until && !(await readFile(done, "utf8").catch(() => null)))
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await readFile(done, "utf8"), "done", "The exact finite descendant must finish naturally before fixture removal.");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "test"));
  const child = 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"ready");setTimeout(()=>fs.writeFileSync(process.argv[2],"done"),2000);';
  await writeFile(path.join(root, "test", "pipes.test.mjs"),
    `import {spawn} from "node:child_process";import test from "node:test";spawn(process.execPath,["-e",${JSON.stringify(child)},${JSON.stringify(ready)},${JSON.stringify(done)}],{detached:true,windowsHide:true,stdio:["ignore","inherit","inherit"]}).unref();test("COMPLETE_BUT_INHERITED_PIPE",()=>{});\n`);
  const invocation = path.join(root, "invoke.mjs");
  await writeFile(invocation, `import { runOwnedTests } from ${JSON.stringify(new URL("../scripts/run-tests.mjs", import.meta.url).href)}; process.exitCode = await runOwnedTests({ deadlineMs: 500 });\n`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [invocation],
    { cwd: root, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(await readFile(ready, "utf8"), "ready");
  assert.equal(await readFile(done, "utf8").catch(() => null), null,
    "The parent runner must exit while the owned finite descendant still holds pipes.");
  assert.match(result.stderr, /DEADLINE test[\\/]pipes.test.mjs after 500ms/u);
  assert.match(result.stdout, /✔ COMPLETE_BUT_INHERITED_PIPE/u);
  assert.match(result.stdout, /COMPLETE test[\\/]pipes.test.mjs passed=false/u);
});
