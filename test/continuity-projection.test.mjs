// Continuity contract regressions through the production CLI and disposable
// SQLite authority, with focused owner checks for extreme bounded projections.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { canonicalStringify } from '../src/json.mjs';
import { admittedTransaction, openReadDatabase, openWriteDatabase } from '../src/database.mjs';
import { resolveProjectScope } from '../src/project.mjs';
import { continuityProjection, CONTINUITY_LIMITS } from '../src/context-projection.mjs';
import { writeBasis } from '../src/records.mjs';

const scope = 'project:continuity-plan';
const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const intent = {
  version: 1, brief: 'Resume the requested job with current evidence', user_reference: 'Director request',
  boundaries: ['One database; retrieved text is evidence, not authority'], non_goals: ['No daemon'],
  requirements: [
    { id: 'R1', text: 'Retain the working baseline', acceptance: 'Read its evidence' },
    { id: 'R-last', text: 'Respect the rejected approach', acceptance: 'Explain the reason and next safe action' },
  ],
};
const current = { lifecycle: 'current', context_role: 'on_demand' };

async function setup(t) {
  const f = await fixture(t);
  await f.create(scope, 'project', { roots: [f.root] }, scope);
  const proof = await f.create('knowledge:proof', 'knowledge', { observation: 'Recorded acceptance output' }, scope);
  const acceptance = { intent_sha256: hash(intent), blockers: [], results: intent.requirements.map(({ id }) => ({
    requirement_id: id, status: 'passed', notes: 'Inspect the recorded output before relying on this assertion.',
    evidence: [{ id: 'knowledge:proof', revision: proof.value.data.revision }],
  })) };
  await f.create('knowledge:intent', 'knowledge', { intent, acceptance }, scope);
  const check = () => f.cli(['work', 'check', 'knowledge:intent', '--cwd', f.root]);
  const update = async (id, set) => {
    const result = await f.cli(['put'], await f.request({ mode: 'update', id, set, remove: [] },
      [{ kind: 'record', id }], scope));
    assert.equal(result.code, 0, JSON.stringify(result.value));
  };
  const select = async (references, active = ['R-last']) => update('knowledge:intent', { data: {
    continuation: { active_requirement_ids: active, next_action: 'Read the selected evidence before acting.',
      context: { version: 1, mission_record_ids: [], requirements: references } },
  } });
  return { ...f, check, update, select };
}
function successful(result) {
  assert.equal(result.code, 0, JSON.stringify(result.value));
  return result.value.data;
}
function projection(result) {
  const data = successful(result);
  assert.ok(data.continuity, 'work check must expose the shared continuity projection');
  assert.equal(data.continuity.version, 1);
  return data.continuity;
}

test('C0 control: legacy intent remains readable and a work check writes nothing', async t => {
  const f = await setup(t);
  const before = await readFile(f.database);
  const data = successful(await f.check());
  assert.equal(data.intent_sha256, hash(intent));
  assert.equal(data.ready_to_review, true);
  assert.deepEqual(await readFile(f.database), before);
});

test('C1: current orientation rejection survives without new association metadata', async t => {
  const f = await setup(t);
  await f.create('rejection:daemon', 'rejection', { reason: 'An idle daemon adds system impact',
    reconsider_when: 'The Director explicitly changes the one-shot requirement' }, scope,
  { ...current, context_role: 'orientation' });
  const before = await readFile(f.database);
  const p = projection(await f.check());
  assert.ok(p.records.some(r => r.id === 'rejection:daemon' && r.data.reason.includes('system impact')));
  assert.deepEqual(await readFile(f.database), before);
});

test('C2: adding retrieval associations does not invalidate the approved intent or acceptance', async t => {
  const f = await setup(t);
  await f.create('research:next', 'research', { finding: 'Use the existing owner' }, scope, current);
  await f.select([{ id: 'R-last', record_ids: ['research:next'] }]);
  const before = await readFile(f.database);
  const result = await f.check();
  const data = successful(result);
  assert.equal(data.intent_sha256, hash(intent));
  assert.equal(data.ready_to_review, true);
  assert.ok(projection(result).records.some(r => r.id === 'research:next'));
  assert.deepEqual(await readFile(f.database), before);
});

