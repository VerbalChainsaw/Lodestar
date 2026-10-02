import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, temporaryDirectory } from './helpers/contract.mjs';
import { canonicalStringify } from '../src/json.mjs';
import { buildHumanRequest } from '../src/operator-actions.mjs';
import { directInterfaceSelection, sourceDigest } from '../src/interface-config.mjs';
import { admittedTransaction, openWriteDatabase } from '../src/database.mjs';

const scope = 'project:operator-improvements';
const hash = v => createHash('sha256').update(canonicalStringify(v)).digest('hex');
const intent = { version:1, brief:'Deliver the requested useful operator path', user_reference:'Director brief',
  requirements:[{id:'R1',text:'Capture useful results',acceptance:'Inspect saved evidence'},
    {id:'R2',text:'Preserve the other branch',acceptance:'Read the unchanged result'}], boundaries:[], non_goals:[] };
const current = {lifecycle:'current',context_role:'on_demand'};

test('OI capture diagnostics escape actual unknown JSON keys without changing saved state', async t => {
  const f = await setup(t), before = await readFile(f.database);
  const root = await f.associate({ 'a/b~c': true });
  assert.equal(root.value.error.code, 'invalid_input');
  assert.equal(root.value.error.identifiers.pointer, '/a~1b~0c');
  assert.deepEqual(await readFile(f.database), before);
  const nested = await f.prepare({ version: 1, stage: 'create', intent_record_id: 'knowledge:intent',
    author: 'Operator', record: { id: 'knowledge:pointer', type: 'knowledge', name: 'Pointer fixture',
      body: 'A rejected draft', 'a/b~c': true } });
  assert.equal(nested.value.error.code, 'invalid_input');
  assert.equal(nested.value.error.identifiers.pointer, '/record/a~1b~0c');
  assert.match(nested.value.error.action, /Correct the named capture field/);
  assert.deepEqual(await readFile(f.database), before);
});
const ok = r => { assert.equal(r.code,0,JSON.stringify(r.value)); return r.value.data; };
async function setup(t) {
  const f = await fixture(t);
  await f.create(scope,'project',{roots:[f.root]},scope);
  const proof = ok(await f.create('knowledge:proof','knowledge',{body:'Existing proof'},scope,current));
  const acceptance = {intent_sha256:hash(intent),blockers:['Preserve this blocker'],results:[{
    requirement_id:'R2',status:'unverified',notes:'Other recorded result',evidence:[{id:proof.id,revision:proof.revision}]}]};
  await f.create('knowledge:intent','knowledge',{intent,acceptance,tasks:[{runtime_task_id:'external:1',owner:'native',requirement_ids:['R2'],status:'recorded'}],
    continuation:{active_requirement_ids:['R1'],next_action:'Inspect the result'}},scope,current);
  let serial=0;
  const prepare = async draft => { const file=path.join(f.root,`draft-${++serial}.json`);await writeFile(file,JSON.stringify(draft));
    return f.cli(['work','prepare-capture','--cwd',f.root,'--file',file]); };
  const associate = (extra={}) => prepare({version:1,stage:'associate',intent_record_id:'knowledge:intent',author:'Operator',
    record_id:'knowledge:proof',context_target:{kind:'requirements',requirement_ids:['R1']},...extra});
  const save = d => f.cli(['put'],buildHumanRequest('put',d.input,d.write_basis,'Operator',`capture-${++serial}`));
  const get = async id => ok(await f.cli(['get','--',id]));
  return {...f,prepare,associate,save,get,acceptance};
}

