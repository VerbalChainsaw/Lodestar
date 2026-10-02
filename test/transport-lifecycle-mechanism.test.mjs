import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../src/interface-client.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(t, operation, inheritedPipes, { signal, overflow = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lodestar-transport-lifecycle-"));
  const pidFile = path.join(root, "owned-pids.json"), ready = path.join(root, "ready");
  const cli = path.join(root, "finite-cli.mjs"), database = path.join(root, "unused.db");
  await writeFile(database, "Synthetic transport file; no database is opened.");
  const source = `import {spawn} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',${JSON.stringify('process.stdout.on("error",()=>{});process.stderr.on("error",()=>{});process.stderr.write(Buffer.from([0xc3]));require("node:fs").writeFileSync(process.argv[1],"ready");' + (overflow ? 'setTimeout(()=>process.stdout.write("x".repeat(65536)),250);' : '') + 'setTimeout(()=>{},5000)')},${JSON.stringify(ready)}],{detached:true,windowsHide:true,stdio:${JSON.stringify(inheritedPipes ? ["ignore", "inherit", "inherit"] : "ignore")}});
writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,descendant:child.pid}));
const wait=setInterval(()=>{if(!existsSync(${JSON.stringify(ready)}))return;clearInterval(wait);console.log(JSON.stringify({v:5,ok:true,operation:${JSON.stringify(operation)},revision:null,database_instance_id:null,database_epoch:null,more:false,next:[],data:{fixture:true}}));process.exit(0);},5);
`;
  await writeFile(cli, source);
  const pending = executeCli({ node: process.execPath, cli, database }, {
    operation, args: [operation], effect: operation === "put" ? "record_write" : "read",
    timeoutMs: signal || overflow ? 5000 : 800, maxOutputBytes: overflow ? 4096 : 65536, signal,
  });
  t.after(async () => {
    const pids = await readFile(pidFile, "utf8").then(JSON.parse).catch(() => null);
    // These exact PIDs were recorded by this invocation's disposable parent.
    for (const pid of [pids?.parent, pids?.descendant]) if (Number.isInteger(pid) && alive(pid)) process.kill(pid);
    await pending;
    await rm(root, { recursive: true, force: true });
  });
  let pids;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await readFile(ready, "utf8").catch(() => null) === "ready") {
      pids = JSON.parse(await readFile(pidFile, "utf8")); break;
    }
    await delay(10);
  }
  assert.ok(pids, "The finite descendant must actually start before testing the deadline.");
  return { pending, pids };
}

for (const operation of ["get", "put"]) test(`${operation} whole-call deadline bounds inherited pipes after direct CLI exit`, async (t) => {
  const { pending, pids } = await fixture(t, operation, true);
  const result = await Promise.race([pending, delay(1600).then(() => null)]);
  const witness = { parentAlive: alive(pids.parent), descendantAlive: alive(pids.descendant), result };
  assert.equal(witness.parentAlive, false, "Direct CLI must have exited for this distinct failure trajectory.");
  assert.ok(result, `800 ms deadline did not settle within the 1600 ms allowance: ${JSON.stringify(witness)}`);
  assert.equal(result.kind, "TransportError");
  assert.equal(result.code, "timeout");
  assert.equal(result.mayHaveCommitted, operation === "put");
  if (operation === "put") assert.match(result.message, /outcome.*unknown.*saved request/i);
  assert.equal(witness.descendantAlive, true, "Deadline completion must be observed while the finite fixture still holds inherited pipes.");
});

test("detached finite descendant without inherited pipes does not prevent complete response", async (t) => {
  const { pending, pids } = await fixture(t, "get", false);
  const result = await Promise.race([pending, delay(1600).then(() => null)]);
  assert.ok(result, "Control response should settle after the direct CLI exits and closes its pipes.");
  assert.equal(result.kind, "EnvelopeSuccess");
  assert.equal(result.envelope.data.fixture, true);
  assert.equal(alive(pids.parent), false);
  assert.equal(alive(pids.descendant), true, "Control must retain a running descendant, proving pipes are the distinction.");
});

for (const interruption of ["cancelled", "output_limit"]) test(`dispatched write ${interruption} bounds inherited pipes without trusting buffered success`, async (t) => {
  const controller = new AbortController();
  const { pending, pids } = await fixture(t, "put", true, interruption === "cancelled"
    ? { signal: controller.signal } : { overflow: true });
  if (interruption === "cancelled") { await delay(100); controller.abort(); }
  const result = await Promise.race([pending, delay(1600).then(() => null)]);
  assert.ok(result, `${interruption} did not settle while the fixture held inherited pipes.`);
  assert.equal(alive(pids.parent), false);
  assert.equal(alive(pids.descendant), true);
  assert.equal(result.kind, "TransportError");
  assert.equal(result.code, interruption);
  assert.equal(result.envelope, undefined, "Incomplete buffered success cannot settle a dispatched write.");
  assert.equal(result.mayHaveCommitted, true);
  assert.match(result.message, /outcome.*unknown.*saved request/i);
});
