import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cp, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';
import { directInterfaceSelection } from '../src/interface-config.mjs';
import { prepareCliJournal, retireCliJournal, storeCliResponse } from '../src/recovery-journal.mjs';
import { fixture } from './helpers/contract.mjs';
import { commitBeforeResponse } from './claude-journal-fixture.mjs';

const rootFor = f => path.join(f.root, 'cli-pending');
const cliPath = path.resolve('lodestar.mjs');
async function bodyFor(f, id) {
  return f.request({ mode: 'create', record: { id, name: id, kind: 'note', scope: 'global',
    availability: 'known', data: {}, aliases: [], links: [], sources: [] } }, [{ kind: 'record', id }]);
}
function child(f, args, body, cli = cliPath) {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--db', f.database, ...args],
    { input: JSON.stringify(body), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  return { code: result.status, value: JSON.parse(result.stdout || result.stderr), ...result };
}
async function locked(f, fn) {
  const holder = new DatabaseSync(f.database);
  try { holder.exec('BEGIN IMMEDIATE'); const result = await fn(); assert.equal(holder.isTransaction, true); return result; }
  finally { if (holder.isTransaction) holder.exec('ROLLBACK'); holder.close(); }
}
async function retainedBusy(f, args, body) {
  const code = await locked(f, () => runCli(['--db', f.database, ...args], {
    stdin: Readable.from([JSON.stringify(body)]), stdout: { write() { assert.fail('Busy operation cannot succeed'); } },
    stderr: { write() { throw new Error('Lost rejection delivery'); } } }));
  assert.equal(code, 5);
  const folder = path.join(rootFor(f), (await readdir(rootFor(f)))[0]);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'response.json'))).error.code, 'database_busy');
  return folder;
}
async function replacementRuntime(f){
  const runtime=path.join(f.root,'replacement-runtime');
  for(const directory of ['src','docs','managed-assets'])await cp(path.resolve(directory),path.join(runtime,directory),{recursive:true});
  for(const name of ['lodestar.mjs','package.json'])await copyFile(path.resolve(name),path.join(runtime,name));
  return path.join(runtime,'lodestar.mjs');
}

test('historical complete rejection is listed settled and exact runtime retry preserves old folder', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:historical-rejected');
  const folder = await retainedBusy(f, ['put'], body);
  const snapshot = await Promise.all(['request.json', 'context.json', 'response.json'].map(name => readFile(path.join(folder, name))));
  const changed = { ...await directInterfaceSelection(f.database), runtimeFingerprint: 'a'.repeat(64) };
  const journal = await prepareCliJournal(changed, 'put', { options: {}, positionals: [] }, ['put'],
    { stdin: Readable.from([JSON.stringify(body)]) });
  assert.equal(journal.context.prior_outcome_unknown, false);
  const oldListing = await (await import('../src/recovery-journal.mjs')).listRecovery(changed);
  assert.equal(oldListing.settled_journals.length, 1);
  assert.equal(oldListing.journals.length, 1, 'only the new unanswered journal remains unresolved');
  const actual = await Promise.all(['request.json', 'context.json', 'response.json'].map(name => readFile(path.join(folder, name))));
  assert.deepEqual(actual, snapshot);
});

test('actual replacement-runtime CLI accepts historical no-commit journal and preserves its files',async t=>{
  const f=await fixture(t),body=await bodyFor(f,'note:historical-upgrade');
  const folder=await retainedBusy(f,['put'],body),before=await readFile(path.join(folder,'request.json'));
  const cli=await replacementRuntime(f),retry=child(f,['put'],body,cli);
  assert.equal(retry.code,0,JSON.stringify(retry));assert.equal(retry.value.request.replayed,false);
  const listed=child(f,['recovery','list'],null,cli);
  assert.equal(listed.value.data.journals.length,0);assert.equal(listed.value.data.settled_journals.length,1);
  assert.deepEqual(await readFile(path.join(folder,'request.json')),before);
});

