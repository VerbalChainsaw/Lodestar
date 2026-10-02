import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';

test('published guided capture draft and literal read recipes run through the public CLI', async t => {
  const docs = await readFile(new URL('../docs/operator-recipes.md', import.meta.url), 'utf8');
  const section = docs.split('## Project attention and guided capture')[1].split('## Exact invocation')[0];
  const json = [...section.matchAll(/```json\s*([\s\S]*?)```/gu)].map(match => JSON.parse(match[1]));
  const attentionArgs = json.find(value => Array.isArray(value) && value.includes('attention'));
  const prepareArgs = json.find(value => Array.isArray(value) && value.includes('prepare-capture'));
  const draft = json.find(value => !Array.isArray(value) && value.stage === 'create');
  assert.ok(attentionArgs && prepareArgs && draft, 'The executable recipe must expose its draft and literal reads.');
  const f = await fixture(t), scope = 'project:guided-recipe';
  await f.create(scope, 'project', { roots: [f.root] }, scope);
  await f.create(draft.intent_record_id, 'knowledge', {
    intent: { version: 1, brief: 'Retain the focused observation', user_reference: 'Disposable recipe check',
      requirements: [{ id: 'R1', text: 'Inspect the focused result', acceptance: 'Review the saved observation and its limits.' }],
      boundaries: ['One authority'], non_goals: [] },
    continuation: { active_requirement_ids: ['R1'], next_action: 'Review the focused observation' },
  }, scope);
  const draftFile = path.join(f.root, 'draft.json');
  await writeFile(draftFile, JSON.stringify(draft));
  const substitutions = { '<database>': f.database, '<project-root>': f.root,
    '<intent-id>': draft.intent_record_id, '<draft.json>': draftFile };
  const args = values => values.map(value => substitutions[value] ?? value).slice(2);
  const hash = async () => createHash('sha256').update(await readFile(f.database)).digest('hex');
  const before = await hash();
  const attention = await f.cli(args(attentionArgs));
  assert.equal(attention.code, 0, JSON.stringify(attention.value));
  assert.equal(attention.value.operation, 'work.attention');
  const prepared = await f.cli(args(prepareArgs));
  assert.equal(prepared.code, 0, JSON.stringify(prepared.value));
  assert.equal(prepared.value.request, null);
  assert.equal(await hash(), before, 'Attention and preparation must make no database writes.');
  const created = await f.cli(['put'], { v: 5, request_id: 'recipe-create',
    write_basis: prepared.value.data.write_basis, input: prepared.value.data.input });
  assert.equal(created.code, 0, JSON.stringify(created.value));
  const saved = await f.cli(['get', '--', draft.record.id]);
  assert.equal(saved.code, 0);
  assert.equal(saved.value.data.data.result.observed_outcome, 'passed');
  const afterCreate = await hash();
  await writeFile(draftFile, JSON.stringify({ version: 1, stage: 'associate',
    intent_record_id: draft.intent_record_id, author: draft.author, record_id: draft.record.id,
    context_target: { kind: 'requirements', requirement_ids: ['R1'] } }));
  const association = await f.cli(args(prepareArgs));
  assert.equal(association.code, 0, JSON.stringify(association.value));
  assert.equal(await hash(), afterCreate, 'Canceled preparation must keep the saved record and perform no second write.');
  const attached = await f.cli(['put'], { v: 5, request_id: 'recipe-associate',
    write_basis: association.value.data.write_basis, input: association.value.data.input });
  assert.equal(attached.code, 0, JSON.stringify(attached.value));
  const intent = await f.cli(['get', '--', draft.intent_record_id]);
  assert.deepEqual(intent.value.data.data.continuation.context.requirements,
    [{ id: 'R1', record_ids: [draft.record.id] }]);
  assert.equal(Object.hasOwn(intent.value.data.data, 'acceptance'), false,
    'A passed observation must not infer an acceptance assessment.');
});
