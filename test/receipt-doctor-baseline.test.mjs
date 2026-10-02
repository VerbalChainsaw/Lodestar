import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';

test('doctor independently rejects a genuine accepted receipt whose replay result is missing', async (t) => {
  const f = await fixture(t);
  const accepted = await f.create('fact:doctor-receipt', 'fact', { value: 1 });
  const id = accepted.value.receipt_id;
  const db = new DatabaseSync(f.database);
  db.function('lodestar_write_contract', () => 5);
  const content = JSON.parse(db.prepare('SELECT content_json FROM records WHERE id=?').get(id).content_json);
  delete content.value.result;
  const bytes = JSON.stringify(content);
  db.prepare('UPDATE records SET content_json=? WHERE id=?').run(bytes, id);
  db.close();
  const report = await f.cli(['doctor']);
  assert.equal(report.value.data.healthy, false);
  assert.ok(report.value.data.issues.some((issue) => issue.code === 'database_integrity' && issue.identifiers.id === id));
  const raw = await f.cli(['get', id, '--raw']);
  assert.equal(raw.value.data.raw_record.content_json, bytes);
});
