import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { loadInterfaceConfig } from '../src/interface-config.mjs';
import { executeCli } from '../src/interface-client.mjs';
import { runManager } from '../src/manager.mjs';
import { sameMachinePath } from '../src/project.mjs';
import { canonicalStringify } from '../src/json.mjs';

async function setup(t) {
  const f = await fixture(t), a = 'project:operator-a', b = 'project:operator-b';
  await f.create(a, 'project', { roots: [f.root] }, a);
  const second = path.join(f.root, 'second'); await mkdir(second);
  await f.create(b, 'project', { roots: [second] }, b);
  await f.create('knowledge:intent', 'knowledge', { intent: { version: 1, brief: 'Deliver the selected branch', user_reference: 'Operator request', boundaries: ['One store'], non_goals: ['No daemon'], requirements: [{id:'R1', text:'Capture evidence', acceptance:'Review actual evidence'},{id:'R2',text:'Preserve sibling',acceptance:'Inspect sibling'}] }, continuation: { active_requirement_ids:['R1'], next_action:'Inspect result', context:{version:1,mission_record_ids:[],requirements:[]} } }, a);
  const config = path.join(f.root, 'interfaces.json'), loader = path.join(f.root, 'loader.exe');
  await writeFile(loader, 'fixture'); await writeFile(config, JSON.stringify({v:1,generation:randomUUID(),loader,runtime:{node:process.execPath,cli:fileURLToPath(new URL('../lodestar.mjs',import.meta.url)),database:f.database}}));
  return {f,a,b,second,selection:await loadInterfaceConfig(config)};
}
async function journey(s, answer, execute = executeCli) {
  let output='', count=0; const calls=[];
  const code=await runManager({selection:s.selection,initialProject:s.a,initialCwd:s.f.root,io:{stdout:{write:text=>{output+=text;}},stdin:{}},ask:async prompt=> {
    assert.ok(++count<60, `Script did not finish: ${output.slice(-3000)}`);
    const title=output.trimEnd().split('\n').filter(line=>line&&!line.startsWith('  ')).at(-1);
    const menu=output.slice(output.lastIndexOf(`\n${title}`));
    return answer({prompt,title,menu,output});
  },execute:async(selected,invocation)=>{calls.push(invocation);return execute(selected,invocation);}});
  return {output,calls,code};
}
const option=(menu,text)=>menu.split('\n').find(line=>line.includes(`. ${text}`))?.match(/^\s*(\d+)\./)?.[1]??'q';

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

function captureAnswers({title,prompt,menu}) {
  if(prompt.startsWith('Human author'))return 'Alex';
  if(prompt.startsWith('Record name'))return 'Captured note';
  if(prompt.startsWith('Body'))return 'p';
  if(title==='Select capture intent')return '1';
  if(title==='Capture purpose')return option(menu,'Requirement context only');
  if(title==='Select requirement')return '1';
  if(title==='Capture source')return option(menu,'Create knowledge');
  return null;
}
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

for (const corrupt of ['input','basis','version','basis-target','review-target','intent-change']) test(`C malformed ${corrupt} preparation cannot journal or dispatch put`,async t=>{
  const s=await setup(t);let opened=false;const before=await readFile(s.f.database);
  const r=await journey(s,ctx=>{
    if(ctx.title===`${s.a} (${s.a})`){if(opened)return 'q';opened=true;return option(ctx.menu,'Capture / link');}
    return captureAnswers(ctx)??'q';
  },async(selected,invocation)=>{
    const result=await executeCli(selected,invocation);
    if(invocation.operation==='work.prepare-capture'&&result.kind==='EnvelopeSuccess') {
      if(corrupt==='input')result.envelope.data.input={mode:'update',id:'project:other',set:{data:{}}};
      if(corrupt==='basis')result.envelope.data.write_basis.targets='bad';
      if(corrupt==='version')result.envelope.data.version=999;
      if(corrupt==='basis-target')result.envelope.data.write_basis.targets=result.envelope.data.write_basis.targets.filter(target=>target.id!=='knowledge:intent');
      if(corrupt==='review-target')result.envelope.data.review.record_revision=123;
      if(corrupt==='intent-change') { result.envelope.data.stage='create'; result.envelope.data.input.record.semantics.applicability.project=s.b; }
    }
    return result;
  });
  assert.match(r.output,/malformed or unsupported/);assert.ok(!r.calls.some(c=>c.operation==='put'));
  assert.deepEqual(await readFile(s.f.database),before);
});
test('C3 stale association guard rejects after actual evidence change; retained ID resumes without another create',async t=>{
  const s=await setup(t);let project=0,associationAttempt=false,recordId;
  const r=await journey(s,ctx=>{
    if(ctx.prompt.startsWith('Type SAVE'))return 'SAVE';
    if(ctx.title===`${s.a} (${s.a})`)return ++project<=2?option(ctx.menu,'Capture / link'):'q';
    if(ctx.title==='Capture review')return option(ctx.menu,'Save reviewed stage');
    return captureAnswers(ctx)??'q';
  },async(selected,invocation)=>{
    if(invocation.operation==='put') {
      const req=JSON.parse(await readFile(invocation.args[2]));
      if(req.input.mode==='create')recordId=req.input.record.id;
      else if(!associationAttempt){associationAttempt=true;
        const changed=await s.f.cli(['put'],await s.f.request({mode:'update',id:recordId,set:{data:{body:'A later observed source body'}},remove:[]},[{kind:'record',id:recordId}],s.a));assert.equal(changed.code,0,JSON.stringify(changed.value));
      }
    }
    return executeCli(selected,invocation);
  });
  const writes=r.calls.filter(c=>c.operation==='put');assert.equal(writes.length,3,r.output);
  const requests=await Promise.all(writes.map(c=>readFile(c.args[2],'utf8').then(JSON.parse)));
  assert.equal(requests.filter(request=>request.input.mode==='create').length,1);
  assert.match(r.output,/revision_conflict/);assert.match(r.output,/Record .* retained; association not saved/);
  const checked=(await s.f.cli(['work','check','--cwd',s.f.root,'--','knowledge:intent'])).value.data;
  assert.ok(checked.continuity.records.some(record=>record.id===recordId));
});