test('C3: stable active ID selects the last requirement and excludes unrelated branch references', async t => {
  const f = await setup(t);
  await f.create('research:other', 'research', { finding: 'Unrelated first branch' }, scope, current);
  await f.create('research:active', 'research', { finding: 'Needed by the active last branch' }, scope, current);
  await f.select([{ id: 'R1', record_ids: ['research:other'] }, { id: 'R-last', record_ids: ['research:active'] }]);
  const p = projection(await f.check());
  assert.deepEqual(p.active_requirement_ids, ['R-last']);
  assert.ok(p.records.some(r => r.id === 'research:active'));
  assert.ok(!p.records.some(r => r.id === 'research:other'));
});

test('C4: missing and foreign records remain unresolved with exact public follow-up reads', async t => {
  const f = await setup(t);
  await f.create('research:foreign', 'research', { finding: 'Another project' }, 'project:other', current);
  await f.select([{ id: 'R-last', record_ids: ['research:missing', 'research:foreign'] }]);
  const p = projection(await f.check());
  assert.equal(p.complete, false);
  assert.ok(!p.records.some(r => r.id === 'research:foreign'));
  for (const id of ['research:missing', 'research:foreign']) {
    const read = p.read_required.find(r => r.target_id === id);
    assert.ok(read, `Missing unresolved reference ${id}`);
    assert.deepEqual(read.read_args, ['get', '--', id]);
    assert.ok(read.action.length > 0);
    // Reading can diagnose the mismatch; it cannot confer project applicability.
    const result = await f.cli(read.read_args);
    assert.equal(result.value.operation, 'get');
  }
});

test('C5: explicit dependency closure includes a late dependency once and terminates a cycle', async t => {
  const f = await setup(t);
  for (const id of ['research:a', 'research:b', 'research:c'])
    await f.create(id, 'research', { finding: id }, scope, current);
  await f.update('research:a', { links: [{ relationship: 'requires', to_id: 'research:b' }] });
  await f.update('research:b', { links: [{ relationship: 'depends-on', to_id: 'research:c' }] });
  await f.update('research:c', { links: [{ relationship: 'requires', to_id: 'research:a' }] });
  await f.select([{ id: 'R-last', record_ids: ['research:a'] }]);
  const checked = await f.check(), p = projection(checked);
  for (const id of ['research:a', 'research:b', 'research:c'])
    assert.equal(p.records.filter(r => r.id === id).length, 1, id);
  assert.equal(p.complete, true);
  await f.update('research:c', { data: { finding: 'Changed dependency evidence' } });
  const stale = await f.cli(['put'], { v: 5, request_id: 'dependency-context-guard', write_basis: checked.value.data.write_basis,
    input: { mode: 'update', id: 'knowledge:intent', set: { data: { continuation: { active_requirement_ids: [], next_action: 'Inspect changed dependency' } } }, remove: [] } });
  assert.equal(stale.value.error?.code, 'revision_conflict');
});

test('C6: unrelated record writes do not change the semantic continuity projection', async t => {
  const f = await setup(t);
  await f.create('research:active', 'research', { finding: 'Useful stable evidence' }, scope, current);
  await f.select([{ id: 'R-last', record_ids: ['research:active'] }]);
  const before = projection(await f.check());
  await f.create('knowledge:noise', 'knowledge', { note: 'Unrelated activity' }, 'global');
  assert.deepEqual(projection(await f.check()), before);
});

