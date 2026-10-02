import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';

const success = result => { assert.equal(result.code, 0, JSON.stringify(result.value)); return result.value; };
const noBasis = value => {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.hasOwn(value, 'write_basis'), false);
  for (const nested of Object.values(value)) noBasis(nested);
};
async function record(f, id, { name = id, body = 'alpha beta', aliases = [], ...extra } = {}) {
  const request = await f.request({ mode: 'create', record: { id, kind: 'knowledge', name,
    scope: 'global', availability: 'known', data: { body }, aliases, links: [], sources: [], ...extra } },
  [{ kind: 'record', id }]);
  success(await f.cli(['put'], request));
}

test('compact find keeps exact literal reads and unchanged full/default results without DB writes', async t => {
  const f = await fixture(t);
  await record(f, '--help', { body: 'alpha '.repeat(20000) });
  const bytes = await readFile(f.database);
  const full = success(await f.cli(['find', '--', '--help']));
  const explicit = success(await f.cli(['find', '--match', 'contains', '--', '--help']));
  assert.deepEqual(explicit, full);
  const compact = success(await f.cli(['find', '--compact', '--', '--help']));
  assert.equal(compact.data.projection, 'compact');
  assert.equal(compact.data.complete, true);
  assert.equal(compact.data.requires_full_read, true);
  assert.equal(compact.data.projection_complete, false);
  assert.equal(compact.data.discovery_complete, true);
  assert.equal(compact.data.selected_records, 1); assert.equal(compact.data.displayed_records, 1);
  const row = compact.data.records[0];
  assert.equal(row.id, '--help'); assert.equal(row.revision, full.data.records[0].revision);
  assert.deepEqual(row.read_args, ['get', '--', '--help']);
  assert.equal(row.lifecycle, full.data.records[0].semantics.lifecycle);
  assert.deepEqual(row.applicability, full.data.records[0].semantics.applicability);
  assert.ok(row.match_reasons.includes('exact_id'));
  assert.ok(row.omitted_fields.includes('data')); assert.equal(row.data, undefined);
  assert.ok(row.snippet.length <= 240); noBasis(compact.data);
  assert.equal(row.snippet_truncated, true); assert.ok(row.snippet_omitted_characters > 0);
  const read = success(await f.cli(row.read_args));
  assert.deepEqual(read, success(await f.cli(['get', '--', '--help'])));
  assert.ok(Buffer.byteLength(JSON.stringify(compact.data)) <= 24000);
  assert.deepEqual(await readFile(f.database), bytes);
});

test('compact find caps rows and bytes, reports oversized IDs honestly, and preserves stable paging flags', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 23; i++) await record(f, `knowledge:${String(i).padStart(2, '0')}`);
  await record(f, 'knowledge:zz' + 'x'.repeat(30000));
  const bytes = await readFile(f.database);
  const first = success(await f.cli(['find', '--compact', '--match', 'terms', '--explain', '--history', '--kind', 'knowledge', '--scope', 'global', 'beta alpha']));
  assert.equal(first.data.records.length, 20); assert.equal(first.more, true);
  const continuation = first.next[0].args;
  for (const flag of ['--compact', '--match', '--explain', '--history', '--kind', '--scope', '--at-revision']) assert.ok(continuation.includes(flag));
  const second = success(await f.cli(['find', ...continuation]));
  assert.equal(second.more, false); assert.equal(second.data.records.length, 3);
  assert.equal(second.data.omitted_records, 1);
  assert.equal(second.data.selected_records, 4); assert.equal(second.data.displayed_records, 3);
  assert.equal(second.data.discovery_complete, false); assert.equal(second.data.projection_complete, false);
  assert.deepEqual(second.data.full_read_args.slice(0, 1), ['find']);
  assert.equal(second.data.full_read_args.includes('--compact'), false);
  assert.equal(second.data.records.some(row => row.id.includes('zz')), false);
  assert.ok(Buffer.byteLength(JSON.stringify(second.data)) <= 24000);
  const oversized = success(await f.cli(second.data.full_read_args));
  assert.equal(oversized.data.records.at(-1).id.length, 30012);
  assert.deepEqual(await readFile(f.database), bytes);
  const capped = success(await f.cli(['find', '--all', '--kind', 'knowledge', '--compact', '--limit', '500']));
  assert.ok(capped.data.records.length <= 20); assert.equal(capped.more, true);
});