test('historical changed-runtime peer disappearing during classification cannot cause a conflict',async t=>{
  const f=await fixture(t),body=await bodyFor(f,'note:historical-disappearing');
  const folder=await retainedBusy(f,['put'],body),moved=path.join(f.root,'retained-owner-files');
  const changed={...await directInterfaceSelection(f.database),runtimeFingerprint:'a'.repeat(64)};
  const original=fs.promises.open;let intercepted=false,journal;
  fs.promises.open=async function(file,...args){
    if(file===path.join(folder,'context.json')&&!intercepted){intercepted=true;fs.renameSync(folder,moved);}
    return original.call(this,file,...args);
  };syncBuiltinESMExports();
  try{journal=await prepareCliJournal(changed,'put',{options:{},positionals:[]},['put'],
    {stdin:Readable.from([JSON.stringify(body)])});}
  finally{fs.promises.open=original;syncBuiltinESMExports();}
  assert.equal(intercepted,true);assert.equal(journal.context.prior_outcome_unknown,false);
  assert.deepEqual(JSON.parse(await readFile(path.join(moved,'request.json'))),body);
});

for (const fault of ['prior-unknown', 'missing-prior-unknown', 'uncertainty-marker', 'foreign-file', 'changed-bytes', 'changed-arguments',
  'wrong-operation', 'wrong-database-identity', 'malformed-response', 'committed-unknown']) {
  test(`historical rejection cannot bypass ${fault}`, async t => {
    const f = await fixture(t), body = await bodyFor(f, 'note:historical-' + fault);
    const folder = await retainedBusy(f, ['put'], body);
    if (fault === 'prior-unknown' || fault === 'missing-prior-unknown') {
      const context = JSON.parse(await readFile(path.join(folder, 'context.json')));
      if (fault === 'prior-unknown') context.prior_outcome_unknown = true; else delete context.prior_outcome_unknown;
      await writeFile(path.join(folder, 'context.json'), JSON.stringify(context));
    }
    if (fault === 'uncertainty-marker') await writeFile(path.join(folder, 'response.uncertainty.json'), '{}');
    if (fault === 'foreign-file') await writeFile(path.join(folder, 'foreign.txt'), 'Preserve');
    if(['wrong-operation','wrong-database-identity','committed-unknown'].includes(fault)){
      const response=JSON.parse(await readFile(path.join(folder,'response.json')));
      if(fault==='wrong-operation')response.operation='delete';
      if(fault==='wrong-database-identity')response.database_instance_id='b'.repeat(64);
      if(fault==='committed-unknown')response.error.identifiers.committed='unknown';
      await writeFile(path.join(folder,'response.json'),JSON.stringify(response));
    }
    if(fault==='malformed-response')await writeFile(path.join(folder,'response.json'),'{');
    const changed = { ...await directInterfaceSelection(f.database), runtimeFingerprint: 'a'.repeat(64) };
    const request = fault === 'changed-bytes' ? { ...body, input: { ...body.input, record: { ...body.input.record, name: 'Changed' } } } : body;
    const args = fault === 'changed-arguments' ? ['put', '--human'] : ['put'];
    await assert.rejects(prepareCliJournal(changed, 'put', { options: {}, positionals: [] }, args,
      { stdin: Readable.from([JSON.stringify(request)]) }), error => ['recovery_request_conflict', 'recovery_journal_invalid','invalid_json'].includes(error.code));
    assert.ok(fs.existsSync(folder));
  });
}

for(const historical of [false,true])test(`actual busy CLI rejection permits identical successor-session retry; historical=${historical}`, async t => {
  const f = await fixture(t); await f.create('project:retry', 'project', { roots: [f.root] }, 'project:retry');
  const body = await f.request({ key: 'retry-choice', value: 'SQLite', reason: 'Same request', status: 'accepted',
    direction: { kind: 'user', attribution: 'asserted', reference: 'task:user:retry', instruction: 'Use SQLite.' } },
  [{ kind: 'record', id: 'project:retry' }, { kind: 'decision', scope: 'project:retry', key: 'retry-choice' }],
  'project:retry', { id: 'agent:original', agent: 'test', harness: 'test', session: 'original' });
  const args = ['decision', 'set', '--cwd', f.root, '--session', 'original', '--agent', 'test', '--harness', 'test'];
  let oldFolder;
  if(historical)oldFolder=await retainedBusy(f,args,body);
  else{
    const refused = await locked(f, () => child(f, args, body));
    assert.equal(refused.value.error.code, 'database_busy', JSON.stringify(refused));
  }
  const retry = child(f, args.map(value => value === 'original' ? 'successor' : value), body);
  assert.equal(retry.code, 0, JSON.stringify(retry));
  assert.equal(retry.value.request.replayed, false);
  assert.deepEqual(await readdir(rootFor(f)), historical?[path.basename(oldFolder)]:[]);
});

