import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  canonicalStringify,
  readStreamComplete,
} from "../src/json.mjs";
import { resolveInputPath } from "../src/paths.mjs";

test("canonical JSON preserves prototype-shaped keys without pollution", () => {
  const value = JSON.parse(
    '{"constructor":{"safe":true},"state":"known","__proto__":{"safe":true}}',
  );
  const text = canonicalStringify(value);
  assert.equal(
    text,
    '{"__proto__":{"safe":true},"constructor":{"safe":true},"state":"known"}',
  );
  const parsed = JSON.parse(text);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal({}.safe, undefined);
});

test("canonical JSON accepts deep and wide valid values but still rejects sparse arrays", () => {
  let value = { state: "known" };
  for (let index = 0; index < 1_000; index += 1) value = { nested: value };
  assert.match(canonicalStringify(value), /"state":"known"/u);
  assert.equal(JSON.parse(canonicalStringify(Array.from({ length: 100_001 }, (_, index) => index)))
    .length, 100_001);
  const sparse = [];
  sparse.length = 2;
  assert.throws(
    () => canonicalStringify(sparse),
    ({ code }) => code === "invalid_json",
  );
});

test("streamed string input rejects unpaired Unicode surrogates", async () => {
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield "\uD800";
    },
  };
  await assert.rejects(
    readStreamComplete(chunks, {
      resource: "test_stream",
    }),
    ({ code }) => code === "invalid_utf8",
  );
});

test("streamed string input preserves a surrogate pair split across chunks", async () => {
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield "\uD83D";
      yield "\uDE00";
    },
  };
  assert.equal(
    await readStreamComplete(chunks, {
      resource: "test_stream",
    }),
    "\u{1F600}",
  );
});

test("stream input accepts only byte-exact chunk representations", async () => {
  for (const chunk of [
    [0x17B, 0x17D],
    new Uint16Array([0x7B, 0x7D]),
    new DataView(Uint8Array.from([0x7B, 0x7D]).buffer),
  ]) {
    await assert.rejects(
      readStreamComplete([chunk], {
        resource: "test_stream",
      }),
      ({ code }) => code === "invalid_input",
    );
  }
  assert.equal(
    await readStreamComplete([Uint8Array.from([0x7B, 0x7D])], {
      resource: "test_stream",
    }),
    "{}",
  );
});

test("stream input rejects prototype-spoofed Uint8Array objects", async () => {
  const bytes = Buffer.from("{}");
  const spoofed = Object.create(Uint8Array.prototype);
  Object.defineProperties(spoofed, {
    byteLength: { value: bytes.length },
    length: { value: bytes.length },
  });
  for (const [index, byte] of bytes.entries()) {
    spoofed[index] = byte + 256;
  }

  await assert.rejects(
    readStreamComplete([spoofed], {
      resource: "test_stream",
    }),
    ({ code }) => code === "invalid_input",
  );
});

test("path validation leaves representable length to the selected platform", () => {
  const longPath = `root/${"x".repeat(17 * 1024)}`;
  const pathApi = { resolve: (_cwd, selected) => selected };
  assert.equal(resolveInputPath(longPath, { cwd: "/", platform: "linux", pathApi }), longPath);
});
