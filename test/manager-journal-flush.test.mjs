import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runManager } from "../src/manager.mjs";
import { executeCli } from "../src/interface-client.mjs";
import { loadInterfaceConfig } from "../src/interface-config.mjs";
import { fixture } from "./helpers/contract.mjs";

for (const failure of [null, "request.json", "context.json", "response"]) {
  test(`Manager flush boundary: ${failure ?? "successful dispatch and exact replay"}`, async (t) => {
    const f = await fixture(t);
    const loader = path.join(f.root, "Lodestar.Loader.exe");
    await fs.writeFile(loader, "fixture executable placeholder");
    const configPath = path.join(f.root, "interfaces.json");
    await fs.writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(),
      runtime: { node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)),
        database: f.database }, loader }));
    const selection = await loadInterfaceConfig(configPath);
    await f.create("knowledge:flush", "knowledge", { value: 1 });
    const original = fs.writeFile;
    const events = [], captured = new Map(), dispatched = [];
    fs.writeFile = async (file, bytes, options) => {
      const name = path.basename(file);
      const journalFile = path.dirname(file).startsWith(path.join(f.root, "pending"));
      if (!journalFile) return original(file, bytes, options);
      captured.set(name, Buffer.from(bytes));
      await original(file, bytes, options);
      assert.equal(options?.flag, "wx");
      assert.equal(options?.flush, true, `${name} must await an explicit flush`);
      if (name === failure || (failure === "response" && name.startsWith("response."))) {
        events.push(`failed:${name}`);
        throw Object.assign(new Error(`Injected storage flush failure for ${name}`), { code: "EIO" });
      }
      events.push(`flushed:${name}`);
    };
    syncBuiltinESMExports();
    t.after(() => { fs.writeFile = original; syncBuiltinESMExports(); });
    const execute = async (selected, invocation) => {
      if (invocation.operation === "put") {
        assert.deepEqual(events.slice(0, 2), ["flushed:request.json", "flushed:context.json"]);
        dispatched.push(await fs.readFile(invocation.args[invocation.args.indexOf("--file") + 1]));
      }
      return executeCli(selected, invocation);
    };
    let output = "";
    const io = { stdout: { write: (text) => { output += text; } }, stdin: {} };
    const answers = ["3", "knowledge:flush", "1", "5", "", "", "", '{"value":2}', "SAVE", "6", "2", "9"];
    assert.equal(await runManager({ selection, io, ask: async () => answers.shift() ?? null, execute }), 0);
    const [name] = await fs.readdir(path.join(f.root, "pending"));
    const folder = path.join(f.root, "pending", name);
    for (const [file, bytes] of captured) {
      if (file.startsWith("response.") && failure !== "response") continue;
      assert.deepEqual(await fs.readFile(path.join(folder, file)), bytes);
    }
    if (failure === "request.json" || failure === "context.json") {
      assert.equal(dispatched.length, 0);
      assert.match(output, /no write was dispatched/i);
      assert.match(output, /storage|disk|permissions/i);
      assert.match(output, /preserve/i);
      assert.equal((await f.cli(["get", "knowledge:flush"])).value.data.data.value, 1);
    } else {
      assert.equal(dispatched.length, 1);
      assert.equal((await f.cli(["get", "knowledge:flush"])).value.data.data.value, 2);
      if (failure === "response") {
        assert.match(output, /Response could not be journaled/);
        await assert.rejects(fs.stat(path.join(folder, "response.json")), { code: "ENOENT" });
      } else {
        const responseName = [...captured.keys()].find((file) => file.startsWith("response."));
        // Successful response temp is renamed only after its flush completes.
        assert.deepEqual(await fs.readFile(path.join(folder, "response.json")), captured.get(responseName));
        const revision = (await f.cli(["get", "knowledge:flush"])).value.revision;
        const replay = ["7", "1", "REPLAY", "9"];
        await runManager({ selection, io, ask: async () => replay.shift() ?? null, execute });
        assert.equal(dispatched.length, 2);
        assert.deepEqual(dispatched[0], dispatched[1]);
        assert.equal((await f.cli(["get", "knowledge:flush"])).value.revision, revision);
      }
    }
  });
}
