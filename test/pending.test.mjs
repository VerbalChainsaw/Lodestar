import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { mutate } from '../src/records.mjs';
import { openReadDatabase, openWriteDatabase } from '../src/database.mjs';
import { pendingList, pendingMutation } from '../src/pending.mjs';
import { resolveProject, resolveProjectScope } from '../src/project.mjs';
import { workStatus } from '../src/work.mjs';
const actor = { id: 'agent:one', agent: 'agent', session: 'one', harness: 'test' };
async function setup(t) {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  f.pending = async (action, input, extra = []) => f.cli(['pending', action, '--cwd', f.root], await f.request(input,
    [{ kind: 'record', id: input.id }, { kind: 'record', id: 'project:test' }, ...extra], 'project:test', actor));
  return f;
}
const destination = { operation: 'put', input: { mode: 'create', record: { id: 'fact:promoted', kind: 'fact',
  name: 'Observed fact', scope: 'project:test', availability: 'known', data: { observation: 'Inspected source' }, aliases: [], links: [], sources: [] } } };

test('a candidate stays non-governing and promotion preserves it in one receipt transaction', async (t) => {
  const f = await setup(t);
  assert.equal((await f.pending('add', { id: 'pending:one', text: 'Investigate this source' })).code, 0);
  const start = await f.cli(['start', '--cwd', f.root]);
  assert.equal(start.value.data.pending, 1);
  assert.equal(start.value.data.context.some(({ id }) => id === 'pending:one'), false);
  const result = await f.pending('promote', { id: 'pending:one', destination }, [{ kind: 'record', id: 'fact:promoted' }]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  const candidate = await f.cli(['get', 'pending:one']);
  const fact = await f.cli(['get', 'fact:promoted']);
  assert.equal(candidate.value.data.semantics.lifecycle, 'superseded');
  assert.equal(candidate.value.data.revision, fact.value.data.revision);
  assert.equal((await f.cli(['pending', 'list', '--cwd', f.root])).value.data.count, 0);
  assert.match(JSON.stringify((await f.cli(['get', 'pending:one', '--history'])).value.data), /Investigate this source/);
});

test('invalid destination rolls back promotion and candidate settlement together', async (t) => {
  const f = await setup(t);
  await f.pending('add', { id: 'pending:one', text: 'candidate' });
  const before = await f.cli(['get', 'pending:one']);
  const invalid = { ...destination, input: { ...destination.input, record: { ...destination.input.record, kind: 'decision-event' } } };
  const result = await f.pending('promote', { id: 'pending:one', destination: invalid }, [{ kind: 'record', id: 'fact:promoted' }]);
  assert.notEqual(result.code, 0);
  assert.equal((await f.cli(['get', 'pending:one'])).value.revision, before.value.revision);
  assert.notEqual((await f.cli(['get', 'fact:promoted'])).code, 0);
});

test('promotion cannot overwrite its candidate through an update or replacement destination', async (t) => {
  const f = await setup(t);
  const invoke = async (action, input, extra = []) => {
    const body = await f.request(input, [{ kind: 'record', id: input.id },
      { kind: 'record', id: 'project:test' }, ...extra], 'project:test', actor);
    const db = await openWriteDatabase(f.database);
    try {
      const project = resolveProjectScope(db, 'project:test', f.root);
      return pendingMutation(db, project, { actor: actor.id }, action, body, { project });
    } finally { db.close(); }
  };
  await invoke('add', { id: 'pending:self', text: 'Preserve the original candidate' });
  const before = await f.cli(['get', 'pending:self']);
  for (const input of [
    { mode: 'replace', record: { ...destination.input.record, id: 'pending:self' } },
    { mode: 'update', id: 'pending:self', set: { data: { promoted: true } }, remove: [] },
  ]) {
    let rejected;
    try { await invoke('promote', { id: 'pending:self', destination: { operation: 'put', input } }); }
    catch (error) { rejected = error; }
    assert.ok(rejected, 'candidate settlement must not overwrite a reported promotion');
    assert.equal(rejected.code, 'invalid_input');
    assert.match(rejected.action, /distinct|different.*ID/i);
    const after = await f.cli(['get', 'pending:self']);
    assert.equal(after.value.revision, before.value.revision, 'rejection creates no revision or receipt');
    assert.deepEqual(after.value.data, before.value.data, 'candidate contents and lifecycle survive');
  }
  const promoted = await invoke('promote', { id: 'pending:self', destination },
    [{ kind: 'record', id: 'fact:promoted' }]);
  const candidate = await f.cli(['get', 'pending:self']);
  const fact = await f.cli(['get', 'fact:promoted']);
  assert.equal(candidate.value.data.semantics.lifecycle, 'superseded');
  assert.equal(fact.value.data.kind, 'fact');
  assert.deepEqual(fact.value.data.data, destination.input.record.data);
  assert.equal(candidate.value.data.revision, fact.value.data.revision);
  assert.equal((await f.cli(['get', promoted.receipt_id])).code, 0);
});

test('confirmed pending receipts reconcile before current destination admission guards', async (t) => {
  const f = await setup(t);
  const input = { id: 'pending:legacy', destination: { operation: 'put',
    input: { mode: 'replace', record: { ...destination.input.record, id: 'pending:legacy' } } } };
  const body = await f.request(input, [{ kind: 'record', id: input.id },
    { kind: 'record', id: 'project:test' }], 'project:test', actor);
  const db = await openWriteDatabase(f.database);
  try {
    // A fully producer-validated receipt represents a previously accepted exact request.
    // Its result is authoritative during replay even when current admission becomes stricter.
    const original = mutate(db, 'pending.promote', body, () => ({ data: { legacy: true }, changed_ids: [] }));
    const replay = pendingMutation(db, resolveProjectScope(db, 'project:test', f.root),
      { actor: actor.id }, 'promote', body);
    assert.equal(replay.receipt_id, original.receipt_id);
    assert.equal(replay.request.replayed, true);
    assert.deepEqual(replay.data, original.data);
    assert.equal(replay.revision, original.revision);
  } finally { db.close(); }
});

test('pending retirement keeps exact text and history; no transcript guessing or size truncation', async (t) => {
  const f = await setup(t);
  const text = 'Complete candidate text. '.repeat(10000);
  const result = await f.pending('add', { id: 'pending:long', text });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.data.record.data.text, text);
  assert.equal((await f.pending('drop', { id: 'pending:long', reason: 'Resolved without promotion' })).code, 0);
  const saved = await f.cli(['get', 'pending:long']);
  assert.equal(saved.value.data.data.text, text);
  assert.equal(saved.value.data.semantics.lifecycle, 'historical');
});

