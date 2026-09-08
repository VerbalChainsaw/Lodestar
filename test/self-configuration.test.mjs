import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { AGENT_BOOTSTRAP } from "../src/bootstrap.mjs";
import { runInstalledLodestar } from "../codex-plugin/scripts/lodestar-runtime.mjs";
import { renderWindowsPosixShim, renderWslShim } from "../src/windows-install.mjs";
import { fixture } from "./helpers/contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Lodestar's native and plugin metadata permit automatic Codex invocation", async () => {
  for (const directory of ["managed-assets/skills/lodestar", "codex-plugin/skills/lodestar"]) {
    const metadata = await readFile(path.join(root, directory, "agents/openai.yaml"), "utf8");
    assert.match(metadata, /^policy:\r?\n[ \t]+allow_implicit_invocation:[ \t]+true[ \t]*$/mu,
      `${directory} must permit automatic invocation; matching installed bytes alone cannot establish this`);
  }
});

async function invoke(args, input = "") {
  let output = "", error = "";
  const code = await runCli(args, { stdin: Readable.from([input]),
    stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { error += value; } } });
  return { code, value: JSON.parse(output || error) };
}

test("start provides current guide and installation repair without writing files or DB", async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, "home");
  await mkdir(home);
  const db = await readFile(f.database);
  const args = ["start", "--cwd", f.root, "--home", home, "--target", "codex"];
  const before = await f.cli(args);
  assert.equal(before.code, 0);
  assert.deepEqual(before.value.data.operating_guide, AGENT_BOOTSTRAP);
  assert.equal(before.value.data.installation.verified, false);
  assert.equal(before.value.data.installation.ready, true);
  assert.equal(before.value.data.complete, true);
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readFile(f.database), db);
  assert.equal((await invoke(before.value.data.installation.repair.arguments)).code, 0);
  const after = await f.cli(args);
  assert.equal(after.value.data.installation.verified, true);
  assert.equal(after.value.data.installation.repair, null);
  if (process.platform === "win32") assert.equal(after.value.data.installation.launchers[0].target,
    path.join(home, ".local", "bin", "lodestar"));
  await writeFile(path.join(home, ".agents", "skills", "lodestar", "SKILL.md"), "new local instructions");
  const changed = await f.cli(args);
  assert.equal(changed.value.data.installation.verified, false);
  assert.equal(changed.value.data.installation.repair.review_required, true);
  assert.deepEqual(await readFile(f.database), db);
});

