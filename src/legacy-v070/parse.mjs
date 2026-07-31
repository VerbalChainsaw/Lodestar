import { lodestarError } from "../errors.mjs";
import { decodeUtf8 } from "../json.mjs";

export function parseJson(buffer, label) {
  try {
    return JSON.parse(decodeUtf8(buffer, {
      resource: "legacy_json",
      identifiers: { path: label },
    }));
  } catch (error) {
    if (error?.name === "LodestarError") throw error;
    throw lodestarError(
      "legacy_json_invalid",
      "A v0.7 source file is not valid JSON.",
      { identifiers: { path: label }, cause: error },
    );
  }
}

export function parseJsonLines(buffer, label, defaultScope, maximum) {
  const entries = [];
  const text = decodeUtf8(buffer, {
    resource: "legacy_jsonl",
    identifiers: { path: label },
  });
  let start = 0;
  let lineNumber = 0;
  while (start <= text.length) {
    lineNumber += 1;
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = newline === -1 ? text.length + 1 : newline + 1;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      entries.push({
        record,
        defaultScope,
        location: {
          file: label,
          line: lineNumber,
        },
      });
      if (entries.length > maximum) {
        throw lodestarError(
          "resource_limit",
          "The v0.7 source exceeds the import record limit.",
          {
            identifiers: {
              path: label,
              records: entries.length,
              maximum,
            },
          },
        );
      }
    } catch (error) {
      if (error?.name === "LodestarError") throw error;
      throw lodestarError(
        "legacy_jsonl_invalid",
        "A v0.7 record line is not valid JSON.",
        {
          identifiers: { path: label, line: lineNumber },
          cause: error,
        },
      );
    }
  }
  return entries;
}
