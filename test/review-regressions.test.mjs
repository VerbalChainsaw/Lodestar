import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import { writeFile, utimes, unlink } from 'node:fs/promises';
import { inspectLocalSourceSync } from '../src/bootstrap.mjs';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { admittedTransaction, openReadDatabase, openWriteDatabase } from '../src/database.mjs';
import { applyPutInput, getRawRecord, mutate, preparePutEvidence, putRecord, writeRecordSnapshot } from '../src/records.mjs';
import { recordInput } from '../src/project.mjs';
import { allocateRevision, currentRevision } from '../src/revisions.mjs';
import { promoteRecoveredDatabase, recoveryPreflight } from '../src/schema-migration.mjs';
const actor = { id: 'agent:review', agent: 'agent', session: 'review', harness: 'test' };

test('current content owners are checked before admission, while exact replay survives later source changes', async (t) => {
  const f = await fixture(t);
  const sourcePath = path.join(f.root, 'catalog.json');
  await writeFile(sourcePath, '{"name":"original"}');
  const observed = inspectLocalSourceSync(sourcePath);
  const record = { id: 'fact:source', kind: 'fact', name: 'Source', scope: 'global', data: {}, aliases: [], links: [],
    sources: [{ origin: 'catalog:test', freshness: 'current', metadata: { inspection: 'inspected', kind: 'local_file', relation: 'content_owner',
      locator: { base: 'absolute', path: sourcePath }, observed_at: observed.observed_at,
      fingerprint: { algorithm: 'sha256', value: observed.sha256, bytes: observed.bytes } } }] };
  const request = await f.request({ mode: 'create', record }, [{ kind: 'record', id: record.id }]);
  await writeFile(sourcePath, '{"name":"changed"}');
  assert.equal((await f.cli(['put'], request)).value.error.code, 'needs_reinspection');
  await writeFile(sourcePath, '{"name":"original"}');
  await utimes(sourcePath, new Date(), new Date(Date.now() + 3000));
  const accepted = await f.cli(['put'], request);
  assert.equal(accepted.code, 0, JSON.stringify(accepted.value));
  await unlink(sourcePath);
  const replay = await f.cli(['put'], request);
  assert.equal(replay.value.request.replayed, true);
  assert.equal(replay.value.revision, accepted.value.revision);
  const update = await f.request({ mode: 'update', id: record.id, set: { name: 'Update' }, remove: [] }, [{ kind: 'record', id: record.id }]);
  assert.equal((await f.cli(['put'], update)).value.error.code, 'needs_reinspection');
});

test('invalid explicit priority is rejected without allocating a revision', async (t) => {
  const f = await fixture(t);
  for (const priority of [null, '5', 1.5]) {
    const result = await f.cli(['put'], await f.request({ mode: 'create', record: {
      id: 'fact:priority', kind: 'fact', name: 'Priority', scope: 'global', priority,
      data: {}, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id: 'fact:priority' }]));
    assert.equal(result.value.error.code, 'invalid_mutation_contract');
  }
  const db = await openReadDatabase(f.database);
  try { assert.equal(currentRevision(db), 0); } finally { db.close(); }
});

