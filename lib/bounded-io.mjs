import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";

import { LodestarError } from "./errors.mjs";

const CHUNK_BYTES = 64 * 1024;

function limitError(resource, actual, maximum, detail = {}) {
  return new LodestarError(
    "resource-limit-exceeded",
    `${resource} exceeds its supported byte limit`,
    {
      detail: {
        resource,
        actual,
        maximum,
        ...detail,
      },
    },
  );
}

export function assertByteLimit(value, {
  maximum,
  resource = "input",
  detail = {},
} = {}) {
  const actual = Buffer.isBuffer(value)
    ? value.byteLength
    : Buffer.byteLength(String(value));
  if (actual > maximum) throw limitError(resource, actual, maximum, detail);
  return value;
}

export async function readFileLimited(file, {
  maximum,
  encoding = null,
  resource = "file",
  fsApi = fs,
} = {}) {
  // Injected filesystem doubles are intentionally honored for deterministic
  // fault tests. Production reads stream at most maximum + 1 bytes.
  if (fsApi !== fs && typeof fsApi.readFile === "function") {
    const value = await fsApi.readFile(file, encoding ?? undefined);
    assertByteLimit(value, {
      maximum,
      resource,
      detail: { path: file },
    });
    return value;
  }
  const handle = await fs.open(file, "r");
  const chunks = [];
  let total = 0;
  try {
    while (total <= maximum) {
      const buffer = Buffer.allocUnsafe(
        Math.min(CHUNK_BYTES, maximum + 1 - total),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  if (total > maximum) {
    throw limitError(resource, total, maximum, { path: file });
  }
  const value = Buffer.concat(chunks, total);
  return encoding ? value.toString(encoding) : value;
}

export async function hashFileLimited(file, {
  maximum,
  resource = "file",
  fsApi = fs,
} = {}) {
  if (fsApi !== fs && typeof fsApi.readFile === "function") {
    const value = await fsApi.readFile(file);
    assertByteLimit(value, {
      maximum,
      resource,
      detail: { path: file },
    });
    return {
      bytes: value.byteLength,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  const handle = await fs.open(file, "r");
  const digest = createHash("sha256");
  let total = 0;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  try {
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) {
        throw limitError(resource, total, maximum, { path: file });
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { bytes: total, sha256: digest.digest("hex") };
}
