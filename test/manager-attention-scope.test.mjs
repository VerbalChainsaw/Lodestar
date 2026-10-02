import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { loadInterfaceConfig } from '../src/interface-config.mjs';
import { executeCli } from '../src/interface-client.mjs';
import { runManager } from '../src/manager.mjs';

const scope = 'project:manager-attention';
const historical = 'project:manager-before';
const unrelated = 'project:unrelated';
const intent = { version: 1, brief: 'Read the full selected project inventory', user_reference: 'Manager scope regression',
  requirements: [{ id: 'R1', text: 'Recover omitted intents', acceptance: 'Read each owned project scope' }], boundaries: [], non_goals: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const option = (menu, text) => menu.split('\n').find(line => line.includes(`. ${text}`))?.match(/^\s*(\d+)\./)?.[1] ?? 'q';
const fullRead = selectedScope => ['find', '--all', '--scope', selectedScope, '--kind', 'knowledge'];

async function setup(t, withHistory = true, malformedHistory = false) {
  const f = await fixture(t);
  await f.create(scope, 'project', { roots: [f.root] }, scope);
  if (withHistory) await f.create(historical, 'project', { roots: [path.join(f.root, 'old')] }, historical);
  for (let index = 0; index < 21; index++) await f.create(`knowledge:intent-${String(index).padStart(2, '0')}`,
    'knowledge', { intent }, withHistory && index > 0 ? historical : scope,
    { lifecycle: 'current', context_role: 'on_demand' });
  if (malformedHistory) await f.create('knowledge:malformed-history', 'knowledge', { intent: { version: 99 } }, historical,
    { lifecycle: 'current', context_role: 'on_demand' });
  if (withHistory) {
    const changed = await f.cli(['put'], await f.request({ mode: 'update', id: historical,
      set: { data: { canonical_project_id: scope }, links: [{ relationship: 'canonical-project', to_id: scope }] }, remove: [] },
    [{ kind: 'record', id: historical }, { kind: 'record', id: scope }], historical));
    assert.equal(changed.code, 0, JSON.stringify(changed.value));
  }
  const config = path.join(f.root, 'interfaces.json');
  await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), runtime: {
    node: process.execPath, cli: fileURLToPath(new URL('../lodestar.mjs', import.meta.url)), database: f.database } }));
  return { f, selection: await loadInterfaceConfig(config, { requireLoader: false }) };
}

async function journey(s, { mutate = () => {}, pickScopes = [scope, historical], beforeFollowup = () => {},
  selectedIntent = 'knowledge:intent-00', surface = 'Project attention', openContinuity = false } = {}) {
  let output = '', prompts = 0, opened = false, next = 0, continuityOpened = false;
  const calls = [], results = [];
  const before = await readFile(s.f.database);
  const code = await runManager({ selection: s.selection, initialProject: scope, initialCwd: s.f.root,
    io: { stdout: { write: text => { output += text; } }, stdin: {} },
    ask: async () => {
      assert.ok(++prompts < 40, output);
      const title = output.trimEnd().split('\n').filter(line => line && !line.startsWith('  ')).at(-1);
      const menu = output.slice(output.lastIndexOf(`\n${title}`));
      if (title === `${scope} (${scope})`) { if (opened) return 'q'; opened = true; return option(menu, surface); }
      if (title === 'Select attention intent' || title === 'Select current intent') return option(menu, selectedIntent);
      if (title === 'Project attention actions') {
        if (openContinuity && !continuityOpened) { continuityOpened = true; return option(menu, 'Intent / continuity'); }
        if (next >= pickScopes.length) return 'q';
        const chosen = pickScopes[next++];
        beforeFollowup(chosen);
        const line = menu.split('\n').find(value => value.includes(chosen) && value.includes('find'));
        return line?.match(/^\s*(\d+)\./)?.[1]
          ?? (pickScopes.length === 1 && chosen === scope ? option(menu, 'Full intent inventory') : 'q');
      }
      return 'q';
    }, execute: async (selection, invocation) => {
      calls.push({ operation: invocation.operation, args: invocation.args, effect: invocation.effect ?? 'read' });
      const result = await executeCli(selection, invocation);
      mutate(result, invocation);
      results.push({ operation: invocation.operation, args: invocation.args, kind: result.kind,
        envelope: result.envelope });
      return result;
    } });
  const after = await readFile(s.f.database);
  const evidence = { code, output, calls, results, database_bytes_unchanged: before.equals(after),
    database_sha256_before: digest(before), database_sha256_after: digest(after) };
  assert.equal(code, 0, output);
  assert.deepEqual(after, before);
  assert.ok(calls.every(call => call.effect === 'read'), 'Attention journey dispatched a write');
  return evidence;
}

