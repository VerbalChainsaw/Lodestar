import assert from 'node:assert/strict';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';
import { openWriteDatabase } from '../src/database.mjs';
import { putRecord, getRecordHistory, getRawRecord, mutate, writeBasis } from '../src/records.mjs';
import { diagnoseDatabase } from '../src/doctor.mjs';
import { currentRevision } from '../src/revisions.mjs';
import { recoveryPreflight, promoteRecoveredDatabase } from '../src/schema-migration.mjs';
import { validateStoredReceipt } from '../src/stored-semantics.mjs';
import { fixture } from './helpers/contract.mjs';

async function acceptedReceipt(t) {
  const f = await fixture(t);
  const input = { mode: 'create', record: { id: 'fact:receipt', kind: 'fact', name: 'Receipt target',
    scope: 'global', availability: 'known', data: { value: 1 }, aliases: [], links: [], sources: [] } };
  const request = await f.request(input, [{ kind: 'record', id: input.record.id }]);
  const accepted = await f.cli(['put'], request);
  assert.equal(accepted.code, 0);
  return { f, request, receiptId: accepted.value.receipt_id };
}

function damage(database, id, change) {
  const db = new DatabaseSync(database);
  db.function('lodestar_write_contract', () => 5);
  try {
    const original = db.prepare('SELECT content_json FROM records WHERE id=?').get(id).content_json;
    const content = JSON.parse(original);
    change(content.value, content);
    const bytes = JSON.stringify(content);
    db.prepare('UPDATE records SET content_json=? WHERE id=?').run(bytes, id);
    return bytes;
  } finally { db.close(); }
}

const required = ['request_id', 'database_epoch', 'operation', 'payload_sha256', 'committed_revision',
  'result', 'changed_ids', 'before_images', 'database_revision_before'];
const malformed = [
  ['request_id', ''], ['request_id', 'changed:request'], ['database_epoch', 'bad'],
  ['database_epoch', 'a'.repeat(64)], ['operation', null],
  ['payload_sha256', 'bad'], ['committed_revision', 0], ['committed_revision', '1'],
  ['committed_revision', 2], ['result', null], ['result', []], ['result', {}],
  ['result', { data: null, next: [42] }], ['changed_ids', null], ['changed_ids', [null]],
  ['before_images', {}], ['before_images', [null]], ['before_images', [{ raw_record: {}, raw_associations: {} }]],
  ['database_revision_before', -1], ['database_revision_before', '0'], ['database_revision_before', 1],
];
for (const [label, change] of [
  ...required.map((field) => [`missing ${field}`, (data) => { delete data[field]; }]),
  ...malformed.map(([field, value], index) => [`malformed ${field} (${index})`, (data) => { data[field] = value; }]),
]) {
  test(`corrupt receipt ${label} fails replay honestly and doctor identifies it without modifying state`, async (t) => {
    const { f, request, receiptId } = await acceptedReceipt(t);
    assert.equal(typeof receiptId, 'string');
    const bytes = damage(f.database, receiptId, change);
    const db = await openWriteDatabase(f.database);
    try {
      const before = getRawRecord(db, 'fact:receipt');
      const revision = currentRevision(db);
      assert.throws(() => putRecord(db, request), (error) => {
        assert.equal(error.code, 'database_integrity');
        assert.equal(error.identifiers.id, receiptId);
        assert.match(error.action, /preserve|backup|doctor/i);
        return true;
      });
      const report = diagnoseDatabase(db);
      assert.equal(report.healthy, false);
      assert.ok(report.issues.some((issue) => issue.code === 'database_integrity'
        && issue.identifiers.id === receiptId), JSON.stringify(report.issues));
      assert.equal(currentRevision(db), revision);
      assert.deepEqual(getRawRecord(db, 'fact:receipt'), before);
      assert.equal(db.prepare('SELECT content_json FROM records WHERE id=?').get(receiptId).content_json, bytes);
    } finally { db.close(); }
  });
}

test('valid receipts retain changed, unchanged, exact replay and precise before-image history', async (t) => {
  const { f, request } = await acceptedReceipt(t);
  const db = await openWriteDatabase(f.database);
  const next = (id, input) => ({ v: 5, request_id: id,
    write_basis: writeBasis(db, { targets: [{ kind: 'record', id: 'fact:receipt' }] }), input });
  try {
    const replay = putRecord(db, request);
    assert.equal(replay.request.replayed, true);
    assert.equal(replay.revision, 1);
    assert.equal(replay.data.id, 'fact:receipt');
    assert.throws(() => putRecord(db, { ...request, input: { ...request.input,
      record: { ...request.input.record, name: 'Changed request' } } }), { code: 'request_conflict' });
    const unchanged = next('unchanged', { mode: 'update', id: 'fact:receipt', set: { data: { value: 1 } }, remove: [] });
    const unchangedResult = putRecord(db, unchanged);
    assert.equal(unchangedResult.data.revision, 1);
    assert.equal(putRecord(db, unchanged).revision, unchangedResult.revision);
    assert.equal(getRecordHistory(db, 'fact:receipt').versions.length, 0);
    const original = getRawRecord(db, 'fact:receipt');
    const update = next('changed', { mode: 'update', id: 'fact:receipt', set: { data: { value: 2 } }, remove: [] });
    const changed = putRecord(db, update);
    const history = getRecordHistory(db, 'fact:receipt');
    assert.equal(history.versions.length, 1);
    assert.equal(history.versions[0].revision, changed.revision);
    assert.equal(history.versions[0].sequence, 0);
    assert.equal(history.versions[0].receipt_id, changed.receipt_id);
    assert.deepEqual(history.versions[0].raw_record, { ...original.raw_record });
    assert.deepEqual(history.versions[0].raw_associations, original.raw_associations);
    assert.equal(putRecord(db, update).request.replayed, true);
    assert.equal(diagnoseDatabase(db).healthy, true);
  } finally { db.close(); }
});

