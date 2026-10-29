import assert from 'node:assert/strict';
import test from 'node:test';
import {openConnection, initializeConnection, admittedTransaction} from '../src/database.mjs';
import {diagnoseDatabase} from '../src/doctor.mjs';
import {archivedReceiptPointer} from '../src/receipt-storage.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
function fixture(t) {
  const db = openConnection(':memory:');
  initializeConnection(db, {createdAt: '2026-10-29T00:00:00.000Z'});
  t.after(() => db.close());
  return db;
}
function insert(db, id, type, content) {
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id, type, id, 'global', content,
    '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z');
}
test('doctor bounds Unicode-heavy findings and duplicated check lists with exact totals', t => {
  const db = fixture(t);
  admittedTransaction(db, () => {
    for (let i=0; i<1200; i++) insert(db, `decision:${i}:${'🧭'.repeat(150)}`, 'decision-event', '{"state":"known","value":{}}');
  });
  const report = diagnoseDatabase(db);
  assert.equal(report.healthy, false);
  assert.equal(report.complete, true);
  assert.equal(report.checks.decisions.healthy, false);
  assert.equal(report.checks.decisions.events, 1200);
  assert.equal(report.reporting.issue_counts.decision_event_invalid, 1200);
  assert.equal(report.reporting.lists['checks.decisions.invalid'].total, 1200);
  const list = report.reporting.lists['checks.decisions.invalid'];
  assert.equal(list.returned + list.omitted, list.total);
  assert.ok(report.reporting.issues_omitted > 0);
  assert.ok(bytes(report) <= 256 * 1024);
  assert.ok(!JSON.stringify(report).includes('�'));
});
test('oversized individual metadata and integrity details cannot bypass the report budget', t => {
  const db = fixture(t);
  admittedTransaction(db, () => db.prepare("UPDATE metadata SET value=? WHERE key='schema_version'").run('🧭'.repeat(300000)));
  const quick = diagnoseDatabase(db, {quick:true});
  assert.equal(quick.healthy, false);
  assert.equal(quick.complete, false);
  assert.ok(bytes(quick) <= 256 * 1024);
  assert.ok(quick.reporting.fields_truncated.includes('schema_version'));
  const prepare = db.prepare.bind(db);
  db.prepare = sql => sql === 'PRAGMA integrity_check'
    ? {all: () => Array.from({length:300}, () => ({integrity_check: '界'.repeat(10000)}))} : prepare(sql);
  const failed = diagnoseDatabase(db);
  assert.equal(failed.healthy, false);
  assert.equal(failed.reporting.issue_counts.integrity_error, 300);
  assert.ok(bytes(failed) <= 256 * 1024);
});
test('mixed cold warnings and omitted real failures never become healthy or complete', t => {
  const db = fixture(t);
  admittedTransaction(db, () => {
    for(let i=0;i<900;i++) insert(db, `invalid:${i}:${'x'.repeat(400)}`, 'note', '{"state":"known","value":{}}');
    const id = `mutation-receipt:${'a'.repeat(64)}`;
    insert(db,id,'mutation-receipt',archivedReceiptPointer(id,1,'C:/missing-doctor-fixture/manifest.json','b'.repeat(64)));
  });
  const report=diagnoseDatabase(db);
  assert.equal(report.healthy,false);
  assert.equal(report.complete,false);
  assert.equal(report.reporting.issue_counts.archive_restore_required,1);
  assert.ok(report.reporting.issue_count > report.issues.length);
  assert.ok(bytes(report)<=256*1024);
});
test('legacy schema 5 is diagnosed without upgrading or claiming schema 6', t => {
  const db=fixture(t);
  const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
  admittedTransaction(db,()=>db.prepare("UPDATE metadata SET value='5' WHERE key='schema_version'").run());
  for(const {name,sql} of triggers) {db.exec(`DROP TRIGGER ${name}`);db.exec(sql.replaceAll('IS NOT 6','IS NOT 5'));}
  db.function('lodestar_write_contract',()=>5);
  const report=diagnoseDatabase(db);
  assert.equal(report.healthy,true);
  assert.equal(report.schema_version,5);
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'5');
});