test('pending input rejects empty/control text and cannot promote claimed host authority through CLI', async (t) => {
  const f = await setup(t);
  for (const text of ['', 'bad\u0000text']) assert.notEqual((await f.pending('add', { id: 'pending:invalid', text })).code, 0);
  await f.pending('add', { id: 'pending:user', text: 'candidate direction' });
  const result = await f.pending('promote', { id: 'pending:user', destination: { operation: 'decision.set', input: {
    key: 'scope', value: 'change', status: 'accepted', reason: 'candidate', direction: { kind: 'user', attribution: 'host_observed', reference: 'fake', instruction: 'Change scope' } } } },
  [{ kind: 'decision', scope: 'project:test', key: 'scope' }]);
  assert.notEqual(result.code, 0);
});

test('limited pending reads expose only visible record targets and retain project bindings', async (t) => {
  const f = await setup(t);
  for (const id of ['pending:one', 'pending:two', 'pending:three']) {
    assert.equal((await f.pending('add', { id, text: id })).code, 0);
  }
  const db = await openReadDatabase(f.database);
  try {
    const project = resolveProject(db, f.root);
    for (const limit of [1, 2, 0, 3, 4, null]) {
      const result = pendingList(db, project, limit);
      assert.equal(result.count, 3);
      assert.equal(result.records.length, limit === null ? 3 : Math.min(limit, 3));
      assert.equal(result.more, limit !== null && limit < 3);
      assert.deepEqual(result.write_basis.targets.map(({ id }) => id).sort(),
        [...result.records.map(({ id }) => id), 'project:test'].sort(), `limit ${limit}`);
    }
  } finally { db.close(); }
  const listed = await f.cli(['pending', 'list', '--cwd', f.root, '--limit', '1']);
  assert.equal(listed.code, 0);
  const result = await f.cli(['pending', 'drop', '--cwd', f.root, '--session', 'one', '--agent', 'agent'], {
    v: 5, request_id: 'drop-visible-candidate', write_basis: listed.value.data.write_basis,
    input: { id: listed.value.data.records[0].id, reason: 'Resolved the visible candidate' },
  });
  assert.equal(result.code, 0, JSON.stringify(result.value));
});

test('empty pending reads retain their project binding without candidate targets', async (t) => {
  const f = await setup(t);
  const result = await f.cli(['pending', 'list', '--cwd', f.root, '--limit', '1']);
  assert.equal(result.code, 0);
  assert.equal(result.value.data.count, 0);
  assert.equal(result.value.data.more, false);
  assert.deepEqual(result.value.data.records, []);
  assert.deepEqual(result.value.data.write_basis.targets.map(({ id }) => id), ['project:test']);
});

test('adjacent work limits keep only visible write targets and the required binding', async (t) => {
  const f = await setup(t);
  for (const id of ['work:one', 'work:two', 'work:three']) {
    const input = { id, description: id };
    const started = await f.cli(['work', 'start', '--cwd', f.root], await f.request(input,
      [{ kind: 'record', id }, { kind: 'record', id: 'project:test' }], 'project:test', actor));
    assert.equal(started.code, 0, JSON.stringify(started.value));
  }
  const db = await openReadDatabase(f.database);
  try {
    const project = resolveProject(db, f.root);
    for (const history of [false, true]) for (const limit of [1, 2, 0, 3, 4, null]) {
      const all = workStatus(db, project, history);
      const result = workStatus(db, project, history, limit);
      assert.deepEqual(result.records, limit === null ? all.records : all.records.slice(0, limit));
      assert.equal(result.more, result.records.length < all.records.length);
      assert.deepEqual(result.write_basis.targets.map(({ id }) => id).sort(),
        [...result.records.filter(({ kind }) => kind === 'work').map(({ id }) => id), 'project:test'].sort());
    }
  } finally { db.close(); }
});
