import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';
import { dispatch } from '../src/agent-state.mjs';
import { directInterfaceSelection } from '../src/interface-config.mjs';
import { childEnvironment, executeCli, executeProcess, parseCliResult } from '../src/interface-client.mjs';
import * as journals from '../src/recovery-journal.mjs';
import { fixture } from './helpers/contract.mjs';

const rootFor = f => path.join(f.root, 'cli-pending');
const cleanupWarning = text => {
  const prefix = 'Warning: recovery_journal_cleanup_failed ';
  assert.ok(text.startsWith(prefix), text); return JSON.parse(text.slice(prefix.length));
};
async function bodyFor(f, id, text = 'Private settled body') {
  return f.request({ mode: 'create', record: { id, name: id, kind: 'note', scope: 'global',
    availability: 'known', data: { body: text }, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id }]);
}
async function stoppedBeforeResponse(f, body) {
  const parsed = { options: {}, positionals: [] }, selection = await directInterfaceSelection(f.database);
  const journal = await journals.prepareCliJournal(selection, 'put', parsed, ['put'], { stdin: Readable.from([JSON.stringify(body)]) });
  const result = await dispatch('put', parsed, f.database, {});
  return { journal, envelope: { v: 5, ok: true, operation: 'put', ...result } };
}

test('27 acknowledged CLI writes leave no full-content pending folders', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 27; n++) await f.create(`note:growth-${n}`, 'note', { body: `PRIVATE-${n}` });
  assert.deepEqual(await readdir(rootFor(f)), []);
  const listed = await f.cli(['recovery', 'list']);
  assert.deepEqual(listed.value.data.journals, []); assert.deepEqual(listed.value.data.settled_journals, []);
});

test('actual plugin process and verified output-file delivery retire only their own request copies', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:plugin-process');
  const file = path.join(f.root, 'plugin-request.json'); fs.writeFileSync(file, JSON.stringify(body));
  const result = await executeCli(await directInterfaceSelection(f.database), {
    operation: 'put', args: ['put', '--file', file], effect: 'record_write' });
  assert.equal(result.kind, 'EnvelopeSuccess', JSON.stringify(result));
  assert.deepEqual(await readdir(rootFor(f)), []); assert.deepEqual(JSON.parse(await readFile(file)), body);
  const other = await bodyFor(f, 'note:output-file'), output = path.join(f.root, 'complete-response.json');
  const delivered = await f.cli(['put', '--output', output], other); assert.equal(delivered.code, 0);
  const bytes = await readFile(output), receipt = delivered.value.data.output_file;
  assert.equal(bytes.length, receipt.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  assert.equal(JSON.parse(bytes).request.id, other.request_id); assert.deepEqual(await readdir(rootFor(f)), []);
});

test('acknowledged delete does not retain new settled plaintext journals; original request still replays receipt', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:private-delete', 'PRIVATE-DELETED-PLAINTEXT');
  const first = await f.cli(['put'], body); assert.equal(first.code, 0);
  const replay = await f.cli(['put'], body); assert.equal(replay.code, 0);
  assert.equal(replay.value.request.replayed, true); assert.equal(replay.value.receipt_id, first.value.receipt_id);
  const deletion = await f.request({ id: body.input.record.id, reason: 'Retire private note' }, [{ kind: 'record', id: body.input.record.id }]);
  const result = await f.cli(['delete'], deletion); assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.data.retired, true); assert.deepEqual(await readdir(rootFor(f)), []);
  assert.equal((await f.cli(['get', first.value.receipt_id])).code, 0);
});

