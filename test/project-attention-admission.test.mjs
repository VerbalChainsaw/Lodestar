import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { admittedTransaction, openWriteDatabase } from '../src/database.mjs';

const scope = 'project:attention-admission';
const historicalScope = 'project:attention-before';
const current = { lifecycle: 'current', context_role: 'on_demand' };
const intent = { version: 1, brief: 'Exercise admitted project attention', user_reference: 'Focused attention contract',
  requirements: [{ id: 'R1', text: 'Select a supported intent', acceptance: 'Run its literal work check' }],
  boundaries: [], non_goals: [] };
const ok = response => {
  assert.equal(response.code, 0, JSON.stringify(response.value));
  return response.value.data;
};
const argumentLists = args => args.every(token => typeof token === 'string') ? [args] : args;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function setup(t) {
  const f = await fixture(t);
  await f.create(scope, 'project', { roots: [f.root] }, scope);
  await f.create(historicalScope, 'project', { roots: [path.join(f.root, 'historical')] }, historicalScope);
  const rebind = async () => ok(await f.cli(['put'], await f.request({ mode: 'update', id: historicalScope,
    set: { data: { canonical_project_id: scope }, links: [{ relationship: 'canonical-project', to_id: scope }] },
    remove: [],
  }, [{ kind: 'record', id: historicalScope }, { kind: 'record', id: scope }], historicalScope)));
  return { ...f, rebind };
}

test('attention offers only owner-admissible intents and preserves malformed candidate gaps', async t => {
  const f = await setup(t);
  await f.create('knowledge:current', 'knowledge', { intent }, scope, current);
  await f.create('knowledge:historical-scope', 'knowledge', { intent }, historicalScope, current);
  // inspectWorkIntent admits by record scope; checkout applicability does not narrow that contract.
  await f.create('knowledge:other-checkout', 'knowledge', { intent }, scope, current);
  const checkoutDb = await openWriteDatabase(f.database);
  try { admittedTransaction(checkoutDb, () => checkoutDb.prepare(
    "UPDATE records SET content_json=json_set(content_json,'$._lodestar.semantics.applicability.checkout',?) WHERE id=?")
    .run(path.join(f.root, 'other-checkout'), 'knowledge:other-checkout'), f.database); }
  finally { checkoutDb.close(); }
  await f.create('knowledge:global-applicable', 'knowledge', { intent }, 'global',
    { ...current, applicability: { project: scope, checkout: null } });
  await f.create('knowledge:bad-intent', 'knowledge', { intent: { version: 99 } }, historicalScope, current);
  await f.create('knowledge:bad-data', 'knowledge', { intent, unrelated: true }, scope, current);
  await f.create('knowledge:retired', 'knowledge', { intent }, scope, { ...current, lifecycle: 'historical' });
  await f.rebind();
  const before = await readFile(f.database);
  const attention = ok(await f.cli(['work', 'attention', '--cwd', f.root]));
  assert.deepEqual(attention.intents.map(row => row.id),
    ['knowledge:current', 'knowledge:historical-scope', 'knowledge:other-checkout']);
  for (const row of attention.intents) {
    ok(await f.cli(['work', 'check', '--cwd', f.root, '--', row.id]));
    const selected = ok(await f.cli(['work', 'attention', '--cwd', f.root, '--', row.id]));
    assert.notEqual(selected.sections.acceptance.state, 'unavailable', row.id);
  }
  const global = await f.cli(['work', 'check', '--cwd', f.root, '--', 'knowledge:global-applicable']);
  assert.equal(global.value.error.code, 'invalid_intent_contract');
  assert.equal(attention.intent_inventory.complete, false);
  assert.deepEqual(attention.intent_inventory.issues.map(issue => issue.identifiers.id),
    ['knowledge:bad-data', 'knowledge:bad-intent']);
  for (const id of ['knowledge:bad-data', 'knowledge:bad-intent']) {
    const read = attention.read_required.find(row => row.target_id === id);
    assert.ok(read, `Malformed candidate ${id} must remain inspectable`);
    assert.equal(ok(await f.cli(read.read_args)).id, id);
  }
  assert.deepEqual(await readFile(f.database), before);
  console.log(JSON.stringify({ attention_admission: attention.intents.map(row => row.id),
    candidate_gaps: attention.intent_inventory.issues.map(row => row.identifiers.id),
    bytes_unchanged: true, database_sha256: digest(before) }));
});

test('attention overflow literal reads recover every admitted current and historical-scope intent', async t => {
  const f = await setup(t), admitted = [];
  for (let index = 0; index < 24; index++) {
    const id = `knowledge:intent-${String(index).padStart(2, '0')}`;
    admitted.push(id);
    await f.create(id, 'knowledge', { intent }, index % 2 ? historicalScope : scope, current);
  }
  await f.rebind();
  const before = await readFile(f.database);
  const attention = ok(await f.cli(['work', 'attention', '--cwd', f.root]));
  assert.equal(attention.intents.length, 20);
  assert.equal(attention.intent_inventory.more, true);
  assert.equal(attention.intent_inventory.omitted_count, 4);
  const reads = argumentLists(attention.intent_inventory.read_args);
  assert.deepEqual(reads.map(args => args[3]).sort(), [scope, historicalScope].sort());
  const recovered = new Set();
  for (const args of reads) {
    const full = ok(await f.cli(args));
    assert.equal(full.complete, true);
    for (const record of full.records) recovered.add(record.id);
  }
  for (const id of admitted) assert.ok(recovered.has(id), `Literal full reads omit admitted ${id}`);
  const required = attention.read_required.find(row => row.code === 'attention_intent_inventory_incomplete');
  assert.deepEqual(required.read_args, attention.intent_inventory.read_args);
  assert.deepEqual(attention.sections.acceptance.read_args, attention.intent_inventory.read_args);
  assert.deepEqual(await readFile(f.database), before);
  console.log(JSON.stringify({ attention_overflow: { displayed: 20, omitted: 4, literal_reads: reads,
    recovered: [...recovered].sort(), bytes_unchanged: true, database_sha256: digest(before) } }));
});

test('attention source-correction candidate remains a named raw-read gap', async t => {
  const f = await setup(t);
  await f.create('knowledge:damaged', 'knowledge', { intent }, historicalScope, current);
  await f.rebind();
  const db = await openWriteDatabase(f.database);
  try {
    admittedTransaction(db, () => {
    const row = db.prepare('SELECT content_json FROM records WHERE id=?').get('knowledge:damaged');
    db.prepare('UPDATE records SET content_json=? WHERE id=?').run(
      row.content_json.replace('"Exercise admitted project attention"', '9007199254740993'), 'knowledge:damaged');
    }, f.database);
  } finally { db.close(); }
  const before = await readFile(f.database);
  const attention = ok(await f.cli(['work', 'attention', '--cwd', f.root]));
  assert.equal(attention.intents.length, 0);
  assert.equal(attention.intent_inventory.complete, false);
  assert.equal(attention.intent_inventory.issues[0].identifiers.id, 'knowledge:damaged');
  const required = attention.read_required.find(row => row.target_id === 'knowledge:damaged');
  assert.deepEqual(required.read_args, ['get', '--raw', '--', 'knowledge:damaged']);
  const raw = ok(await f.cli(required.read_args));
  assert.ok(JSON.stringify(raw).includes('9007199254740993'));
  assert.deepEqual(await readFile(f.database), before);
});
