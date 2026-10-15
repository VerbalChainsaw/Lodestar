import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setup, journey, option, captureAnswers } from './helpers/manager-operator.mjs';
import { loadInterfaceConfig } from '../src/interface-config.mjs';
import { executeCli } from '../src/interface-client.mjs';
import { runManager } from '../src/manager.mjs';
import { sameMachinePath } from '../src/project.mjs';
import { canonicalStringify } from '../src/json.mjs';

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
