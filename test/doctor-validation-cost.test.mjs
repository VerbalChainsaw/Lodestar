import assert from "node:assert/strict";
import test from "node:test";

import { openDiagnosticDatabase } from "../src/database.mjs";
import { diagnoseDatabase } from "../src/doctor.mjs";
import { decodeReceiptStorage } from "../src/receipt-storage.mjs";
import { validateContent } from "../src/validate.mjs";
import { fixture } from "./helpers/contract.mjs";

test("validation-only content preserves envelope checks and the default serialized result", () => {
  const valid = { state: "known", value: { z: -0, a: "evidence" } };
  assert.equal(validateContent(valid), '{"state":"known","value":{"a":"evidence","z":0}}');
  assert.equal(validateContent(valid, { serialize: false }), undefined);
  for (const value of [null, [], {}, { state: "invalid" },
    { state: "known", _lodestar: { priority: 0, revision: 0 } },
    { state: "known", value: { z: undefined, a: Infinity } }]) {
    let expected;
    try { validateContent(value); } catch (error) { expected = error; }
    assert.ok(expected);
    assert.throws(() => validateContent(value, { serialize: false }), (error) => {
      assert.equal(error.code, expected.code);
      assert.equal(error.message, expected.message);
      assert.deepEqual(error.identifiers, expected.identifiers);
      return true;
    });
  }
});

test("doctor validates large receipts without serializing their complete content again", async (t) => {
  const f = await fixture(t);
  const accepted = await f.create("fact:doctor-cost", "fact", {
    text: "historical-payload ".repeat(16_384),
  });
  const db = await openDiagnosticDatabase(f.database);
  try {
    const receiptId = accepted.value.receipt_id;
    const readReceipt = db.prepare("SELECT content_json FROM records WHERE id=?");
    const before = readReceipt.get(receiptId).content_json;
    const requestId = JSON.parse(decodeReceiptStorage(before, {id: receiptId})).value.request_id;
    const revision = db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value;
    const stringify = JSON.stringify;
    const objectKeys = Object.keys;
    let receiptSerializations = 0;
    let receiptEnvelopeWalks = 0;
    const serialization = t.mock.method(JSON, "stringify", function (value, ...args) {
      if (value?.value?.request_id === requestId && value?._lodestar) receiptSerializations += 1;
      return Reflect.apply(stringify, this, [value, ...args]);
    });
    const traversal = t.mock.method(Object, "keys", function (value) {
      if (value?.value?.request_id === requestId && value?._lodestar) receiptEnvelopeWalks += 1;
      return Reflect.apply(objectKeys, this, [value]);
    });
    let report;
    try { report = diagnoseDatabase(db); }
    finally { traversal.mock.restore(); serialization.mock.restore(); }
    assert.equal(report.healthy, true);
    assert.equal(readReceipt.get(receiptId).content_json, before);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value, revision);
    assert.equal(receiptSerializations, 0);
    assert.equal(receiptEnvelopeWalks, 1);
  } finally { db.close(); }
});
