import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { lodestarError, wrapError } from "./errors.mjs";

export const JSON_LIMITS = Object.freeze({
  depth: 128,
  nodes: 100_000,
  streamChunks: 16_384,
});

const READ_CHUNK_BYTES = 64 * 1024;

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
    buffer: Buffer.from(combined.slice(0, end)),
    pendingHigh: nextPending,
  };
}

function normalizedJson(value, stack, state, depth) {
  state.nodes += 1;
  if (state.nodes > JSON_LIMITS.nodes) {
    throw lodestarError(
      "resource_limit",
      "The JSON value exceeds its structural node limit.",
      {
        identifiers: {
          resource: "json_nodes",
          nodes: state.nodes,
          maximum: JSON_LIMITS.nodes,
        },
        action: "Reduce the JSON structure and retry.",
      },
    );
  }
  if (depth > JSON_LIMITS.depth) {
    throw lodestarError(
      "resource_limit",
      "The JSON value exceeds its nesting-depth limit.",
      {
        identifiers: {
          resource: "json_depth",
          depth,
          maximum: JSON_LIMITS.depth,
        },
        action: "Flatten the JSON structure and retry.",
      },
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw lodestarError(
        "invalid_json",
        "JSON numbers must be finite.",
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw lodestarError(
      "invalid_json",
      "The value contains a type JSON cannot represent.",
    );
  }
  if (stack.has(value)) {
    throw lodestarError(
      "invalid_json",
      "The value contains a circular reference.",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value)
    && prototype !== Object.prototype
    && prototype !== null
  ) {
    throw lodestarError(
      "invalid_json",
      "JSON objects must use an ordinary object prototype.",
    );
  }
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw lodestarError(
          "invalid_json",
          "JSON arrays cannot contain empty slots.",
          { identifiers: { index } },
        );
      }
      result.push(normalizedJson(
        value[index],
        stack,
        state,
        depth + 1,
      ));
    }
  } else {
    result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) {
        throw lodestarError(
          "invalid_json",
          "JSON object properties cannot be undefined.",
          { identifiers: { key } },
        );
      }
      result[key] = normalizedJson(entry, stack, state, depth + 1);
    }
  }
  stack.delete(value);
  return result;
}

export function canonicalStringify(value) {
  return JSON.stringify(normalizedJson(
    value,
    new Set(),
    { nodes: 0 },
    0,
  ));
}

export function jsonBytes(value) {
  return Buffer.byteLength(canonicalStringify(value), "utf8");
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

export async function readTextFileBounded(
  file,
  {
    maximum,
    resource = "file_input",
  },
) {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile()) {
      throw lodestarError(
        "invalid_path",
        "The input path is not a regular file.",
        { identifiers: { path: file } },
      );
    }
    if (info.size > maximum) {
      throw lodestarError(
        "resource_limit",
        `${resource} exceeds its byte limit.`,
        {
          identifiers: {
            path: file,
            resource,
            bytes: info.size,
            maximum,
          },
          action: "Use a smaller input file.",
        },
      );
    }
    const buffer = await readHandleBounded(handle, {
      maximum,
      resource,
      identifiers: { path: file },
    });
    const text = decodeUtf8(buffer, {
      resource,
      identifiers: { path: file },
    });
    assertTextBytes(text, maximum, resource, { path: file });
    return text;
  } catch (error) {
    throw wrapError(
      error,
      "input_unreadable",
      "Lodestar could not read the input file.",
      {
        identifiers: { path: file },
        action: "Check that the path names a readable regular file.",
      },
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readHandleBounded(
  handle,
  {
    maximum,
    resource = "file_input",
    identifiers = {},
  },
) {
  const chunks = [];
  let bytes = 0;
  while (true) {
    const remaining = maximum - bytes;
    const size = Math.min(READ_CHUNK_BYTES, remaining + 1);
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
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
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, bytes);
}

export async function readStreamBounded(
  stream,
  {
    maximum,
    resource = "stdin_input",
  },
) {
  const chunks = [];
  let bytes = 0;
  let chunkCount = 0;
  let pendingHigh = "";
  for await (const chunk of stream) {
    let buffer;
    if (typeof chunk === "string") {
      const validated = validStringChunk(chunk, pendingHigh, resource);
      buffer = validated.buffer;
      pendingHigh = validated.pendingHigh;
    } else {
      if (pendingHigh) throw invalidUtf8(resource);
      buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    if (buffer.length === 0) continue;
    chunkCount += 1;
    if (chunkCount > JSON_LIMITS.streamChunks) {
      throw lodestarError(
        "resource_limit",
        `${resource} exceeds its chunk-count limit.`,
        {
          identifiers: {
            resource,
            chunks: chunkCount,
            maximum: JSON_LIMITS.streamChunks,
          },
          action: "Send the JSON document through a normal bounded stream.",
        },
      );
    }
    bytes += buffer.length;
    if (bytes > maximum) {
      throw lodestarError(
        "resource_limit",
        `${resource} exceeds its byte limit.`,
        {
          identifiers: { resource, bytes, maximum },
          action: "Send a smaller JSON document.",
        },
      );
    }
    chunks.push(buffer);
  }
  if (pendingHigh) throw invalidUtf8(resource);
  return decodeUtf8(Buffer.concat(chunks), { resource });
}