test('actual lost stdout preserves exact sole stdin request and replays original committed receipt', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:lost-stdout');
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(body, null, 2) + '\n'); let stderr = '';
  const code = await runCli(['--db', f.database, 'put'], { stdin: Readable.from([bytes]),
    stdout: { write() { throw new Error('Injected output loss'); } }, stderr: { write(value) { stderr += value; } } });
  assert.equal(code, 5); const failure = JSON.parse(stderr);
  const folder = path.join(rootFor(f), (await readdir(rootFor(f)))[0]);
  assert.equal(failure.error.identifiers.journal, folder);
  assert.deepEqual(await readFile(path.join(folder, 'request.json')), bytes);
  const response = JSON.parse(await readFile(path.join(folder, 'response.json'), 'utf8'));
  assert.equal(response.ok, true); assert.equal(response.receipt_id, failure.error.identifiers.receipt_id);
  const retry = await f.cli(['put', '--file', path.join(folder, 'request.json')]);
  assert.equal(retry.code, 0); assert.equal(retry.value.request.replayed, true);
  assert.equal(retry.value.receipt_id, response.receipt_id); assert.equal(retry.value.revision, response.revision);
  assert.deepEqual(await readFile(path.join(folder, 'request.json')), bytes, 'borrowed retry cannot retire earlier folder');
});

test('pre-response real commit and later rejected same-ID request remain recoverable and unchanged', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:pre-response');
  const { journal, envelope } = await stoppedBeforeResponse(f, body);
  const bytes = await readFile(path.join(journal.folder, 'request.json'));
  const changed = structuredClone(body); changed.input.record.name = 'Changed';
  assert.notEqual((await f.cli(['put'], changed)).code, 0);
  assert.deepEqual(await readFile(path.join(journal.folder, 'request.json')), bytes);
  const listing = await f.cli(['recovery', 'list']); assert.equal(listing.value.data.journals.length, 1);
  const replay = await f.cli(['recovery', 'replay', listing.value.data.journals[0].key]);
  assert.equal(replay.code, 0); assert.equal(replay.value.receipt_id, envelope.receipt_id);
  assert.equal(replay.value.request.replayed, true); assert.deepEqual(await readFile(path.join(journal.folder, 'request.json')), bytes);
});

test('definite typed rejection retires its owned request after response delivery', async t => {
  const f = await fixture(t); await f.create('note:exists', 'note', {});
  const body = await bodyFor(f, 'note:exists'); const result = await f.cli(['put'], body);
  assert.notEqual(result.code, 0);
  assert.equal(result.value.error.code, 'record_exists');
  assert.deepEqual(await readdir(rootFor(f)), []);
});

test('response storage refusal after real commit retains sole stdin bytes and reports receipt reconciliation', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:save-refusal'), bytes = Buffer.from(JSON.stringify(body));
  const original = fs.promises.rename; let failures = 0, stdout = '', stderr = '';
  fs.promises.rename = async function(from, to) {
    if (to.startsWith(rootFor(f)) && path.basename(to) === 'response.json' && failures++ === 0)
      throw Object.assign(new Error('Injected response storage refusal'), { code: 'EACCES' });
    return original.call(this, from, to);
  }; syncBuiltinESMExports();
  let code;
  try { code = await runCli(['--db', f.database, 'put'], { stdin: Readable.from([bytes]),
    stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } }); }
  finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(code, 5); assert.equal(stdout, ''); const error = JSON.parse(stderr).error;
  assert.equal(error.identifiers.phase, 'recovery_response_save'); assert.equal(error.identifiers.committed, true);
  assert.match(error.action, /receipt_read_args/); assert.doesNotMatch(error.message, /write failed/i);
  const folder = path.join(rootFor(f), (await readdir(rootFor(f)))[0]);
  assert.deepEqual(await readFile(path.join(folder, 'request.json')), bytes);
  const listing = await f.cli(['recovery', 'list']); assert.equal(listing.value.data.journals.length, 1);
  const replay = await f.cli(['recovery', 'replay', listing.value.data.journals[0].key]);
  assert.equal(replay.code, 0); assert.equal(replay.value.request.replayed, true);
  assert.equal(replay.value.receipt_id, error.identifiers.receipt_id);
  assert.deepEqual(await readFile(path.join(folder, 'request.json')), bytes);
});

test('retirement refuses bad receipt and unowned handles without removing request bytes', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:bad-receipt');
  const { journal, envelope } = await stoppedBeforeResponse(f, body), bytes = await readFile(path.join(journal.folder, 'request.json'));
  assert.equal(typeof journals.retireCliJournal, 'function');
  const bad = { ...envelope, receipt_id: 'mutation-receipt:' + '0'.repeat(64) };
  await journals.storeCliResponse(journal, bad);
  await assert.rejects(journals.retireCliJournal(journal, bad), /receipt|success|settled/i);
  assert.deepEqual(await readFile(path.join(journal.folder, 'request.json')), bytes);
  await journals.storeCliResponse(journal, envelope);
  assert.equal(await journals.retireCliJournal({ ...journal }, envelope), false);
  assert.deepEqual(await readFile(path.join(journal.folder, 'request.json')), bytes);
});