test('OI C1 public prepare is read-only; create and fresh association save typed record without changing intent',async t=>{
  const f=await setup(t), before=await readFile(f.database);
  const created=ok(await f.prepare({version:1,stage:'create',intent_record_id:'knowledge:intent',author:'Operator',record:{
    id:'knowledge:result',type:'result',name:'Focused result',body:'Actual output',observed_outcome:'passed',evidence_reference:'check.log',limitations:'Selected path only'}}));
  assert.deepEqual(await readFile(f.database),before);
  assert.equal(created.operation,'put'); assert.equal(created.input.mode,'create');
  const saved=ok(await f.save(created)); assert.equal(saved.kind,'knowledge');
  assert.equal(saved.data.result.observed_outcome,'passed'); assert.equal(saved.semantics.context_role,'on_demand');
  assert.equal(saved.semantics.applicability.checkout.replaceAll('\\','/'),f.root.replaceAll('\\','/'));
  const link=ok(await f.associate({record_id:saved.id,acceptance_result:{requirement_id:'R1',status:'unverified',notes:'Inspect this log'}}));
  assert.equal(link.review.intent_sha256,hash(intent)); assert.equal(link.review.record_revision,saved.revision);
  ok(await f.save(link)); const actual=await f.get('knowledge:intent');
  assert.deepEqual(actual.data.intent,intent); assert.deepEqual(actual.data.acceptance.results[0],f.acceptance.results[0]);
  assert.deepEqual(actual.data.acceptance.blockers,f.acceptance.blockers); assert.equal(actual.data.tasks[0].runtime_task_id,'external:1');
  assert.deepEqual(actual.data.acceptance.results[1].evidence,[{id:saved.id,revision:saved.revision,data_sha256:hash(saved.data)}]);
  assert.equal(actual.data.acceptance.results[1].status,'unverified');
  assert.ok(ok(await f.cli(['work','check','--cwd',f.root,'--','knowledge:intent'])).requirements.find(r=>r.id==='R1').evidence.length);
});

test('OI C2 context-only preserves acceptance exactly; repeated association is a no-op',async t=>{
  const f=await setup(t), original=await f.get('knowledge:intent');
  const p=ok(await f.associate()); assert.equal(Object.hasOwn(p.input.set.data,'acceptance'),false); ok(await f.save(p));
  const actual=await f.get('knowledge:intent'); assert.equal(canonicalStringify(actual.data.acceptance),canonicalStringify(original.data.acceptance));
  const again=ok(await f.associate()); assert.equal(again.review.noop,true); assert.equal(again.input,null);
  assert.deepEqual(actual.data.continuation.context.requirements,[{id:'R1',record_ids:['knowledge:proof']}]);
});

test('OI C2 strict purpose, scope, retired and stale acceptance refusals leave bytes unchanged',async t=>{
  const f=await setup(t);
  await f.create('knowledge:foreign','knowledge',{body:'Foreign'},'project:other',current);
  await f.create('knowledge:retired','knowledge',{body:'Retired'},scope,{...current,lifecycle:'historical'});
  for(const extra of [{context_target:{kind:'requirements',requirement_ids:['unknown']}},{record_id:'knowledge:intent'},
    {record_id:'knowledge:foreign'},{record_id:'knowledge:retired'}, {context_target:null},
    {context_target:{kind:'requirements',requirement_ids:['R1','R1']}}]){
    const before=await readFile(f.database),r=await f.associate(extra); assert.notEqual(r.code,0,JSON.stringify(extra));
    assert.ok(r.value.error.identifiers.pointer || r.value.error.identifiers.id); assert.ok(r.value.error.action);
    assert.deepEqual(await readFile(f.database),before);
  }
  ok(await f.cli(['put'],await f.request({mode:'update',id:'knowledge:intent',set:{data:{intent:{...intent,brief:'Changed'}}},remove:[]},[{kind:'record',id:'knowledge:intent'}],scope)));
  const r=await f.associate({acceptance_result:{requirement_id:'R1',status:'passed',notes:'Explicit choice'}});
  assert.equal(r.value.error.code,'invalid_intent_contract'); assert.equal(r.value.error.identifiers.pointer,'/data/acceptance/intent_sha256');
});