test("file/stdin command arguments and native reads preserve values larger than Windows argv", async (t) => {
  const f = await fixture(t);
  const id = `large:${"quoted \" 😀 漢字 ".repeat(4000)}`;
  await f.create(id, "fact", { text: "unmodified result" });
  const args = ["--db", f.database, "get", "--", id];
  const argFile = path.join(f.root, "arguments.json");
  await writeFile(argFile, `\uFEFF${JSON.stringify(args, null, 2).replaceAll("\n", "\r\n")}`);
  const fileResult = await invoke(["--args-file", argFile]);
  assert.equal(fileResult.code, 0, JSON.stringify(fileResult.value));
  assert.equal(fileResult.value.data.id, id);
  const stdinResult = await invoke(["--args-stdin"], JSON.stringify(args));
  assert.equal(stdinResult.value.data.id, id);
  const native = await runInstalledLodestar(args, { env: { ...process.env,
    LODESTAR_NODE: process.execPath, LODESTAR_ENTRY: path.join(root, "lodestar.mjs") } });
  assert.equal(native.data.id, id);
  if (process.platform === "win32") {
    const entry = path.join(root, "lodestar.mjs");
    const run = (exe, argv) => {
      const result = spawnSync(exe, argv, { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const git = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git");
    const bash = path.join(git, "bin", "bash.exe");
    const posix = (value) => run(path.join(git, "usr", "bin", "cygpath.exe"), ["-u", value]).trim();
    await t.test("real Git Bash carries the complete argument file into the core", async (t) => {
      if (spawnSync(bash, ["-lc", "command -v cygpath"], { windowsHide: true }).status !== 0)
        return t.skip("Git Bash is unavailable");
      const gitShim = path.join(f.root, "git-launcher");
      await writeFile(gitShim, renderWindowsPosixShim({ entry }));
      const result = JSON.parse(run(bash, [posix(gitShim), "--args-file", posix(argFile)]));
      assert.equal(result.data.id, id);
    });
    await t.test("real WSL carries the complete argument file into the Windows core", async (t) => {
      if (spawnSync("wsl.exe", ["--", "bash", "-c", "test -x /init && command -v wslpath"],
        { windowsHide: true }).status !== 0) return t.skip("WSL interop is unavailable");
      const linux = (value) => run("wsl.exe", ["--exec", "wslpath", "-u", value]).trim();
      const wslShim = path.join(f.root, "wsl-launcher");
      await writeFile(wslShim, renderWslShim({ entry }));
      const result = JSON.parse(run("wsl.exe", ["--", "bash", linux(wslShim), "--args-file", linux(argFile)]));
      assert.equal(result.data.id, id);
    });
  }
});

test("custom launcher selection survives startup verification and its repair command", async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, "custom-home");
  const launcher = path.join(home, "chosen", "lodestar");
  const flags = ["--target", "codex", "--home", home, "--posix-shim", launcher];
  assert.equal((await invoke(["setup", ...flags, "--apply"])).code, 0);
  const current = await f.cli(["start", "--cwd", f.root, ...flags]);
  assert.equal(current.value.data.installation.verified, true);
  assert.equal(current.value.data.installation.launchers[0].target, launcher);
  await writeFile(launcher, "local custom launcher");
  const changed = await f.cli(["start", "--cwd", f.root, ...flags]);
  assert.equal(changed.value.data.installation.verified, false);
  const repair = changed.value.data.installation.repair;
  assert.equal(repair.review_required, true);
  assert.equal(repair.arguments[repair.arguments.indexOf("--posix-shim") + 1], launcher);
});

test("complete output file carries exact bytes and unavailable output prevents mutation", async (t) => {
  const f = await fixture(t);
  await f.create("large-output", "fact", { text: "😀 multiline\r\n".repeat(10000) });
  const file = path.join(f.root, "complete.json");
  const result = await f.cli(["get", "large-output", "--output", file]);
  assert.equal(result.code, 0);
  const bytes = await readFile(file);
  assert.equal(result.value.data.output_file.bytes, bytes.length);
  assert.equal(result.value.data.output_file.sha256, hash(bytes));
  assert.equal(JSON.parse(bytes).data.data.text, "😀 multiline\r\n".repeat(10000));
  const request = await f.request({ mode: "update", id: "large-output", set: { data: { lost: true } }, remove: [] },
    [{ kind: "record", id: "large-output" }]);
  const before = await readFile(f.database);
  assert.notEqual((await f.cli(["put", "--output", file], request)).code, 0);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readFile(f.database), before);
});

test("BOM and CRLF mutation documents preserve Unicode and replay the same accepted effect", async (t) => {
  const f = await fixture(t);
  const value = "first\r\n😀 漢字\nlast";
  const request = await f.request({ mode: "create", record: {
    id: "bom-roundtrip", kind: "fact", name: "BOM roundtrip", scope: "global", availability: "known",
    data: { text: value }, aliases: [], links: [], sources: [],
  } }, [{ kind: "record", id: "bom-roundtrip" }]);
  const bytes = Buffer.from(`\uFEFF${JSON.stringify(request, null, 2).replaceAll("\n", "\r\n")}`);
  const first = await invoke(["--db", f.database, "put"], bytes);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  const file = path.join(f.root, "request.json");
  await writeFile(file, bytes);
  const replay = await invoke(["--db", f.database, "put", "--file", file]);
  assert.equal(replay.code, 0, JSON.stringify(replay.value));
  assert.equal(replay.value.revision, first.value.revision);
  assert.equal(replay.value.receipt_id, first.value.receipt_id);
  assert.equal((await f.cli(["get", "bom-roundtrip"])).value.data.data.text, value);
});

test("Git checkout preserves managed bytes regardless of autocrlf and original line endings", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-checkout-bytes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = ["managed-assets/skills/example/SKILL.md", "managed-assets/skills/example/agents/openai.yaml",
    "managed-assets/skills/example/LICENSE", "codex-plugin/skills/example/SKILL.md"];
  await writeFile(path.join(directory, ".gitattributes"), await readFile(path.join(root, ".gitattributes")));
  const content = Buffer.from("first\r\nsecond\nUTF8 😀\r\n");
  for (const file of files) { await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), content); }
  const git = (args) => { const result = spawnSync("git", ["-c", "core.autocrlf=true", ...args], { cwd: directory, windowsHide: true }); assert.equal(result.status, 0, result.stderr.toString()); };
  git(["init", "--quiet"]);
  git(["add", "."]);
  const checkout = path.join(directory, "checkout");
  git(["checkout-index", `--prefix=${checkout.replaceAll("\\", "/")}/`, "--", ...files]);
  for (const file of files) assert.deepEqual(await readFile(path.join(checkout, file)), content);
});