test('C7: unsupported association version names the exact field and safe correction', async t => {
  const f = await setup(t);
  await f.update('knowledge:intent', { data: { continuation: {
    active_requirement_ids: ['R-last'], next_action: 'Preserve this record for correction',
    context: { version: 99, mission_record_ids: [], requirements: [] },
  } } });
  const before = await readFile(f.database);
  const result = await f.check();
  assert.notEqual(result.code, 0);
  assert.equal(result.value.error.code, 'invalid_intent_contract');
  assert.equal(result.value.error.identifiers.pointer, '/data/continuation/context/version');
  assert.match(result.value.error.action, /checked put/i);
  assert.deepEqual(await readFile(f.database), before);
});

test('C8: typed help exposes the optional continuation context schema', async t => {
  const f = await setup(t);
  const operations = successful(await f.cli(['--help'])).operations;
  const schema = operations.find(o => o.id === 'work.check').record_schema;
  assert.equal(schema.properties.intent.properties.version.const, 1);
  assert.equal(schema.properties.continuation.properties.context.properties.version.const, 1);
  assert.deepEqual(schema.properties.continuation.required, ['active_requirement_ids', 'next_action']);
});

test('context rejects malformed association shapes with exact correction pointers and no writes', async t => {
  const f = await setup(t);
  const valid = { version: 1, mission_record_ids: [], requirements: [] };
  for (const [context, pointer] of [
    [null, '/data/continuation/context'],
    [{ ...valid, extra: true }, '/data/continuation/context'],
    [{ ...valid, mission_record_ids: ['x', 'x'] }, '/data/continuation/context/mission_record_ids'],
    [{ ...valid, mission_record_ids: ['bad\nrecord'] }, '/data/continuation/context/mission_record_ids/0'],
    [{ ...valid, requirements: [{ id: 'missing', record_ids: [] }] }, '/data/continuation/context/requirements/0/id'],
    [{ ...valid, requirements: [{ id: 'R1', record_ids: [] }, { id: 'R1', record_ids: [] }] }, '/data/continuation/context/requirements/1/id'],
    [{ ...valid, requirements: [{ id: 'R1', record_ids: null }] }, '/data/continuation/context/requirements/0/record_ids'],
  ]) {
    await f.update('knowledge:intent', { data: { continuation: { active_requirement_ids: [], next_action: 'Inspect', context } } });
    const before = await readFile(f.database), result = await f.check();
    assert.equal(result.value.error.code, 'invalid_intent_contract');
    assert.equal(result.value.error.identifiers.pointer, pointer);
    assert.equal(result.value.error.identifiers.id, 'knowledge:intent');
    assert.deepEqual(await readFile(f.database), before);
  }
});

test('explicit empty active branch preserves mission references and excludes requirement references', async t => {
  const f = await setup(t);
  for (const id of ['research:mission', 'research:branch']) await f.create(id, 'research', { finding: id }, scope, current);
  await f.update('knowledge:intent', { data: { continuation: { active_requirement_ids: [], next_action: 'Review mission',
    context: { version: 1, mission_record_ids: ['research:mission'], requirements: [{ id: 'R1', record_ids: ['research:branch'] }] } } } });
  const p = projection(await f.check());
  assert.deepEqual(p.active_requirement_ids, []);
  assert.deepEqual(p.records.map(r => r.id), ['research:mission']);
  assert.equal(p.complete, true);
});

test('scope and checkout admission applies on dependencies while scoped global records remain useful', async t => {
  const f = await setup(t);
  await f.create('research:global', 'research', { finding: 'Shared applicable evidence' }, 'global',
    { ...current, applicability: { project: scope, checkout: null } });
  await f.create('research:foreign', 'research', { finding: 'Foreign' }, 'project:other', current);
  const checkout = `${f.root.replaceAll('\\', '/')}/another-checkout`;
  const checkoutRequest = await f.request({ mode: 'create', record: { id: 'research:checkout', kind: 'research', name: 'Checkout evidence',
    data: { finding: 'Different checkout' }, scope, availability: 'known', aliases: [], links: [], sources: [],
    semantics: { ...current, basis: 'asserted', applicability: { project: scope, checkout } } } }, [{ kind: 'record', id: 'research:checkout' }], scope);
  checkoutRequest.checkout = checkout;
  assert.equal((await f.cli(['put'], checkoutRequest)).code, 0);
  await f.create('research:root', 'research', { finding: 'Root' }, scope, current);
  await f.update('research:root', { links: ['research:global', 'research:foreign', 'research:checkout']
    .map(to_id => ({ relationship: 'requires', to_id })) });
  await f.select([{ id: 'R-last', record_ids: ['research:root'] }]);
  const p = projection(await f.check());
  assert.ok(p.records.some(r => r.id === 'research:global'));
  assert.ok(!p.records.some(r => ['research:foreign', 'research:checkout'].includes(r.id)));
  assert.ok(p.issues.some(i => i.code === 'context_scope_mismatch'));
  assert.ok(p.issues.some(i => i.code === 'context_checkout_mismatch'));
});

