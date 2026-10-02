import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/contract.mjs';
import { loadInterfaceConfig } from '../src/interface-config.mjs';
import { executeCli } from '../src/interface-client.mjs';
import { runManager } from '../src/manager.mjs';
import { combineReadBases } from '../src/operator-actions.mjs';

for (const operation of ['init', 'handoff.checkpoint']) {
  test(`Manager's unavailable ${operation} form directs actual typed help without dispatching a write`, async t => {
    const f = await fixture(t);
    const loader = path.join(f.root, 'loader.exe');
    await writeFile(loader, 'test loader placeholder');
    const config = path.join(f.root, 'interfaces.json');
    await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), loader,
      runtime: { node: process.execPath, cli: fileURLToPath(new URL('../lodestar.mjs', import.meta.url)), database: f.database } }));
    const selection = await loadInterfaceConfig(config);
    const help = await executeCli(selection, { operation: 'help', args: ['--help'] });
    const operations = help.envelope.data.operations;
    const index = operations.findIndex(item => item.id === operation);
    assert.ok(index >= 0);
    const args = ['--db', f.database, ...operations[index].argv, '--help'];
    const before = await readFile(f.database);
    const answers = ['4', String(index + 1), String(operations.length + 1), '9'];
    let output = ''; let writes = 0;
    await runManager({ selection, ask: async () => answers.shift() ?? null,
      io: { stdout: { write: value => { output += value; } }, stdin: {} },
      execute: async (binding, invocation) => {
        if (invocation.effect && invocation.effect !== 'read') writes += 1;
        return executeCli(binding, invocation);
      } });
    assert.ok(output.includes(`Typed help arguments: ${JSON.stringify(args)}`), output);
    assert.doesNotMatch(output, /Domain writes need their dedicated actor and basis adapter/);
    const typed = spawnSync(selection.node, [selection.cli, ...args], { encoding: 'utf8', timeout: 20000 });
    assert.equal(typed.status, 0, typed.stderr || typed.stdout);
    const value = JSON.parse(typed.stdout);
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.ok(JSON.stringify(value.data).includes(operation));
    assert.equal(writes, 0);
    assert.deepEqual(await readFile(f.database), before);
  });
}

test('work.check describes complete reads separately from unresolved acceptance', async t => {
  const f = await fixture(t);
  const project = 'project:read-completeness';
  const intent = 'knowledge:read-completeness';
  await f.create(project, 'project', { roots: [f.root] }, project);
  await f.create(intent, 'knowledge', { intent: { version: 1, brief: 'Prove the requested outcome',
    user_reference: 'operator request', requirements: [{ id: 'R1', text: 'Finish the work',
      acceptance: 'Current evidence demonstrates it' }], boundaries: [], non_goals: [] } }, project);
  const before = await readFile(f.database);
  const check = await f.cli(['work', 'check', intent, '--cwd', f.root]);
  assert.equal(check.value.ok, true, JSON.stringify(check.value));
  assert.equal(check.value.data.complete, true);
  assert.equal(check.value.data.ready_to_review, false);
  assert.ok(check.value.data.issues.length > 0);
  const help = await f.cli(['work', 'check', '--help']);
  const guidance = help.value.data.operations.find(item => item.id === 'work.check').guidance.limits;
  assert.match(guidance, /complete.*read|read.*complete/i);
  assert.match(guidance, /ready_to_review/);
  assert.deepEqual(await readFile(f.database), before);
});