async function save(name, evidence) {
  if (!process.env.MANAGER_SCOPE_EVIDENCE) return;
  await mkdir(process.env.MANAGER_SCOPE_EVIDENCE, { recursive: true });
  await writeFile(path.join(process.env.MANAGER_SCOPE_EVIDENCE, `${name}.json`), JSON.stringify(evidence, null, 2));
}

test('Manager Attention full inventory dispatches current and historical literal reads through actual CLI', async t => {
  const s = await setup(t);
  const actual = await s.f.cli(['work', 'attention', '--cwd', s.f.root, '--', 'knowledge:intent-00']);
  assert.equal(actual.value.v, 5);
  assert.equal(actual.value.data.intent_inventory.complete, false);
  assert.deepEqual(actual.value.data.intent_inventory.read_args.map(args => args[3]).sort(), [scope, historical].sort());
  const evidence = await journey(s);
  await save('historical-full-read', evidence);
  const inventories = evidence.results.filter(result => result.operation === 'find' && result.args.includes('--scope'));
  assert.deepEqual(inventories.map(result => result.args[3]).sort(), [scope, historical].sort(), evidence.output);
  const recovered = new Set();
  for (const result of inventories) {
    assert.equal(result.kind, 'EnvelopeSuccess');
    assert.equal(result.envelope.v, 5);
    assert.equal(result.envelope.data.complete, true);
    for (const row of result.envelope.data.records) recovered.add(row.id);
  }
  assert.equal(recovered.size, 21);
});

test('Manager Attention retains the flat single-scope inventory read contract', async t => {
  const s = await setup(t, false), evidence = await journey(s, { pickScopes: [scope] });
  await save('single-scope', evidence);
  assert.ok(evidence.calls.some(call => JSON.stringify(call.args) === JSON.stringify(fullRead(scope))), evidence.output);
});

test('Manager Attention rejects an unrelated literal inventory scope', async t => {
  const s = await setup(t), evidence = await journey(s, { pickScopes: [unrelated], mutate: (result, invocation) => {
    if (invocation.operation !== 'work.attention' || result.kind !== 'EnvelopeSuccess') return;
    result.envelope.data.intent_inventory.read_args.push(fullRead(unrelated));
    result.envelope.data.read_required.push({ code: 'injected-unrelated-read', read_args: fullRead(unrelated) });
  } });
  await save('unrelated-literal', evidence);
  assert.ok(!evidence.calls.some(call => call.operation === 'find' && call.args.includes(unrelated)));
  assert.match(evidence.output, /Unsupported attention read/);
});

test('Manager Attention cannot expand verified project scopes using altered Attention identity', async t => {
  const s = await setup(t), evidence = await journey(s, { pickScopes: [unrelated], mutate: (result, invocation) => {
    if (invocation.operation !== 'work.attention' || result.kind !== 'EnvelopeSuccess') return;
    result.envelope.data.project.historical_scopes.push(unrelated);
    result.envelope.data.intent_inventory.read_args.push(fullRead(unrelated));
  } });
  await save('unrecognized-identity', evidence);
  assert.match(evidence.output, /missing, malformed or unsupported metadata/);
  assert.ok(!evidence.calls.some(call => call.operation === 'find' && call.args.includes(unrelated)));
});

