import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { handoffMutation, validateHandoff } from '../src/continuity.mjs';

const actor = (name) => ({ id: `agent:${name}`, agent: 'agent', session: name, harness: 'test' });
const checkpoint = { objective: 'Finish the authorized work', current_state: 'Implementation saved',
  completed_results: ['source saved'], unresolved_work: ['verify installation'], references: ['task:original'] };
async function setup(t) {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  f.requestHandoff = (input, name = 'one') => f.request(input,
    [{ kind: 'record', id: input.id }, { kind: 'record', id: 'project:test' }], 'project:test', actor(name));
  f.handoff = (action, request) => f.cli(['handoff', action, '--cwd', f.root], request);
  return f;
}

test('handoff status and startup never claim or write; a transfer is claimed explicitly once', async (t) => {
  const f = await setup(t);
  let result = await f.handoff('arm', await f.requestHandoff({ id: 'handoff:test', checkpoint }));
  assert.equal(result.code, 0, JSON.stringify(result.value));
  const bytes = await readFile(f.database);
  assert.equal((await f.handoff('status')).code, 0);
  assert.equal((await f.cli(['start', '--cwd', f.root, '--session', 'two'])).code, 0);
  assert.deepEqual(await readFile(f.database), bytes);
  const first = await f.requestHandoff({ id: 'handoff:test' }, 'two');
  const competing = await f.requestHandoff({ id: 'handoff:test' }, 'three');
  assert.equal((await f.handoff('claim', first)).code, 0);
  assert.notEqual((await f.handoff('claim', competing)).code, 0);
  const close = await f.requestHandoff({ id: 'handoff:test', checkpoint, state: 'closed', reason: 'Consumed and continued' }, 'two');
  assert.equal((await f.handoff('checkpoint', close)).code, 0);
  result = await f.handoff('claim', first);
  assert.equal(result.value.request.replayed, true);
  assert.equal(result.value.data.record.data.state, 'claimed');
  const current = await f.cli(['get', 'handoff:test']);
  assert.equal(current.value.data.data.state, 'closed');
});

test('checkpoint updates preserve complete large packets and immutable predecessors', async (t) => {
  const f = await setup(t);
  const large = { ...checkpoint, current_state: 'exact '.repeat(30000), references: Array.from({ length: 150 }, (_, i) => `reference:${i}`) };
  assert.deepEqual(validateHandoff(large).checkpoint, large);
  assert.equal((await f.handoff('arm', await f.requestHandoff({ id: 'handoff:large', checkpoint: large }))).code, 0);
  assert.equal((await f.handoff('checkpoint', await f.requestHandoff({ id: 'handoff:large', checkpoint }))).code, 0);
  const history = await f.cli(['get', 'handoff:large', '--history']);
  assert.match(JSON.stringify(history.value.data), /exact exact exact/);
  const packets = await f.cli(['find', 'Finish the authorized', '--kind', 'handoff-packet', '--history']);
  assert.equal(packets.value.data.records.length, 2);
});

test('continuity requires complete checkpoint fields and actor identity; cancellation is explicit', async (t) => {
  const f = await setup(t);
  assert.throws(() => validateHandoff({ objective: 'missing the rest' }));
  const missingActor = await f.request({ id: 'handoff:test', checkpoint },
    [{ kind: 'record', id: 'handoff:test' }, { kind: 'record', id: 'project:test' }], 'project:test');
  assert.throws(() => handoffMutation(null, { scope: 'project:test' }, { actor: null }, 'arm', missingActor),
    ({ code }) => code === 'identity_required');
  assert.equal((await f.handoff('arm', await f.requestHandoff({ id: 'handoff:test', checkpoint }))).code, 0);
  assert.equal((await f.handoff('disarm', await f.requestHandoff({ id: 'handoff:test', reason: 'No transfer needed' }))).code, 0);
  assert.equal((await f.cli(['get', 'handoff:test'])).value.data.data.state, 'cancelled');
});
