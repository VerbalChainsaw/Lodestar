import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  canonicalStringify,
  JSON_LIMITS,
  readHandleBounded,
  readStreamBounded,
} from "../src/json.mjs";

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

test("canonical JSON rejects adversarial depth and sparse arrays", () => {
  let value = { state: "known" };
  for (let index = 0; index < 130; index += 1) value = { nested: value };
  assert.throws(
    () => canonicalStringify(value),
    ({ code }) => code === "resource_limit",
  );
  const sparse = [];
  sparse.length = 2;
  assert.throws(
    () => canonicalStringify(sparse),
    ({ code }) => code === "invalid_json",
  );
});

test("bounded handle reads stop when a file grows past its limit", async () => {
  const values = [Buffer.from("1234"), Buffer.from("5")];
  const handle = {
    async read(buffer, offset, length) {
      const value = values.shift() ?? Buffer.alloc(0);
      const selected = value.subarray(0, length);
      selected.copy(buffer, offset);
      return { bytesRead: selected.length, buffer };
    },
  };
  await assert.rejects(
    readHandleBounded(handle, {
      maximum: 4,
      resource: "growing_file",
    }),
    ({ code }) => code === "resource_limit",
  );
});

test("streamed string input rejects unpaired Unicode surrogates", async () => {
  const chunks = {
    async *[Symbol.asyncIterator]() {
      yield "\uD800";
    },
  };
  await assert.rejects(
    readStreamBounded(chunks, {
      maximum: 16,
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
    await readStreamBounded(chunks, {
      maximum: 16,
      resource: "test_stream",
    }),
    "\u{1F600}",
  );
});

test("stream limits count empty chunks before conversion", async () => {
  const atLimit = {
    async *[Symbol.asyncIterator]() {
      for (let index = 1; index < JSON_LIMITS.streamChunks; index += 1) {
        yield "";
      }
      yield "{}";
    },
  };
  assert.equal(
    await readStreamBounded(atLimit, {
      maximum: 16,
      resource: "test_stream",
    }),
    "{}",
  );

  const overLimit = {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < JSON_LIMITS.streamChunks; index += 1) {
        yield Buffer.alloc(0);
      }
      yield "{}";
    },
  };
  await assert.rejects(
    readStreamBounded(overLimit, {
      maximum: 16,
      resource: "test_stream",
    }),
    ({ code, identifiers }) =>
      code === "resource_limit"
      && identifiers.chunks === JSON_LIMITS.streamChunks + 1,
  );
});

test("stream input accepts only byte-exact chunk representations", async () => {
  for (const chunk of [
    [0x17B, 0x17D],
    new Uint16Array([0x7B, 0x7D]),
    new DataView(Uint8Array.from([0x7B, 0x7D]).buffer),
  ]) {
    await assert.rejects(
      readStreamBounded([chunk], {
        maximum: 16,
        resource: "test_stream",
      }),
      ({ code }) => code === "invalid_input",
    );
  }
  assert.equal(
    await readStreamBounded([Uint8Array.from([0x7B, 0x7D])], {
      maximum: 16,
      resource: "test_stream",
    }),
    "{}",
  );
});

test("stream bounds use intrinsic byte length before copying typed arrays", async (t) => {
  class UnderreportingBytes extends Uint8Array {
    get byteLength() {
      return 0;
    }
  }
  const chunk = new UnderreportingBytes(1024);
  const originalFrom = Buffer.from;
  let copiedAttackerChunk = false;
  Buffer.from = function instrumentedFrom(value, ...rest) {
    if (value === chunk) copiedAttackerChunk = true;
    return originalFrom.call(this, value, ...rest);
  };
  t.after(() => {
    Buffer.from = originalFrom;
  });

  await assert.rejects(
    readStreamBounded([chunk], {
      maximum: 4,
      resource: "test_stream",
    }),
    ({ code, identifiers }) =>
      code === "resource_limit"
      && identifiers.bytes === 1024
      && identifiers.maximum === 4,
  );
  assert.equal(copiedAttackerChunk, false);
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
    readStreamBounded([spoofed], {
      maximum: 16,
      resource: "test_stream",
    }),
    ({ code }) => code === "invalid_input",
  );
});