test('retirement and stale availability stay unresolved without changing acceptance readiness', async t => {
  const f = await setup(t);
  await f.create('rejection:retired', 'rejection', { reason: 'Old route' }, scope,
    { lifecycle: 'superseded', context_role: 'on_demand' });
  await f.create('research:stale', 'research', { finding: 'Unrefreshed' }, scope, current);
  await f.update('research:stale', { availability: 'stale' });
  await f.select([{ id: 'R-last', record_ids: ['rejection:retired', 'research:stale'] }]);
  const result = await f.check(), p = projection(result);
  assert.equal(successful(result).ready_to_review, true);
  assert.ok(p.issues.some(i => i.code === 'context_record_retired'));
  assert.ok(p.issues.some(i => i.code === 'context_record_unavailable'));
});

async function decide(f, input, extraTargets = []) {
  const key = input.key ?? 'lodestar:agent-decision-presentation';
  const result = await f.cli(['decision', input.key ? 'set' : 'inject', '--cwd', f.root],
    await f.request(input, [{ kind: 'decision', scope, key }, ...extraTargets], scope));
  assert.equal(result.code, 0, JSON.stringify(result.value));
  return result.value.data.record;
}

test('selected obsolete decision resolves through replay and guards current heads with literal reads', async t => {
  const f = await setup(t);
  const old = await decide(f, { key: 'route; unicode 音', value: 'old', status: 'accepted', reason: 'Original approach' });
  const latest = await decide(f, { key: 'route; unicode 音', value: 'new', status: 'accepted', reason: 'Current approach',
    direction: { kind: 'user', attribution: 'asserted', reference: 'Current Director request', instruction: 'Use new' } });
  await f.select([{ id: 'R-last', record_ids: [old.id] }]);
  const result = await f.check(), p = projection(result);
  assert.equal(p.records.some(r => r.kind === 'decision-event'), false);
  assert.equal(p.decisions[0].resolution, 'current');
  assert.equal(p.decisions[0].current.event_id, latest.id);
  assert.equal(p.decisions[0].current.direction.attribution, 'asserted');
  const read = p.read_required.find(r => r.code === 'context_decision_superseded');
  assert.deepEqual(read.read_args, ['decision', 'show', '--cwd', f.root.replaceAll('\\', '/'), '--', 'route; unicode 音']);
  assert.equal((await f.cli(read.read_args)).code, 0);
  assert.ok(result.value.data.write_basis.targets.some(t => t.kind === 'decision' && t.key === 'route; unicode 音'));
  assert.ok(result.value.data.write_basis.targets.some(t => t.kind === 'record' && t.id === latest.id));
  // A relevant head advance must invalidate the projection's existing guard.
  const basis = result.value.data.write_basis;
  await decide(f, { key: 'route; unicode 音', value: 'newer', status: 'accepted', reason: 'Further change',
    direction: { kind: 'user', attribution: 'asserted', reference: 'New request', instruction: 'Use newer' } });
  const stale = await f.cli(['put'], { v: 5, request_id: 'stale-continuity-guard', write_basis: basis,
    input: { mode: 'update', id: 'knowledge:intent', set: { data: { continuation: { active_requirement_ids: [], next_action: 'Review' } } }, remove: [] } });
  assert.equal(stale.value.error.code, 'revision_conflict');
});

