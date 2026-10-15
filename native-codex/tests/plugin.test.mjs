import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleHook } from '../scripts/lodestar-hook.mjs';
import { authorizePrompt, attestTool, executeWork, executeHandoff, recordTail, captureNotes, startupContext, extractNotes, parseHandoffCommand, canonical, sessionRecordId } from '../scripts/lodestar-runtime.mjs';
const entry=process.env.LODESTAR_ENTRY;
assert.ok(entry,'Set LODESTAR_ENTRY to the installed package entry for real CLI integration');
const root=await mkdtemp(path.join(os.tmpdir(),'lodestar-plugin-test-'));
after(() => rm(root, { recursive: true, force: true }));
const db=path.join(root,'fixture.db'), data=path.join(root,'plugin-data');
const env={...process.env, LODESTAR_NODE:process.execPath, LODESTAR_ENTRY:entry, LODESTAR_DB:db};
const init=spawnSync(process.execPath,[entry,'init','--db',db],{env,encoding:'utf8',windowsHide:true,timeout:20_000,maxBuffer:1024*1024});assert.equal(init.status,0,init.stderr||init.error?.message);
const opts={env,dataDir:data};
const host={session_id:'fixture-host-session',turn_id:'turn-1',cwd:root};
let call=0;
const packet={goal:'Preserve full packet',rules:['Keep every rule'],entries:[{key:'one',state:'fact',text:'body',scope:['test'],provenance:{kind:'user',sourceRef:'test',observedAt:'2026-10-08'},generation:1}],work:{progress:'done'},nextMove:'Continue',evidence:[{note:'proof'}],custom:{deep:['retained']}};
async function invoke(family,command,args={},override={}) {
 const name=`lodestar_${family}_${command}`, h={...host,...override,tool_use_id:`tool-${++call}`,tool_name:name,tool_input:args};
 if(family==='handoff'&&command!=='status') await authorizePrompt({...h,prompt:`handoff ${command}`},data);
 const token=await attestTool(h,data);assert.equal(token.allowed,true,token.reason);
 return (family==='work'?executeWork:executeHandoff)(`lodestar__${name}`,token.updatedInput,data,opts);
}
test('exact authorization and tokens bind tool, arguments, TTL and single use',async()=>{
 assert.equal(parseHandoffCommand("don't handoff now"),null);assert.equal(parseHandoffCommand('$handoff now'),'now');
 let h={...host,tool_name:'lodestar_handoff_arm',tool_use_id:'security-1',tool_input:{packet}};
 assert.equal((await attestTool(h,data)).allowed,false);
 await authorizePrompt({...h,prompt:'handoff now'},data);assert.equal((await attestTool(h,data)).allowed,false);
 await assert.rejects(executeWork('lodestar_work_status',{},data,opts),/Missing host/);
 h={...h,tool_name:'lodestar_work_status',tool_use_id:'security-2',tool_input:{}};
 let token=await attestTool(h,data);
 await assert.rejects(executeWork('lodestar_work_start',{...token.updatedInput,report:'changed'},data,opts),/mismatched/);
 await assert.rejects(executeWork('lodestar_work_status',token.updatedInput,data,opts));
 token=await attestTool(h,data,0);await assert.rejects(executeWork('lodestar_work_status',token.updatedInput,data,{...opts,now:()=>700000}),/expired/);
 token=await attestTool(h,data);await executeWork('lodestar_work_status',token.updatedInput,data,opts);
 await assert.rejects(executeWork('lodestar_work_status',token.updatedInput,data,opts));
});
test('all work operations use v5 real CLI with session isolation and truthful outcomes',async()=>{
 let r=await invoke('work','start',{report:'Repair owner TOKEN=secret-value'});assert.equal(r.result.record.kind,'work');assert.match(r.result.record.data.description,/REDACTED/);
 let peer=await invoke('work','start',{report:'Peer area'},{session_id:'peer-session'});assert.notEqual(peer.result.record.id,r.result.record.id);
 let status=await invoke('work','status');assert.equal(status.result.records.length,2);
 await assert.rejects(invoke('work','done',{outcome:'verified'}),/requires evidence/);
 r=await invoke('work','done',{report:'Finished'});assert.equal(r.result.record.data.status,'closed');assert.equal(r.result.record.data.last_outcome.outcome,'completed');
 await invoke('work','start',{report:'Verify owner'});r=await invoke('work','done',{outcome:'verified',evidence:[{command:'node --test',result:'pass'}]});assert.equal(r.result.record.data.last_outcome.outcome,'verified');
});
test('handoff lifecycle preserves packet and tails only while session armed',async()=>{
 assert.equal(await recordTail(host,'user','Not armed',opts),false);
 let r=await invoke('handoff','arm',{packet});assert.deepEqual(r.result.record.data.checkpoint.references[0].packet,packet);
 assert.equal(await recordTail(host,'user','User API_KEY=private',opts),true);
 let status=await invoke('handoff','status');let record=status.result.records.find(r=>r.data.source_actor===`codex:${host.session_id}`);
 assert.match(record.data.checkpoint.references.at(-1).text,/REDACTED/);
 assert.equal(await recordTail({...host,session_id:'unarmed-peer'},'assistant','peer',opts),false);
 r=await invoke('handoff','checkpoint',{packet:{...packet,nextMove:'Checkpoint'}});assert.equal(r.result.record.data.checkpoint.current_state,'Checkpoint');
 r=await invoke('handoff','now',{packet:{...packet,nextMove:'Transfer now'}});assert.equal(r.result.record.data.state,'open');assert.equal(r.result.record.data.checkpoint.current_state,'Transfer now');
 r=await invoke('handoff','disarm');assert.equal(r.result.record.data.state,'cancelled');assert.equal(await recordTail({...host,turn_id:'later'},'assistant','No reopen',opts),false);
});
test('pending notes deduplicate/max three, redact, quarantine; startup complete markers',async()=>{
 const text='LODESTAR NOTE: one API_KEY=private\nLODESTAR NOTE: one API_KEY=private\nLODESTAR NOTE: two\nLODESTAR NOTE: three\nLODESTAR NOTE: four';
 assert.equal(extractNotes(text).length,3);assert.equal(await captureNotes(host,text,opts),3);assert.equal(await captureNotes(host,text,opts),3);
 const transport=await import(pathToFileURL(path.join(path.dirname(entry),'codex-plugin/scripts/lodestar-runtime.mjs')));
 const pending=await transport.runInstalledLodestar(['pending','list','--cwd',root],{env});assert.equal(pending.data.records.length,3);assert.ok(pending.data.records.every(r=>r.semantics.lifecycle==='unresolved'&&r.semantics.context_role==='on_demand'));
 const context=await startupContext(host,opts);assert.ok(context.startsWith('Lodestar startup context'));assert.ok(context.endsWith('stop before mutation.'));assert.ok(context.includes('"required_complete":true'));
});
test('journal keeps exact requests and confirmed replay avoids duplicate dispatch',async()=>{
 const h={...host,turn_id:'recovery',tool_use_id:'same-logical-call',tool_name:'lodestar_work_start',tool_input:{report:'Recovery'}}, token=await attestTool(h,data);
 const first=await executeWork(h.tool_name,token.updatedInput,data,opts);
 const secondToken=await attestTool(h,data);const second=await executeWork(h.tool_name,secondToken.updatedInput,data,opts);assert.deepEqual(second,first);
 const files=await readdir(path.join(data,'requests'));const journals=await Promise.all(files.map(f=>readFile(path.join(data,'requests',f),'utf8').then(JSON.parse)));
 assert.ok(journals.every(j=>j.request.v===5&&j.request.write_basis&&j.request.request_id&&j.host.toolUseId));assert.ok(journals.every(j=>j.state==='confirmed'));
});

