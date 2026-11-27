import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, appendFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('./review.mjs',import.meta.url));
const event=(type,turn_id)=>({type:'event_msg',payload:{type,turn_id}});
const message=(role,text)=>({type:'response_item',payload:{type:'message',role,phase:'final_answer',content:[{type:role==='user'?'input_text':'output_text',text}]}});
const codex=(id,...lines)=>[event('task_started',id),...lines.map(x=>message('user',x)),message('assistant','Verified the export in the fixture.'),event('task_complete',id)];
const rows=arr=>arr.map(x=>JSON.stringify(x)+'\n').join('');
const claude=(role,text,extra={})=>({type:role,sessionId:'claude-session',message:{role,stop_reason:role==='assistant'?'end_turn':null,content:[{type:'text',text}]},...extra});
async function fixture(t,spec,maxProposals){
 const root=await realpath(await mkdtemp(join(tmpdir(),'lodestar-logs-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const state=join(root,'state.json'), config=join(root,'config.json');
 const sources=spec.map(([id,format,project,start='begin'])=>({id,format,project,start,path:join(root,id+'.jsonl')}));
 await writeFile(config,JSON.stringify({version:1,state,sources,maxProposals}));
 const run=(op,code=0)=>{
  const r=spawnSync(process.execPath,[cli,op,config],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,code,r.stdout+'\n'+r.stderr);return JSON.parse(r.stdout);
 };
 return {state,config,sources,run};
}
test('Codex incrementally commits complete turns, ordered user items, privacy filters, crash-safe dedup',async t=>{
 const {sources:[{path}],state,run}=await fixture(t,[['one','codex','project-a']]);
 const turn=codex('a','Decision: retain the older public layout','TODO: Check the Windows shortcut');
 const done=rows(turn.slice(-1));
 await writeFile(path,rows(turn.slice(0,-1))+done.slice(0,-1));
 assert.equal(run('once').added,0);
 const held=JSON.parse(await readFile(state,'utf8')); assert.equal(held.cursors.one.pending.items.length,3);
 await appendFile(path,'\n');
 const second=run('once'); assert.equal(second.added,3); assert.equal(second.bytesRead,Buffer.byteLength(done));
 const saved=await readFile(state,'utf8');
 assert.equal(run('once').bytesRead,0);assert.equal(await readFile(state,'utf8'),saved);
 const found=run('review').proposals;assert.deepEqual(found.map(x=>x.kind),['decision','open-work','unverified-report']);
 assert.ok(found.every(x=>x.project==='project-a'&&x.status==='proposal'&&Number.isSafeInteger(x.evidence.byteOffset)));
 await appendFile(path,rows(codex('replay','TODO: Check the Windows shortcut','Fix the credential token ABCDEFG', '> TODO: quoted advice')));
 assert.equal(run('once').added,0);
});
test('Claude final text, tool/meta filtering, missing source isolation, and cross-project dedup',async t=>{
 const {sources:[a,b,c],run}=await fixture(t,[['a','claude','p1'],['b','claude','p2'],['c','codex','p1']]);
 const text='TODO: Check the dev package';
 const turn=rows([claude('user','TODO: do not capture this',{isMeta:true}),claude('user',text),claude('assistant','Unfinished',{message:{role:'assistant',stop_reason:null,content:[]}}),{...claude('user',''),message:{role:'user',content:[{type:'tool_result',content:'TODO: not human'}]}},claude('assistant','Done.')]);
 await writeFile(a.path,turn);await writeFile(b.path,turn);
 const partial=run('once',2);assert.equal(partial.ok,false);assert.equal(partial.added,2);
 assert.deepEqual(run('review').proposals.map(x=>x.project),['p1','p2']);
 await writeFile(c.path,rows(codex('t',text)));assert.equal(run('once').added,1); // Assistant report only.
});
test('begin detects truncation, retained proposals are capped; oversized and malformed lines are skipped',async t=>{
 const {sources:[s],run}=await fixture(t,[['a','codex','p']],10);
 await writeFile(s.path,'x'.repeat(270000)+'\n{bad}\n'+rows(Array.from({length:14},(_,i)=>codex('t'+i,'TODO: Verify candidate '+i)).flat()));
 const a=run('once');assert.equal(a.bytesRead,256*1024);assert.equal(a.added,0);
 const b=run('once');assert.equal(b.sources[0].skipped,2);assert.equal(b.added,15);
 assert.equal(run('status').proposalCount,10);
 await writeFile(s.path,rows(codex('new','TODO: Rebuild replacement safely')));
 const rotated=run('once');assert.equal(rotated.sources[0].rotated,true);assert.equal(rotated.added,2);
 assert.deepEqual(run('review').proposals.slice(-2).map(x=>x.kind),['open-work','unverified-report']);
});
test('end onboarding skips history and handles append; status and review do not read missing sources',async t=>{
 const {sources:[s],run}=await fixture(t,[['a','codex','p','end']]);
 await writeFile(s.path,rows(codex('old','TODO: Ignore earlier history')));
 assert.equal(run('once').bytesRead,0);
 await appendFile(s.path,rows(codex('new','TODO: Record the new work')));
 assert.equal(run('once').added,2);
 await rm(s.path);assert.equal(run('status').proposalCount,2);assert.equal(run('once',2).ok,false);
});
test('incomplete and mixed turns never become proposals; only fingerprints survive',async t=>{
 const {sources:[a,b],state,run}=await fixture(t,[['a','codex','p'],['b','claude','p']]);
 const privateText='TODO: private-person-name-123 Check the fixture';
 await writeFile(a.path,rows([
  event('task_started','private-turn-id'),message('user',privateText),event('task_complete','private-turn-id'),
  event('task_started','aborted'),message('user',privateText),message('assistant','Done.'),event('turn_aborted','aborted'),
  event('task_started','wrong'),message('user',privateText),message('assistant','Done.'),event('task_complete','other'),
  event('task_started','private-turn-id'),message('user',privateText),
 ]));
 await writeFile(b.path,rows([claude('user',privateText),claude('assistant','Done.',{sessionId:'other'})]));
 assert.equal(run('once').added,0);
 const checkpoint=await readFile(state,'utf8');
 for(const value of ['private-person-name-123','private-turn-id','claude-session'])assert.ok(!checkpoint.includes(value));
 await appendFile(a.path,rows([message('assistant','Fixed: private-other-name'),event('task_complete','private-turn-id')]));
 assert.equal(run('once').added,2);
 const review=run('review');
 assert.deepEqual(review.proposals.map(x=>x.kind),['open-work','unverified-report']);
 for(const value of ['private-person-name-123','private-other-name','private-turn-id']) {
  assert.ok(!JSON.stringify(review).includes(value));
  assert.ok(!(await readFile(state,'utf8')).includes(value));
 }
});
test('fails closed on legacy or extra checkpoint data, disallows persistent mode',async t=>{
 const {sources:[a],state,run}=await fixture(t,[['a','codex','p']]);
 await writeFile(a.path,rows(codex('a','TODO: Review typed evidence')));
 assert.equal(run('once').added,2);
 const saved=JSON.parse(await readFile(state,'utf8'));
 for(const bad of [{...saved,version:1},{...saved,proposals:[{...saved.proposals[0],text:'private text'}]}]){
  await writeFile(state,JSON.stringify(bad));
  const failure=run('review',2);assert.equal(failure.ok,false);assert.ok(!JSON.stringify(failure).includes('private text'));
 }
 assert.match(run('watch',2).error,/Usage/);
});

test('bad UTF-8 cannot bridge a pending turn to its completion',async t=>{
 const {sources:[a],run}=await fixture(t,[['a','codex','p']]);
 const valid=codex('a','TODO: The skipped bytes should break this turn');
 await writeFile(a.path,Buffer.concat([Buffer.from(rows(valid.slice(0,-1))),Buffer.from([0xc0,0x0a]),Buffer.from(rows(valid.slice(-1)))]));
 const result=run('once');
 assert.equal(result.sources[0].skipped,1);
 assert.equal(result.added,0);
});

test('refuses checkpoint reuse under a different project scope and does not alter existing state',async t=>{
 const {sources:[a],config,state,run}=await fixture(t,[['a','codex','p1']]);
 await writeFile(a.path,rows(codex('one','TODO: Keep this in the first project')));
 assert.equal(run('once').added,2);
 const previous=await readFile(state,'utf8');
 const settings=JSON.parse(await readFile(config,'utf8'));
 settings.sources[0].project='p2';
 await writeFile(config,JSON.stringify(settings));
 assert.equal(run('once',2).ok,false);
 assert.equal(run('review',2).ok,false);
 assert.equal(await readFile(state,'utf8'),previous);
});
