import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, readdir, rename, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import test from 'node:test';
import { openReadDatabase } from '../src/database.mjs';
import { fixture } from './helpers/contract.mjs';
import { directInterfaceSelection } from '../src/interface-config.mjs';
import { prepareCliJournal } from '../src/recovery-journal.mjs';
import { runCli } from '../src/cli.mjs';

const cliModule = new URL('../src/cli.mjs', import.meta.url).href;
async function waitFor(file) {
  for(let n=0;n<1000;n++){
    try{await access(file);return;}catch{await new Promise(resolve=>setTimeout(resolve,10));}
  }
  assert.fail(`Gate was never reached: ${file}`);
}
function child(t,f,body,phase=null){
  const marker=path.join(f.root,`${phase??'plain'}-ready`),release=path.join(f.root,`${phase??'plain'}-release`);
  const source=`import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {runCli} from ${JSON.stringify(cliModule)};
const phase=${JSON.stringify(phase)},marker=${JSON.stringify(marker)},release=${JSON.stringify(release)};
let gated=false,contextPublished=false;
function gate(){if(gated)return;gated=true;fs.writeFileSync(marker,'ready');const until=Date.now()+15000;while(!fs.existsSync(release)){if(Date.now()>until)throw new Error('Gate timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
const rename=fs.promises.rename,unlink=fs.promises.unlink,open=fs.promises.open,mkdir=fs.promises.mkdir;
function wait(file){const until=Date.now()+15000;while(!fs.existsSync(file)){if(Date.now()>until)throw new Error('Gate timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
fs.promises.mkdir=async function(file,...args){if(String(file).endsWith('.preparing')&&phase?.startsWith('prescan')){gate();const result=await mkdir(file,...args);fs.writeFileSync(marker+'-created','ready');wait(release+'-publish');return result;}return mkdir(file,...args);};
fs.promises.rename=async function(from,to){if(path.basename(to)==='context.json'&&phase==='publish')gate();const value=await rename(from,to);if(path.basename(to)==='context.json')contextPublished=true;return value;};
fs.promises.unlink=async function(file){if(path.basename(file)==='request.json'&&phase==='retire')gate();return unlink(file);};
fs.promises.open=async function(file,...args){if((contextPublished&&path.basename(file)==='request.json'&&phase==='dispatch')||
  (path.basename(file)==='context.json'&&phase==='peerread'))gate();return open(file,...args);};
syncBuiltinESMExports();
process.exitCode=await runCli(['--db',${JSON.stringify(f.database)},'put']);`;
  const process_=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','--eval',source],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(process_.exitCode===null)process_.kill();});
  let stdout='',stderr='';process_.stdout.on('data',chunk=>stdout+=chunk);process_.stderr.on('data',chunk=>stderr+=chunk);
  const done=new Promise(resolve=>process_.on('close',status=>resolve({status,stdout,stderr})));
  process_.stdin.end(JSON.stringify(body));return{done,marker,release};
}
async function request(f,id){return f.request({mode:'create',record:{id,kind:'fact',name:'Concurrent request',scope:'global',
  data:{body:'Exact once'},aliases:[],links:[],sources:[]}},[{kind:'record',id}]);}
