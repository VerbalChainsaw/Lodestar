import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runManager } from '../src/manager.mjs';
import { executeCli } from '../src/interface-client.mjs';
import { loadInterfaceConfig } from '../src/interface-config.mjs';
import { fixture } from './helpers/contract.mjs';

async function journey(t, { count = 1, extension = 'current', followFailure = false, decision = false } = {}) {
  const f = await fixture(t), scope = 'project:operator';
  await f.create(scope, 'project', { roots: [f.root] }, scope);
  await f.create('rejection:idle', 'rejection', { reason: 'Idle service creates unnecessary system impact' }, scope,
    { lifecycle: 'current', context_role: 'orientation' });
  let decisionId;
  if (decision) {
    const result = await f.cli(['decision', 'set', '--cwd', f.root], await f.request({ key: 'route; Ω', value: 'One shot',
      status: 'accepted', reason: 'Reuse the existing owner' }, [{ kind: 'decision', scope, key: 'route; Ω' }], scope));
    assert.equal(result.code, 0, JSON.stringify(result.value)); decisionId = result.value.data.record.id;
    const newer = await f.cli(['decision', 'set', '--cwd', f.root], await f.request({ key: 'route; Ω', value: 'One shot, current',
      status: 'accepted', reason: 'Reuse the existing owner with current reasons' }, [{ kind: 'decision', scope, key: 'route; Ω' }], scope));
    assert.equal(newer.code, 0, JSON.stringify(newer.value));
  }
  for (let i = 0; i < count; i++) await f.create(`intent:${i}`, 'knowledge', {
    intent: { version: 1, brief: 'Resume this job', user_reference: 'Requested job', boundaries: ['One shot'],
      non_goals: ['No daemon'], requirements: [{ id: 'R-last', text: 'Finish readout', acceptance: 'Inspect results' }] },
    continuation: { active_requirement_ids: ['R-last'], next_action: 'Read the named gap',
      context: { version: 1, mission_record_ids: ['--missing; Ω', ...(decisionId ? [decisionId] : [])], requirements: [] } }
  }, scope);
  const configPath = path.join(f.root, 'interfaces.json');
  const loader = path.join(f.root, 'Lodestar.Loader.exe'); await writeFile(loader, 'placeholder');
  await writeFile(configPath, JSON.stringify({ v: 1, generation: randomUUID(), loader,
    runtime: { node: process.execPath, cli: fileURLToPath(new URL('../lodestar.mjs', import.meta.url)), database: f.database } }));
  const selection = await loadInterfaceConfig(configPath);
  const before = await readFile(f.database), calls = [];
  let output = '', visits = new Map();
  const ask = async () => {
    const title = output.trimEnd().split('\n').filter(line => line && !line.startsWith('  ')).at(-1);
    const turn = (visits.get(title) ?? 0) + 1; visits.set(title, turn);
    if (title === 'Main menu') return '9';
    if (title?.startsWith('project:operator (')) return turn === 1 ? '11' : '12';
    if (title === 'Select current intent') return '1';
    if (title === 'Intent / continuity actions') {
      if (turn > 1) return 'q';
      if (decision) return output.slice(output.lastIndexOf('\nIntent / continuity actions')).match(/\s+(\d+)\. Required:.*context_decision_superseded/)?.[1] ?? 'q';
      return '2';
    }
    return 'q';
  };
  await runManager({ selection, initialProject: scope, initialCwd: f.root,
    io: { stdout: { write: text => { output += text; } }, stdin: {} }, ask,
    execute: async (selected, invocation) => {
      calls.push(invocation);
      if (followFailure && invocation.operation === 'get' && invocation.args.at(-1) === '--missing; Ω')
        return { kind: 'TransportError', code: 'fixture_failure', message: 'Follow-up unavailable' };
      const result = await executeCli(selected, invocation);
      if (extension === 'no-create-help' && invocation.operation === 'help' && result.kind === 'EnvelopeSuccess')
        result.envelope.data.operations = result.envelope.data.operations.filter(operation => operation.id !== 'put');
      if (invocation.operation === 'work.check' && result.kind === 'EnvelopeSuccess') {
        if (extension === 'missing') delete result.envelope.data.continuity;
        if (extension === 'unknown') result.envelope.data.continuity.version = 999;
        if (extension === 'unsafe') result.envelope.data.continuity.read_required[0].read_args = ['put', '--file', 'attack.json'];
        if (extension === 'malformed') { result.envelope.data.continuity.records.push(null); result.envelope.data.continuity.complete = true; }
        if (extension === 'null-read') { result.envelope.data.continuity.read_required.push(null); result.envelope.data.continuity.complete = true; }
      }
      return result;
    } });
  assert.deepEqual(await readFile(f.database), before, 'operator journey mutated the store');
  assert.ok(calls.every(call => ['help', 'get', 'find', 'start', 'work.check', 'decision.show'].includes(call.operation)
    && (call.effect === undefined || call.effect === 'read')), 'a write was dispatched');
  return { output, calls };
}

