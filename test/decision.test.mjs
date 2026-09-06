import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';

const actor = { id: 'agent:session', agent: 'agent', session: 'session', harness: 'test' };
async function setup(t) {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  f.change = async (action, input) => f.cli(['decision', action, '--cwd', f.root], await f.request(input,
    [{ kind: 'record', id: 'project:test' }, { kind: 'decision', scope: 'project:test', key: input.key ?? '__injection__' }], 'project:test', actor));
  return f;
}

test('decision history allows reasoned A to B to A and deduplicates identical explanations', async (t) => {
  const f = await setup(t);
  for (const [value, reason] of [['A', 'Initial evidence'], ['B', 'Changed evidence'], ['A', 'New observation supports A']]) {
    const result = await f.change('set', { key: 'build:Choice_A', value, reason, status: 'accepted' });
    assert.equal(result.code, 0, JSON.stringify(result.value));
  }
  const before = await f.cli(['decision', 'show', 'build:Choice_A', '--cwd', f.root]);
  assert.equal(before.value.data.facts[0].value, 'A');
  const repeat = await f.change('set', { key: 'build:Choice_A', value: 'A', reason: 'New observation supports A', status: 'accepted' });
  assert.equal(repeat.code, 0, JSON.stringify(repeat.value));
  assert.equal(repeat.value.data.changed, false);
  const after = await f.cli(['decision', 'show', 'build:Choice_A', '--cwd', f.root]);
  assert.equal(after.value.data.dead.length, before.value.data.dead.length);
  const corrected = await f.change('set', { key: 'build:Choice_A', value: 'A', reason: 'Corrected evidence explanation', status: 'accepted' });
  assert.equal(corrected.value.data.changed, true);
});

test('user boundaries require actual supplied direction to revise across any session', async (t) => {
  const f = await setup(t);
  const direction = { kind: 'user', attribution: 'asserted', reference: 'user:1', instruction: 'Keep the source intact.' };
  assert.equal((await f.change('set', { key: 'source', value: 'keep', reason: 'User scope', status: 'accepted', direction })).code, 0);
  const refused = await f.change('set', { key: 'source', value: 'rewrite', reason: 'Agent preference', status: 'accepted' });
  assert.notEqual(refused.code, 0);
  assert.equal((await f.cli(['decision', 'show', 'source', '--cwd', f.root])).value.data.facts[0].value, 'keep');
  const forged = await f.change('set', { key: 'source', value: 'rewrite', reason: 'Changed direction', status: 'accepted',
    direction: { ...direction, attribution: 'host_observed' } });
  assert.notEqual(forged.code, 0);
  assert.equal((await f.change('set', { key: 'source', value: 'rewrite', reason: 'User revised scope', status: 'accepted',
    direction: { ...direction, reference: 'user:2', instruction: 'Now revise the source.' } })).code, 0);
});

test('decision status and explicit successor preserve their checked head', async (t) => {
  const f = await setup(t);
  assert.equal((await f.change('set', { key: 'build', value: 'old', reason: 'Initial', status: 'accepted' })).code, 0);
  assert.equal((await f.change('status', { key: 'build', reason: 'Missing prerequisite', status: 'blocked' })).code, 0);
  const blocked = await f.cli(['decision', 'show', 'build', '--cwd', f.root]);
  assert.equal(blocked.value.data.blocked[0].value, 'old');
  const result = await f.change('drop', { key: 'build', reason: 'Replacement available', status: 'superseded', successor: { key: 'build:new', value: 'new' } });
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.match(JSON.stringify((await f.cli(['decision', 'show', 'build', '--cwd', f.root])).value.data), /build:new/);
});

test('decision keys reject malformed spelling instead of silently conflating it', async (t) => {
  const f = await setup(t);
  for (const key of [' leading', 'trailing ', 'bad\nkey']) {
    await assert.rejects(() => f.change('set', { key, value: 'x', reason: 'x', status: 'accepted' }));
  }
});