async function verifyOneReceipt(f,body,outcomes){
  const diagnostic=JSON.stringify(outcomes);
  const values=outcomes.map(outcome=>{assert.equal(outcome.status,0,diagnostic);assert.equal(outcome.stderr,'',diagnostic);return JSON.parse(outcome.stdout);});
  assert.equal(values.filter(value=>!value.request.replayed).length,1,diagnostic);
  assert.equal(values[0].receipt_id,values[1].receipt_id,diagnostic);assert.equal(values[0].revision,values[1].revision,diagnostic);
  const retry=await f.cli(['put'],body);assert.equal(retry.code,0,JSON.stringify(retry.value));
  assert.equal(retry.value.request.replayed,true);assert.equal(retry.value.receipt_id,values[0].receipt_id);
  const db=await openReadDatabase(f.database);
  try{assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE type='mutation-receipt'").get().n,1);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value,'1');}
  finally{db.close();}
}

test('same-ID real CLI children never borrow an incompletely published journal',async t=>{
  const f=await fixture(t),body=await request(f,'fact:publish-race'),first=child(t,f,body,'publish');
  await waitFor(first.marker);const second=await child(t,f,body).done;
  await writeFile(first.release,'go');const original=await first.done;
  await verifyOneReceipt(f,body,[original,second]);
});

test('same-ID real CLI child keeps its dispatch input while the earlier owner retires',async t=>{
  const f=await fixture(t),body=await request(f,'fact:retirement-race'),first=child(t,f,body,'retire');
  await waitFor(first.marker);const second=child(t,f,body,'dispatch');await waitFor(second.marker);
  await writeFile(first.release,'go');const original=await first.done;
  await writeFile(second.release,'go');const borrowed=await second.done;
  await verifyOneReceipt(f,body,[original,borrowed]);
});

test('a modern peer disappearing during admission cannot remove this invocation input',async t=>{
  const f=await fixture(t),body=await request(f,'fact:peer-admission-race'),first=child(t,f,body,'retire');
  await waitFor(first.marker);const second=child(t,f,body,'peerread');await waitFor(second.marker);
  await writeFile(first.release,'go');const original=await first.done;
  await writeFile(second.release,'go');const retry=await second.done;
  await verifyOneReceipt(f,body,[original,retry]);
});

test('different same-ID bytes refuse before dispatch even while the original journal is publishing',async t=>{
  const f=await fixture(t),body=await request(f,'fact:publish-conflict'),first=child(t,f,body,'publish');
  await waitFor(first.marker);const changed=structuredClone(body);changed.input.record.name='Different request';
  const second=await child(t,f,changed).done;await writeFile(first.release,'go');const original=await first.done;
  assert.equal(original.status,0,JSON.stringify(original));assert.notEqual(second.status,0,JSON.stringify(second));
  assert.equal(JSON.parse(second.stderr).error.code,'recovery_request_conflict',JSON.stringify(second));
  const get=await f.cli(['get',body.input.record.id]);assert.equal(get.value.data.name,body.input.record.name);
});

test('different bindings that both finish prescan are refused by the publication scan',async t=>{
  const f=await fixture(t),body=await request(f,'fact:mutual-prescan'),changed=structuredClone(body);
  changed.input.record.name='Other binding';
  const first=child(t,f,body,'prescan-a'),second=child(t,f,changed,'prescan-b');
  await Promise.all([waitFor(first.marker),waitFor(second.marker)]);
  await Promise.all([writeFile(first.release,'go'),writeFile(second.release,'go')]);
  await Promise.all([waitFor(first.marker+'-created'),waitFor(second.marker+'-created')]);
  await Promise.all([writeFile(first.release+'-publish','go'),writeFile(second.release+'-publish','go')]);
  const outcomes=await Promise.all([first.done,second.done]);
  for(const outcome of outcomes){assert.notEqual(outcome.status,0,JSON.stringify(outcome));
    assert.equal(JSON.parse(outcome.stderr).error.code,'recovery_request_conflict',JSON.stringify(outcome));}
  const db=await openReadDatabase(f.database);try{
    assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE type='mutation-receipt'").get().n,0);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='database_revision'").get().value,'0');
  }finally{db.close();}
  const root=path.join(f.root,'cli-pending'),names=await readdir(root);assert.equal(names.length,2);
  const saved=await Promise.all(names.map(name=>readFile(path.join(root,name,'request.json'),'utf8')));
  assert.deepEqual(saved.sort(),[JSON.stringify(body),JSON.stringify(changed)].sort());
});

async function frozen(f,body){
  return prepareCliJournal(await directInterfaceSelection(f.database),'put',{options:{},positionals:[]},['put'],
    {stdin:Readable.from([JSON.stringify(body)])});
}

