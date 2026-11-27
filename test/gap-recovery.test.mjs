import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { directInterfaceSelection } from '../src/interface-config.mjs';
import { commitBeforeResponse } from './claude-journal-fixture.mjs';
const cliRoot = f => path.join(f.root,'cli-pending');

test('a lost CLI response replays the exact original receipt without another revision',async t=>{
  const f=await fixture(t);
  const body=await f.request({mode:'create',record:{id:'note:lost-response',name:'Lost response',kind:'note',scope:'global',availability:'known',data:{},aliases:[],links:[],sources:[]}},[{kind:'record',id:'note:lost-response'}]);
  const first=await commitBeforeResponse(f,'put',body); assert.equal(first.code,0);
  const folder=path.join(cliRoot(f),(await readdir(cliRoot(f)))[0]);
  const bytes=await readFile(path.join(folder,'request.json'));
  const list=await f.cli(['recovery','list']); assert.equal(list.value.data.journals.length,1);
  const replay=await f.cli(['recovery','replay',list.value.data.journals[0].key]);
  assert.equal(replay.code,0,JSON.stringify(replay.value));
  assert.equal(replay.value.operation,'put'); assert.equal(replay.value.request.replayed,true);
  assert.equal(replay.value.receipt_id,first.value.receipt_id); assert.equal(replay.value.revision,first.value.revision);
  assert.deepEqual(await readFile(path.join(folder,'request.json')),bytes);
  assert.equal((await f.cli(['recovery','list'])).value.data.journals.length,0);
});

test('changed saved CLI arguments block replay while preserving original bytes',async t=>{
  const f=await fixture(t),body=await f.request({mode:'create',record:{id:'note:arg-binding',name:'Argument binding',kind:'note',scope:'global',availability:'known',data:{},aliases:[],links:[],sources:[]}},[{kind:'record',id:'note:arg-binding'}]);
  assert.equal((await commitBeforeResponse(f,'put',body)).code,0);
  const folder=path.join(cliRoot(f),(await readdir(cliRoot(f)))[0]);
  const bytes=await readFile(path.join(folder,'request.json'));
  const context=JSON.parse(await readFile(path.join(folder,'context.json'),'utf8'));
  context.arguments.push('--db','elsewhere.db'); await writeFile(path.join(folder,'context.json'),JSON.stringify(context));
  const list=await f.cli(['recovery','list']);assert.equal(list.value.data.journals[0].replay_eligible,false);
  assert.notEqual((await f.cli(['recovery','replay',list.value.data.journals[0].key])).code,0);
  assert.deepEqual(await readFile(path.join(folder,'request.json')),bytes);
});

test('legacy direct Manager journal is visible and replayed through public recovery',async t=>{
  const f=await fixture(t),selection=await directInterfaceSelection(f.database);
  const body=await f.request({mode:'create',record:{id:'note:manager-journal',name:'Manager journal',kind:'note',scope:'global',availability:'known',data:{},aliases:[],links:[],sources:[]}},[{kind:'record',id:'note:manager-journal'}],null,{id:'user:fixture',agent:'human',harness:'manager',session:null});
  body.request_id='ll-'+randomUUID();const folder=path.join(f.root,'pending',body.request_id);await mkdir(folder,{recursive:true});
  const bytes=Buffer.from(JSON.stringify(body)+'\n'); await writeFile(path.join(folder,'request.json'),bytes);
  await writeFile(path.join(folder,'context.json'),JSON.stringify({generation:selection.generation,fingerprint:selection.fingerprint,runtime_fingerprint:selection.runtimeFingerprint,request_sha256:createHash('sha256').update(bytes).digest('hex'),node:selection.node,cli:selection.cli,database:f.database,database_instance_id:body.database_instance_id,database_epoch:body.database_epoch,operation:'put',cwd:null,project_id:null}));
  const list=await f.cli(['recovery','list']);assert.equal(list.value.data.journals[0].replay_eligible,true,JSON.stringify(list.value));
  const replay=await f.cli(['recovery','replay',list.value.data.journals[0].key]); assert.equal(replay.code,0,JSON.stringify(replay.value));
  assert.equal(replay.value.request.id,body.request_id);assert.deepEqual(await readFile(path.join(folder,'request.json')),bytes);
});

test('bare CLI retires its acknowledged journal while exact original request replays confirmed receipt',async t=>{
  const f=await fixture(t),body=await f.request({mode:'create',record:{id:'note:cli-journal',name:'CLI journal',kind:'note',scope:'global',availability:'known',data:{},aliases:[],links:[],sources:[]}},[{kind:'record',id:'note:cli-journal'}]);
  body.request_id=randomUUID(); const file=path.join(f.root,'original.json');
  const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n'); await writeFile(file,bytes);
  const put=await f.cli(['put','--file',file]); assert.equal(put.code,0,JSON.stringify(put.value));
  const names=await readdir(cliRoot(f));
  assert.equal(names.length,0);
  assert.deepEqual(await readFile(file),bytes);
  const replay=await f.cli(['put','--file',file]);assert.equal(replay.code,0);
  assert.equal(replay.value.request.replayed,true);assert.equal(replay.value.receipt_id,put.value.receipt_id);
  assert.equal(replay.value.revision,put.value.revision);
  const list=await f.cli(['recovery','list']);
  assert.equal(list.code,0); assert.equal(list.value.data.journals.length,0);
  assert.deepEqual(await readFile(file),bytes);
});
test('recovery listing exposes malformed journal instead of dropping it',async t=>{
  const f=await fixture(t),folder=path.join(f.root,'pending','cli-'+ 'a'.repeat(64));
  await mkdir(folder,{recursive:true}); await writeFile(path.join(folder,'request.json'),'{broken');
  const result=await f.cli(['recovery','list']);
  assert.equal(result.code,0); assert.equal(result.value.data.complete,true);
  assert.equal(result.value.data.journals.length,1);
  assert.equal(result.value.data.journals[0].replay_eligible,false);
  assert.match(result.value.data.journals[0].action,/Preserve/);
});
test('recovery key cannot escape declared roots or dispatch an arbitrary command',async t=>{
  const f=await fixture(t),before=createHash('sha256').update(await readFile(f.database)).digest('hex');
  const result=await f.cli(['recovery','replay','../../other']);
  assert.equal(result.code,2); assert.equal(result.value.ok,false);
  assert.equal(createHash('sha256').update(await readFile(f.database)).digest('hex'),before);
});