test('unknown journal replays exact original receipt; stale original basis is rejected',async()=>{
 const h={...host,turn_id:'unknown-outcome',tool_use_id:'original-request',tool_name:'lodestar_work_start',tool_input:{report:'Original operation'}}, t=await attestTool(h,data);
 const first=await executeWork(h.tool_name,t.updatedInput,data,opts);
 const files=await readdir(path.join(data,'requests'));let file,saved;
 for(const f of files){const j=JSON.parse(await readFile(path.join(data,'requests',f),'utf8'));if(j.host.turnId===h.turn_id){file=path.join(data,'requests',f);saved=j;break;}}
 const requestBytes=canonical(saved.request);await writeFile(file,canonical({...saved,state:'unknown',result:undefined}));
 const again=await attestTool({...h,turn_id:'later-reconciliation',tool_use_id:'new-host-call'},data);const replay=await executeWork(h.tool_name,again.updatedInput,data,opts);assert.equal(replay.result.record.id,first.result.record.id);
 const settled=JSON.parse(await readFile(file,'utf8'));assert.equal(canonical(settled.request),requestBytes);assert.equal(settled.result.request.replayed,true);
 const runtime=await import(pathToFileURL(path.join(path.dirname(entry),'codex-plugin/scripts/lodestar-runtime.mjs')));
 await invoke('work','start',{report:'New revision'},{turn_id:'new-revision'});
 const stale={...saved.request,request_id:'new-logical-request-with-stale-basis',input:{...saved.request.input,description:'Must reject'}};
 await assert.rejects(runtime.runInstalledLodestar([...runtime.mutationCommand('work.start',stale),'--session',host.session_id,'--agent','codex','--harness','codex'],{env,input:canonical(stale),operation:'work.start',effect:'domain_write'}),e=>e.toolResult.write_outcome==='rejected'&&e.toolResult.error.code==='revision_conflict');
});

