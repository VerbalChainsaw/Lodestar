import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { lodestarError, wrapError } from "./errors.mjs";

const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const UINT8_ARRAY = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
).get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
).get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
).get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
).get;

function byteView(value) {
  try {
    if (
      !ARRAY_BUFFER_IS_VIEW(value)
      || TYPED_ARRAY_TAG.call(value) !== "Uint8Array"
    ) {
      return null;
    }
    return {
      buffer: TYPED_ARRAY_BUFFER.call(value),
      byteLength: TYPED_ARRAY_BYTE_LENGTH.call(value),
      byteOffset: TYPED_ARRAY_BYTE_OFFSET.call(value),
    };
  } catch {
    return null;
  }
}

function copyByteView(view) {
  try {
    return Buffer.from(
      new UINT8_ARRAY(view.buffer, view.byteOffset, view.byteLength),
    );
  } catch {
    return null;
  }
}

function invalidUtf8(resource, identifiers = {}, cause = undefined) {
  return lodestarError(
    "invalid_utf8",
    `${resource} is not valid UTF-8.`,
    {
      identifiers: { ...identifiers, resource },
      action: "Encode the JSON input as valid UTF-8 and retry.",
      cause,
    },
  );
}

function validStringChunk(value, pendingHigh, resource) {
  const combined = `${pendingHigh}${value}`;
  let end = combined.length;
  let nextPending = "";
  const last = combined.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) {
    nextPending = combined[end - 1];
    end -= 1;
  }
  for (let index = 0; index < end; index += 1) {
    const code = combined.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const following = combined.charCodeAt(index + 1);
      if (following < 0xDC00 || following > 0xDFFF) {
        throw invalidUtf8(resource);
      }
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw invalidUtf8(resource);
    }
  }
  return {
    text: combined.slice(0, end),
    pendingHigh: nextPending,
  };
}

function normalizedJson(value) {
  const holder = Object.create(null);
  const ancestors = new Set();
  const tasks = [{ kind: "value", value, target: holder, key: "value" }];
  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task.kind === "leave") {
      ancestors.delete(task.value);
      continue;
    }
    if (task.kind === "array") {
      if (task.index >= task.source.length) continue;
      if (!Object.hasOwn(task.source, task.index)) {
        throw lodestarError(
          "invalid_json",
          "JSON arrays cannot contain empty slots.",
          { identifiers: { index: task.index } },
        );
      }
      tasks.push({ ...task, index: task.index + 1 });
      tasks.push({ kind: "value", value: task.source[task.index],
        target: task.target, key: task.index });
      continue;
    }
    if (task.kind === "object") {
      if (task.index >= task.keys.length) continue;
      const key = task.keys[task.index], entry = task.source[key];
      if (entry === undefined) {
        throw lodestarError(
          "invalid_json",
          "JSON object properties cannot be undefined.",
          { identifiers: { key } },
        );
      }
      tasks.push({ ...task, index: task.index + 1 });
      tasks.push({ kind: "value", value: entry, target: task.target, key });
      continue;
    }
    const current = task.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      task.target[task.key] = current;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw lodestarError("invalid_json", "JSON numbers must be finite.");
      }
      task.target[task.key] = Object.is(current, -0) ? 0 : current;
      continue;
    }
    if (typeof current !== "object") {
      throw lodestarError(
        "invalid_json",
        "The value contains a type JSON cannot represent.",
      );
    }
    if (ancestors.has(current)) {
      throw lodestarError("invalid_json", "The value contains a circular reference.");
    }
    const isArray = Array.isArray(current), prototype = Object.getPrototypeOf(current);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw lodestarError(
        "invalid_json",
        "JSON objects must use an ordinary object prototype.",
      );
    }
    const result = isArray ? [] : Object.create(null);
    task.target[task.key] = result;
    ancestors.add(current);
    tasks.push({ kind: "leave", value: current });
    tasks.push(isArray
      ? { kind: "array", source: current, target: result, index: 0 }
      : { kind: "object", source: current, target: result,
        keys: Object.keys(current).sort(), index: 0 });
  }
  return holder.value;
}

export function canonicalStringify(value) {
  return JSON.stringify(normalizedJson(value));
}

export function decodeUtf8(
  value,
  {
    resource = "input",
    identifiers = {},
  } = {},
) {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
  } catch (error) {
    throw invalidUtf8(resource, identifiers, error);
  }
}

export function assertTextBytes(
  text,
  maximum,
  resource,
  identifiers = {},
) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maximum) {
    throw lodestarError(
      "resource_limit",
      `${resource} exceeds its byte limit.`,
      {
        identifiers: {
          ...identifiers,
          resource,
          bytes,
          maximum,
        },
        action: "Reduce the input size and retry.",
      },
    );
  }
  return bytes;
}

export function parseJsonText(
  text,
  {
    maximum,
    resource = "json_input",
    identifiers = {},
  } = {},
) {
  if (maximum !== undefined) {
    assertTextBytes(text, maximum, resource, identifiers);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw wrapError(
      error,
      "invalid_json",
      "Input is not valid JSON.",
      { identifiers },
    );
  }
}


export async function readTextFileComplete(
  file,
  { resource = "file_input" } = {},
) {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile()) {
      throw lodestarError("invalid_path", "The input path is not a regular file.",
        { identifiers: { path: file } });
    }
    return decodeUtf8(await handle.readFile(), { resource, identifiers: { path: file } });
  } catch (error) {
    throw wrapError(error, "input_unreadable", "Lodestar could not read the input file.", {
      identifiers: { path: file },
      action: "Check that the path names a readable regular file.",
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readStreamComplete(
  stream,
  { resource = "stdin_input" } = {},
) {
  const chunks = [];
  let pendingHigh = "";
  for await (const chunk of stream) {
    let buffer;
    if (typeof chunk === "string") {
      const validated = validStringChunk(chunk, pendingHigh, resource);
      pendingHigh = validated.pendingHigh;
      buffer = Buffer.from(validated.text);
    } else {
      const view = byteView(chunk);
      if (view !== null) {
        if (pendingHigh) throw invalidUtf8(resource);
        buffer = copyByteView(view);
      }
      if (buffer === null || buffer === undefined) {
        throw lodestarError("invalid_input",
          `${resource} yielded a chunk that is not text or bytes.`, {
            identifiers: { resource, received_type: typeof chunk },
            action: "Send JSON through string, Buffer, or Uint8Array chunks.",
          });
      }
    }
    if (buffer.length) chunks.push(buffer);
  }
  if (pendingHigh) throw invalidUtf8(resource);
  return decodeUtf8(Buffer.concat(chunks), { resource });
}

