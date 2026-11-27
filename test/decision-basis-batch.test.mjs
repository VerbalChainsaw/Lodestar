import assert from 'node:assert/strict';
import test from 'node:test';
import { admittedTransaction, openWriteDatabase } from '../src/database.mjs';
import { allocateRevision, currentRevision } from '../src/revisions.mjs';
import { mutate, writeBasis, writeRecordSnapshot } from '../src/records.mjs';
import { recordInput } from '../src/project.mjs';
import { fixture } from './helpers/contract.mjs';

const scope = 'project:batch';
const targets = ['key0', 'key1', 'key2'].map((key) => ({ kind: 'decision', scope, key }));
const timestamp = '2026-09-30T10:00:00.000Z';
function addEvents(db, entries) {
  return admittedTransaction(db, () => {
    const revision = allocateRevision(db);
    for (const [id, key, origin = scope] of entries) {
      writeRecordSnapshot(db, recordInput(id, 'decision-event', id, origin, 0,
        { key, event: 'set', value: id, status: 'accepted', reason: 'Observed test state' }),
      { createdAt: timestamp, updatedAt: timestamp, revision });
    }
    return revision;
  });
}
function observe(t, db) {
  const queries = new Map(), rows = new Map();
  const original = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql) => {
    const statement = original(sql);
    if (sql.includes("type='decision-event'") && sql.includes('scope=?')) {
      const all = statement.all.bind(statement);
      statement.all = (origin) => {
        const result = all(origin);
        queries.set(origin, (queries.get(origin) ?? 0) + 1);
        rows.set(origin, (rows.get(origin) ?? 0) + result.length);
        return result;
      };
    }
    return statement;
  });
  return { queries, rows, clear() { queries.clear(); rows.clear(); } };
}

test('write basis scans each entire decision scope once per batch and resets across reads', async (t) => {
  const f = await fixture(t), db = await openWriteDatabase(f.database);
  try {
    const revision = addEvents(db, targets.map(({ key }, index) => [`event:${index}`, key]));
    addEvents(db, [['event:other', 'key0', 'project:other']]);
    const measured = observe(t, db);
    const basis = writeBasis(db, { targets: [...targets, { kind: 'decision', scope: 'project:other', key: 'key0' }] });
    assert.deepEqual(basis.targets.slice(0, 3).map(({ expected_revision }) => expected_revision), [revision, revision, revision]);
    assert.equal(measured.queries.get(scope), 1);
    assert.equal(measured.rows.get(scope), 3);
    assert.equal(measured.queries.get('project:other'), 1);
    measured.clear();
    const newer = addEvents(db, [['event:new', 'key0']]);
    const next = writeBasis(db, { targets });
    assert.deepEqual(next.targets.map(({ expected_revision }) => expected_revision), [newer, revision, revision]);
    assert.equal(measured.queries.get(scope), 1);
    assert.equal(measured.rows.get(scope), 4);
  } finally { db.close(); }
});

test('admission validates multiple decision preconditions with one full scope scan and no stale reuse', async (t) => {
  const f = await fixture(t), db = await openWriteDatabase(f.database);
  try {
    addEvents(db, targets.map(({ key }, index) => [`event:${index}`, key]));
    const old = writeBasis(db, { targets });
    const measured = observe(t, db);
    const result = mutate(db, 'test:batch', { v: 5, request_id: 'admit:first', write_basis: old, input: {} },
      () => ({ data: { accepted: true } }));
    assert.equal(result.data.accepted, true);
    assert.equal(measured.queries.get(scope), 1);
    assert.equal(measured.rows.get(scope), 3);
    addEvents(db, [['event:new', 'key0']]);
    measured.clear();
    let applied = false;
    assert.throws(() => mutate(db, 'test:batch', { v: 5, request_id: 'admit:stale', write_basis: old, input: {} },
      () => { applied = true; return { data: {} }; }), { code: 'revision_conflict' });
    assert.equal(applied, false);
  } finally { db.close(); }
});

test('batching retains corruption discovery on an unrelated decision key before mutation', async (t) => {
  const f = await fixture(t), db = await openWriteDatabase(f.database);
  try {
    addEvents(db, targets.map(({ key }, index) => [`event:${index}`, key]));
    const basis = writeBasis(db, { targets: [targets[0]] });
    admittedTransaction(db, () => db.prepare('UPDATE records SET content_json=? WHERE id=?')
      .run(JSON.stringify({ state: 'known', value: { key: 'key2' },
        _lodestar: { priority: 0, revision: 'damaged' } }), 'event:2'));
    const revision = currentRevision(db);
    assert.throws(() => writeBasis(db, { targets: [targets[0]] }), { code: 'database_integrity' });
    let applied = false;
    assert.throws(() => mutate(db, 'test:batch', { v: 5, request_id: 'admit:corrupt', write_basis: basis, input: {} },
      () => { applied = true; return { data: {} }; }), { code: 'database_integrity' });
    assert.equal(applied, false);
    assert.equal(currentRevision(db), revision);
  } finally { db.close(); }
});