test('OI C3 prepared basis rejects evidence drift; exact committed request replays one receipt and effect',async t=>{
  const f=await setup(t),p=ok(await f.associate());
  ok(await f.cli(['put'],await f.request({mode:'update',id:'knowledge:proof',set:{data:{body:'Changed'}},remove:[]},[{kind:'record',id:'knowledge:proof'}],scope)));
  assert.equal((await f.save(p)).value.error.code,'revision_conflict');
  const fresh=ok(await f.associate()), request=buildHumanRequest('put',fresh.input,fresh.write_basis,'Operator','exact-replay');
  const first=await f.cli(['put'],request);ok(first);const replay=await f.cli(['put'],request);ok(replay);
  assert.equal(replay.value.request.replayed,true);assert.equal(first.value.revision,replay.value.revision);
  const db=new DatabaseSync(f.database,{readOnly:true});try {
    const rows=db.prepare("SELECT content_json FROM records WHERE type='mutation-receipt'").all();
    assert.equal(rows.filter(r=>JSON.parse(r.content_json).value.request_id==='exact-replay').length,1);
  } finally {db.close();}
});

test('OI A1 coherent attention names absent selection and retains work/pending for malformed intent',async t=>{
  const f=await setup(t);await f.create('knowledge:second','knowledge',{intent},scope,current);
  const actor={id:'user:Operator',agent:'human',harness:'manager',session:null};
  ok(await f.cli(['work','start','--cwd',f.root],await f.request({id:'work:open',description:'Actual open work'},[{kind:'record',id:'work:open'}],scope,actor)));
  ok(await f.cli(['pending','add','--cwd',f.root],await f.request({id:'pending:item',text:'Unresolved candidate'},[{kind:'record',id:'pending:item'}],scope,actor)));
  const before=await readFile(f.database),data=ok(await f.cli(['work','attention','--cwd',f.root]));
  assert.equal(data.version,1);assert.equal(data.selected_intent_id,null);assert.equal(data.sections.acceptance.state,'not_selected');
  assert.equal(data.sections.work.items[0].id,'work:open');assert.equal(data.sections.pending.items[0].id,'pending:item');
  assert.equal(data.intents.length,2);assert.deepEqual(data.sections.work.read_args,['work','status','--cwd',f.root.replaceAll('\\','/')]);
  assert.deepEqual(await readFile(f.database),before);
  await f.create('knowledge:bad','knowledge',{intent:{version:99}},scope,current);
  const r=ok(await f.cli(['work','attention','--cwd',f.root,'--','knowledge:bad']));
  assert.equal(r.sections.acceptance.state,'unavailable');assert.equal(r.sections.work.items.length,1);assert.equal(r.complete,false);
});

test('OI P1 active dependency precedes noisy orientation at node frontier; whole oversized record leaves smaller useful row',async t=>{
  const f=await setup(t);
  await f.create('research:z-active','research',{body:'Active result '+ '😀'.repeat(70000)},scope,current);
  await f.create('rejection:z-needed','rejection',{reason:'Keep the existing owner',reconsider_when:'Changed brief'},scope,current);
  ok(await f.cli(['put'],await f.request({mode:'update',id:'research:z-active',set:{links:[{relationship:'requires',to_id:'rejection:z-needed'}]},remove:[]},[{kind:'record',id:'research:z-active'}],scope)));
  for(let i=0;i<258;i++) await f.create(`knowledge:a-noise-${String(i).padStart(3,'0')}`,'knowledge',{body:'Orientation noise'},scope,{...current,context_role:'orientation'});
  ok(await f.cli(['put'],await f.request({mode:'update',id:'knowledge:intent',set:{data:{continuation:{active_requirement_ids:['R1'],next_action:'Inspect dependency',
    context:{version:1,mission_record_ids:[],requirements:[{id:'R1',record_ids:['research:z-active']}]}}}},remove:[]},[{kind:'record',id:'knowledge:intent'}],scope)));
  const p=ok(await f.cli(['work','check','--cwd',f.root,'--','knowledge:intent'])).continuity;
  const needed=p.records.find(r=>r.id==='rejection:z-needed');assert.ok(needed,'Active dependency survives frontier and byte admission: '+JSON.stringify({ids:p.records.map(r=>r.id),issues:p.issues.map(r=>[r.code,r.identifiers]),limits:p.limits,omitted:p.omitted}).slice(0,6000));
  assert.equal(needed.selection.order,0);assert.match(needed.selection.reason,/active/);
  assert.ok(p.read_required.some(r=>r.target_id==='research:z-active' && r.read_args[2]==='research:z-active'));
  assert.ok(Buffer.byteLength(canonicalStringify(p))<=128*1024);assert.ok(p.limits.inspected_nodes<=256);
  assert.deepEqual(ok(await f.cli(['work','check','--cwd',f.root,'--','knowledge:intent'])).continuity,p);
});