test('A2 uncertain original-project journal remains visible while attention refreshes another project and bytes stay bound',async t=>{
  const s=await setup(t);let phase='capture',jump=0,recordId,requestBytes,contextBytes,journalFile,attention=0;
  const r=await journey(s,ctx=>{
    if(ctx.prompt.startsWith('Type SAVE'))return 'SAVE';
    if(ctx.title===`${s.a} (${s.a})`) {if(phase==='capture'){phase='jump';return option(ctx.menu,'Capture / link');}return phase==='jump'?'p':'q';}
    if(ctx.title==='Capture review')return option(ctx.menu,'Save reviewed stage');
    if(ctx.title==='Jump to project'){phase=++jump===1?'attention':'done';return option(ctx.menu,jump===1?s.b:s.a);}
    if(ctx.title===`${s.b} (${s.b})`)return attention===0?option(ctx.menu,'Project attention'):'p';
    if(ctx.title==='Project attention actions'){attention++;return attention===1?option(ctx.menu,'Refresh'):'q';}
    return captureAnswers(ctx)??'q';
  },async(selected,invocation)=>{
    const result=await executeCli(selected,invocation);
    if(invocation.operation==='put') {
      journalFile=invocation.args[2];requestBytes=await readFile(journalFile);recordId=JSON.parse(requestBytes).input.record.id;
      contextBytes=await readFile(path.join(path.dirname(journalFile),'context.json'));
      assert.equal(result.kind,'EnvelopeSuccess');return {kind:'TransportError',code:'fixture_lost_response',message:'actual create committed; response lost',mayHaveCommitted:true};
    }
    return result;
  });
  assert.equal(r.calls.filter(c=>c.operation==='put').length,1,r.output);assert.equal(attention,2,r.output);
  assert.ok(r.calls.filter(c=>c.operation==='work.attention').every(c=>sameMachinePath(c.args[3],s.second)));
  assert.match(r.output.slice(r.output.indexOf('Project attention ·')),new RegExp(`"scope": "${s.a}"`));
  assert.deepEqual(await readFile(journalFile),requestBytes);assert.deepEqual(await readFile(path.join(path.dirname(journalFile),'context.json')),contextBytes);
  assert.equal(JSON.parse(contextBytes).project_id,s.a);assert.ok(sameMachinePath(JSON.parse(contextBytes).cwd,s.f.root));
  assert.equal((await s.f.cli(['get','--',recordId])).code,0);
});
for (const surface of ['Intent / continuity','Project attention']) test(`M1 menu-only jump from nested ${surface} resolves B without writes`,async t=>{
  const s=await setup(t),before=await readFile(s.f.database);let opened=false;
  const r=await journey(s,({title,menu})=>{
    if(title===`${s.a} (${s.a})`){if(opened)return 'q';opened=true;return option(menu,surface);}
    if(title==='Select attention intent')return '1';
    if(title==='Intent / continuity actions'||title==='Project attention actions')return 'p';
    if(title==='Jump to project')return option(menu,s.b);
    return 'q';
  });
  assert.ok(r.calls.some(c=>c.operation==='start'&&sameMachinePath(c.args[2],s.second)),r.output);
  assert.ok(!r.calls.some(c=>c.operation==='put'));assert.deepEqual(await readFile(s.f.database),before);
});
test('I1 Connection shows observed database identity/revision separately from support constants',async t=>{
  const s=await setup(t);let opened=false;
  const r=await journey(s,({title,menu})=> {if(title==='Main menu'){if(opened)return 'q';opened=true;return option(menu,'Connection');}return 'q';});
  const expected=(await s.f.cli(['get','--','knowledge:intent'])).value;
  const connection=r.output.slice(r.output.indexOf('"config":'));
  assert.ok(connection.includes(expected.database_instance_id));assert.ok(connection.includes(expected.database_epoch));
  assert.match(connection,/"observed_revision": [0-9]+/);assert.match(connection,/"database_observation_time": "/);
});