test('history refuses damaged accepted receipt evidence while raw bytes remain available', async (t) => {
  const { f, receiptId } = await acceptedReceipt(t);
  const bytes = damage(f.database, receiptId, (data) => { delete data.before_images; });
  const db = await openWriteDatabase(f.database);
  try {
    assert.throws(() => getRecordHistory(db, 'fact:receipt'), { code: 'database_integrity' });
    assert.equal(getRawRecord(db, receiptId).raw_record.content_json, bytes);
  } finally { db.close(); }
});

test('a changed operation remains a request conflict while tampered exact-payload operation is integrity failure', async (t) => {
  const { f, request, receiptId } = await acceptedReceipt(t);
  const db = await openWriteDatabase(f.database);
  try {
    let applied = false;
    assert.throws(() => mutate(db, 'delete', request, () => { applied = true; return { data: {} }; }),
      { code: 'request_conflict' });
    assert.equal(applied, false);
  } finally { db.close(); }
  damage(f.database, receiptId, (data) => { data.operation = 'delete'; });
  const replayDb = await openWriteDatabase(f.database);
  try { assert.throws(() => putRecord(replayDb, request), { code: 'database_integrity' }); }
  finally { replayDb.close(); }
});

test('recovery retains valid original receipt epochs and bytes while old requests remain fenced', async (t) => {
  const { f, request, receiptId } = await acceptedReceipt(t);
  const db = await openWriteDatabase(f.database);
  let original;
  try {
    original = getRawRecord(db, receiptId).raw_record.content_json;
    await sqliteBackup(db, path.join(f.root, 'accepted-image.db'));
  } finally { db.close(); }
  const recovery = await recoveryPreflight(f.database, path.join(f.root, 'accepted-image.db'));
  const promoted = await promoteRecoveredDatabase(f.database, { request: { v: 5, request_id: 'recover:receipt',
    database_instance_id: request.database_instance_id, database_epoch: request.database_epoch,
    reason: 'Fully accounted fixture recovery', recovery } });
  assert.notEqual(promoted.database_epoch, request.database_epoch);
  const current = await openWriteDatabase(f.database);
  try {
    assert.equal(diagnoseDatabase(current).healthy, true);
    assert.equal(getRawRecord(current, receiptId).raw_record.content_json, original);
    assert.equal(getRecordHistory(current, 'fact:receipt').versions.length, 0);
    assert.throws(() => putRecord(current, request), { code: 'database_epoch_conflict' });
  } finally { current.close(); }
});

test('receipt history preserves legacy and source-correction before-image content bytes', async (t) => {
  const { f, request } = await acceptedReceipt(t);
  const legacy = '{"state":"known","value":{"exact":9007199254740993},"_lodestar":{"priority":0,"revision":1}}';
  const raw = new DatabaseSync(f.database);
  raw.function('lodestar_write_contract', () => 5);
  raw.prepare('UPDATE records SET content_json=? WHERE id=?').run(legacy, 'fact:receipt');
  raw.close();
  const db = await openWriteDatabase(f.database);
  try {
    const correction = { v: 5, request_id: 'correct:legacy',
      write_basis: writeBasis(db, { targets: [{ kind: 'record', id: 'fact:receipt' }] }),
      input: { mode: 'replace', record: { ...request.input.record, data: { exact: '9007199254740993' } } } };
    const accepted = putRecord(db, correction);
    const history = getRecordHistory(db, 'fact:receipt');
    assert.equal(history.versions.length, 1);
    assert.equal(history.versions[0].raw_record.content_json, legacy);
    assert.equal(history.versions[0].receipt_id, accepted.receipt_id);
    assert.equal(putRecord(db, correction).request.replayed, true);
    assert.equal(diagnoseDatabase(db).healthy, true);
  } finally { db.close(); }
});