test('actual busy CLI rejection permits exact request in a changed runtime location', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:runtime-retry');
  const refused = await locked(f, () => child(f, ['put'], body));
  assert.equal(refused.value.error.code, 'database_busy');
  const retry = child(f, ['put'], body, await replacementRuntime(f));
  assert.equal(retry.code, 0, JSON.stringify(retry));
  assert.equal(retry.value.request.replayed, false);
  assert.deepEqual(await readdir(rootFor(f)), []);
});

test('pre-transaction missing-precondition and record-exists rejections leave no settled folders', async t => {
  const f = await fixture(t); await f.create('note:exists-rejection', 'note', {});
  const existing = await bodyFor(f, 'note:exists-rejection');
  const refused = await f.cli(['put'], existing); assert.equal(refused.value.error.code, 'record_exists');
  const missing = await bodyFor(f, 'note:missing-precondition'); missing.preconditions = [];
  const invalid = await f.cli(['put'], missing); assert.equal(invalid.value.error.code, 'missing_precondition');
  assert.deepEqual(await readdir(rootFor(f)), []);
});

test('rejection delivered through complete output file retires its exact stored response',async t=>{
  const f=await fixture(t);await f.create('note:rejected-output','note',{});
  const body=await bodyFor(f,'note:rejected-output'),output=path.join(f.root,'rejected-response.json');
  const refused=await f.cli(['put','--output',output],body);
  assert.equal(refused.code,3);assert.equal(refused.value.error.code,'record_exists');
  const bytes=await readFile(output);assert.equal(bytes.length,refused.value.data.output_file.bytes);
  assert.equal(JSON.parse(bytes).error.code,'record_exists');
  assert.deepEqual(await readdir(rootFor(f)),[]);
});

test('earlier unknown committed dispatch survives a later busy rejection and exact recovery returns its receipt', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:unknown-before-rejection');
  const original = await commitBeforeResponse(f, 'put', body);
  const bytes = await readFile(path.join(original.folder, 'request.json'));
  const refused = await locked(f, () => child(f, ['put'], body));
  assert.equal(refused.value.error.code, 'database_busy');
  const names = await readdir(rootFor(f)); assert.equal(names.length, 2);
  for (const name of names) {
    const context = JSON.parse(await readFile(path.join(rootFor(f), name, 'context.json')));
    if (name !== path.basename(original.folder)) assert.equal(context.prior_outcome_unknown, true);
  }
  const listing = await f.cli(['recovery', 'list']);
  assert.equal(listing.value.data.journals.length, 2);
  assert.equal(listing.value.data.settled_journals.length, 0);
  const saved = listing.value.data.journals.find(row => row.folder === original.folder);
  const replay = await f.cli(['recovery', 'replay', saved.key]);
  assert.equal(replay.code, 0); assert.equal(replay.value.request.replayed, true);
  assert.equal(replay.value.receipt_id, original.value.receipt_id);
  assert.deepEqual(await readFile(path.join(original.folder, 'request.json')), bytes);
});

