import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { normalizeMachinePath } from '../src/project.mjs';
const actor = { id: 'agent:one', agent: 'agent', session: 'one', harness: 'test' };

test('Windows and WSL path dialects normalize to one project path', () => {
  assert.equal(normalizeMachinePath('c:\\Project\\Repo\\'), 'C:/Project/Repo');
  assert.equal(normalizeMachinePath('/mnt/c/Project/Repo'), 'C:/Project/Repo');
});

test('automatic context selects orientation, scoped global dependencies, and complete topic matches', async (t) => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  await f.create('fact:needed', 'fact', { text: 'complete '.repeat(10000) }, 'project:test');
  await f.create('fact:orientation', 'fact', { command: 'npm test' }, 'project:test', { context_role: 'orientation', lifecycle: 'current' });
  const update = await f.request({ mode: 'update', id: 'fact:orientation', set: { links: [{ relationship: 'depends-on', to_id: 'fact:needed' }] }, remove: [] },
    [{ kind: 'record', id: 'fact:orientation' }], 'project:test');
  assert.equal((await f.cli(['put'], update)).code, 0);
  const start = await f.cli(['start', '--cwd', f.root]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.deepEqual(start.value.data.context.map(({ id }) => id), ['fact:orientation', 'fact:needed']);
  assert.equal(start.value.data.context[1].data.text.length, 90000);
  const topic = await f.cli(['start', '--cwd', f.root, '--topic', 'needed']);
  assert.equal(topic.value.data.context.filter(({ id }) => id === 'fact:needed').length, 1);
});

test('work outcomes are advisory, atomic, evidence-aware, and do not treat age as success', async (t) => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  const change = async (action, input) => f.cli(['work', action, '--cwd', f.root], await f.request(input,
    [{ kind: 'record', id: 'work:one' }, { kind: 'record', id: 'project:test' }], 'project:test', actor));
  assert.equal((await change('start', { id: 'work:one', description: 'Repair package' })).code, 0);
  const status = await f.cli(['work', 'status', '--cwd', f.root]);
  assert.equal(status.value.data.advisory, true);
  const report = { id: 'work:one', action_id: 'package:build', description: 'Build completed', outcome: 'completed' };
  assert.equal((await change('done', report)).code, 0);
  assert.equal((await change('done', report)).value.data.changed, false);
  assert.notEqual((await change('report', { ...report, outcome: 'verified' })).code, 0);
  const verified = await change('report', { ...report, outcome: 'verified', evidence: ['test:package-install'] });
  assert.equal(verified.code, 0, JSON.stringify(verified.value));
  const work = await f.cli(['get', 'work:one']);
  const event = await f.cli(['get', work.value.data.data.last_event_id]);
  assert.equal(work.value.data.revision, event.value.data.revision);
  assert.equal(event.value.data.data.outcome, 'verified');
  assert.equal((await f.cli(['work', 'history', '--cwd', f.root])).value.data.records.filter(({ kind }) => kind === 'work-event').length, 2);
});

test('catalog reconciliation is read-only, preserves local fields, and never treats omission as deletion', async (t) => {
  const f = await fixture(t);
  const catalog = path.join(f.root, 'projects.json');
  await f.create('project:test', 'project', { roots: [f.root], local_note: 'keep this' }, 'project:test');
  await f.create('config:lodestar:sources', 'config', { instruction_sources: [], skill_source_roots: [], catalog_sources: [
    { id: 'authored-projects', kind: 'project_catalog', locator: catalog, source_owned_fields: ['name', 'path', 'aliases', 'description'] }] });
  await writeFile(catalog, JSON.stringify({ projects: [{ name: 'Test project', path: f.root, aliases: ['Test'], description: 'Authored description' }] }));
  const bytes = await readFile(f.database);
  const start = await f.cli(['start', '--cwd', f.root]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  const preview = start.value.data.catalog[0];
  assert.equal(preview.status, 'reconciliation_available');
  assert.deepEqual(await readFile(f.database), bytes);
  const applied = await f.cli(['put'], { v: 5, request_id: 'catalog-first', write_basis: preview.write_basis, input: preview.input });
  assert.equal(applied.code, 0, JSON.stringify(applied.value));
  assert.equal(applied.value.data.data.local_note, 'keep this');
  assert.equal((await f.cli(['start', '--cwd', f.root])).value.data.catalog[0].status, 'unchanged');
  await writeFile(catalog, JSON.stringify({ projects: [] }));
  assert.equal((await f.cli(['start', '--cwd', f.root])).value.data.catalog[0].status, 'source_entry_missing');
  assert.equal((await f.cli(['get', 'project:test'])).value.data.data.local_note, 'keep this');
});

test('a missing required source is explicit and never substituted with packaged private rules', async (t) => {
  const f = await fixture(t);
  await f.create('config:lodestar:sources', 'config', { instruction_sources: [
    { id: 'required', kind: 'instruction', locator: path.join(f.root, 'missing.md'), required: true }], catalog_sources: [], skill_source_roots: [] });
  const result = await f.cli(['start', '--cwd', f.root]);
  assert.equal(result.code, 0);
  assert.equal(result.value.data.required_complete, false);
  assert.equal(result.value.data.required.find(({ id }) => id === 'required').status, 'missing');
  assert.ok(result.value.data.required.every((source) => source.text === undefined));
});