test('OI I1 help/version publish existing constants; selected identity labels source bytes and digests differ for same release',async t=>{
  const f=await fixture(t);
  for(const args of [['help'],['version']]){const d=ok(await f.cli(args));assert.equal(d.version,'3.0.0');assert.equal(d.contract_version,5);assert.equal(d.schema_version,5);}
  const h=ok(await f.cli(['help'])),cap=h.operations.find(o=>o.id==='work.prepare-capture');
  assert.equal(cap.effect,'read');assert.equal(cap.input_schema,null);assert.equal(cap.mutation_request,null);assert.ok(cap.draft_schema.oneOf);
  const selected=await directInterfaceSelection(f.database);assert.match(selected.coreSourceDigest,/^[a-f0-9]{64}$/);assert.equal(selected.coreSourceBasis,'source_inventory');
  assert.match(selected.coreSourceNotice,/packaged payload unverified/);
  const a=await temporaryDirectory(t,'identity-a-'),b=await temporaryDirectory(t,'identity-b-');
  for(const dir of [a,b]){await mkdir(path.join(dir,'src'));await writeFile(path.join(dir,'lodestar.mjs'),'export {};');await writeFile(path.join(dir,'package.json'),'{"version":"3.0.0"}');}
  await writeFile(path.join(a,'src','one.mjs'),'a');await writeFile(path.join(b,'src','one.mjs'),'b');
  assert.notEqual(await sourceDigest(a,path.join(a,'lodestar.mjs')),await sourceDigest(b,path.join(b,'lodestar.mjs')));
});

test('OI capture variants and explicit first continuation use ordinary records and leave acceptance uncovered',async t=>{
  const f=await setup(t);
  ok(await f.cli(['put'],await f.request({mode:'update',id:'knowledge:intent',set:{data:{}},remove:['continuation','acceptance']},[{kind:'record',id:'knowledge:intent'}],scope)));
  const noContinuation=await f.associate();assert.equal(noContinuation.value.error.identifiers.pointer,'/initialize_continuation');
  const init={active_requirement_ids:[],next_action:'Read mission evidence'};
  const mission=ok(await f.associate({context_target:{kind:'mission'},initialize_continuation:init}));ok(await f.save(mission));
  const linked=await f.get('knowledge:intent');assert.equal(linked.data.acceptance,undefined);assert.deepEqual(linked.data.continuation.active_requirement_ids,[]);
  for(const type of ['knowledge','research']){
    const record={id:`${type}:capture`,type,name:'Captured knowledge',body:'Body with literal p\nand observed text',...(type==='research'?{source:'https://example.com/source',claim:'Operator supplied claim',limitations:'Source not fetched'}:{})};
    const p=ok(await f.prepare({version:1,stage:'create',intent_record_id:'knowledge:intent',author:'Operator',record}));ok(await f.save(p));
    const actual=await f.get(record.id);assert.equal(actual.kind,type);assert.equal(actual.data.body,record.body);assert.equal(actual.semantics.context_role,'on_demand');
    if(type==='research'){assert.equal(actual.data.acquisition,'operator_supplied');assert.equal(actual.data.reviewed_at,undefined);assert.equal(actual.data.body_sha256,createHash('sha256').update(record.body).digest('hex'));}
  }
  const evidence=ok(await f.associate({context_target:null,acceptance_result:{requirement_id:'R1',status:'failed',notes:'Explicit failed result'}}));
  ok(await f.save(evidence));const actual=await f.get('knowledge:intent');assert.equal(actual.data.acceptance.results.length,1);assert.equal(actual.data.acceptance.results[0].status,'failed');
  assert.deepEqual(actual.data.continuation,linked.data.continuation);
});

