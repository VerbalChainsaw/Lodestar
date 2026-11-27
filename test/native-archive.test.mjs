import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { validateNativeArchive } from "../scripts/smoke-native-codex.mjs";

// Build real tar headers so link/special-entry refusal is exercised on Windows
// without requiring filesystem symlink privileges or an external fixture library.
function tarMember(name, type = "0", link = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  for (const [offset, width, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, 0], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width);
  }
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  header.write(link, 157, 100);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

test("native archive admission accepts regular files and directories before extraction", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-native-admission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, "valid.tgz");
  await writeFile(archive, gzipSync(Buffer.concat([
    tarMember("scripts/", "5"), tarMember("scripts/runtime.mjs"), Buffer.alloc(1024),
  ])));
  assert.deepEqual(validateNativeArchive(archive), ["scripts/", "scripts/runtime.mjs"]);
});

test("native archive admission rejects links, Windows aliases and escaping paths before extraction", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-native-admission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = [
    [tarMember("scripts/link", "2", "../../outside")],
    [tarMember("scripts/link", "1", "../../outside")],
    [tarMember("scripts/device", "3")],
    [tarMember("scripts/entry:stream")],
    [tarMember("C:/scripts/entry")],
    [tarMember("/scripts/entry")],
    [tarMember("scripts/../entry")],
    [tarMember("scripts/entry\u0001")],
    [tarMember("scripts/entry.")],
    [tarMember("scripts/CON")],
    [tarMember("scripts/entry"), tarMember("scripts/entry")],
    [tarMember("scripts/Entry"), tarMember("scripts/entry")],
  ];
  for (const [index, members] of invalid.entries()) {
    const archive = path.join(directory, `invalid-${index}.tgz`);
    await writeFile(archive, gzipSync(Buffer.concat([...members, Buffer.alloc(1024)])));
    assert.throws(() => validateNativeArchive(archive), undefined, `unsafe archive ${index} was accepted`);
  }
});
