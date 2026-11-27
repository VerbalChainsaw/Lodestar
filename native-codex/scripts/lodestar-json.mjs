export const JSON_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const JSON_MAXIMUM_DEPTH = 1024;

function numeric(value) {
  if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error("JSON number is outside the supported numeric domain");
  }
}

function decimalMeaning(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(token);
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, "");
  if (!digits) return { negative: false, digits: "0", exponent: 0n };
  const trimmed = digits.replace(/0+$/u, "");
  const exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length)
    + BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return { negative: match[1] === "-", digits, exponent };
}

function structuralAdmission(text) {
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      while (++index < text.length) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === '"') break;
      }
      let next = index + 1;
      while (/\s/u.test(text[next] ?? "")) next += 1;
      if (text[next] === ":") {
        const name = JSON.parse(text.slice(start, index + 1));
        const names = stack.at(-1);
        if (names instanceof Set) {
          if (names.has(name)) throw new Error("JSON objects cannot contain duplicate member names");
          names.add(name);
        }
      }
    } else if (character === "{" || character === "[") {
      stack.push(character === "{" ? new Set() : null);
      if (stack.length > JSON_MAXIMUM_DEPTH) throw new Error("JSON nesting exceeds the supported depth");
    } else if (character === "}" || character === "]") stack.pop();
  }
}

export function parseNativeJson(text) {
  if (Buffer.byteLength(text, "utf8") > JSON_MAXIMUM_BYTES) throw new Error("JSON input exceeds 16 MiB");
  text = text.replace(/^\uFEFF/u, "");
  // The lexical pass bounds structure before parsing can allocate a deep graph.
  // JSON.parse owns syntax validation and supplies the original numeric tokens.
  try {
    structuralAdmission(text);
    return JSON.parse(text, (field, value, context) => {
      if (typeof value === "number") {
        numeric(value);
        if (typeof context?.source !== "string") throw new Error("Source-aware JSON parsing is required");
        if (value === 0 && /[1-9]/u.test(context.source.split(/[eE]/u, 1)[0])) {
          throw new Error("JSON number cannot be preserved exactly");
        }
        const source = decimalMeaning(context.source), canonical = decimalMeaning(JSON.stringify(value));
        if (source.negative !== canonical.negative || source.digits !== canonical.digits
            || source.exponent !== canonical.exponent) {
          throw new Error("JSON number cannot be preserved exactly");
        }
      }
      return value;
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid JSON input");
    throw error;
  }
}

export function assertJsonValue(value) {
  const ancestors = new Set(), tasks = [{ value, depth: 0 }];
  while (tasks.length) {
    const task = tasks.pop(), current = task.value;
    if (task.leave) { ancestors.delete(current); continue; }
    if (typeof current === "number") numeric(current);
    if (current === null || typeof current !== "object") continue;
    const depth = task.depth + 1;
    if (depth > JSON_MAXIMUM_DEPTH) throw new Error("JSON nesting exceeds the supported depth");
    if (ancestors.has(current)) throw new Error("JSON values cannot be circular");
    ancestors.add(current);
    tasks.push({ value: current, leave: true });
    for (const item of Object.values(current)) {
      // Optional object fields are filtered by native canonicalization.
      if (item !== undefined) tasks.push({ value: item, depth });
    }
  }
}

export async function readHookJson(stream) {
  const parts = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > JSON_MAXIMUM_BYTES) throw new Error("JSON input exceeds 16 MiB");
    parts.push(bytes);
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts, length)); }
  catch { throw new Error("JSON input is not valid UTF-8"); }
  return text.trim() ? parseNativeJson(text) : {};
}