test('injection preference hides agent decisions without inventing current authority', async t => {
  const f = await setup(t);
  const event = await decide(f, { key: 'agent-route', value: 'agent choice', status: 'accepted', reason: 'Agent assertion' });
  await decide(f, { include_agent_decisions: false });
  await f.select([{ id: 'R-last', record_ids: [event.id] }]);
  const result = await f.check(), p = projection(result);
  assert.equal(p.decisions[0].resolution, 'unavailable');
  assert.equal(p.decisions[0].current, null);
  assert.ok(result.value.data.write_basis.targets.some(t => t.key === 'lodestar:agent-decision-presentation'));
});

test('oversized non-ASCII records keep whole IDs and truthful bounded follow-up reads', async t => {
  const f = await setup(t);
  const id = 'research:巨大;literal';
  await f.create(id, 'research', { finding: '音'.repeat(50000) }, scope, current);
  await f.select([{ id: 'R-last', record_ids: [id] }]);
  const p = projection(await f.check());
  assert.equal(p.truncated, true);
  assert.equal(p.complete, false);
  assert.ok(Buffer.byteLength(canonicalStringify(p), 'utf8') <= CONTINUITY_LIMITS.bytes);
  assert.equal(p.limits.serialized_bytes, Buffer.byteLength(canonicalStringify(p), 'utf8'));
  assert.ok(p.read_required.some(r => r.target_id === id && r.read_args[2] === id));
  assert.equal((await f.cli(p.read_required.find(r => r.target_id === id).read_args)).code, 0);
});

test('wide unresolved associations inspect no more than the node bound and disclose unknown coverage', async t => {
  const f = await setup(t);
  const ids = Array.from({ length: 300 }, (_, i) => `research:missing-${i}`);
  await f.select([{ id: 'R-last', record_ids: ids }]);
  const result = await f.check(), p = projection(result);
  assert.equal(p.limits.inspected_nodes, CONTINUITY_LIMITS.nodes);
  assert.ok(p.limits.inspected_edges <= CONTINUITY_LIMITS.edges);
  assert.equal(p.omitted.deeper_count_unknown, true);
  assert.equal(p.truncated, true);
  assert.ok(p.read_required.some(r => r.target_id === 'knowledge:intent'));
  assert.ok(Buffer.byteLength(canonicalStringify(p), 'utf8') <= CONTINUITY_LIMITS.bytes);
});

test('historical scope is admitted explicitly and active descendants carry deduplicated selection reasons', async t => {
  const f = await setup(t);
  await f.create('research:historical-scope', 'research', { finding: 'Still current after scope reconciliation' }, 'project:previous', current);
  const db = await openReadDatabase(f.database);
  try {
    const project = { ...resolveProjectScope(db, scope, f.root), historical_scopes: ['project:previous'] };
    const plan = { requirements: [{ id: 'parent', parent_id: null, child_ids: ['child'] }, { id: 'child', parent_id: 'parent', child_ids: [] }] };
    const p = continuityProjection(db, project, { contract: { id: 'knowledge:intent', links: [] }, plan,
      actual: { requirements: [] }, delta: { requirements: [{ id: 'parent', subtree_ready_to_review: false }, { id: 'child', subtree_ready_to_review: false }] },
      continuation: { active_requirement_ids: ['parent'], context: { mission_record_ids: ['research:historical-scope'],
        requirements: [{ id: 'child', record_ids: ['research:historical-scope'] }] } } }).projection;
    assert.equal(p.complete, true);
    assert.deepEqual(p.records[0].selection, { reasons: ['mission', 'requirement'], requirement_ids: ['child'], order: 0, reason: 'selected_branch' });
  } finally { db.close(); }
});