for (const refusal of ['foreign-file', 'changed-context', 'linked-request', 'hardlinked-request', 'replaced-directory']) test(`acknowledged commit reports ${refusal} cleanup refusal loudly`, async t => {
  const f = await fixture(t), body = await bodyFor(f, `note:${refusal}`); let stdout = '', stderr = '', folder;
  const code = await runCli(['--db', f.database, 'put'], { stdin: Readable.from([JSON.stringify(body)]),
    stdout: { write(value) {
      stdout += value; folder = path.join(rootFor(f), fs.readdirSync(rootFor(f))[0]);
      if (refusal === 'foreign-file') fs.writeFileSync(path.join(folder, 'foreign.txt'), 'Preserve this');
      if (refusal === 'changed-context') fs.appendFileSync(path.join(folder, 'context.json'), ' ');
      if (refusal === 'linked-request') {
        const target = path.join(f.root, 'preserved-request.json'); fs.renameSync(path.join(folder, 'request.json'), target);
        fs.symlinkSync(target, path.join(folder, 'request.json'));
      }
      if (refusal === 'hardlinked-request') fs.linkSync(path.join(folder, 'request.json'), path.join(f.root, 'request-alias.json'));
      if (refusal === 'replaced-directory') {
        const old = folder + '-preserved'; fs.renameSync(folder, old); fs.mkdirSync(folder);
        for(const name of ['request.json','context.json','response.json']) fs.copyFileSync(path.join(old,name),path.join(folder,name));
      }
    } }, stderr: { write(value) { stderr += value; } } });
  assert.equal(code, 0); assert.equal(JSON.parse(stdout).ok, true);
  const error = cleanupWarning(stderr); assert.equal(error.identifiers.phase, 'recovery_journal_retire');
  assert.equal(error.identifiers.committed, true); assert.match(error.message, /committed.*(?:cleanup|retir)/i);
  assert.match(error.action, /receipt_read_args/); assert.doesNotMatch(error.message, /write failed/i);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'response.json'))).ok, true);
  if (refusal === 'foreign-file') assert.equal(await readFile(path.join(folder, 'foreign.txt'), 'utf8'), 'Preserve this');
});

for (const failAt of [1, 2]) test(`real unlink failure at step ${failAt} retains committed response and emits truthful failure`, async t => {
  const f = await fixture(t), body = await bodyFor(f, `note:unlink-${failAt}`); let stdout = '', stderr = '', calls = 0;
  const original = fs.promises.unlink;
  fs.promises.unlink = async function(file) {
    if (path.dirname(file).startsWith(rootFor(f)) && ++calls === failAt) throw Object.assign(new Error('Injected storage refusal'), { code: 'EACCES' });
    return original.call(this, file);
  }; syncBuiltinESMExports();
  let code;
  try { code = await runCli(['--db', f.database, 'put'], { stdin: Readable.from([JSON.stringify(body)]),
    stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } }); }
  finally { fs.promises.unlink = original; syncBuiltinESMExports(); }
  assert.equal(code, 0); assert.equal(JSON.parse(stdout).ok, true); assert.equal(calls, failAt);
  const error = cleanupWarning(stderr); assert.equal(error.identifiers.committed, true);
  assert.equal(error.identifiers.phase, 'recovery_journal_retire');
  const folder = path.join(rootFor(f), (await readdir(rootFor(f)))[0]);
  const response = JSON.parse(await readFile(path.join(folder, 'response.json'))); assert.equal(response.ok, true);
  assert.equal((await f.cli(error.identifiers.receipt_read_args.slice(2))).code, 0);
  assert.equal(fs.existsSync(path.join(folder, 'request.json')), failAt === 1);
});

