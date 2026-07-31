import { Buffer } from "node:buffer";

const DEFAULT_MAXIMUM_BYTES = 16 * 1024;
const MAXIMUM_DEPTH = 6;
const MAXIMUM_ITEMS = 32;
const MAXIMUM_NODES = 256;

function arrayKind(value) {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
}

function valueType(value) {
  if (value === null) return "null";
  if (arrayKind(value) === true) return "array";
  return typeof value;
}

function truncateString(value, maximum) {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}`, "utf8") > maximum - 3) {
      break;
    }
    result += character;
  }
  return `${result}...`;
}

export function boundedDiagnosticValue(
  value,
  options = {},
) {
  let maximumBytes = DEFAULT_MAXIMUM_BYTES;
  try {
    if (
      typeof options?.maximumBytes === "number"
      && Number.isFinite(options.maximumBytes)
      && options.maximumBytes > 0
    ) {
      maximumBytes = Math.floor(options.maximumBytes);
    }
  } catch {
    // Retain the fixed default when options cannot be inspected.
  }
  const seen = new Set();
  const state = {
    nodes: 0,
    remaining: Math.max(128, Math.floor(maximumBytes * 0.75)),
  };
  const visit = (current, depth) => {
    state.nodes += 1;
    if (state.nodes > MAXIMUM_NODES || state.remaining <= 0) {
      return "[diagnostic truncated]";
    }
    if (current === null || typeof current === "boolean") {
      state.remaining -= 5;
      return current;
    }
    if (typeof current === "number") {
      state.remaining -= 24;
      return Number.isFinite(current) ? current : String(current);
    }
    if (typeof current === "string") {
      const selected = truncateString(
        current,
        Math.max(16, Math.min(1024, state.remaining)),
      );
      state.remaining -= Buffer.byteLength(selected, "utf8");
      return selected;
    }
    if (
      typeof current !== "object"
      || depth >= MAXIMUM_DEPTH
      || seen.has(current)
    ) {
      const marker = seen.has(current)
        ? "[circular diagnostic value]"
        : `[${valueType(current)} diagnostic value omitted]`;
      state.remaining -= marker.length;
      return marker;
    }

    seen.add(current);
    let result;
    const isArray = arrayKind(current);
    if (isArray === null) {
      seen.delete(current);
      return "[unreadable diagnostic value]";
    }
    if (isArray) {
      result = [];
      let length;
      try {
        length = current.length;
      } catch {
        seen.delete(current);
        return "[unreadable diagnostic value]";
      }
      if (!Number.isSafeInteger(length) || length < 0) {
        seen.delete(current);
        return "[unreadable diagnostic value]";
      }
      const selectedLength = Math.min(length, MAXIMUM_ITEMS);
      for (let index = 0; index < selectedLength; index += 1) {
        try {
          result.push(visit(current[index], depth + 1));
        } catch {
          result.push("[unreadable diagnostic value]");
        }
      }
      if (length > selectedLength) {
        result.push({
          diagnostic_omitted_items: length - selectedLength,
        });
      }
    } else {
      result = Object.create(null);
      let keys;
      try {
        keys = Object.keys(current).sort();
      } catch {
        keys = [];
      }
      const selected = keys.slice(0, MAXIMUM_ITEMS);
      for (const key of selected) {
        const boundedKey = truncateString(key, 256);
        state.remaining -= Buffer.byteLength(boundedKey, "utf8");
        try {
          result[boundedKey] = visit(current[key], depth + 1);
        } catch {
          result[boundedKey] = "[unreadable diagnostic value]";
        }
      }
      if (keys.length > selected.length) {
        result.diagnostic_omitted_properties = keys.length - selected.length;
      }
    }
    seen.delete(current);
    return result;
  };

  const result = visit(value, 0);
  try {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= maximumBytes) {
      return result;
    }
  } catch {
    // The small fallback below is always serializable.
  }
  return {
    diagnostic_truncated: true,
    original_type: valueType(value),
  };
}
