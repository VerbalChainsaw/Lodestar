import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { handleHook } from '../scripts/lodestar-hook.mjs';
import { canonical, authorizePrompt, attestTool, executeHandoff } from '../scripts/lodestar-runtime.mjs';

const entry = process.env.LODESTAR_ENTRY;
assert(entry, 'Set LODESTAR_ENTRY to the core CLI for disposable process integration tests');
const hook = fileURLToPath(new URL('../scripts/lodestar-hook.mjs', import.meta.url));
const core = await import(pathToFileURL(path.join(path.dirname(entry), 'codex-plugin/scripts/lodestar-runtime.mjs')));
const { combineReadBases } = await import(pathToFileURL(path.join(path.dirname(entry), 'src/operator-actions.mjs')));
const { canonicalStringify } = await import(pathToFileURL(path.join(path.dirname(entry), 'src/json.mjs')));
const identity = f => ['--session', f.host.session_id, '--agent', 'codex', '--harness', 'codex'];
async function read(f, args) { return core.runInstalledLodestar(args, { env: f.env }); }
async function put(f, id, data) {
  const start = await read(f, ['start', '--cwd', f.root, ...identity(f)]);
  let exact;
  try { exact = await read(f, ['get', '--', id]); }
  catch (error) { if (error.envelope?.error.code !== 'record_not_found') throw error; exact = error.envelope; }
  const request = { v: 5, request_id: randomUUID(), write_basis: combineReadBases([start, exact]), input: {
    mode: 'create', record: { id, kind: 'knowledge', name: id, scope: start.data.project.scope,
      data, availability: 'known', aliases: [], links: [], sources: [], semantics: {
        lifecycle: 'current', context_role: 'on_demand', basis: 'asserted',
        applicability: { project: start.data.project.scope, checkout: null } } } } };
  return core.runInstalledLodestar(core.mutationCommand('put', request),
    { env: f.env, input: canonical(request), operation: 'put', effect: 'domain_write' });
}
async function decision(f, reason) {
  const basis = await read(f, ['decision', 'show', '--cwd', f.root, '--', 'fixture-route']);
  const request = { v: 5, request_id: randomUUID(), write_basis: basis.data.write_basis,
    input: { key: 'fixture-route', value: 'supported local native lifecycle', reason, status: 'accepted',
      rejected_alternative: 'Invent local hook delivery on cloud orchestration' } };
  return core.runInstalledLodestar([...core.mutationCommand('decision.set', request), ...identity(f)],
    { env: f.env, input: canonical(request), operation: 'decision.set', effect: 'domain_write' });
}
async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'lodestar-compaction-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = { root, data: path.join(root, 'plugin-data'), intent: 'knowledge:synthetic-current-intent',
    host: { session_id: `isolated-fixture-${randomUUID()}`, turn_id: 'fixture-turn-1', cwd: root } };
  f.env = { ...process.env, LODESTAR_NODE: process.execPath, LODESTAR_ENTRY: entry, LODESTAR_DB: path.join(root, 'fixture.db') };
  f.options = { env: f.env, dataDir: f.data };
  await read(f, ['init']);
  await mkdir(path.join(root, '.omx'));
  f.binding = { version: 1, project_root: root, session_id: f.host.session_id, intent_record_id: f.intent,
    database: f.env.LODESTAR_DB };
  await writeFile(path.join(root, '.omx/lodestar-compaction.json'), JSON.stringify(f.binding));
  const route = await decision(f, 'Local-only Codex can deliver the supported native boundary.');
  await put(f, 'knowledge:synthetic-rationale', { choice: 'Checkpoint current intent, not a completed release',
    reason: 'Recovery must retain the current goal and finish gate.' });
  const intent = { version: 1, brief: 'Preserve the synthetic goal through the native compaction adapter.',
    user_reference: 'Isolated test only', requirements: [{ id: 'R1', text: 'Use recovered intent and decision reasons',
      acceptance: 'Completion requires actual local context rebuild evidence; keep it unverified here.' }],
    boundaries: ['No live decisions or trust changes'], non_goals: ['No session rotation'] };
  await put(f, f.intent, { intent, acceptance: {
    intent_sha256: createHash('sha256').update(canonicalStringify(intent)).digest('hex'),
    results: [{ requirement_id: 'R1', status: 'unverified', evidence: [], notes: 'Native live delivery is not yet tested.' }], blockers: [] },
    continuation: { active_requirement_ids: ['R1'], next_action: 'Read the saved reason; verify the real boundary before finishing.',
      context: { version: 1, mission_record_ids: ['knowledge:synthetic-rationale', route.data.record.id], requirements: [] } } });
  return f;
}
const pre = (f, extra = {}) => handleHook({ ...f.host, hook_event_name: 'PreCompact', trigger: 'manual', ...extra }, f.data, f.options);
const start = f => read(f, ['start', '--cwd', f.root, ...identity(f)]);
const resume = f => handleHook({ session_id: f.host.session_id, cwd: f.root, source: 'compact', hook_event_name: 'SessionStart' }, f.data, f.options);
async function journal(f) {
  const folder = path.join(f.data, 'requests');
  const files = await readdir(folder);
  for (const name of files) {
    const file = path.join(folder, name), saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.suffix.startsWith('compact:')) return { file, saved };
  }
  throw new Error('No compaction request journal');
}