test('terms matches reordered Unicode words and aliases across fields with deterministic explanations', async t => {
  const f = await fixture(t);
  await record(f, 'knowledge:one', { name: 'ÉCOLE', body: 'cafe\u0301 river', aliases: ['BETA'] });
  await record(f, 'knowledge:two', { body: 'river alone' });
  assert.equal(success(await f.cli(['find', 'river café'])).data.records.length, 0);
  const terms = success(await f.cli(['find', '--match', 'terms', '--explain', 'RIVER CAFÉ école beta']));
  assert.deepEqual(terms.data.records.map(row => row.id), ['knowledge:one']);
  assert.deepEqual(terms.data.match_policy, { normalization: 'NFC', case: 'Unicode toLowerCase', combination: 'AND', maximum_terms: 16, synonyms: false });
  assert.ok(terms.data.records[0].match_reasons.includes('alias_terms'));
  assert.ok(terms.data.records[0].match_reasons.includes('body_terms'));
  await record(f, 'knowledge:unicode-snippet', { body: 'e\u0301'.repeat(1000) + ' uniquelyRelevantTerm' });
  const snippet = success(await f.cli(['find', '--compact', '--match', 'terms', 'uniquelyRelevantTerm']));
  assert.match(snippet.data.records[0].snippet, /uniquelyRelevantTerm/iu);
  const reversed = success(await f.cli(['find', '--match', 'terms', 'beta école CAFÉ RIVER']));
  assert.deepEqual(reversed.data.records.map(row => row.id), ['knowledge:one']);
  const decomposed = success(await f.cli(['find', '--match', 'terms', 'cafe\u0301 e\u0301cole river beta']));
  assert.deepEqual(decomposed.data.records.map(row => row.id), ['knowledge:one']);
  const explained = success(await f.cli(['find', '--explain', 'BETA']));
  assert.ok(explained.data.records[0].match_reasons.includes('exact_alias'));
  for (const args of [['--match', 'unknown', 'alpha'], ['--all', '--match', 'terms'], ['--match', 'terms', '   '], ['--match', 'terms', Array.from({length:17}, (_,i)=>`t${i}`).join(' ')]]) {
    const invalid = await f.cli(['find', ...args]);
    assert.notEqual(invalid.code, 0); assert.equal(invalid.value.error.code, 'invalid_input'); assert.ok(invalid.value.error.action);
  }
  const empty = success(await f.cli(['find', '--compact', '--match', 'terms', 'missing synonym']));
  assert.equal(empty.data.complete, true); assert.equal(empty.more, false); assert.deepEqual(empty.data.records, []);
  assert.equal(empty.data.match_status, 'no_matches'); assert.equal(empty.data.discovery_complete, true);
  assert.equal(empty.data.selected_records, 0); assert.equal(empty.data.displayed_records, 0);
});

test('compact start checks full native sources and dependencies while explicitly requiring full instructions', async t => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  await f.create('knowledge:orientation', 'knowledge', { body: 'massive '.repeat(20000) }, 'project:test', { context_role: 'orientation', lifecycle: 'current' });
  await writeFile(path.join(f.root, 'AGENTS.md'), 'Apply native rule. '.repeat(12000));
  const bytes = await readFile(f.database);
  const full = success(await f.cli(['start', '--cwd', f.root, '--harness', 'codex']));
  const compact = success(await f.cli(['start', '--cwd', f.root, '--harness', 'codex', '--compact']));
  assert.equal(compact.data.complete, full.data.complete);
  assert.equal(compact.data.required_complete, full.data.required_complete);
  assert.equal(compact.data.instructions_complete, false); assert.equal(compact.data.requires_full_start, true);
  assert.equal(compact.data.projection_complete, false);
  assert.deepEqual(compact.data.full_read_args, ['start', '--cwd', f.root, '--harness', 'codex']);
  assert.ok(compact.data.omitted_fields.includes('operating_guide'));
  assert.equal(compact.data.required[0].text, undefined);
  assert.equal(compact.data.required[0].status, full.data.required[0].status);
  assert.ok(compact.data.required[0].omitted_fields.includes('text'));
  assert.equal(compact.data.context[0].data, undefined); noBasis(compact.data);
  assert.ok(Buffer.byteLength(JSON.stringify(compact.data)) <= 24000);
  assert.deepEqual(await readFile(f.database), bytes);
  await f.create('config:lodestar:sources', 'config', { instruction_sources: [{ id: 'required', kind: 'instruction', locator: path.join(f.root, 'missing'), required: true }], catalog_sources: [], skill_source_roots: [] });
  const missing = success(await f.cli(['start', '--cwd', f.root, '--compact']));
  assert.equal(missing.data.complete, false); assert.equal(missing.data.required_complete, false);
  assert.equal(missing.data.required.find(source => source.id === 'required').status, 'missing');
});

test('typed help exposes compact, explain and match policy in shared declarations', async t => {
  const f = await fixture(t);
  const find = success(await f.cli(['find', '--help'])).data;
  const op = find.operations.find(({ id }) => id === 'find');
  for (const name of ['compact', 'explain', 'match']) assert.ok(op.parameters.some(p => p.name === name));
  assert.deepEqual(op.parameters.find(p => p.name === 'match').schema.enum, ['contains', 'terms']);
  const start = success(await f.cli(['start', '--help'])).data.operations.find(({ id }) => id === 'start');
  assert.ok(start.parameters.some(p => p.name === 'compact'));
  assert.ok(op.cli_inputs.constraints.some(value => value.includes('24000') && value.includes('20')));
  assert.ok(op.cli_inputs.constraints.some(value => value.includes('--all') && value.includes('terms')));
  assert.ok(start.cli_inputs.constraints.some(value => value.includes('full start')));
});