test('unknown dispatch retains strict changed-runtime, changed-bytes and other-database admission', async t => {
  const f = await fixture(t), body = await bodyFor(f, 'note:unknown-conflicts');
  const selection = await directInterfaceSelection(f.database);
  const args = ['put'];
  const journal = await prepareCliJournal(selection, 'put', { options: {}, positionals: [] }, args,
    { stdin: Readable.from([JSON.stringify(body)]) });
  const bytes = await readFile(path.join(journal.folder, 'request.json'));
  for (const [retryArgs, retryBody] of [
    [args, { ...body, input: { ...body.input, record: { ...body.input.record, name: 'Changed bytes' } } }],
  ]) {
    const refused = child(f, retryArgs, retryBody);
    assert.equal(refused.value.error.code, 'recovery_request_conflict');
  }
  await assert.rejects(prepareCliJournal({ ...selection, runtimeFingerprint: 'changed-runtime' }, 'put',
    { options: {}, positionals: [] }, args, { stdin: Readable.from([JSON.stringify(body)]) }),
  error => error.code === 'recovery_request_conflict');
  const otherDatabase = path.join(f.root, 'different.db');
  assert.equal(await runCli(['--db', otherDatabase, 'init'], { stdout: { write() {} }, stderr: { write() {} } }), 0);
  const refused = child({ ...f, database: otherDatabase }, args, body);
  assert.equal(refused.value.error.code, 'recovery_journal_invalid');
  assert.deepEqual(await readFile(path.join(journal.folder, 'request.json')), bytes);
  assert.deepEqual(await readdir(rootFor(f)), [path.basename(journal.folder)]);
});

for (const code of ['internal_error', 'response_delivery_failed', 'database_commit_outcome_unknown']) {
  test(`owned ${code} response cannot retire an uncertain request`, async t => {
    const f = await fixture(t), body = await bodyFor(f, 'note:' + code);
    const journal = await prepareCliJournal(await directInterfaceSelection(f.database), 'put', { options: {}, positionals: [] }, ['put'],
      { stdin: Readable.from([JSON.stringify(body)]) });
    const envelope = { v: 5, ok: false, operation: 'put', more: false, next: [],
      scope: { project: null, cwd: null, session: null, actor: null }, error: { code, message: 'Unknown outcome', action: 'Preserve request', identifiers: {} } };
    await storeCliResponse(journal, envelope);
    assert.equal(await retireCliJournal(journal, envelope), false);
    assert.deepEqual(JSON.parse(await readFile(path.join(journal.folder, 'request.json'))), body);
  });
}

for (const fault of ['foreign-file', 'changed-context', 'unlink']) {
  test(`rejected-write retirement ${fault} failure preserves error and evidence`, async t => {
    const f = await fixture(t); await f.create('note:cleanup-rejected', 'note', {});
    const body = await bodyFor(f, 'note:cleanup-rejected'); let stderr = '', folder;
    const original = fs.promises.unlink;
    if (fault === 'unlink') {
      fs.promises.unlink = async file => {
        if (file.startsWith(rootFor(f))) throw Object.assign(new Error('Injected rejection cleanup fault'), { code: 'EACCES' });
        return original(file);
      }; syncBuiltinESMExports();
    }
    let code;
    try { code = await runCli(['--db', f.database, 'put'], { stdin: Readable.from([JSON.stringify(body)]),
      stdout: { write() { assert.fail('Rejected write cannot report success'); } }, stderr: { write(value) {
        stderr += value;
        if (value.startsWith('{')) {
          folder = path.join(rootFor(f), fs.readdirSync(rootFor(f))[0]);
          if (fault === 'foreign-file') fs.writeFileSync(path.join(folder, 'foreign.txt'), 'Preserve');
          if (fault === 'changed-context') fs.appendFileSync(path.join(folder, 'context.json'), ' ');
        }
      } } }); }
    finally { fs.promises.unlink = original; syncBuiltinESMExports(); }
    const lines = stderr.trim().split('\n');
    assert.equal(code, 3); assert.equal(JSON.parse(lines[0]).error.code, 'record_exists');
    assert.equal(lines.length, 2); assert.match(lines[1], /^Warning: recovery_journal_cleanup_failed /);
    const warning = JSON.parse(lines[1].slice('Warning: recovery_journal_cleanup_failed '.length));
    assert.equal(warning.identifiers.committed, false);
    assert.equal(warning.identifiers.response_delivered, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'request.json'))), body);
    assert.equal(JSON.parse(await readFile(path.join(folder, 'response.json'))).error.code, 'record_exists');
  });
}
