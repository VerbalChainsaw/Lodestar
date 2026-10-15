import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import test from "node:test";
import { spawnOwnedProcess, writeOwnedFrame } from "./helpers/owned-process.mjs";

test("owned process preserves spawn failure instead of an unhandled error", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lodestar-owned-missing-"));
  const result = await spawnOwnedProcess(t, path.join(root, "absent-node.exe"), [],
    { stdio: ["ignore", "pipe", "pipe"] }).completed;
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(result.error.code, "ENOENT");
  assert.match(result.error.message, /ENOENT/u);
  assert.notEqual(result.status, 0);
  assert.equal(result.timedOut, false);
});

test("owned process deadline retains diagnostics and closes its exact child", async (t) => {
  const owned = spawnOwnedProcess(t, process.execPath,
    ["-e", 'process.stderr.write("OWNED_STALL_READY");setTimeout(()=>{},5000);'],
    { stdio: ["ignore", "pipe", "pipe"] }, { timeoutMs: 800 });
  const result = await owned.completed;
  assert.equal(result.timedOut, true, JSON.stringify(result));
  assert.equal(result.error.code, "TEST_CHILD_TIMEOUT");
  assert.match(result.stderr, /OWNED_STALL_READY/u, "The child must run before exercising its deadline.");
  assert.match(result.error.message, /deadline exceeded after 800ms/u);
  assert.notEqual(result.status, 0);
  assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null);
  assert.equal(owned.child.stdout.destroyed, true);
  assert.equal(owned.child.stderr.destroyed, true);
});

test("lexical cleanup closes a failed fixture child before FIFO directory removal", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lodestar-owned-cleanup-"));
  let owned;
  t.after(async () => {
    assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null,
      "The earlier directory hook must see an already stopped child.");
    await rm(root, { recursive: true, force: true });
  });
  owned = spawnOwnedProcess(t, process.execPath,
    ["-e", 'process.stdout.write("ready");setTimeout(()=>{},5000);'],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const original = new Error("Expected fixture assertion failure");
  await assert.rejects(async () => {
    try {
      await Promise.race([once(owned.child.stdout, "data"), owned.completed.then((result) => {
        assert.fail(`Fixture child closed without readiness: ${JSON.stringify(result)}`);
      })]);
      throw original;
    }
    finally { await owned.stop(); }
  }, (failure) => failure === original);
});

test("owned process keeps normal exit status and complete output", async (t) => {
  const result = await spawnOwnedProcess(t, process.execPath,
    ["-e", 'process.stdout.write("complete");process.stderr.write("diagnostic");process.exitCode=7;'],
    { stdio: ["ignore", "pipe", "pipe"] }).completed;
  assert.equal(result.error, undefined);
  assert.equal(result.timedOut, false);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "complete");
  assert.equal(result.stderr, "diagnostic");
});

test("owned frame backpressure rejects when its stdin closes before drain", async (t) => {
  const owned = spawnOwnedProcess(t, process.execPath,
    ["-e", 'process.stdout.write("ready");setTimeout(()=>{},5000);'],
    { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const pending = writeOwnedFrame(owned, Buffer.alloc(1024 * 1024));
    assert.equal(owned.child.stdin.writableNeedDrain, true, "The regression must exercise real backpressure.");
    owned.child.stdin.destroy();
    await assert.rejects(pending, /closed while awaiting drain/u);
    assert.equal(owned.child.stdin.listenerCount("drain"), 0);
  } finally { await owned.stop(); }
});

test("owned process caps combined output and closes only its finite child", async (t) => {
  const owned = spawnOwnedProcess(t, process.execPath,
    ["-e", 'process.stdout.write("a".repeat(6144),()=>process.stderr.write("b".repeat(6144)));setTimeout(()=>{},5000);'],
    { stdio: ["ignore", "pipe", "pipe"] }, { maxOutputBytes: 8192 });
  const result = await owned.completed;
  assert.equal(result.error.code, "TEST_CHILD_OUTPUT_LIMIT", JSON.stringify(result));
  assert.equal(result.timedOut, false);
  assert.equal(result.stopped, true);
  assert.equal(result.outputBytes, 12288);
  assert.equal(result.admittedBytes, 8192);
  assert.equal(result.maxOutputBytes, 8192);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 8192);
  assert.ok(result.error.message.length < 4096, "The diagnostic must retain samples rather than copy all captured output.");
  assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null);
  assert.equal(owned.child.stdout.destroyed, true);
  assert.equal(owned.child.stderr.destroyed, true);
});

test("owned process admits complete split Unicode at the exact combined byte budget", async (t) => {
  const owned = spawnOwnedProcess(t, process.execPath,
    ["-e", 'const text=Buffer.from("🧭");process.stdout.write(text.subarray(0,2));setTimeout(()=>{process.stdout.write(text.subarray(2));process.stderr.write("é");},20);'],
    { stdio: ["ignore", "pipe", "pipe"] }, { maxOutputBytes: 6 });
  const result = await owned.completed;
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.status, 0);
  assert.equal(result.stopped, false);
  assert.equal(result.stdout, "🧭");
  assert.equal(result.stderr, "é");
  assert.equal(result.outputBytes, 6);
  assert.equal(result.admittedBytes, 6);
  assert.equal(await owned.stop(), result, "Stopping an already complete child must preserve the original result.");
});

test("owned process rejects unbounded output budgets before launching", (t) => {
  for (const maxOutputBytes of [0, Infinity, 2147483648])
    assert.throws(() => spawnOwnedProcess(t, process.execPath, [], {}, { maxOutputBytes }), RangeError);
});

test("owned process forced stop marks incomplete inherited pipes after direct exit zero", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "lodestar-owned-inherited-"));
  const done = path.join(root, "done");
  let owned;
  t.after(async () => {
    await owned?.stop();
    const until = Date.now() + 5000;
    while (await readFile(done, "utf8").catch(() => null) !== "done") {
      assert.ok(Date.now() < until, "The exact finite descendant must finish before fixture removal.");
      await delay(10);
    }
    await rm(root, { recursive: true, force: true });
  });
  const descendant = 'require("node:fs").writeFileSync(process.argv[1],"ready");setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"done"),1500);';
  const source = `const{spawn}=require("node:child_process");const fs=require("node:fs");spawn(process.execPath,["-e",${JSON.stringify(descendant)},${JSON.stringify(done)}],{detached:true,windowsHide:true,stdio:["ignore","inherit","inherit"]}).unref();const wait=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(done)}))return;clearInterval(wait);process.stdout.write("complete");process.exit(0);},5);setTimeout(()=>process.exit(1),5000);`;
  owned = spawnOwnedProcess(t, process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let settled = false;
  owned.completed.then(() => { settled = true; });
  await once(owned.child, "exit");
  assert.equal(owned.child.exitCode, 0);
  assert.equal(settled, false, "The actual descendant must keep response pipes open beyond direct exit.");
  assert.equal(await readFile(done, "utf8"), "ready");
  await owned.stop();
  const result = await owned.completed;
  assert.equal(result.status, 0);
  assert.equal(result.error.code, "TEST_CHILD_STOPPED");
  assert.equal(result.stopped, true);
  assert.equal(result.timedOut, false);
  assert.equal(owned.child.stdout.destroyed, true);
  assert.equal(owned.child.stderr.destroyed, true);
});
