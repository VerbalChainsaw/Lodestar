import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { decorateError, lodestarError, wrapError } from "./errors.mjs";

export const JSON_INPUT_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const JSON_MAXIMUM_DEPTH = 1024;

function assertJsonDepth(depth, maximum = JSON_MAXIMUM_DEPTH) {
  if (depth > maximum) throw lodestarError("resource_limit",
    "JSON nesting exceeds the supported depth.", {
      identifiers: { resource: "json_depth", depth, maximum },
      action: "Flatten the JSON nesting or split the data into linked records, then retry; no data was truncated.",
    });
}

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

function normalizedJson(value, maximumDepth) {
  const holder = Object.create(null);
  const ancestors = new Set();
  const tasks = [{ kind: "value", value, target: holder, key: "value", pointer: "", depth: 0 }];
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
        target: task.target, key: task.index,
        pointer: `${task.pointer}/${task.index}`, depth: task.depth });
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
      tasks.push({ kind: "value", value: entry, target: task.target, key,
        pointer: `${task.pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, depth: task.depth });
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
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw lodestarError(
          "unsupported_numeric_value",
          "Integer-valued JSON numbers must use the JavaScript safe-integer range.",
          {
            identifiers: { pointer: task.pointer },
            action: "Use a string for an exact larger identifier or correct the source value.",
          },
        );
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
    assertJsonDepth(task.depth + 1, maximumDepth);
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
      ? { kind: "array", source: current, target: result, index: 0,
        pointer: task.pointer, depth: task.depth + 1 }
      : { kind: "object", source: current, target: result,
        keys: Object.keys(current).sort(), index: 0, pointer: task.pointer, depth: task.depth + 1 });
  }
  return holder.value;
}

export function canonicalStringify(value, { maximumDepth = JSON_MAXIMUM_DEPTH } = {}) {
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > JSON_MAXIMUM_DEPTH) {
    throw new TypeError(`Canonical JSON depth must be a positive integer no larger than ${JSON_MAXIMUM_DEPTH}.`);
  }
  return JSON.stringify(normalizedJson(value, maximumDepth));
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
  assertInputBytes(bytes, maximum, resource, identifiers);
  return bytes;
}

function assertInputBytes(bytes, maximum, resource, identifiers = {}) {
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
}

export function parseJsonText(
  text,
  {
    maximum,
    resource = "json_input",
    identifiers = {},
    validateNumbers = true,
  } = {},
) {
  // A transport BOM is not JSON data. Preserve raw source decoding elsewhere;
  // consume only the optional initial marker at the structured JSON boundary.
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (maximum !== undefined) {
    assertTextBytes(text, maximum, resource, identifiers);
  }
  try {
    const value = JSON.parse(text);
    const validateNumberAt = typeof validateNumbers === "function"
      ? (pointer) => validateNumbers(pointer, value) : validateNumbers;
    assertJsonNumericDomain(text, { validateNumbers: validateNumberAt });
    return value;
  } catch (error) {
    throw wrapError(
      error,
      "invalid_json",
      "Input is not valid JSON.",
      { identifiers },
    );
  }
}

export function assertJsonNumericDomain(text, { validateNumbers = true } = {}) {
  let offset = 0;
  const decimalMeaning = (token) => {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(token);
    const fraction = match[3] ?? "";
    let digits = `${match[2]}${fraction}`.replace(/^0+/u, "");
    if (!digits) return { negative: false, digits: "0", exponent: 0n };
    let exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
    while (digits.endsWith("0")) {
      digits = digits.slice(0, -1);
      exponent += 1n;
    }
    return { negative: match[1] === "-", digits, exponent };
  };
  const preservesDecimalMeaning = (token, numeric) => {
    const source = decimalMeaning(token);
    const canonical = decimalMeaning(JSON.stringify(numeric));
    return source.negative === canonical.negative
      && source.digits === canonical.digits
      && source.exponent === canonical.exponent;
  };
  const whitespace = () => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const stringToken = () => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === "\\") offset += 2;
      else if (text[offset++] === '"') return JSON.parse(text.slice(start, offset));
    }
    return "";
  };
  const inspectValue = (pointer, depth = 0) => {
    whitespace();
    if (text[offset] === "{" || text[offset] === "[") assertJsonDepth(depth + 1);
    if (text[offset] === '"') {
      stringToken();
      return;
    }
    if (text[offset] === "{") {
      offset += 1;
      const keys = new Set();
      whitespace();
      if (text[offset] === "}") { offset += 1; return; }
      while (offset < text.length) {
        whitespace();
        const key = stringToken();
        const keyPointer = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (keys.has(key)) {
          throw lodestarError(
            "invalid_json",
            "JSON objects cannot contain duplicate member names.",
            { identifiers: { pointer: keyPointer, key } },
          );
        }
        keys.add(key);
        whitespace();
        offset += 1;
        inspectValue(keyPointer, depth + 1);
        whitespace();
        if (text[offset++] === "}") return;
      }
      return;
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      let index = 0;
      while (offset < text.length) {
        inspectValue(`${pointer}/${index++}`, depth + 1);
        whitespace();
        if (text[offset++] === "]") return;
      }
      return;
    }
    const token = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
    token.lastIndex = offset;
    const match = token.exec(text);
    if (match) {
      offset = token.lastIndex;
      // Binding owners may admit ignored metadata numbers by pointer. Every
      // consumer still scans the complete document for duplicate names.
      if (!(typeof validateNumbers === "function" ? validateNumbers(pointer) : validateNumbers)) return;
      const numeric = Number(match[0]);
      if (!Number.isFinite(numeric)
        || (Number.isInteger(numeric) && !Number.isSafeInteger(numeric))
        || !preservesDecimalMeaning(match[0], numeric)) {
        throw lodestarError(
          "unsupported_numeric_value",
          "A JSON number is outside the supported numeric domain.",
          {
            identifiers: { pointer, value: match[0] },
            action: "Use a string for an exact larger identifier or correct the source value.",
          },
        );
      }
      return;
    }
    while (/[A-Za-z]/u.test(text[offset] ?? "")) offset += 1;
  };
  inspectValue("");
}


export async function readTextFileComplete(
  file,
  { resource = "file_input", maximum = JSON_INPUT_MAXIMUM_BYTES } = {},
) {
  let handle;
  let primaryError;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile()) {
      throw lodestarError("invalid_path", "The input path is not a regular file.",
        { identifiers: { path: file } });
    }
    assertInputBytes(info.size, maximum, resource, { path: file });
    // The stat is an early rejection, not a snapshot: bound the actual read too
    // so a file growing after stat cannot bypass admission.
    return await readStreamComplete(handle.createReadStream({
      highWaterMark: 64 * 1024, autoClose: false,
    }), { resource, maximum, identifiers: { path: file } });
  } catch (error) {
    primaryError = wrapError(error, "input_unreadable", "Lodestar could not read the input file.", {
      identifiers: { path: file },
      action: "Check that the path names a readable regular file.",
    });
    throw primaryError;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        const cleanup = {
          code: "input_close_failed",
          action: "No database mutation was dispatched. Preserve the input file, inspect file handles and storage access, and restart Lodestar before retrying.",
        };
        if (primaryError) throw decorateError(primaryError, { cleanup, committed: false });
        throw lodestarError("input_unreadable", "Lodestar could not close the input file. No database mutation was dispatched.", {
          identifiers: { path: file, resource, cleanup, committed: false },
          action: cleanup.action,
          cause: error,
        });
      }
    }
  }
}

export async function readStreamComplete(
  stream,
  { resource = "stdin_input", maximum = JSON_INPUT_MAXIMUM_BYTES, identifiers = {} } = {},
) {
  const chunks = [];
  let bytes = 0;
  let pendingHigh = "";
  for await (const chunk of stream) {
    let buffer;
    if (typeof chunk === "string") {
      // Count before making a normalized string or Buffer. A held high
      // surrogate plus a leading low surrogate encodes as four bytes, while
      // Buffer.byteLength counts the low surrogate alone as three.
      const leading = chunk.charCodeAt(0);
      const pendingBytes = pendingHigh
        ? (leading >= 0xDC00 && leading <= 0xDFFF ? 1 : 3) : 0;
      assertInputBytes(bytes + Buffer.byteLength(chunk, "utf8") + pendingBytes,
        maximum, resource, identifiers);
      const validated = validStringChunk(chunk, pendingHigh, resource);
      pendingHigh = validated.pendingHigh;
      buffer = Buffer.from(validated.text);
    } else {
      const view = byteView(chunk);
      if (view !== null) {
        if (pendingHigh) throw invalidUtf8(resource);
        assertInputBytes(bytes + view.byteLength, maximum, resource, identifiers);
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
    bytes += buffer.length;
    if (buffer.length) chunks.push(buffer);
  }
  if (pendingHigh) throw invalidUtf8(resource);
  return decodeUtf8(Buffer.concat(chunks, bytes), { resource, identifiers });
}
