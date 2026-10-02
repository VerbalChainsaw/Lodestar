import assert from 'node:assert/strict';
import { readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { dispatch } from '../src/agent-state.mjs';
import { prepareCliJournal } from '../src/recovery-journal.mjs';
import { fixture } from './helpers/contract.mjs';
import { directInterfaceSelection } from '../src/interface-config.mjs';
import { executeCli } from '../src/interface-client.mjs';
import { runManager } from '../src/manager.mjs';
import { commitBeforeResponse, unansweredCreate } from './claude-journal-fixture.mjs';

async function journalFolder(f, requestId) {
  const root = path.join(f.root, 'cli-pending');
  for (const name of await readdir(root)) {
    const folder = path.join(root, name);
    const context = JSON.parse(await readFile(path.join(folder, 'context.json'), 'utf8'));
    if (context.request_id === requestId) return folder;
  }
  throw new Error('Expected actual CLI journal was not created.');
}

for (const confirmation of ['q', 'SAVE']) test(`Manager shared recovery dispatches only explicit SAVE (${confirmation})`, async t => {
  const f = await fixture(t);
  const first = await unansweredCreate(f, 'note:cancel-recovery', { body: 'Keep this' });
  const folder = await journalFolder(f, first.value.request.id);
  const database = await readFile(f.database);
  const request = await readFile(path.join(folder, 'request.json'));
  const answers = ['7', '1', '1', confirmation, '9'];
  let replays = 0, output = '';
  const code = await runManager({ selection: await directInterfaceSelection(f.database),
    io: { stdin: { isTTY: true }, stdout: { isTTY: true, write: value => output += value } },
    ask: async () => answers.shift() ?? null,
    execute: async (selection, invocation, options) => {
      if (invocation.args[0] === 'recovery' && invocation.args[1] === 'replay') replays++;
      return executeCli(selection, invocation, options);
    } });
  assert.equal(code, 0, output);
  assert.equal(replays, confirmation === 'SAVE' ? 1 : 0, output);
  assert.deepEqual(await readFile(f.database), database);
  assert.deepEqual(await readFile(path.join(folder, 'request.json')), request);
  assert.equal((await f.cli(['recovery', 'list'])).value.data.journals.length, confirmation === 'SAVE' ? 0 : 1);
});

test('a linked recovery root is reported as incomplete and never replayed', async t => {
  const f = await fixture(t);
  const first = await unansweredCreate(f, 'note:linked-root', {});
  const folder = await journalFolder(f, first.value.request.id);
  const before = await f.cli(['recovery', 'list']);
  const root = path.dirname(folder), target = path.join(f.root, 'preserved-journals');
  await rename(root, target);
  await symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir');
  const bytes = await readFile(f.database);
  const listing = await f.cli(['recovery', 'list']);
  assert.equal(listing.code, 0);
  assert.equal(listing.value.data.complete, false);
  assert.match(listing.value.data.errors[0].message, /link/);
  const replay = await f.cli(['recovery', 'replay', before.value.data.journals[0].key]);
  assert.notEqual(replay.code, 0);
  assert.deepEqual(await readFile(f.database), bytes);
});

test('CLI freezes relative project context and refuses changed dispatch under the same request ID', async t => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  const body = await f.request({ key: 'recovery:binding', value: 'frozen', reason: 'Observed basis', status: 'accepted' },
    [{ kind: 'record', id: 'project:test' }, { kind: 'decision', scope: 'project:test', key: 'recovery:binding' }],
    'project:test', { id: 'agent:session', agent: 'agent', session: 'session', harness: 'test' });
  const relative = path.relative(process.cwd(), f.root);
  const first = await commitBeforeResponse(f, 'decision.set', body, {
    arguments: ['decision', 'set', '--cwd', relative], options: { '--cwd': relative } });
  assert.equal(first.code, 0, JSON.stringify(first.value));
  const folder = await journalFolder(f, body.request_id);
  const contextBytes = await readFile(path.join(folder, 'context.json'));
  const context = JSON.parse(contextBytes);
  assert.equal(context.arguments[context.arguments.indexOf('--cwd') + 1], f.root);
  const database = await readFile(f.database);
  const retry = await f.cli(['decision', 'set', '--cwd', path.dirname(f.root)], body);
  assert.equal(retry.value.error.code, 'recovery_request_conflict', JSON.stringify(retry.value));
  assert.deepEqual(await readFile(path.join(folder, 'context.json')), contextBytes);
  assert.deepEqual(await readFile(f.database), database);
});

test('uncertain replay rejection preserves uncertainty and exact multibyte BOM input', async t => {
  const f = await fixture(t);
  const body = await f.request({ mode: 'create', record: { id: 'note:uncertain-conflict',
    name: '測試 🌳', kind: 'note', scope: 'global', availability: 'known', data: { body: 'café' },
    aliases: [], links: [], sources: [] } }, [{ kind: 'record', id: 'note:uncertain-conflict' }]);
  const source = path.join(f.root, 'original.json');
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(body, null, 2) + '\n');
  await writeFile(source, bytes);
  // Freeze a real conflicting attempt before the original core commit. The
  // production owner supplies its exact invocation binding; no context is forged.
  const changed = { ...body, input: { ...body.input, record: { ...body.input.record, name: 'Changed' } } };
  const changedBytes = Buffer.from(JSON.stringify(changed));
  const journal = await prepareCliJournal(await directInterfaceSelection(f.database), 'put',
    { options: {}, positionals: [] }, ['put'], { stdin: Readable.from([changedBytes]) });
  const folder = journal.folder;
  assert.deepEqual(await readFile(path.join(folder, 'request.json')), changedBytes);
  const committed = await dispatch('put', { options: { '--file': source }, positionals: [] }, f.database, {});
  const first = { value: committed };
  const listing = await f.cli(['recovery', 'list']);
  const key = listing.value.data.journals[0].key;
  const rejected = await f.cli(['recovery', 'replay', key]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.value.error.code, /conflict/);
  const after = await f.cli(['recovery', 'list']);
  assert.equal(after.value.data.journals.length, 1);
  assert.deepEqual(await readFile(path.join(folder, 'request.json')), changedBytes);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'response.uncertainty.json'), 'utf8')).mayHaveCommitted, true);
  // Check exact capture separately from the deliberately altered recovery file.
  assert.equal(first.value.data.name, '測試 🌳');
  assert.deepEqual(await readFile(source), bytes);
});