test('full SHA invocation names roundtrip through actual Windows capture and replay paths',async t=>{
  const f=await fixture(t),body=await request(f,'fact:path-roundtrip');
  const directory=path.join(f.root,'external database path with extra length');await mkdir(directory);
  const database=path.join(directory,'lodestar.db');await copyFile(f.database,database);
  const long={...f,database,async cli(args){let stdout='',stderr='';const code=await runCli(['--db',database,...args],{
    stdin:Readable.from([]),stdout:{write(value){stdout+=value;}},stderr:{write(value){stderr+=value;}}});
    return{code,value:JSON.parse(stdout||stderr)};}};
  const journal=await frozen(long,body);
  assert.equal(path.basename(journal.folder).length,170);
  if(process.platform==='win32')assert.ok(path.join(journal.folder,'request.json').length>260);
  const context=JSON.parse(await readFile(path.join(journal.folder,'context.json')));
  assert.equal(context.arguments[context.arguments.indexOf('--file')+1],path.join(journal.folder,'request.json'));
  const listing=await long.cli(['recovery','list']);assert.equal(listing.value.data.journals[0].replay_eligible,true);
  const replay=await long.cli(['recovery','replay',listing.value.data.journals[0].key]);assert.equal(replay.code,0,JSON.stringify(replay.value));
  assert.deepEqual(JSON.parse(await readFile(path.join(journal.folder,'request.json'))),body);
});

test('historical deterministic context-v1 stays admissible and untouched on exact CLI retry',async t=>{
  const f=await fixture(t),body=await request(f,'fact:legacy-v1'),journal=await frozen(f,body);
  const folder=path.join(f.root,'cli-pending','cli-'+createHash('sha256').update(body.request_id).digest('hex'));
  await rename(journal.folder,folder);
  const context=journal.context;delete context.invocation_id;delete context.binding_sha256;
  context.arguments[context.arguments.indexOf('--file')+1]=path.join(folder,'request.json');
  context.arguments_sha256=createHash('sha256').update(JSON.stringify(context.arguments)).digest('hex');
  const contextBytes=JSON.stringify(context)+'\n';await writeFile(path.join(folder,'context.json'),contextBytes);
  const listing=await f.cli(['recovery','list']);assert.equal(listing.value.data.journals[0].replay_eligible,true);
  const retry=await f.cli(['put'],body);assert.equal(retry.code,0,JSON.stringify(retry.value));
  assert.deepEqual(await readdir(path.join(f.root,'cli-pending')),[path.basename(folder)]);
  assert.equal(await readFile(path.join(folder,'context.json'),'utf8'),contextBytes);
  assert.equal(await readFile(path.join(folder,'request.json'),'utf8'),JSON.stringify(body));
});

for(const field of ['invocation_id','binding_sha256'])test(`changed ${field} refuses new journal admission and exact retry`,async t=>{
  const f=await fixture(t),body=await request(f,'fact:tampered-'+field),journal=await frozen(f,body);
  const context={...journal.context,[field]:field==='invocation_id'?'00000000-0000-4000-8000-000000000000':'0'.repeat(64)};
  const bytes=JSON.stringify(context);await writeFile(path.join(journal.folder,'context.json'),bytes);
  const listing=await f.cli(['recovery','list']);assert.equal(listing.value.data.journals[0].replay_eligible,false);
  const retry=await f.cli(['put'],body);assert.notEqual(retry.code,0);assert.equal(retry.value.error.code,'recovery_journal_invalid');
  assert.equal(await readFile(path.join(journal.folder,'context.json'),'utf8'),bytes);
  assert.equal(await readFile(path.join(journal.folder,'request.json'),'utf8'),JSON.stringify(body));
  const absent=await f.cli(['get',body.input.record.id]);assert.equal(absent.code,3);assert.equal(absent.value.error.code,'record_not_found');
});