test('source-root configuration is a required dependency for put and pending promotion', async (t) => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  const configId = 'config:lodestar:sources';
  const config = { skill_source_roots: [{ id: 'test', locator: f.root }] };
  await f.create(configId, 'config', config);
  const sourcePath = path.join(f.root, 'source.json');
  await writeFile(sourcePath, '{}');
  const observed = inspectLocalSourceSync(sourcePath);
  const input = { mode: 'create', record: { id: 'fact:located', kind: 'fact', name: 'Located', scope: 'project:test',
    data: {}, aliases: [], links: [], sources: [{ origin: 'source:test', freshness: 'current', metadata: {
      inspection: 'inspected', kind: 'local_file', relation: 'content_owner', locator: { base: 'source_root', source_id: 'test', path: 'source.json' },
      observed_at: observed.observed_at, fingerprint: { algorithm: 'sha256', value: observed.sha256, bytes: observed.bytes } } }] } };
  const targets = [{ kind: 'record', id: input.record.id }];
  const missing = await f.request(input, targets, 'project:test');
  assert.equal((await f.cli(['put'], missing)).value.error.code, 'missing_precondition');
  const pendingId = 'pending:located';
  assert.equal((await f.cli(['pending', 'add', '--cwd', f.root], await f.request({ id: pendingId, text: 'Check source' },
    [{ kind: 'record', id: pendingId }], 'project:test', actor))).code, 0);
  const destination = { operation: 'put', input };
  const missingPromotion = await f.request({ id: pendingId, destination }, [...targets, { kind: 'record', id: pendingId }], 'project:test', actor);
  assert.equal((await f.cli(['pending', 'promote', '--cwd', f.root], missingPromotion)).value.error.code, 'missing_precondition');
  targets.push({ kind: 'record', id: configId });
  const request = await f.request(input, targets, 'project:test');
  const promotion = await f.request({ id: pendingId, destination }, [...targets, { kind: 'record', id: pendingId }], 'project:test', actor);
  const db = await openWriteDatabase(f.database);
  try {
    const prepared = preparePutEvidence(db, input, request);
    const change = await f.cli(['put'], await f.request({ mode: 'update', id: configId, set: { data: { ...config, changed: true } }, remove: [] }, [{ kind: 'record', id: configId }]));
    assert.equal(change.code, 0);
    assert.throws(() => mutate(db, 'put', request, (context) => ({ data: applyPutInput(db, input, { ...context, ...prepared }), changed_ids: [input.record.id] }),
      { resolveBinding: true, requiredTargets: [{ kind: 'record', id: input.record.id }] }), { code: 'revision_conflict' });
    assert.equal((await f.cli(['pending', 'promote', '--cwd', f.root], promotion)).value.error.code, 'revision_conflict');
    assert.equal(db.prepare('SELECT id FROM records WHERE id=?').get(input.record.id), undefined);
    assert.equal((await f.cli(['get', pendingId])).value.data.semantics.lifecycle, 'unresolved');
    assert.equal(currentRevision(db), change.value.revision);
  } finally { db.close(); }
});

test('immutable history creation cannot overwrite an ordinary record with a colliding old ID', async (t) => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  const rejected = await f.cli(['put'], await f.request({ mode: 'create', record: { id: 'decision:future', kind: 'fact', name: 'Collision', scope: 'global',
    data: {}, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id: 'decision:future' }]));
  assert.notEqual(rejected.code, 0);
  const db = await openWriteDatabase(f.database);
  let colliding;
  try { admittedTransaction(db, () => {
    const revision = allocateRevision(db); colliding = `decision:${revision + 1}`;
    const now = new Date().toISOString();
    writeRecordSnapshot(db, recordInput(colliding, 'fact', 'Old user fact', 'project:test', 0, { evidence: 'must survive' }), { revision, createdAt: now, updatedAt: now });
  }); } finally { db.close(); }
  const before = await f.cli(['get', colliding]);
  const request = await f.request({ key: 'test', value: 'one', reason: 'Evidence', status: 'accepted' },
    [{ kind: 'decision', scope: 'project:test', key: 'test' }], 'project:test', actor);
  const result = await f.cli(['decision', 'set', '--cwd', f.root], request);
  assert.equal(result.value.error.code, 'record_collision');
  const after = await f.cli(['get', colliding]);
  assert.equal(after.value.data.kind, 'fact');
  assert.equal(after.value.data.data.evidence, 'must survive');
  assert.equal(after.value.revision, before.value.revision);
});

