import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {SCHEMA_VERSION} from '../src/schema.mjs';
import {decodeReceiptStorage,encodeReceiptStorage} from '../src/receipt-storage.mjs';
import { fixture } from './helpers/contract.mjs';

for (const representation of ['legacy-json','gzip']) test(`doctor ${representation} independently rejects a genuine accepted receipt whose replay result is missing`, async (t) => {
  const f = await fixture(t);
  await f.create('fact:doctor-receipt', 'fact', { value: 'x'.repeat(5000) });
  const request = await f.request({ mode: 'update', id: 'fact:doctor-receipt', set: {data: {value: 2}}, remove: [] }, [{kind: 'record', id: 'fact:doctor-receipt'}]);
  const accepted = await f.cli(['put'], request);
  assert.equal(accepted.code, 0);
  const id = accepted.value.receipt_id;
  const db = new DatabaseSync(f.database);
  db.function('lodestar_write_contract', () => SCHEMA_VERSION);
  const content = JSON.parse(decodeReceiptStorage(db.prepare('SELECT content_json FROM records WHERE id=?').get(id).content_json,{id}));
  delete content.value.result;
  const decoded = JSON.stringify(content);
  const bytes = representation === 'gzip' ? encodeReceiptStorage(decoded,id) : decoded;
  if (representation === 'gzip') assert.equal(JSON.parse(bytes)._lodestar_storage?.codec, 'gzip');
  db.prepare('UPDATE records SET content_json=? WHERE id=?').run(bytes, id);
  db.close();
  const report = await f.cli(['doctor']);
  assert.equal(report.value.data.healthy, false);
  assert.ok(report.value.data.issues.some((issue) => issue.code === 'database_integrity' && issue.identifiers.id === id));
  const raw = await f.cli(['get', id, '--raw']);
  assert.equal(raw.value.data.raw_record.content_json, decoded);
  const readback = new DatabaseSync(f.database, {readOnly:true});
  try { assert.equal(readback.prepare('SELECT content_json FROM records WHERE id=?').get(id).content_json, bytes); } finally { readback.close(); }
});