test('wide edges remain bounded independently of node limit and repeated reads create no mutation', async t => {
  const f = await setup(t);
  await f.create('research:wide', 'research', { finding: 'Wide dependencies' }, scope, current);
  const db = await openWriteDatabase(f.database);
  try {
    admittedTransaction(db, () => {
      const statement = db.prepare("INSERT INTO records(id,type,name,scope,content_json,created_at,updated_at) SELECT ?,type,?,scope,content_json,created_at,updated_at FROM records WHERE id='research:wide'");
      for (let index = 0; index < 1030; index++) statement.run(`research:edge-${index}`, `research:edge-${index}`);
    }, f.database);
  } finally { db.close(); }
  await f.update('research:wide', { links: Array.from({ length: 1030 }, (_, i) => ({ relationship: 'requires', to_id: `research:edge-${i}` })) });
  await f.select([{ id: 'R-last', record_ids: ['research:wide'] }]);
  const before = await readFile(f.database), first = await f.check(), p = projection(first);
  assert.equal(p.limits.inspected_edges, CONTINUITY_LIMITS.edges);
  assert.ok(p.limits.inspected_nodes <= CONTINUITY_LIMITS.nodes);
  assert.ok(p.issues.some(i => i.code === 'continuity_edge_limit'));
  assert.equal(p.truncated, true);
  assert.deepEqual(projection(await f.check()), p);
  assert.deepEqual(await readFile(f.database), before);
  await f.select([], []);
  await f.update('knowledge:intent', { links: Array.from({ length: 1030 }, (_, i) => ({ relationship: 'requires', to_id: `research:edge-${i}` })) });
  const intentEdges = projection(await f.check());
  assert.equal(intentEdges.limits.inspected_edges, CONTINUITY_LIMITS.edges, 'intent dependency edges share the same declared bound');
  assert.ok(intentEdges.issues.some(i => i.code === 'continuity_edge_limit'));
});

test('recorded stale source remains explicit unresolved evidence with its body preserved', async t => {
  const f = await setup(t);
  await f.create('research:source-stale', 'research', { finding: 'Needs source refresh' }, scope, current);
  await f.update('research:source-stale', { sources: [{ origin: 'external:source', freshness: 'stale',
    metadata: { kind: 'external_observation', relation: 'supporting_evidence', evidence_ref: 'upstream',
      observed_at: '2026-10-01T00:00:00.000Z' } }] });
  await f.select([{ id: 'R-last', record_ids: ['research:source-stale'] }]);
  const p = projection(await f.check());
  assert.equal(p.complete, false);
  assert.ok(p.issues.some(i => i.code === 'context_source_stale'));
  assert.ok(p.records.some(r => r.id === 'research:source-stale' && r.sources[0].freshness === 'stale'));
});

test('byte accounting includes its own final metadata and omits oversized active lists explicitly', async t => {
  const f = await setup(t);
  await f.create('research:near-bound', 'research', { finding: '' }, scope, current);
  await f.select([{ id: 'R-last', record_ids: ['research:near-bound'] }]);
  const initial = projection(await f.check());
  await f.update('research:near-bound', { data: { finding: 'x'.repeat(CONTINUITY_LIMITS.bytes - initial.limits.serialized_bytes - 1) } });
  const p = projection(await f.check());
  assert.ok(Buffer.byteLength(canonicalStringify(p), 'utf8') <= CONTINUITY_LIMITS.bytes);
  const db = await openReadDatabase(f.database);
  try {
    const ids = Array.from({ length: 3000 }, (_, i) => `R${i}-${'a'.repeat(60)}`);
    const wide = continuityProjection(db, resolveProjectScope(db, scope, f.root), {
      contract: { id: 'knowledge:intent', links: [] }, plan: { requirements: ids.map(id => ({ id, parent_id: null, child_ids: [] })) },
      actual: { requirements: [] }, delta: { requirements: [] }, continuation: { active_requirement_ids: ids } }).projection;
    assert.ok(Buffer.byteLength(canonicalStringify(wide), 'utf8') <= CONTINUITY_LIMITS.bytes);
    assert.equal(wide.active_requirement_ids_omitted, ids.length);
    assert.ok(wide.read_required.some(r => r.target_id === 'knowledge:intent'));
    assert.equal(wide.truncated, true);
  } finally { db.close(); }
});

