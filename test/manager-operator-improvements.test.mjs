import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setup, journey, option, captureAnswers } from './helpers/manager-operator.mjs';
import { loadInterfaceConfig } from '../src/interface-config.mjs';
import { executeCli } from '../src/interface-client.mjs';
import { runManager } from '../src/manager.mjs';
import { sameMachinePath } from '../src/project.mjs';
import { canonicalStringify } from '../src/json.mjs';

test('M1 nested Records project jump resolves selected root through actual CLI without writes',async t=>{
  const s=await setup(t),before=await readFile(s.f.database); let jumped=false;
  const r=await journey(s,({title,menu})=>{
    if(title===`${s.a} (${s.a})`)return jumped?'q':option(menu,'Records');
    if(title==='Current associated records'){jumped=true;return 'p';}
    if(title==='Jump to project')return option(menu,s.b);
    if(title===`${s.b} (${s.b})`)return 'q';
    return 'q';
  });
  assert.match(r.output,/p: Jump to project/); assert.match(r.output,new RegExp(`${s.b} \\(${s.b}\\)`));
  assert.ok(r.calls.some(c=>c.operation==='start'&&sameMachinePath(c.args[2],s.second)));
  assert.deepEqual(await readFile(s.f.database),before);
});

test('A1 Project attention uses public selected read; details leave snapshot unchanged and Refresh re-reads',async t=>{
  const s=await setup(t),before=await readFile(s.f.database);let visits=0, opened=false;
  const r=await journey(s,({title,menu})=>{
    if(title===`${s.a} (${s.a})`){if(opened)return 'q';opened=true;return option(menu,'Project attention');}
    if(title==='Select attention intent')return '1';
    if(title==='Project attention actions')return ++visits===1?option(menu,'Refresh'): 'q';
    return 'q';
  });
  assert.equal(r.calls.filter(c=>c.operation==='work.attention').length,2,r.output);
  assert.match(r.output,/Recovery.*read.*runtime/is); assert.match(r.output,/database revision/i);
  assert.deepEqual(await readFile(s.f.database),before);
});

test('C1 guided create and associate are two separately confirmed exact puts; p body and default unverified survive',async t=>{
  const s=await setup(t);let original=(await s.f.cli(['get','--','knowledge:intent'])).value.data;
  const acceptance={intent_sha256:createHash('sha256').update(canonicalStringify(original.data.intent)).digest('hex'),blockers:[],results:[{requirement_id:'R2',status:'unverified',notes:'Preserve this sibling',evidence:[]}]};
  const seeded=await s.f.cli(['put'],await s.f.request({mode:'update',id:original.id,set:{data:{acceptance}},remove:[]},[{kind:'record',id:original.id}],s.a));
  assert.equal(seeded.code,0,JSON.stringify(seeded.value)); original=(await s.f.cli(['get','--',original.id])).value.data;let opened=false;
  const r=await journey(s,({prompt,title,menu})=>{
    if(prompt.startsWith('Type SAVE'))return 'SAVE';
    if(prompt.startsWith('Human author'))return 'Alex';
    if(prompt.startsWith('Record name'))return 'Observed result';
    if(prompt.startsWith('Body'))return 'p';
    if(prompt.startsWith('Observed outcome'))return 'Focused check passed';
    if(prompt.startsWith('Evidence reference'))return 'work/check.log';
    if(prompt.startsWith('Limitations'))return 'Only this branch';
    if(prompt.startsWith('Result notes'))return 'Needs human review';
    if(title===`${s.a} (${s.a})`){if(opened)return 'q';opened=true;return option(menu,'Capture / link');}
    if(title==='Select capture intent')return '1';
    if(title==='Capture purpose')return option(menu,'Requirement context and recorded result');
    if(title==='Select requirement')return '1';
    if(title==='Recorded result status')return option(menu,'Unverified');
    if(title==='Capture source')return option(menu,'Create result');
    if(title==='Capture review')return option(menu,'Save reviewed stage');
    return 'q';
  });
  const puts=r.calls.filter(c=>c.operation==='put');assert.equal(puts.length,2,r.output);
  const requests=await Promise.all(puts.map(c=>readFile(c.args[2],'utf8').then(JSON.parse)));
  const id=requests[0].input.record.id;const captured=(await s.f.cli(['get','--',id])).value.data;
  assert.equal(captured.data.body,'p');assert.equal(captured.semantics.applicability.project,s.a);
  const intent=(await s.f.cli(['get','--','knowledge:intent'])).value.data;
  assert.deepEqual(intent.data.intent,original.data.intent);
  assert.deepEqual(intent.data.acceptance.results.find(item=>item.requirement_id==='R2'),acceptance.results[0]);
  const result=intent.data.acceptance.results.find(item=>item.requirement_id==='R1');assert.equal(result.status,'unverified');
  assert.equal(result.evidence[0].revision,captured.revision);
  assert.equal(result.evidence[0].data_sha256,createHash('sha256').update(canonicalStringify(captured.data)).digest('hex'));
  const db=new DatabaseSync(s.f.database,{readOnly:true});try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records WHERE id=?').get(id).n,1);
    for(const request of requests) assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE type='mutation-receipt' AND json_extract(content_json,'$.value.request_id')=?").get(request.request_id).n,1);
  }finally{db.close();}
  assert.match(r.output,/Record saved; association not yet saved/);
  assert.equal((await readdir(path.join(s.f.root,'pending'))).length,2);
});