test('identical puts keep record revision/history stable and data-only updates preserve association evidence', async (t) => {
  const f = await fixture(t);
  await f.create('fact:peer', 'fact', {});
  await f.create('fact:owner', 'fact', { value: 'one' });
  const update = async (set) => f.cli(['put'], await f.request({ mode: 'update', id: 'fact:owner', set, remove: [] }, [{ kind: 'record', id: 'fact:owner' }]));
  assert.equal((await update({ links: [{ relationship: 'depends-on', to_id: 'fact:peer' }], sources: [{ origin: 'user:one', freshness: 'unknown',
    metadata: { inspection: 'inspected', kind: 'user_direction', relation: 'supporting_evidence', evidence_ref: 'user:one' } }] })).code, 0);
  const readRaw = async () => { const db = await openReadDatabase(f.database); try { return getRawRecord(db, 'fact:owner'); } finally { db.close(); } };
  const before = await readRaw();
  const result = await update({ data: { value: 'two' } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.deepEqual((await readRaw()).raw_associations, before.raw_associations);
  const historyBefore = await f.cli(['get', 'fact:owner', '--history']);
  const repeated = await update({ data: { value: 'two' } });
  assert.equal(repeated.value.data.revision, result.value.data.revision);
  assert.equal((await f.cli(['get', 'fact:owner', '--history'])).value.data.versions.length, historyBefore.value.data.versions.length);
  assert.equal(repeated.value.revision, result.value.revision + 1);
});

test('a project mapping invalidates old fact bases and returns a canonical checked correction path', async (t) => {
  const f = await fixture(t);
  await f.create('project:old', 'project', { roots: [f.root] }, 'project:old');
  await f.create('project:new', 'project', { roots: [] }, 'project:new');
  await f.create('fact:old', 'fact', { value: 'old' }, 'project:old');
  const old = await f.cli(['get', 'fact:old']);
  const mapping = await f.request({ mode: 'update', id: 'project:old', set: { data: { canonical_project_id: 'project:new' },
    links: [{ relationship: 'canonical-project', to_id: 'project:new' }] }, remove: [] },
  [{ kind: 'record', id: 'project:old' }, { kind: 'record', id: 'project:new' }], 'project:old');
  assert.equal((await f.cli(['put'], mapping)).code, 0);
  const stale = await f.cli(['put'], { v: 5, request_id: 'old-binding', write_basis: old.value.data.write_basis,
    input: { mode: 'update', id: 'fact:old', set: { data: { value: 'stale' } }, remove: [] } });
  assert.equal(stale.value.error.code, 'project_binding_conflict');
  const fresh = await f.cli(['get', 'fact:old']);
  assert.equal(fresh.value.data.write_basis.project_scope, 'project:new');
  assert.ok(fresh.value.data.write_basis.targets.some(({ id }) => id === 'project:new'));
  assert.equal(fresh.value.data.data.value, 'old');
  const corrected = await f.cli(['put'], { v: 5, request_id: 'fresh-binding', write_basis: fresh.value.data.write_basis,
    input: { mode: 'update', id: 'fact:old', set: { data: { value: 'corrected' } }, remove: [] } });
  assert.equal(corrected.code, 0, JSON.stringify(corrected.value));
  assert.equal(corrected.value.data.data.value, 'corrected');
  assert.equal(corrected.value.data.scope, 'project:old', 'correcting meaning preserves its origin');
});

test('schema and fence definitions are rechecked under mutation admission', async (t) => {
  const f = await fixture(t);
  const request = await f.request({ mode: 'create', record: { id: 'fact:guard', kind: 'fact', name: 'Guard', scope: 'global', data: {}, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id: 'fact:guard' }]);
  const db = await openWriteDatabase(f.database);
  try {
    db.exec('DROP TRIGGER lodestar_contract_records_insert');
    assert.throws(() => putRecord(db, request), ({ code }) => ['invalid_database', 'database_integrity'].includes(code));
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 0);
  } finally { db.close(); }
});

for (const changed of ['accepted source', 'recovered image']) test(`recovery rejects ${changed} changes after preflight`, async (t) => {
  const f = await fixture(t);
  await f.create('fact:accepted', 'fact', { original: true });
  const source = path.join(f.root, 'accepted.db');
  const db = await openReadDatabase(f.database);
  try { await backup(db, source); } finally { db.close(); }
  const evidence = await recoveryPreflight(f.database, source);
  const request = { v: 5, request_id: 'recovery-race', database_instance_id: evidence.recovered.database_instance_id,
    database_epoch: evidence.recovered.database_epoch, reason: 'Preserve all accepted work', recovery: evidence };
  const altered = await openWriteDatabase(changed === 'accepted source' ? source : f.database);
  try { admittedTransaction(altered, () => altered.prepare("UPDATE records SET name='new accepted information' WHERE id='fact:accepted'").run()); }
  finally { altered.close(); }
  await assert.rejects(promoteRecoveredDatabase(f.database, { request }), ({ code }) => code === 'recovery_accounting_conflict');
  const current = await openReadDatabase(f.database);
  try { assert.equal(current.prepare("SELECT value FROM metadata WHERE key='database_epoch'").get().value, request.database_epoch); }
  finally { current.close(); }
});
