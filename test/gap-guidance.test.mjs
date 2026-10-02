import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
const actor={id:'agent:fixture',agent:'agent',harness:'fixture',session:'fixture'};
async function project(t){const f=await fixture(t);await f.create('project:test','project',{roots:[f.root]},'project:test');return f;}
test('missing mutation or search input reports the supported next action without changing the database', async t=>{
  const f=await fixture(t),before=await readFile(f.database);
  for(const command of ['put','delete','find']){
    const result=await f.cli([command]);assert.equal(result.code,2);
    assert.equal(result.value.error.code,'missing_argument',JSON.stringify(result.value));
    assert.match(result.value.error.action,command==='find'?/query|--all/:/--file.*stdin/);
  }
  assert.deepEqual(await readFile(f.database),before);
});
test('bare handoff and decision are explicit reads and preserve database bytes',async t=>{
  const f=await project(t),before=await readFile(f.database);
  for(const command of ['handoff','decision']){const result=await f.cli([command,'--cwd',f.root]);assert.equal(result.code,0,JSON.stringify(result.value));assert.equal(result.value.more,false);assert.equal(result.value.operation,command+'.'+(command==='decision'?'show':'status'));}
  assert.deepEqual(await readFile(f.database),before);
});
test('get revision pin refuses a newer basis and accepts the current one',async t=>{
  const f=await fixture(t);const first=await f.create('note:pin','note',{});await f.create('note:newer','note',{});
  const stale=await f.cli(['get','note:pin','--at-revision',String(first.value.revision)]);
  assert.equal(stale.code,3);assert.equal(stale.value.error.code,'read_revision_conflict');
  const current=await f.cli(['get','note:pin']);assert.equal((await f.cli(['get','note:pin','--at-revision',String(current.value.revision)])).code,0);
});
test('help publishes diagnostic exit four and decision status write effect',async t=>{
  const f=await fixture(t),help=await f.cli(['decision','--help']);
  assert.match(help.value.data.exit_codes['4'],/diagnostic|integrity/i);
  assert.match(help.value.data.summary,/status.*write/i);
});
test('generic put refuses an impossible operator-attested calendar date before a record write',async t=>{
  const f=await fixture(t),body=await f.request({mode:'create',record:{id:'research:bad-date',name:'Bad date',kind:'research',scope:'global',availability:'known',data:{review_acquisition:'operator_attested',reviewed_at:'2026-02-30',reviewed_by:'Alex',review_qualifiers:'Inspected source',source_version:null},aliases:[],links:[],sources:[]}},[{kind:'record',id:'research:bad-date'}]);
  const bytes=await readFile(f.database),result=await f.cli(['put'],body);
  assert.equal(result.code,2,JSON.stringify(result.value));assert.match(result.value.error.action,/date|review/i);assert.deepEqual(await readFile(f.database),bytes);
});
test('handoff and decision pages expose continuation without creating database writes',async t=>{
  const f=await project(t),checkpoint={objective:'Finish',current_state:'Saved',completed_results:[],unresolved_work:['Verify'],references:[]};
  for(let i=0;i<2;i++){
    const handoff=await f.request({id:'handoff:'+i,checkpoint},[{kind:'record',id:'handoff:'+i},{kind:'record',id:'project:test'}],'project:test',actor);
    assert.equal((await f.cli(['handoff','arm','--cwd',f.root],handoff)).code,0);
    const decision=await f.request({key:'choice:'+i,value:'Chosen',reason:'Evidence',status:'accepted'},[{kind:'decision',scope:'project:test',key:'choice:'+i},{kind:'record',id:'project:test'}],'project:test',actor);
    assert.equal((await f.cli(['decision','set','--cwd',f.root],decision)).code,0);
  }
  const before=await readFile(f.database);
  for(const args of [['handoff','status'],['decision','show']]){
    const first=await f.cli([...args,'--cwd',f.root,'--limit','1']);assert.equal(first.code,0,JSON.stringify(first.value));assert.equal(first.value.more,true);assert.equal(first.value.next.length,1);
    const next=await f.cli([first.value.next[0].command,...first.value.next[0].args]);assert.equal(next.code,0);assert.equal(next.value.more,false);
  }
  assert.deepEqual(await readFile(f.database),before);
});