test('I1 Connection reads exact selected source identity and help support constants',async t=>{
  const s=await setup(t);let opened=false;
  const r=await journey(s,({title,menu})=> { if(title==='Main menu'){if(opened)return 'q';opened=true;return option(menu,'Connection');}return 'q';});
  assert.match(r.output,/coreSourceDigest/);assert.ok(r.output.includes(s.selection.coreSourceDigest));
  assert.match(r.output,/source_inventory/);assert.match(r.output,/"contract_version": 5/);assert.match(r.output,/"schema_version": 5/);
  assert.match(r.output,/packaged payload unverified/);
});

for(const decision of ['Keep draft and jump','Discard draft and jump','Cancel jump']) test(`M1 capture review ${decision} preserves original binding and requires preparation after navigation`,async t=>{
  const s=await setup(t);let phase='capture',review=0,jumps=0,projectA=0;
  const r=await journey(s,ctx=>{
    const {title,menu,prompt}=ctx;
    const answer=captureAnswers(ctx);if(answer!==null)return answer;
    if(prompt.startsWith('Type SAVE'))return 'SAVE';
    if(title===`${s.a} (${s.a})`) {projectA++;return phase==='done'?'q':option(menu,'Capture / link');}
    if(title==='Capture review') {if(++review===1)return 'p';phase='done';return option(menu,'Save reviewed stage');}
    if(title==='Unsaved capture draft')return option(menu,decision);
    if(title==='Jump to project')return option(menu,++jumps===1?s.b:s.a);
    if(title===`${s.b} (${s.b})`)return 'p';
    return 'q';
  });
  assert.equal(r.calls.filter(c=>c.operation==='put').length,2,r.output);
  const preparations=r.calls.filter(c=>c.operation==='work.prepare-capture');
  assert.ok(preparations.every(c=>sameMachinePath(c.args[3],s.f.root)));
  assert.equal(preparations.length,3,r.output);
  assert.equal(projectA,decision==='Cancel jump'?2:3);
  assert.ok(!r.calls.some(c=>c.operation==='put'&&c.args.includes(s.second)));
});

