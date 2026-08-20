// One grammar for every Lodestar marker. A marker is a bracketed tag with ordered
// attributes: [KIND attr=value ...]. The same definition formats (core rendering) and
// parses (hook capture), so display, capture, storage, and documentation cannot drift.
//
// Rules:
// - Kind is uppercase in display (DECISION, DEAD, SUPERSEDED, NOTE); parsing is
//   case-insensitive on kinds and attribute names.
// - Attributes are lowercase, in canonical order matching the golden forms:
//   key, status, by, value, date, reason, reopen, text.
// - A value renders bare when it is a safe token (ASCII letters, digits, spaces,
//   . _ - : /) and contains no double quote; otherwise it is JSON-quoted. Parsing
//   accepts both forms.
// - status displays ACCEPTED | BLOCKED (uppercase); storage and parsing are lowercase.
// - date is YYYY-MM-DD.
// - DECISION, DEAD, and SUPERSEDED require a key; NOTE requires text.
// - Unknown kinds are ignored by parsing (no false positives on ordinary brackets).
//
// The historical line form "LODESTAR NOTE: <text>" maps to a NOTE marker and remains
// tolerated by capture for compatibility.

export const MARKER_KINDS = Object.freeze([
  "DECISION", "DEAD", "SUPERSEDED", "NOTE",
]);

export const MARKER_FIELDS = Object.freeze([
  "key", "status", "by", "value", "date", "reason", "reopen", "text",
]);

const BARE = /^[A-Za-z0-9][A-Za-z0-9 ._\-:/]*$/u;
const BRACKET = /\[(DECISION|DEAD|SUPERSEDED|NOTE)\s+([^\]]*?)\s*\]/giu;
const ATTR = /([a-z]+)\s*=\s*(?:"((?:\\.|[^"])*)"|(\S+))/giu;
export const LEGACY_NOTE = /^[ \t]*LODESTAR NOTE:[ \t]*(\S.*?)[ \t]*$/gmu;

export function markerField(name, value) {
  const text = String(value ?? "");
  return `${name}=${BARE.test(text) && !text.includes('"') ? text : JSON.stringify(text)}`;
}

export function formatMarker(kind, fields) {
  if (!MARKER_KINDS.includes(kind)) {
    throw new Error(`Unknown marker kind: ${kind}`);
  }
  const parts = [];
  for (const name of MARKER_FIELDS) {
    const value = fields[name];
    if (value === undefined || value === null || value === "") continue;
    parts.push(markerField(name, value));
  }
  return `[${kind} ${parts.join(" ")}]`;
}

export function parseMarkers(text) {
  if (typeof text !== "string") return [];
  const markers = [];
  // Scan brackets while respecting double-quoted spans and backslash escapes, so a
  // "]" inside a quoted value does not terminate the marker (and truncate a value).
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("[", cursor);
    if (start < 0) break;
    let end = -1;
    let quoted = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) { escaped = false; continue; }
      if (character === "\\" && quoted) { escaped = true; continue; }
      if (character === '"') { quoted = !quoted; continue; }
      if (character === "]" && !quoted) { end = index; break; }
    }
    cursor = end < 0 ? text.length : end + 1;
    if (end < 0) break;
    const body = text.slice(start, end + 1);
    const kindMatch = /^\[(DECISION|DEAD|SUPERSEDED|NOTE)\s+([\s\S]*?)\s*\]$/iu.exec(body);
    if (!kindMatch) continue;
    const kind = kindMatch[1].toUpperCase();
    const attrs = {};
    for (const attr of String(kindMatch[2]).matchAll(ATTR)) {
      const name = attr[1].toLowerCase();
      const value = attr[2] !== undefined
        ? attr[2].replace(/\\(["\\])/gu, "$1")
        : attr[3];
      if (attrs[name] === undefined) attrs[name] = value;
    }
    if (["DECISION", "DEAD", "SUPERSEDED"].includes(kind) && attrs.key === undefined) continue;
    if (kind === "NOTE" && attrs.text === undefined) continue;
    // status parses case-insensitively to lowercase; display renders it uppercase.
    if (attrs.status !== undefined) attrs.status = attrs.status.toLowerCase();
    markers.push({ kind, ...attrs });
  }
  return markers;
}
// Historical capture form: "LODESTAR NOTE: <text>" lines map to NOTE markers.
export function parseLegacyNotes(text) {
  if (typeof text !== "string") return [];
  const notes = [];
  for (const match of String(text).matchAll(LEGACY_NOTE)) {
    const note = match[1].replace(/\s+/gu, " ").trim();
    if (note) notes.push({ kind: "NOTE", text: note });
  }
  return notes;
}