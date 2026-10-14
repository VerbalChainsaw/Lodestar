import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {fixture} from './helpers/contract.mjs';
import {runCli} from '../src/cli.mjs';
import {loadFindPages,executeCli} from '../src/interface-client.mjs';
import {directInterfaceSelection,loadInterfaceConfig,revalidateSelection} from '../src/interface-config.mjs';
import {prepareCliJournal,listRecovery,recoveryReplay} from '../src/recovery-journal.mjs';

async function savedRequest(f){
 const body=await f.request({mode:'create',record:{id:'note:runtime',name:'Runtime',kind:'note',scope:'global',availability:'known',data:{},aliases:[],links:[],sources:[]}},[{kind:'record',id:'note:runtime'}]);
 const selection=await directInterfaceSelection(f.database);
 const journal=await prepareCliJournal(selection,'put',{options:{},positionals:[]},['put'],{stdin:Readable.from([JSON.stringify(body)])});
 return {body,selection,journal};
}

test('record budget resumes at core-owned cursor without duplicates or omitted rows',async t=>{
 const f=await fixture(t);for(const id of ['a','b','c','d'])await f.create('note:'+id,'note',{});
 const selection=await directInterfaceSelection(f.database);
 const first=await loadFindPages(selection,['--all','--limit','3'],{maxRecords:2});
 assert.deepEqual(first.records.map(x=>x.id),['note:a','note:b']);assert.equal(first.complete,false);
 assert.equal(first.continuation.args[first.continuation.args.indexOf('--offset')+1],'2');
 assert.equal(first.continuation.args[first.continuation.args.indexOf('--at-revision')+1],String(first.revision));
 const rest=await loadFindPages(selection,first.continuation.args);
 assert.deepEqual([...first.records,...rest.records].map(x=>x.id),['note:a','note:b','note:c','note:d']);
 const unbounded=await loadFindPages(selection,['--all'],{maxRecords:1});
 assert.deepEqual(unbounded.records.map(x=>x.id),['note:a']);
 assert.deepEqual((await loadFindPages(selection,unbounded.continuation.args)).records.map(x=>x.id),['note:b','note:c','note:d']);
 await f.create('note:e','note',{});
 const changed=await executeCli(selection,{operation:'find',args:['find',...first.continuation.args]});
 assert.equal(changed.kind,'EnvelopeError');assert.match(changed.envelope.error.code,/revision/);
});

test('partial legacy context cannot suppress journaling and dispatch an unrecoverable write',async t=>{
 const f=await fixture(t),{body,selection}=await savedRequest(f);
 const folder=path.join(f.root,'pending','unbound-copy');await mkdir(folder,{recursive:true});
 const bytes=Buffer.from(JSON.stringify(body));await writeFile(path.join(folder,'request.json'),bytes);
 await writeFile(path.join(folder,'context.json'),JSON.stringify({database:f.database,operation:'put',request_sha256:createHash('sha256').update(bytes).digest('hex'),database_instance_id:body.database_instance_id,database_epoch:body.database_epoch}));
 const file=path.join(folder,'request.json');
 const captured=await prepareCliJournal(selection,'put',{options:{'--file':file},positionals:[]},['put','--file',file],{});
 assert.ok(captured);assert.notEqual(captured.folder,folder);
 const before=await readdir(path.join(f.root,'cli-pending'));let error='';
 const code=await runCli(['--db',f.database,'put','--file',file],{stdout:{write(){throw new Error('Lost response');}},stderr:{write:x=>error+=x}});
 assert.equal(code,5);assert.equal(JSON.parse(error).error.code,'response_delivery_failed');
 assert.equal((await f.cli(['get','note:runtime'])).value.ok,true);
 assert.equal((await readdir(path.join(f.root,'cli-pending'))).length,before.length+1);
 assert.deepEqual(await readFile(file),bytes);
});

for(const kind of ['EnvelopeError','TransportError','EnvelopeSuccess'])test(`replay response save failure preserves certainty for ${kind}`,async t=>{
 const f=await fixture(t),{body,selection,journal}=await savedRequest(f);
 const key=(await listRecovery(selection)).journals[0].key;
 await assert.rejects(recoveryReplay(selection,key,async()=>{
  const response=kind==='EnvelopeSuccess'?(await f.cli(['put','--file',path.join(journal.folder,'request.json')])).value:
   {v:5,ok:false,operation:'put',revision:null,database_instance_id:null,database_epoch:null,more:false,next:[],error:{code:'database_busy',message:'No transaction started',identifiers:{committed:false},action:'Retry exact request'}};
  await mkdir(path.join(journal.folder,'response.json'));
  return {kind,envelope:response,mayHaveCommitted:kind==='TransportError'};
 }),error=>{
  assert.equal(error.code,'response_delivery_failed');assert.equal(error.identifiers.committed,kind==='EnvelopeSuccess'?true:'unknown');
  if(kind!=='EnvelopeSuccess'){assert.equal(Object.hasOwn(error.identifiers,'receipt_read_args'),false);assert.equal(Object.hasOwn(error.identifiers,'committed_revision'),false);}
  return true;
 });
});

test('configured nonstandard CLI bytes participate in source inventory and revalidation',async t=>{
 const f=await fixture(t),cli=path.join(f.root,'selected-cli.mjs'),config=path.join(f.root,'interfaces.json');
 await writeFile(path.join(f.root,'package.json'),'{}');await writeFile(cli,'console.log("original")');
 await writeFile(config,JSON.stringify({v:1,generation:randomUUID(),runtime:{node:process.execPath,cli,database:f.database}}));
 const selection=await loadInterfaceConfig(config,{requireLoader:false});await writeFile(cli,'console.log("changed")');
 await assert.rejects(revalidateSelection(selection),{code:'interface_config_changed'});
});