test('compact bounds oversized queries and exact start identities without inventing read arrays', async t => {
  const f = await fixture(t);
  const query = 'needle' + 'z'.repeat(9000);
  await record(f, 'knowledge:huge-query', { body: query + '😀'.repeat(1000), name: 'n'.repeat(15000) });
  const found = success(await f.cli(['find', '--compact', '--', query]));
  assert.equal(found.data.complete, true); assert.equal(found.data.omitted_records, 1);
  assert.equal(found.data.full_read_args, undefined);
  assert.ok(found.data.omitted_fields.includes('full_read_args'));
  assert.ok(found.data.omitted_fields.includes('query'));
  assert.equal(found.data.discovery_complete, false);
  assert.match(found.data.required_action, /--args-file.*--args-stdin/u);
  assert.ok(Buffer.byteLength(JSON.stringify(found.data)) <= 24000);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  await f.create('knowledge:huge-orientation', 'knowledge', { body: '😀'.repeat(20000) }, 'project:test', { context_role: 'orientation', lifecycle: 'current' });
  const start = success(await f.cli(['start', '--cwd', f.root, '--topic', query, '--compact']));
  assert.equal(start.data.full_read_args, undefined);
  assert.ok(start.data.omitted_fields.includes('full_read_args'));
  assert.equal(start.data.instructions_complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(start.data)) <= 24000);
});

test('compact retains source checks and source-correction errors and rejects a stale continuation', async t => {
  const f = await fixture(t);
  await record(f, 'knowledge:source', { sources: [{ origin: 'fixture:source', freshness: 'current', metadata: {
    kind: 'local_file', relation: 'supporting_evidence', locator: { base: 'absolute', path: path.join(f.root, 'missing.txt') },
    fingerprint: { algorithm: 'sha256', value: '0'.repeat(64), bytes: 0 },
    observed_at: '2026-09-30T00:00:00.000Z' } }] });
  await record(f, '-h');
  const damaged = new DatabaseSync(f.database);
  damaged.function('lodestar_write_contract', () => 5);
  damaged.prepare("UPDATE records SET content_json=json_remove(content_json, '$._lodestar.semantics') WHERE id=?").run('-h');
  damaged.close();
  const before = await readFile(f.database);
  const full = success(await f.cli(['find', '--all', '--kind', 'knowledge']));
  const compact = success(await f.cli(['find', '--all', '--kind', 'knowledge', '--compact']));
  assert.equal(compact.data.complete, false);
  assert.equal(compact.data.discovery_complete, false);
  assert.equal(compact.data.selected_records, 2); assert.equal(compact.data.displayed_records, 1);
  assert.deepEqual(compact.data.record_errors, full.data.record_errors);
  const row = compact.data.records.find(row => row.id === 'knowledge:source');
  assert.equal(row.claim_status, 'needs_reinspection');
  assert.deepEqual(row.source_status_counts, { missing: 1 });
  const corrected = success(await f.cli(compact.data.record_errors[0].identifiers.raw_read_args));
  assert.equal(corrected.data.raw_record.id, '-h');
  assert.deepEqual(await readFile(f.database), before);
  const first = success(await f.cli(['find', '--all', '--kind', 'knowledge', '--compact', '--limit', '1']));
  await record(f, 'knowledge:new');
  const stale = await f.cli(['find', ...first.next[0].args]);
  assert.notEqual(stale.code, 0); assert.equal(stale.value.error.code, 'read_revision_conflict');
});

test('compact start retains dependency failures and reports omitted orientation rows', async t => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  await f.create('knowledge:retired', 'knowledge', { text: 'old' }, 'project:test', { lifecycle: 'historical', context_role: 'on_demand' });
  for (let i = 0; i < 23; i++) await f.create(`knowledge:${i}`, 'knowledge', { text: 'selected' }, 'project:test', { context_role: 'orientation', lifecycle: 'current' });
  const request = await f.request({ mode: 'update', id: 'knowledge:0', set: { links: [{ relationship: 'requires', to_id: 'knowledge:retired' }] }, remove: [] },
    [{ kind: 'record', id: 'knowledge:0' }], 'project:test');
  success(await f.cli(['put'], request));
  const full = success(await f.cli(['start', '--cwd', f.root]));
  const compact = success(await f.cli(['start', '--cwd', f.root, '--compact']));
  assert.equal(compact.data.complete, false);
  assert.deepEqual(compact.data.record_errors, full.data.record_errors);
  assert.ok(compact.data.context.length <= 20); assert.equal(compact.data.omitted_records, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(compact.data)) <= 24000);
});