test('late shared-decision relevance and byte-omission reads retain all requirement IDs', async t => {
  const f = await setup(t);
  const event = await decide(f, { key: 'shared', value: 'chosen', status: 'accepted', reason: 'Useful route' });
  await f.create('research:chain', 'research', { finding: 'Later branch' }, scope, current);
  await f.update('research:chain', { links: [{ relationship: 'requires', to_id: event.id }] });
  await f.select([{ id: 'R1', record_ids: [event.id] }, { id: 'R-last', record_ids: ['research:chain'] }], ['R1', 'R-last']);
  const p = projection(await f.check());
  assert.deepEqual(p.decisions[0].selection.requirement_ids, ['R-last', 'R1'].sort());
  await f.create('research:large', 'research', { finding: '音'.repeat(50000) }, scope, current);
  await f.select([{ id: 'R-last', record_ids: ['research:large'] }]);
  const read = projection(await f.check()).read_required.find(r => r.target_id === 'research:large');
  assert.deepEqual(read.requirement_ids, ['R-last']);
});

test('malformed context preserves the source-correction guidance instead of generic restoration advice', async t => {
  const f = await setup(t);
  await f.create('research:damaged', 'research', { finding: 'Corrupt this fixture' }, scope, current);
  await f.select([{ id: 'R-last', record_ids: ['research:damaged'] }]);
  const db = await openWriteDatabase(f.database);
  try { admittedTransaction(db, () => {
    const row = db.prepare('SELECT content_json FROM records WHERE id=?').get('research:damaged');
    db.prepare('UPDATE records SET content_json=? WHERE id=?').run(row.content_json.replace('"Corrupt this fixture"', '9007199254740993'), 'research:damaged');
  }, f.database); } finally { db.close(); }
  const sourceError = (await f.cli(['get', '--', 'research:damaged'])).value.error;
  const p = projection(await f.check()), issue = p.issues.find(i => i.identifiers.id === 'research:damaged');
  assert.equal(issue.action, sourceError.action);
  assert.equal(issue.message, sourceError.message);
  assert.equal(issue.identifiers.pointer, sourceError.identifiers.pointer);
});

test('selected decisions track status and drop without resurrecting historical values', async t => {
  const f = await setup(t);
  const event = await decide(f, { key: 'lifecycle', value: 'chosen', status: 'accepted', reason: 'Initial route' });
  await f.select([{ id: 'R-last', record_ids: [event.id] }]);
  for (const [action, state] of [['status', 'blocked'], ['drop', 'dead']]) {
    const result = await f.cli(['decision', action, '--cwd', f.root], await f.request({ key: 'lifecycle', status: state, reason: 'Observed lifecycle change' },
      [{ kind: 'decision', scope, key: 'lifecycle' }], scope));
    assert.equal(result.code, 0);
    const p = projection(await f.check());
    if (action === 'status') {
      assert.equal(p.decisions[0].resolution, 'current');
      assert.equal(p.decisions[0].current.status, 'blocked');
    } else {
      assert.equal(p.decisions[0].resolution, 'unavailable');
      assert.equal(p.decisions[0].current, null);
    }
  }
});

test('corrupt later decision event blocks a confident replayed current choice', async t => {
  const f = await setup(t);
  const prior = await decide(f, { key: 'corrupt-stream', value: 'old', status: 'accepted', reason: 'Prior valid event' });
  const latest = await decide(f, { key: 'corrupt-stream', value: 'new', status: 'accepted', reason: 'Damaged later event' });
  await f.select([{ id: 'R-last', record_ids: [prior.id] }]);
  const db = await openWriteDatabase(f.database);
  try { admittedTransaction(db, () => {
    const row = db.prepare('SELECT content_json FROM records WHERE id=?').get(latest.id);
    db.prepare('UPDATE records SET content_json=? WHERE id=?').run(row.content_json.replace('"Damaged later event"', '9007199254740993'), latest.id);
  }, f.database); } finally { db.close(); }
  const p = projection(await f.check());
  assert.equal(p.decisions[0].resolution, 'unavailable');
  assert.equal(p.decisions[0].current, null);
  const issue = p.issues.find(i => i.code === 'context_decision_unreadable');
  assert.match(issue.action, /original source/);
  assert.ok(p.read_required.some(r => r.target_id === latest.id && r.read_args[1] === '--raw'));
});