test('Manager empty-intent instructions lead to typed creation help and a fresh selectable intent', async t => {
  const f = await fixture(t), project = 'project:guidance', id = 'knowledge:guided-intent';
  await f.create(project, 'project', { roots: [f.root] }, project);
  const loader = path.join(f.root, 'loader.exe'), config = path.join(f.root, 'interfaces.json');
  await writeFile(loader, 'fixture loader placeholder');
  await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), loader,
    runtime: { node: process.execPath, cli: fileURLToPath(new URL('../lodestar.mjs', import.meta.url)), database: f.database } }));
  const selection = await loadInterfaceConfig(config);
  const discovery = await executeCli(selection, { operation: 'help', args: ['--help'] });
  const operations = discovery.envelope.data.operations;
  const put = operations.find(item => item.id === 'put'), check = operations.find(item => item.id === 'work.check');
  assert.deepEqual(put.argv, ['put']);
  assert.equal(put.effect, 'record_write');
  assert.deepEqual(check.record_schema.required, ['intent']);
  const before = await readFile(f.database), calls = [], visits = new Map();
  let output = '', afterCreation = null;
  const ask = async question => {
    if (question.startsWith('Run this read?')) return 'no';
    const title = output.trimEnd().split('\n').filter(line => line && !line.startsWith('  ')).at(-1);
    const turn = (visits.get(title) ?? 0) + 1; visits.set(title, turn);
    if (title === `${project} (${project})`) return [null, '11', '12', '11', '12'][turn] ?? 'q';
    if (title === 'Main menu') return [null, '4', '1', '9'][turn] ?? 'q';
    if (title === 'Commands') return turn === 1 ? String(operations.indexOf(put) + 1)
      : turn === 2 ? String(operations.indexOf(check) + 1) : String(operations.length + 1);
    if (title === 'Projects, including recorded historical entries') {
      if (turn > 1) return '2';
      assert.deepEqual(await readFile(f.database), before, 'empty state and Commands mutated the store');
      assert.match(output, /No current intent.*knowledge/);
      assert.match(output, /Main menu > Commands/);
      const helpArgs = JSON.parse(output.match(/Typed help arguments: (\[[^\n]+\])/)[1]);
      assert.deepEqual(helpArgs, ['--db', f.database, ...put.argv, '--help']);
      const typed = spawnSync(selection.node, [selection.cli, ...helpArgs], { encoding: 'utf8', timeout: 20000 });
      assert.equal(typed.status, 0, typed.stderr || typed.stdout);
      const typedPut = JSON.parse(typed.stdout).data.operations.find(item => item.id === 'put');
      assert.ok(typedPut.input_schema.oneOf.some(item => item.properties.mode.const === 'create'));
      assert.match(output, /"record_schema"/);
      const start = await f.cli(['start', '--cwd', f.root]), missing = await f.cli(['get', '--', id]);
      assert.equal(start.code, 0, JSON.stringify(start.value));
      assert.equal(missing.value.error.code, 'record_not_found');
      const request = { v: 5, request_id: `guidance-${randomUUID()}`,
        write_basis: combineReadBases([start.value, missing.value]), input: { mode: 'create', record: {
          id, kind: 'knowledge', name: 'Guided intent', scope: project, availability: 'known',
          data: { intent: { version: 1, brief: 'Create the requested intent', user_reference: 'operator request',
            requirements: [{ id: 'R1', text: 'Read this intent', acceptance: 'Inspect its current check' }], boundaries: [], non_goals: [] } },
          aliases: [], links: [], sources: [], semantics: { lifecycle: 'current', context_role: 'orientation',
            basis: 'asserted', applicability: { project, checkout: f.root } }
        } } };
      const requestFile = path.join(f.root, 'request.json'); await writeFile(requestFile, JSON.stringify(request));
      const created = await executeCli(selection, { operation: 'put', args: [...put.argv, '--file', requestFile], effect: put.effect });
      assert.equal(created.kind, 'EnvelopeSuccess', JSON.stringify(created));
      assert.equal(created.envelope.data.id, id);
      afterCreation = await readFile(f.database);
      return '1';
    }
    return 'q';
  };
  await runManager({ selection, initialProject: project, initialCwd: f.root, ask,
    io: { stdout: { write: value => { output += value; } }, stdin: {} },
    execute: async (binding, invocation) => { calls.push(invocation); return executeCli(binding, invocation); } });
  assert.ok(afterCreation, 'the guided public creation path was not exercised');
  assert.ok(calls.some(call => call.operation === 'work.check' && call.args.at(-1) === id),
    'reopening Intent / continuity did not refresh and select the new intent');
  assert.ok(calls.every(call => call.effect === undefined || call.effect === 'read'), 'Manager dispatched a write');
  assert.deepEqual(await readFile(f.database), afterCreation, 'refreshed selection mutated the store');
});