test('OI A1 overflow and damaged rows expose independent coverage and literal raw detail reads',async t=>{
  const f=await setup(t),actor={id:'user:Operator',agent:'human',harness:'manager',session:null};
  ok(await f.cli(['work','start','--cwd',f.root],await f.request({id:'work:open',description:'Open work'},[{kind:'record',id:'work:open'}],scope,actor)));
  ok(await f.cli(['pending','add','--cwd',f.root],await f.request({id:'pending:item',text:'Candidate'},[{kind:'record',id:'pending:item'}],scope,actor)));
  const db=await openWriteDatabase(f.database);
  try {
    admittedTransaction(db,()=>{
    const clone=db.prepare('INSERT INTO records(id,type,name,scope,content_json,created_at,updated_at) SELECT ?,type,?,scope,content_json,created_at,updated_at FROM records WHERE id=?');
    for(let i=0;i<51;i++){clone.run(`work:extra-${i}`,`Extra work ${i}`,'work:open');clone.run(`pending:extra-${i}`,`Extra candidate ${i}`,'pending:item');}
    for(let i=0;i<22;i++)clone.run(`knowledge:intent-${i}`,`Extra intent ${i}`,'knowledge:intent');
    clone.run('knowledge:damaged','Damaged source','knowledge:intent');
    const row=db.prepare('SELECT content_json FROM records WHERE id=?').get('knowledge:damaged');
    db.prepare('UPDATE records SET content_json=? WHERE id=?').run(row.content_json.replace('"Deliver the requested useful operator path"','9007199254740993'),'knowledge:damaged');
    },f.database);
  }finally{db.close();}
  const before=await readFile(f.database),p=ok(await f.cli(['work','attention','--cwd',f.root,'--','knowledge:intent']));
  assert.equal(p.sections.work.items.length,50);assert.equal(p.sections.pending.items.length,50);assert.equal(p.sections.work.omitted_count,2);
  assert.equal(p.intents.length,20);assert.equal(p.intent_inventory.more,true);assert.equal(p.intent_inventory.complete,false);
  assert.equal(p.sections.work.complete,false);assert.equal(p.sections.pending.more,true);assert.equal(p.complete,false);
  assert.ok(p.read_required.some(r=>r.target_id==='knowledge:damaged'&&r.read_args.includes('--raw')));
  assert.equal(p.sections.acceptance.state,'observed','Unresolved acceptance assertions do not imply incomplete read coverage');
  assert.deepEqual(await readFile(f.database),before);
});

test('OI capture strict transport rejects unknown keys, duplicate names and missing explicit evidence status',async t=>{
  const f=await setup(t);
  for(const extra of [{wrong:true},{acceptance_result:{requirement_id:'R1',notes:'No inferred status'}},{version:2}]){
    const before=await readFile(f.database),r=await f.associate(extra);assert.equal(r.value.error.code,'invalid_input');assert.ok(r.value.error.identifiers.pointer);assert.deepEqual(await readFile(f.database),before);
  }
  const file=path.join(f.root,'duplicate-draft.json');await writeFile(file,'{"version":1,"stage":"associate","author":"A","author":"B"}');
  const r=await f.cli(['work','prepare-capture','--cwd',f.root,'--file',file]);assert.equal(r.value.error.code,'invalid_json');assert.equal(r.value.error.identifiers.pointer,'/author');
});