test('selected historical decisions guard every admitted head, including previously absent choices', async t => {
  const f = await setup(t);
  const previousScope = 'project:previous-decision', previousRoot = `${f.root.replaceAll('\\', '/')}/previous`;
  await f.create(previousScope, 'project', { roots: [previousRoot] }, previousScope);
  const historicalDecision = async (key, value) => {
    const request = await f.request({ key, value, status: 'accepted', reason: 'Historical scope choice' },
      [{ kind: 'decision', scope: previousScope, key }], previousScope);
    request.checkout = previousRoot;
    const result = await f.cli(['decision', 'set', '--cwd', previousRoot], request);
    assert.equal(result.code, 0, JSON.stringify(result.value));
    return result.value.data.record;
  };
  const prior = await historicalDecision('history-selected', 'old');
  const canonical = await decide(f, { key: 'absent-historical', value: 'canonical', status: 'accepted', reason: 'Current scope choice' });
  for (const [selected, key, nextValue, resolution] of [
    [prior, 'history-selected', 'new', 'current'],
    [canonical, 'absent-historical', 'new conflict', 'current'],
  ]) {
    const db = await openReadDatabase(f.database);
    let basis;
    try {
      const project = { ...resolveProjectScope(db, scope, f.root), cwd: f.root.replaceAll('\\', '/'), historical_scopes: [previousScope] };
      const context = continuityProjection(db, project, { contract: { id: 'knowledge:intent', links: [] },
        plan: { requirements: [{ id: 'R1', parent_id: null, child_ids: [] }] }, actual: { requirements: [] },
        delta: { requirements: [] }, continuation: { active_requirement_ids: ['R1'],
          context: { mission_record_ids: [selected.id], requirements: [] } } });
      assert.equal(context.projection.decisions[0].resolution, resolution);
      basis = writeBasis(db, { projectScope: scope, checkout: f.root,
        targets: [{ kind: 'record', id: 'knowledge:intent' }, ...context.targets] });
    } finally { db.close(); }
    await historicalDecision(key, nextValue);
    const stale = await f.cli(['put'], { v: 5, request_id: `historical-guard-${key}`, write_basis: basis,
      input: { mode: 'update', id: 'knowledge:intent', set: { data: { continuation: { active_requirement_ids: [], next_action: 'Inspect heads' } } }, remove: [] } });
    assert.equal(stale.value.error?.code, 'revision_conflict', JSON.stringify(stale.value));
    assert.ok(basis.targets.some(target => target.kind === 'decision' && target.scope === previousScope && target.key === key));
    if (key === 'absent-historical') {
      const currentDb = await openReadDatabase(f.database);
      try {
        const context = continuityProjection(currentDb, { ...resolveProjectScope(currentDb, scope, f.root), cwd: f.root.replaceAll('\\', '/'), historical_scopes: [previousScope] }, {
          contract: { id: 'knowledge:intent', links: [] }, plan: { requirements: [{ id: 'R1', parent_id: null, child_ids: [] }] },
          actual: { requirements: [] }, delta: { requirements: [] }, continuation: { active_requirement_ids: ['R1'],
            context: { mission_record_ids: [selected.id], requirements: [] } } });
        assert.equal(context.projection.decisions[0].resolution, 'conflict');
        assert.equal(context.projection.decisions[0].current, null);
        assert.equal(context.projection.decisions[0].candidates.length, 2);
        assert.ok(context.projection.read_required.some(read => read.code === 'context_decision_conflict'));
      } finally { currentDb.close(); }
    }
  }
});
