import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
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