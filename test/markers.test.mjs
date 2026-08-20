import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMarker, markerField, parseLegacyNotes, parseMarkers,
} from "../src/markers.mjs";

test("formatMarker emits canonical ordered attributes and bare-or-quoted values", () => {
  assert.equal(
    formatMarker("DECISION", { key: "db-engine", status: "ACCEPTED", value: "sqlite",
      date: "2026-08-20", reason: "local-first" }),
    "[DECISION key=db-engine status=ACCEPTED value=sqlite date=2026-08-20 reason=local-first]",
  );
  assert.equal(
    formatMarker("DEAD", { key: "gate", value: "closed", reason: "waiting on vendor" }),
    "[DEAD key=gate value=closed reason=waiting on vendor]",
  );
  // Unsafe values are JSON-quoted; empty fields are omitted; canonical field order.
  assert.equal(
    formatMarker("NOTE", { text: "worth keeping \"quoted\" phrase" }),
    `[NOTE text="worth keeping \\"quoted\\" phrase"]`,
  );
  assert.equal(formatMarker("SUPERSEDED", { key: "k", by: "k", value: "old" }),
    "[SUPERSEDED key=k by=k value=old]");
  assert.throws(() => formatMarker("WIP", { key: "k" }), /Unknown marker kind/u);
});

test("markerField quoting is the single rule", () => {
  assert.equal(markerField("value", "plain-token_1:/."), "value=plain-token_1:/.");
  assert.equal(markerField("value", "has space"), "value=has space");
  assert.equal(markerField("value", 'has"quote'), `value="has\\"quote"`);
  assert.equal(markerField("value", "emoji \u{1F600}"), `value="emoji 😀"`);
});

test("parseMarkers reads every kind, both quoting forms, and ignores unknown kinds", () => {
  const text = [
    "[DECISION key=db:engine status=ACCEPTED value=\"PostgreSQL\" date=2026-08-19 reason=\"centralized writes\"]",
    "[dead key=old-db value=sqlite date=2026-08-19 reason=removed]",
    "[SUPERSEDED key=old-path by=db:engine value=sqlite reason=\"replaced\"]",
    "[NOTE text=\"migrations are append-only\"]",
    "[WIP key=ignored]",
    "[DECISION reason=\"no key\"]",
    "[NOTE value=\"no text\"]",
    "plain prose",
  ].join("\n");
  const markers = parseMarkers(text);
  assert.equal(markers.length, 4, JSON.stringify(markers));
  assert.deepEqual(markers.map(({ kind }) => kind),
    ["DECISION", "DEAD", "SUPERSEDED", "NOTE"]);
  assert.equal(markers[0].key, "db:engine");
  assert.equal(markers[0].status, "accepted");
  assert.equal(markers[0].value, "PostgreSQL");
  assert.equal(markers[1].kind, "DEAD");
  assert.equal(markers[2].by, "db:engine");
  assert.equal(markers[3].text, "migrations are append-only");
});

test("formatMarker and parseMarkers round-trip", () => {
  const fields = { key: "db-engine", status: "ACCEPTED", value: "sqlite",
    date: "2026-08-20", reason: "local-first, zero deps" };
  const formatted = formatMarker("DECISION", fields);
  const [parsed] = parseMarkers(formatted);
  // Status parses lowercase and displays uppercase; everything else round-trips.
  assert.deepEqual(parsed,
    { kind: "DECISION", key: "db-engine", status: "accepted", value: "sqlite",
      date: "2026-08-20", reason: "local-first, zero deps" });
});

test("parseLegacyNotes maps the historical line form to NOTE markers", () => {
  assert.deepEqual(parseLegacyNotes("LODESTAR NOTE: keep this"), [{ kind: "NOTE", text: "keep this" }]);
  assert.deepEqual(parseLegacyNotes("ordinary prose"), []);
  assert.deepEqual(parseLegacyNotes("LODESTAR NOTE: same\nLODESTAR NOTE: same").length, 2);
});

test("brackets and escaped quotes inside quoted values round-trip exactly", () => {
  // A ] inside a quoted value must not terminate the marker or truncate the value.
  const fields = { key: "k", value: "a]b", status: "ACCEPTED", date: "2026-08-20" };
  const formatted = formatMarker("DECISION", fields);
  const [parsed] = parseMarkers(formatted);
  assert.equal(parsed.value, "a]b");
  assert.deepEqual(parseMarkers('[NOTE text="fix the ] bracket"]'),
    [{ kind: "NOTE", text: "fix the ] bracket" }]);
  assert.deepEqual(parseMarkers('[NOTE text="has \\"quote\\" inside]"]'),
    [{ kind: "NOTE", text: 'has "quote" inside]' }]);
  assert.deepEqual(
    parseMarkers('[NOTE text="one]two"] then [DEAD key=x value="y]z" date=2026-08-20 reason=q]'),
    [{ kind: "NOTE", text: "one]two" },
      { kind: "DEAD", key: "x", value: "y]z", date: "2026-08-20", reason: "q" }],
  );
});