test('C3 confirmed creation plus literal p at attachment SAVE retains record; resumed association never recreates it',async t=>{
  const s=await setup(t);let project=0,save=0;
  const r=await journey(s,ctx=>{
    const answer=captureAnswers(ctx);if(answer!==null)return answer;
    if(ctx.prompt.startsWith('Type SAVE'))return ++save===2?'p':'SAVE';
    if(ctx.title===`${s.a} (${s.a})`)return ++project<3?option(ctx.menu,'Capture / link'):'q';
    if(ctx.title==='Capture review')return option(ctx.menu,'Save reviewed stage');
    return 'q';
  });
  const puts=r.calls.filter(c=>c.operation==='put');assert.equal(puts.length,2,r.output);
  const requests=await Promise.all(puts.map(c=>readFile(c.args[2],'utf8').then(JSON.parse)));
  assert.equal(requests.filter(v=>v.input.mode==='create').length,1);
  assert.equal(requests[1].input.mode,'update');
  assert.match(r.output,/Record .* retained; association not saved/);
  assert.ok(!r.output.includes('\nJump to project\n'), 'literal p at SAVE opened project selection');
});

test('C3 lost create response keeps exact journal; Recovery replays bytes once then Link existing succeeds',async t=>{
  const s=await setup(t);let project=0,puts=0,recordId,bytes,contextBytes;
  const r=await journey(s,ctx=>{
    if(ctx.prompt.startsWith('Type REPLAY'))return 'REPLAY';
    if(ctx.prompt.startsWith('Type SAVE'))return 'SAVE';
    if(ctx.prompt.startsWith('Existing record ID'))return recordId;
    if(ctx.title===`${s.a} (${s.a})`)return ++project<=3?option(ctx.menu,'Capture / link'):'q';
    if(ctx.title==='Capture recovery')return '1';
    if(ctx.title==='Saved requests (including completed receipts)')return '1';
    if(ctx.title==='Capture source'&&project===3)return option(ctx.menu,'Link existing record');
    if(ctx.title==='Capture review')return option(ctx.menu,'Save reviewed stage');
    return captureAnswers(ctx)??'q';
  },async(selected,invocation)=>{
    const result=await executeCli(selected,invocation);
    if(invocation.operation==='put'&&++puts===1) {
      bytes=await readFile(invocation.args[2]);const req=JSON.parse(bytes);recordId=req.input.record.id;
      contextBytes=await readFile(path.join(path.dirname(invocation.args[2]),'context.json'));
      assert.equal(result.kind,'EnvelopeSuccess');
      return {kind:'TransportError',code:'fixture_lost_response',message:'response lost after actual commit',mayHaveCommitted:true};
    }
    if(invocation.operation==='put'&&puts===2) {
      assert.deepEqual(await readFile(invocation.args[2]),bytes);
      assert.deepEqual(await readFile(path.join(path.dirname(invocation.args[2]),'context.json')),contextBytes);
    }
    return result;
  });
  assert.equal(puts,3,r.output);assert.match(r.output,/Creation confirmed.*Link existing record/s);
  const stored=(await s.f.cli(['get','--',recordId])).value.data;assert.equal(stored.data.body,'p');
  const intent=(await s.f.cli(['get','--','knowledge:intent'])).value.data;
  assert.deepEqual(intent.data.continuation.context.requirements[0].record_ids,[recordId]);
  assert.equal((await readdir(path.join(s.f.root,'pending'))).length,2);
});

test('I1 Connection shows observed database identity/revision separately from support constants',async t=>{
  const s=await setup(t);let opened=false;
  const r=await journey(s,({title,menu})=> {if(title==='Main menu'){if(opened)return 'q';opened=true;return option(menu,'Connection');}return 'q';});
  const expected=(await s.f.cli(['get','--','knowledge:intent'])).value;
  const connection=r.output.slice(r.output.indexOf('"config":'));
  assert.ok(connection.includes(expected.database_instance_id));assert.ok(connection.includes(expected.database_epoch));
  assert.match(connection,/"observed_revision": [0-9]+/);assert.match(connection,/"database_observation_time": "/);
});