test('read revision fencing and optional hook diagnostics keep failures visible',async()=>{
 const runtime=await import(pathToFileURL(path.join(path.dirname(entry),'codex-plugin/scripts/lodestar-runtime.mjs')));
 const before=await runtime.runInstalledLodestar(['start','--cwd',root,'--session',host.session_id,'--agent','codex','--harness','codex'],{env});
 await invoke('work','start',{report:'Revision change for read fencing'},{turn_id:'read-fence'});
 await assert.rejects(runtime.runInstalledLodestar(['get','--at-revision',String(before.revision),'--',sessionRecordId('work',before.data.project,{sessionId:host.session_id})],{env}),e=>e.toolResult.error.code==='read_revision_conflict');
 const output=await handleHook({hook_event_name:'Stop',last_assistant_message:'LODESTAR NOTE: requires real host identity'},data);
 assert.equal(output.continue,true);assert.equal(output.captureErrors.length,2);assert.match(output.systemMessage,/capture failed/);
});

test('handoff now recovers unknown second phase before any new checkpoint',async()=>{
 const args={packet:{...packet,nextMove:'Two-phase recovery'}};
 const h={...host,turn_id:'two-phase-original',tool_use_id:'two-phase-tool',tool_name:'lodestar_handoff_now',tool_input:args};
 await authorizePrompt({...h,prompt:'handoff now'},data);
 const token=await attestTool(h,data);const first=await executeHandoff(h.tool_name,token.updatedInput,data,opts);
 const files=await readdir(path.join(data,'requests'));let file,saved;
 for(const name of files){const j=JSON.parse(await readFile(path.join(data,'requests',name),'utf8'));if(j.host.turnId===h.turn_id&&j.operation==='handoff.now'){file=path.join(data,'requests',name);saved=j;break;}}
 assert.ok(saved);const original=canonical(saved.request);
 await writeFile(file,canonical({...saved,state:'unknown',result:undefined}));
 const runtime=await import(pathToFileURL(path.join(path.dirname(entry),'codex-plugin/scripts/lodestar-runtime.mjs')));
 const read=()=>runtime.runInstalledLodestar(['start','--cwd',root,'--session',host.session_id,'--agent','codex','--harness','codex'],{env});
 const before=await read();
 await assert.rejects(invoke('handoff','now',{packet:{...args.packet,nextMove:'Changed intent'}},{turn_id:'changed-intent'}),/unresolved outcome/);
 assert.equal((await read()).revision,before.revision);
 const retry={...h,turn_id:'two-phase-later',tool_use_id:'new-two-phase-tool'};
 await authorizePrompt({...retry,prompt:'handoff now'},data);const newToken=await attestTool(retry,data);
 const replay=await executeHandoff(h.tool_name,newToken.updatedInput,data,opts);assert.equal(replay.result.record.id,first.result.record.id);
 const settled=JSON.parse(await readFile(file,'utf8'));assert.equal(canonical(settled.request),original);assert.equal(settled.result.request.replayed,true);
 assert.equal((await read()).revision,before.revision);assert.equal((await readdir(path.join(data,'requests'))).length,files.length);
});

test('committed work survives response disconnect and exact replay prevents another dispatch', async (t) => {
 const runtime=await import(pathToFileURL(path.join(path.dirname(entry),'codex-plugin/scripts/lodestar-runtime.mjs')));
 const read=()=>runtime.runInstalledLodestar(['start','--cwd',root,'--session',host.session_id,'--agent','codex','--harness','codex'],{env});
 const h={...host,turn_id:'real-write-disconnect',tool_use_id:'first-write',tool_name:'lodestar_work_start',tool_input:{report:'Committed despite disconnected response'}};
 const first=await attestTool(h,data), next=await attestTool({...h,tool_use_id:'must-not-dispatch',tool_input:{report:'Must remain queued'}},data);
 const before=await read();
 const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/lodestar-mcp.mjs',import.meta.url))],{env:{...env,PLUGIN_DATA:data},windowsHide:true});
 const timer=setTimeout(()=>child.kill(),20_000);
 t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();});
 let stderr='';child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});child.stdin.on('error',()=>{});
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
 child.stdout.destroy();
 child.stdin.end([first,next].map((token,index)=>JSON.stringify({jsonrpc:'2.0',id:index,method:'tools/call',params:{name:h.tool_name,arguments:token.updatedInput}})).join('\n')+'\n');
 const exit=await closed;clearTimeout(timer);
 assert.equal(exit.status,1);assert.equal(exit.signal,null);assert.match(stderr,/^Lodestar MCP response delivery failed/);assert.doesNotMatch(stderr,/Unhandled|\n\s+at /);
 const committed=await read();assert.equal(committed.revision,before.revision+1);
 const journals=await Promise.all((await readdir(path.join(data,'requests'))).map(file=>readFile(path.join(data,'requests',file),'utf8').then(JSON.parse)));
 const saved=journals.find(j=>j.host.turnId===h.turn_id);
 assert.equal(saved.state,'confirmed');assert.equal(saved.result.request.committed_revision,committed.revision);
 assert.equal(journals.filter(j=>j.host.turnId===h.turn_id).length,1);
 assert.ok(await readFile(path.join(data,'attestations',`${next.updatedInput._attestation}.json`)),'The queued operation must not consume its attestation');
 const retry=await attestTool(h,data);
 await executeWork(h.tool_name,retry.updatedInput,data,opts);
 assert.equal((await read()).revision,committed.revision);
});