test('Manager Attention rechecks historical scope membership before dispatch', async t => {
  const s = await setup(t); let removeHistory = false;
  const evidence = await journey(s, { pickScopes: [historical], beforeFollowup: () => { removeHistory = true; },
    mutate: (result, invocation) => {
      if (removeHistory && invocation.operation === 'start' && result.kind === 'EnvelopeSuccess') {
        result.envelope.data.project.historical_scopes = [scope];
      }
    } });
  await save('dispatch-revalidation', evidence);
  assert.equal(removeHistory, true);
  assert.ok(!evidence.calls.some(call => call.operation === 'find' && call.args.includes(historical)));
  assert.match(evidence.output, /follow-up blocked.*scope/i);
});

test('Manager selects an owner-admitted historical intent and opens its actual Attention view', async t => {
  const s = await setup(t), selectedIntent = 'knowledge:intent-01';
  const actual = await s.f.cli(['work', 'attention', '--cwd', s.f.root]);
  assert.ok(actual.value.data.intents.some(row => row.id === selectedIntent));
  const evidence = await journey(s, { selectedIntent, pickScopes: [] });
  await save('historical-selection', evidence);
  const selected = evidence.results.find(result => result.operation === 'work.attention');
  assert.equal(selected?.envelope.data.selected_intent_id, selectedIntent, evidence.output);
  assert.notEqual(selected.envelope.data.sections.acceptance.state, 'unavailable');
  assert.ok(evidence.calls.some(call => call.operation === 'work.check' && call.args.at(-1) === selectedIntent));
});

test('Manager preserves owner diagnostics when a historical intent candidate fails admission', async t => {
  const s = await setup(t, true, true), selectedIntent = 'knowledge:malformed-history';
  const evidence = await journey(s, { selectedIntent, pickScopes: [] });
  await save('historical-malformed', evidence);
  const checked = evidence.results.find(result => result.operation === 'work.check');
  assert.equal(checked?.kind, 'EnvelopeError', evidence.output);
  assert.equal(checked.envelope.error.code, 'invalid_intent_contract');
  assert.match(evidence.output, /invalid_intent_contract/);
  assert.equal(evidence.results.find(result => result.operation === 'work.attention')?.envelope.data.selected_intent_id, null);
});

for (const openContinuity of [false, true]) test(`Manager historical Intent / continuity opens through ${openContinuity ? 'Attention actions' : 'project menu'}`, async t => {
  const s = await setup(t), selectedIntent = 'knowledge:intent-01';
  const advertised = await s.f.cli(['work', 'attention', '--cwd', s.f.root]);
  assert.ok(advertised.value.data.intents.some(row => row.id === selectedIntent));
  const evidence = await journey(s, { selectedIntent, pickScopes: [], openContinuity,
    surface: openContinuity ? 'Project attention' : 'Intent / continuity' });
  await save(`historical-continuity-${openContinuity ? 'attention' : 'direct'}`, evidence);
  assert.ok(evidence.output.includes(`Intent ${selectedIntent} · project ${scope}`), evidence.output);
  assert.match(evidence.output, /RECORDED CONTEXT COVERAGE: selection resolved/);
  assert.ok(evidence.results.some(result => result.operation === 'work.check' && result.args.at(-1) === selectedIntent &&
    result.kind === 'EnvelopeSuccess' && result.envelope.v === 5));
});

test('Manager continuity revalidation rejects a historical record outside verified scope membership', async t => {
  const s = await setup(t), selectedIntent = 'knowledge:intent-01';
  const evidence = await journey(s, { selectedIntent, pickScopes: [], surface: 'Intent / continuity',
    mutate: (result, invocation) => {
      if (invocation.operation === 'get' && invocation.args.at(-1) === selectedIntent && result.kind === 'EnvelopeSuccess') {
        result.envelope.data.scope = unrelated;
      }
    } });
  await save('continuity-unrelated-revalidation', evidence);
  assert.match(evidence.output, /Selected intent is no longer current and readable in this project/);
  assert.ok(!evidence.calls.some(call => call.operation === 'work.check'));
});