test('actual captured cleanup refusal is consumed as one confirmed success by the shared parser', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:consumer-cleanup'); let stdout = '', stderr = '';
  const code = await runCli(['--db', f.database, 'put'], { stdin: Readable.from([JSON.stringify(body)]),
    stdout: { write(value) { stdout += value;
      fs.writeFileSync(path.join(rootFor(f), fs.readdirSync(rootFor(f))[0], 'foreign.txt'), 'Retain this');
    } }, stderr: { write(value) { stderr += value; } } });
  const parsed = parseCliResult({ stdout, stderr, exitCode: code, elapsedMs: 0,
    operation: 'put', args: ['put'], effect: 'record_write', dispatched: true });
  assert.equal(parsed.kind, 'EnvelopeSuccess', JSON.stringify(parsed));
  assert.equal(parsed.exitCode, 0); assert.notEqual(parsed.mayHaveCommitted, true);
  assert.match(stderr, /^Warning: recovery_journal_cleanup_failed /u);
  assert.equal(parsed.envelope.request.id, body.request_id);
});

test('actual child filesystem cleanup fault preserves plugin receipt consumption without loosening parser', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:child-cleanup');
  const file = path.join(f.root, 'child-request.json'), entry = path.join(f.root, 'inject-cleanup.mjs');
  fs.writeFileSync(file, JSON.stringify(body));
  fs.writeFileSync(entry, `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { runCli } from ${JSON.stringify(pathToFileURL(path.resolve('src/cli.mjs')).href)};\nconst unlink = fs.promises.unlink;\nfs.promises.unlink = async file => { if(file.endsWith('request.json')) throw Object.assign(new Error('Injected cleanup refusal'), {code:'EACCES'}); return unlink(file); };\nsyncBuiltinESMExports();\nprocess.exitCode = await runCli(process.argv.slice(2));\n`);
  const selection = await directInterfaceSelection(f.database);
  const result = await executeProcess({ command: selection.node, argv: [entry, '--db', f.database, 'put', '--file', file],
    env: childEnvironment() }, { operation: 'put', args: ['put', '--file', file], effect: 'record_write' });
  assert.equal(result.kind, 'EnvelopeSuccess', JSON.stringify(result));
  assert.equal(result.exitCode, 0); assert.notEqual(result.mayHaveCommitted, true);
  assert.match(result.diagnostics, /stderr: Warning/u);
  const folder = path.join(rootFor(f), (await readdir(rootFor(f)))[0]);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'request.json'))), body);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'response.json'))).receipt_id, result.envelope.receipt_id);
  assert.equal((await f.cli(['get', result.envelope.receipt_id])).code, 0);
});

for (const bothUnavailable of [false, true]) test(`cleanup warning uses stdout fallback; both channels unavailable=${bothUnavailable}`, async t => {
  const f = await fixture(t), body = await bodyFor(f, `note:warning-fallback-${bothUnavailable}`);
  let stdout = '', writes = 0;
  const code = await runCli(['--db', f.database, 'put'], { stdin: Readable.from([JSON.stringify(body)]),
    stdout: { write(value) {
      if(++writes === 1){ stdout += value;
        fs.writeFileSync(path.join(rootFor(f),fs.readdirSync(rootFor(f))[0],'foreign.txt'),'Keep');
      } else if(bothUnavailable) throw new Error('stdout unavailable');
      else stdout += value;
    } }, stderr: { write() { throw new Error('stderr unavailable'); } } });
  assert.equal(code,bothUnavailable ? 5 : 0);
  const consumed = parseCliResult({ stdout, stderr:'', exitCode:code, elapsedMs:0,
    operation:'put',args:['put'],effect:'record_write',dispatched:true });
  assert.equal(consumed.kind,bothUnavailable ? 'TransportError' : 'EnvelopeSuccess');
  const names=await readdir(rootFor(f));assert.equal(names.length,1);
  const response=JSON.parse(await readFile(path.join(rootFor(f),names[0],'response.json')));
  assert.equal(response.ok,true);assert.equal((await f.cli(['get',response.receipt_id])).code,0);
  if(!bothUnavailable)assert.match(stdout,/Warning: recovery_journal_cleanup_failed/u);
});