test('Manager selected-project continuity and literal failed-gap read', async t => {
  const { output, calls } = await journey(t);
  assert.match(output, /ACCEPTANCE MAPPING: needs attention/);
  assert.match(output, /RECORDED CONTEXT COVERAGE: incomplete/);
  assert.match(output, /R-last/); assert.match(output, /Idle service creates unnecessary system impact/);
  assert.match(output, /recorded context.*delivered/is);
  assert.ok(calls.some(call => call.operation === 'get' && JSON.stringify(call.args) === JSON.stringify(['get', '--', '--missing; Ω'])));
  assert.match(output, /record_not_found/);
});
test('Manager explicitly selects among multiple current intents', async t => {
  const { output, calls } = await journey(t, { count: 2 });
  assert.match(output, /Select current intent/);
  assert.ok(calls.some(call => call.operation === 'work.check' && call.args.at(-1) === 'intent:0'));
});
test('Manager empty intent names supported creation and refresh actions', async t => {
  const { output, calls } = await journey(t, { count: 0 });
  assert.match(output, /No current intent.*knowledge/i); assert.match(output, /put.*Commands|Commands.*put/is);
  assert.match(output, /current project-scoped knowledge record with data\.intent/);
  assert.match(output, /Main menu > Commands/);
  assert.match(output, /work\.check for the intent data schema/);
  assert.match(output, /reopen this project's Intent \/ continuity to refresh the library and select/);
  assert.ok(!calls.some(call => call.operation === 'work.check'));
});
test('Manager empty intent does not advertise creation absent from selected-core metadata', async t => {
  const { output, calls } = await journey(t, { count: 0, extension: 'no-create-help' });
  assert.match(output, /Inspect Commands for the selected core's supported creation contract/);
  assert.doesNotMatch(output, /Create the knowledge record with checked put/);
  assert.ok(!calls.some(call => call.operation === 'put' || call.operation === 'work.check'));
});
for (const extension of ['missing', 'unknown', 'unsafe', 'malformed', 'null-read']) test(`Manager ${extension} continuity remains honest and cannot execute unsafe reads`, async t => {
  const { output, calls } = await journey(t, { extension });
  assert.match(output, /coverage.*unknown/i);
  assert.ok(!calls.some(call => call.operation === 'put'));
});
test('Manager exact core required decision read accepts normalized Windows root spelling and stays literal', async t => {
  const { output, calls } = await journey(t, { decision: true });
  assert.match(output, /Reuse the existing owner/);
  const read = calls.find(call => call.operation === 'decision.show');
  assert.ok(read, 'resolved decision has no runnable read');
  assert.equal(read.args[4], '--'); assert.equal(read.args[5], 'route; Ω');
  assert.ok(read.args[3].includes('/'), 'fixture did not exercise the core normalized path spelling');
});
test('Manager failed follow-up keeps the unresolved read visible', async t => {
  const { output } = await journey(t, { followFailure: true });
  assert.match(output, /Follow-up unavailable/); assert.match(output, /incomplete/);
});