async function associatedReceipt(t) {
  const f = await fixture(t);
  await f.create('fact:peer', 'fact', { value: 'Peer' });
  const input = { mode: 'create', record: { id: 'fact:associated', kind: 'fact', name: 'Associated record',
    scope: 'global', availability: 'known', data: { value: 1 }, aliases: ['Associated alias'],
    links: [{ relationship: 'related', to_id: 'fact:peer' }], sources: [{ origin: 'source:observed',
      freshness: 'unknown', metadata: { inspection: 'not_inspected', kind: 'external_observation',
        relation: 'supporting_evidence', observed_at: '2026-09-30T10:00:00.000Z', evidence_ref: 'fixture:observation' } }] } };
  const create = await f.request(input, [{ kind: 'record', id: 'fact:associated' }]);
  assert.equal((await f.cli(['put'], create)).code, 0);
  const before = (await f.cli(['get', 'fact:associated', '--raw'])).value.data;
  const request = await f.request({ mode: 'update', id: 'fact:associated', set: { data: { value: 2 } }, remove: [] },
    [{ kind: 'record', id: 'fact:associated' }]);
  const accepted = await f.cli(['put'], request);
  assert.equal(accepted.code, 0, JSON.stringify(accepted.value));
  const receiptId = accepted.value.receipt_id;
  const bytes = (await f.cli(['get', receiptId, '--raw'])).value.data.raw_record.content_json;
  return { f, request, receiptId, bytes, content: JSON.parse(bytes), before };
}

test('IR-CORE-F1 rejects each missing or nonstring raw before-image field and malformed association entry', async (t) => {
  const { content, receiptId } = await associatedReceipt(t);
  const rawFields = ['id', 'type', 'name', 'scope', 'content_json', 'created_at', 'updated_at'];
  const associationFields = { aliases: ['alias', 'record_id'],
    links: ['from_id', 'relationship', 'to_id', 'created_at'],
    sources: ['record_id', 'origin', 'freshness', 'metadata_json'] };
  const cases = [];
  for (const field of rawFields) {
    cases.push([`missing raw_record.${field}`, (image) => { delete image.raw_record[field]; }]);
    cases.push([`nonstring raw_record.${field}`, (image) => { image.raw_record[field] = 42; }]);
  }
  for (const [table, fields] of Object.entries(associationFields)) {
    cases.push([`null ${table} entry`, (image) => { image.raw_associations[table][0] = null; }]);
    cases.push([`array ${table} entry`, (image) => { image.raw_associations[table][0] = []; }]);
    for (const field of fields) {
      cases.push([`missing ${table}.${field}`, (image) => { delete image.raw_associations[table][0][field]; }]);
      cases.push([`nonstring ${table}.${field}`, (image) => { image.raw_associations[table][0][field] = 42; }]);
    }
  }
  for (const [name, change] of cases) await t.test(name, () => {
    const damaged = structuredClone(content);
    change(damaged.value.before_images[0]);
    const exact = JSON.stringify(damaged);
    assert.throws(() => validateStoredReceipt(damaged, { id: receiptId }), (error) => {
      assert.equal(error.code, 'database_integrity');
      assert.equal(error.identifiers.id, receiptId);
      assert.match(error.identifiers.field, /before_images/);
      return true;
    });
    assert.equal(JSON.stringify(damaged), exact);
  });
});

test('complete producer association images and historical strings preserve exact bytes and replay', async (t) => {
  const { f, request, receiptId, content, before } = await associatedReceipt(t);
  const exact = JSON.stringify(content);
  assert.equal(validateStoredReceipt(content, { id: receiptId }), content.value);
  assert.equal(JSON.stringify(content), exact);
  assert.deepEqual(content.value.before_images[0].raw_record, before.raw_record);
  assert.deepEqual(content.value.before_images[0].raw_associations, before.raw_associations);
  const old = structuredClone(content), image = old.value.before_images[0];
  image.raw_record.name = 'e\u0301';
  image.raw_record.created_at = 'historical timestamp';
  image.raw_record.updated_at = 'legacy value';
  image.raw_record.content_json = '{"state":"known","value":{"exact":9007199254740993}}';
  image.raw_associations.sources[0].metadata_json = '{"inspection":"inspected","legacy":9007199254740993}';
  const historicalBytes = JSON.stringify(old);
  assert.equal(validateStoredReceipt(old, { id: receiptId }), old.value);
  assert.equal(JSON.stringify(old), historicalBytes);
  const db = await openWriteDatabase(f.database);
  try {
    assert.equal(putRecord(db, request).request.replayed, true);
    assert.equal(diagnoseDatabase(db).healthy, true);
    const history = getRecordHistory(db, 'fact:associated');
    assert.deepEqual(history.versions[0].raw_associations, before.raw_associations);
  } finally { db.close(); }
});

test('damaged before-image association rows fail replay and doctor without changing persisted evidence', async (t) => {
  const { f, request, receiptId } = await associatedReceipt(t);
  const bytes = damage(f.database, receiptId, (data) => { data.before_images[0].raw_associations.aliases[0] = null; });
  const db = await openWriteDatabase(f.database);
  try {
    const revision = currentRevision(db), before = getRawRecord(db, 'fact:associated');
    assert.throws(() => putRecord(db, request), { code: 'database_integrity' });
    assert.ok(diagnoseDatabase(db).issues.some((issue) => issue.code === 'database_integrity'
      && issue.identifiers.id === receiptId));
    assert.equal(currentRevision(db), revision);
    assert.deepEqual(getRawRecord(db, 'fact:associated'), before);
    assert.equal(getRawRecord(db, receiptId).raw_record.content_json, bytes);
  } finally { db.close(); }
});