// These tests exercise hook/core process integration; they do not dispatch native
// Desktop lifecycle events or establish Desktop host acceptance.
test('hook/core process integration: checkpoint and fresh-process recovery preserve goal, reason and finish gate', async (t) => {
  const f = await fixture(t);
  const result = await pre(f); assert.equal(result.continue, true, result.systemMessage); assert.match(result.systemMessage, /saved/);
  const j = await journal(f); assert.equal(j.saved.state, 'confirmed');
  const record = await read(f, ['get', '--', j.saved.request.input.id]);
  assert.equal(record.data.data.source_actor, `codex:${f.host.session_id}`);
  const ref = record.data.data.checkpoint.references.find(r => r.kind === 'lodestar-work-check');
  assert.equal(ref.projection.delta.ready_to_review, false);
  assert(JSON.stringify(ref.projection.continuity).includes('Local-only Codex can deliver'));
  const before = (await start(f)).revision;
  const processResult = spawnSync(process.execPath, [hook], {
    env: { ...f.env, PLUGIN_DATA: f.data }, encoding: 'utf8', windowsHide: true,
    timeout: 20_000, maxBuffer: 1024 * 1024, input: JSON.stringify({
      session_id: f.host.session_id, cwd: f.root, hook_event_name: 'SessionStart', source: 'compact' }) });
  assert.equal(processResult.error, undefined, processResult.error?.message);
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.equal(processResult.signal, null);
  const output = JSON.parse(processResult.stdout); assert.equal(output.continue, true, output.systemMessage);
  const text = output.hookSpecificOutput.additionalContext;
  assert(text.includes('Preserve the synthetic goal')); assert(text.includes('Local-only Codex can deliver'));
  assert(text.includes('Completion requires actual local context rebuild evidence'));
  assert(text.includes('"ready_to_review":false')); assert(text.length <= 7000);
  assert.equal((await start(f)).revision, before, 'Recovery reads cannot checkpoint or edit records');
});
test('unbound and wrong-session events do nothing; invalid matching binding stops before compaction', async (t) => {
  const f = await fixture(t), before = (await start(f)).revision;
  const bindingFile = path.join(f.root, '.omx/lodestar-compaction.json');
  await unlink(bindingFile);
  assert.deepEqual(await pre(f), { continue: true });
  await writeFile(bindingFile, JSON.stringify(f.binding));
  assert.deepEqual(await pre(f, { session_id: 'other-session' }), { continue: true });
  await writeFile(bindingFile, JSON.stringify({ ...f.binding, database: path.join(path.dirname(f.root), 'outside.db') }));
  const outside = await pre(f); assert.equal(outside.continue, false); assert.match(outside.systemMessage, /inside the bound project/);
  await writeFile(bindingFile, JSON.stringify({ ...f.binding, project_root: path.dirname(f.root) }));
  const result = await pre(f); assert.equal(result.continue, false); assert.match(result.systemMessage, /working directory/);
  assert.equal((await start(f)).revision, before);
});
test('identical semantic checkpoint and unrelated writes create no additional checkpoint receipts', async (t) => {
  const f = await fixture(t); assert.equal((await pre(f)).continue, true);
  const count = (await readdir(path.join(f.data, 'requests'))).length;
  await put(f, 'knowledge:unrelated-fixture-note', { note: 'Not associated with the mission' });
  const before = (await start(f)).revision;
  const result = await pre(f, { turn_id: 'later-turn' }); assert.equal(result.continue, true, result.systemMessage);
  assert.match(result.systemMessage, /unchanged/); assert.equal((await start(f)).revision, before);
  assert.equal((await readdir(path.join(f.data, 'requests'))).length, count);
  const packet = { goal: 'Ordinary intervening handoff', rules: [], entries: [],
    work: {}, nextMove: 'Continue the same intent', evidence: [] };
  const h = { ...f.host, tool_use_id: 'intervening-checkpoint',
    tool_name: 'lodestar_handoff_checkpoint', tool_input: { packet } };
  await authorizePrompt({ ...h, prompt: 'handoff checkpoint' }, f.data);
  const token = await attestTool(h, f.data); assert.equal(token.allowed, true, token.reason);
  await executeHandoff(h.tool_name, token.updatedInput, f.data, f.options);
  const manualRevision = (await start(f)).revision;
  const restored = await pre(f); assert.equal(restored.continue, true, restored.systemMessage);
  const { saved } = await journal(f);
  const current = await read(f, ['get', '--', saved.request.input.id]);
  assert(current.data.data.checkpoint.references.some(r => r.kind === 'lodestar-work-check'),
    'A repeated compact attempt must restore the projection after an ordinary checkpoint');
  assert((await start(f)).revision > manualRevision, 'Restoration requires a fresh guarded write');
  assert.equal((await readdir(path.join(f.data, 'requests'))).length, count + 2);
});
test('missing bound intent fails visibly and does not write a guessed checkpoint', async (t) => {
  const f = await fixture(t), before = (await start(f)).revision;
  await writeFile(path.join(f.root, '.omx/lodestar-compaction.json'), JSON.stringify({ ...f.binding, intent_record_id: 'knowledge:absent-intent' }));
  const result = await pre(f); assert.equal(result.continue, false); assert.match(result.systemMessage, /checkpoint failed/);
  assert.equal((await start(f)).revision, before);
});
test('unknown committed response replays the exact journal once; unresolved second attempt blocks', async (t) => {
  const f = await fixture(t); assert.equal((await pre(f)).continue, true);
  const { file, saved } = await journal(f), original = canonical(saved.request);
  await writeFile(file, canonical({ ...saved, state: 'unknown', result: undefined }));
  const before = (await start(f)).revision;
  const result = await pre(f, { turn_id: 'later-replay-turn' }); assert.equal(result.continue, true, result.systemMessage);
  const recovered = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(canonical(recovered.request), original); assert.equal(recovered.automatic_replays, 1);
  assert.equal(recovered.result.request.replayed, true); assert.equal((await start(f)).revision, before);
  await writeFile(file, canonical({ ...recovered, state: 'unknown', result: undefined }));
  const blocked = await pre(f, { turn_id: 'third-turn' }); assert.equal(blocked.continue, false);
  assert.match(blocked.systemMessage, /already attempted/); assert.equal((await start(f)).revision, before);
});
test('oversized recovery names full literal reads; post-checkpoint decision changes remain current', async (t) => {
  const f = await fixture(t); assert.equal((await pre(f)).continue, true);
  await decision(f, 'Reopened on new fixture evidence; inspect the current decision reason. ' + 'x'.repeat(10000));
  const output = await resume(f); assert.equal(output.continue, true, output.systemMessage);
  const text = output.hookSpecificOutput.additionalContext; assert(text.length <= 7000);
  const context = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.equal(context.saved_checkpoint_matches_current, false); assert.equal(context.must_read_before_action, true);
  assert.match(context.omitted, /exceeds/); assert.equal(context.read_access.current_work_check_args.at(-1), f.intent);
  const check = await read(f, context.read_access.current_work_check_args);
  assert(JSON.stringify(check.data.continuity).includes('Reopened on new fixture evidence'));
});
