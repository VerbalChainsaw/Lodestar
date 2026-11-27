import {createHash, randomUUID} from 'node:crypto';
import {lstat, open, realpath, rename, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const BATCH=256*1024, MAX_LINE=64*1024, MAX_STATE=2*1024*1024;
const HASH=s=>createHash('sha256').update(s).digest('hex');
const HEX=/^[a-f0-9]{64}$/;
const DECODER=new TextDecoder('utf-8',{fatal:true});
const ID=/^[a-z0-9][a-z0-9_.-]{0,79}$/i;
const safePath=p=>typeof p==='string'&&isAbsolute(p)&&!p.includes('\0');
const samePath=(a,b)=>relative(a,b)==='';
const error=msg=>Object.assign(new Error(msg),{safe:true});
const empty=()=>({offset:0,identity:null,anchor:null,dropping:false,pending:null,session:null});
const signature=(source,s)=>HASH([source.id,source.format,source.project,source.path,s.birthtimeMs,s.dev,s.ino].join('\0'));
const RULES=[
 ['decision',/^(?:we (?:decided|agreed)|decision\s*:|i(?:'ve| have) decided|we(?:'re| are) going with)\b|^decision\s*:/i],
 ['defect',/^(?:bug|defect|regression|blocker)\s*:|^(?:still broken|this still fails|the .{1,90} still (?:fails|doesn.t work))\b/i],
 ['open-work',/^(?:todo|next step|follow[ -]?up|open (?:item|task))\s*:|^(?:still need to|we (?:still )?need to|i (?:still )?need (?:you )?to|(?:please )?(?:fix|repair|implement|finish|add|investigate|verify))\b/i],
 ['constraint',/^(?:constraint|requirement)\s*:|^(?:do not|don.t|never) (?:change|remove|send|publish|store|overwrite|delete|use|enable|install)\b/i],
 ['unverified-report',/^(?:implemented|fixed|verified|merged|released|shipped|blocked|tests? passed|project status)\b/i],
];
const secret=/(?:-----BEGIN|authorization\s*:|\bbearer\b|\b(?:password|passwd|secret|api[ _-]?key|token|credential|cookie|private[ _-]?key)\b|\b(?:sk[-_]|gh[pousr]_|github_pat_|AKIA|xox[baprs]-)[A-Za-z0-9_-]{8,})/i;
const clean=s=>s.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/g,' ').trim();
function extract(text, role, at){
 if(typeof text!=='string'||text.length>MAX_LINE||secret.test(text))return [];
 let fenced=false; const out=[];
 for(const line of text.split(/\r?\n/).slice(0,180)){
  if(/^\s*(?:\x60{3,}|~{3,})/.test(line)){fenced=!fenced;continue}
  if(fenced||/^\s*[>|]/.test(line))continue;
  const statement=clean(line.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/,''));
  if(statement.length<12)continue;
  const match=RULES.find(([kind,re])=>(role==='assistant')===(kind==='unverified-report')&&re.test(statement));
  if(match)out.push({kind:match[0],fingerprint:HASH(statement.toLowerCase()),role,at});
  if(out.length===8)break;
 }
 return out;
}
function items(content, allowed){
 if(typeof content==='string')return content;
 if(!Array.isArray(content))return '';
 return content.filter(b=>allowed.includes(b?.type)&&typeof b.text==='string').map(b=>b.text).join('\n');
}
function retain(pending, candidates, max=12){
 for(const row of candidates)if(pending.length<max)pending.push(row);
}
function feed(source,c,row,at){
 if(!row||typeof row!=='object')return [];
 if(source.format==='codex'){
  const p=row.payload;
  if(row.type==='event_msg'){
   if(p?.type==='task_started'){
    c.pending=typeof p.turn_id==='string'&&ID.test(p.turn_id)?{id:HASH(p.turn_id),items:[],user:false,final:false}:null;
   } else if(p?.type==='task_complete'||p?.type==='turn_aborted'){
    const q=c.pending;c.pending=null;
    if(q?.user&&q.final&&p.type==='task_complete'&&label(p.turn_id)&&q.id===HASH(p.turn_id))return q.items;
   }
  } else if(c.pending&&row.type==='response_item'&&p?.type==='message'){
   if(p.role==='user'){
    const text=items(p.content,['input_text']);
    if(text){c.pending.user=true;retain(c.pending.items,extract(text,'user',at),8)}
   } else if(p.role==='assistant'&&p.phase==='final_answer'){
    const text=items(p.content,['output_text']);
    if(text){c.pending.final=true;retain(c.pending.items,extract(text,'assistant',at))}
   }
  }
  return [];
 }
 // Claude Code: only a human text item and a matching final assistant message.
 // Meta, synthetic, sidechain, tool-only and assistant streaming fragments are ignored.
 if(row.isMeta||row.isSidechain||row.isSynthetic||typeof row.sessionId!=='string'||!ID.test(row.sessionId))return [];
 const session=HASH(row.sessionId);
 if(c.session!==null&&c.session!==session){c.pending=null;return []}
 c.session=session;
 if(row.type==='user'&&row.message?.role==='user'){
  const text=items(row.message.content,['text']);
  if(!text)return []; // Tool results do not invalidate the pending human prompt.
  if(/^\s*</.test(text)){c.pending=null;return []} // Local command and internal envelopes.
  c.pending={items:extract(text,'user',at),user:true};
 }else if(row.type==='assistant'&&row.message?.role==='assistant'&&row.message.stop_reason==='end_turn'){
  const q=c.pending;c.pending=null;
  const text=items(row.message.content,['text']);
  if(q?.user&&text){retain(q.items,extract(text,'assistant',at));return q.items}
 }
 return [];
}

async function boundedFile(path,limit){
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw error('Not a regular, bounded file.');
 const f=await open(path,'r');
 let data;
 try{
  const opened=await f.stat();
  if(!opened.isFile()||opened.ino!==info.ino||opened.dev!==info.dev)throw error('File replaced while opening.');
  data=await readRange(f,0,limit+1);
  if(data.length>limit)throw error('File exceeded read limit.');
 }finally{await f.close()}
 return JSON.parse(data.toString('utf8').replace(/^\uFEFF/,''));
}
function validateConfig(value){
 if(value?.version!==1||!safePath(value.state)||!Array.isArray(value.sources)||value.sources.length<1||value.sources.length>32)throw error('Expected version 1, an absolute state path and 1–32 explicit sources.');
 const ids=new Set(), paths=new Set();
 const state=resolve(value.state);
 const sources=value.sources.map(s=>{
  if(!s||!label(s.id)||!label(s.project)||!['codex','claude'].includes(s.format)||!safePath(s.path)||!['begin','end'].includes(s.start))throw error('Each source needs an id, project, format (codex or claude), exact absolute path, and start (begin or end).');
  const path=resolve(s.path),key=process.platform==='win32'?path.toLowerCase():path;
  if(ids.has(s.id.toLowerCase())||paths.has(key)||[state,state+'.lock'].some(p=>samePath(p,path)))throw error('Duplicate source or path overlaps checkpoint.');
  ids.add(s.id.toLowerCase()); paths.add(key);
  return {id:s.id,project:s.project,format:s.format,path,start:s.start};
 });
 const integer=(n, fallback, lo, hi)=>{
  const x=n===undefined?fallback:n;
  if(!Number.isInteger(x)||x<lo||x>hi)throw error('Config numeric value outside allowed range '+lo+'–'+hi+'.');
  return x;
 };
 const maxProposals=integer(value.maxProposals,300,10,1000);
 return {state,sources,maxProposals,scope:HASH(JSON.stringify(sources))};
}
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)
 &&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const offset=n=>Number.isSafeInteger(n)&&n>=0;
const digest=s=>typeof s==='string'&&HEX.test(s);
const label=s=>typeof s==='string'&&ID.test(s);
const classified=(kind,role)=>RULES.some(([name])=>name===kind)
 &&role===(kind==='unverified-report'?'assistant':'user');
function validCursor(c,format){
 if(!exact(c,['offset','identity','anchor','dropping','pending','session'])
  ||!offset(c.offset)||!digest(c.identity)||!digest(c.anchor)||typeof c.dropping!=='boolean'
  ||!(c.session===null||(format==='claude'&&digest(c.session))))return false;
 if(c.pending===null)return true;
 const p=c.pending;
 return (format==='codex'?exact(p,['id','items','user','final'])&&digest(p.id)&&typeof p.final==='boolean'
                         :exact(p,['items','user']))
  &&typeof p.user==='boolean'&&Array.isArray(p.items)&&p.items.length<=12
  &&p.items.every(x=>exact(x,['kind','fingerprint','role','at'])&&classified(x.kind,x.role)
      &&digest(x.fingerprint)&&offset(x.at)&&x.at<c.offset);
}
function validateState(s,cfg) {
 const sources=new Map(cfg.sources.map(x=>[x.id,x]));
 const ok=exact(s,['version','scope','cursors','proposals'])&&s.version===2&&s.scope===cfg.scope
   &&s.cursors&&typeof s.cursors==='object'&&!Array.isArray(s.cursors)
   &&Object.entries(s.cursors).every(([id,c])=>sources.has(id)&&validCursor(c,sources.get(id).format))
   &&Array.isArray(s.proposals)&&s.proposals.length<=1000
   &&s.proposals.every(x=>exact(x,['id','project','kind','role','status','evidence'])
       &&digest(x.id)&&classified(x.kind,x.role)&&x.status==='proposal'
       &&exact(x.evidence,['sourceId','generation','byteOffset'])
       &&sources.get(x.evidence.sourceId)?.project===x.project&&digest(x.evidence.generation)
       &&offset(x.evidence.byteOffset));
 if(!ok)throw error('Checkpoint is invalid, legacy, or out of scope. Retain it privately and use a new state path.');
 return s;
}
async function readState(cfg){
 try{return validateState(await boundedFile(cfg.state,MAX_STATE),cfg)}
 catch(e){if(e.code==='ENOENT')return {version:2,scope:cfg.scope,cursors:Object.create(null),proposals:[]};throw e}
}
async function save(cfg,state){
 const bytes=JSON.stringify(state);
 if(Buffer.byteLength(bytes)>MAX_STATE)throw error('Review checkpoint exceeded its size limit.');
 const temp=cfg.state+'.'+randomUUID()+'.tmp';
 const f=await open(temp,'wx',0o600);
 try{try{await f.writeFile(bytes);await f.sync()}finally{await f.close()};await rename(temp,cfg.state)}
 finally{await unlink(temp).catch(()=>{})}
}
async function lock(cfg,fn){
 const name=cfg.state+'.lock';
 let f;
 try{f=await open(name,'wx',0o600)}catch(e){
  if(e.code==='EEXIST')throw error('Checkpoint is locked. Stop the other scan; only remove a stale lock after confirming its recorded process has exited.');
  throw e;
 }
 try{await f.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));return await fn()}
 finally{try{await f.close()}finally{await unlink(name)}}
}
async function readRange(f,from,len){
 if(len<=0)return Buffer.alloc(0);
 const b=Buffer.alloc(len),{bytesRead}=await f.read(b,0,len,from);
 return b.subarray(0,bytesRead);
}
async function anchor(f,offset){
 const from=Math.max(0,offset-96);return HASH(await readRange(f,from,offset-from));
}
async function scanSource(source,prior){
 // No recursive discovery or symlink traversal. An exact configured file is the only input.
 const physical=await realpath(source.path);
 if(!samePath(physical,source.path))throw error('Source resolves elsewhere; use its exact physical path.');
 const nameStat=await lstat(source.path);
 if(!nameStat.isFile()||nameStat.isSymbolicLink())throw error('Source is not a regular file.');
 const f=await open(source.path,'r');
 try{
  const s=await f.stat();
  if(!s.isFile()||signature(source,s)!==signature(source,nameStat))throw error('Source changed while opening; retry.');
  let c=structuredClone(prior??empty());
  const identity=signature(source,s);
  if(!Number.isSafeInteger(c.offset)||c.offset<0||s.size>Number.MAX_SAFE_INTEGER)throw error('Unsupported checkpoint or file size.');
  const changed=c.identity!==null&&(identity!==c.identity||s.size<c.offset||c.anchor!==await anchor(f,c.offset));
  if(changed)c=empty();
  if(c.identity===null){
   c.identity=identity;
   if(source.start==='end'){
    c.offset=s.size;
    c.dropping=s.size>0&&(await readRange(f,s.size-1,1))[0]!==10;
   }
  }
  const from=c.offset, before=await anchor(f,from);
  const buf=await readRange(f,from,Math.min(BATCH,s.size-from));
  let pos=0, skipped=0; const candidates=[];
  while(pos<buf.length){
   const end=buf.indexOf(10,pos);
   if(end<0){
    if(c.dropping||buf.length-pos>MAX_LINE){c.dropping=true;c.pending=null;pos=buf.length}
    break;
   }
   if(c.dropping||end-pos>MAX_LINE){c.dropping=false;skipped++;c.pending=null}
   else {
    let row;
    try{
     row=JSON.parse(DECODER.decode(buf.subarray(pos,end)));
     if(!row||typeof row!=='object'||Array.isArray(row))throw error('Invalid event record.');
    }catch{row=null;skipped++;c.pending=null}
    if(row)candidates.push(...feed(source,c,row,from+pos));
   }
   pos=end+1;
  }
  c.offset=from+pos;
  c.anchor=await anchor(f,c.offset);
  const after=await f.stat();
  if(after.size<s.size||before!==await anchor(f,from))throw error('Log changed during scan; leave checkpoint unchanged and retry.');
  return {cursor:c, bytes:buf.length, completedBytes:pos, skipped, rotated:changed, candidates};
 }finally{await f.close()}
}
async function scan(cfg){
 return lock(cfg,async()=>{
  const s=await readState(cfg), seen=new Set(s.proposals.map(x=>x.id));
  const summary={ok:true, added:0, bytesRead:0, sources:[]};
  let changed=false;
  for(const source of cfg.sources){
   let out;
   try{out=await scanSource(source,Object.hasOwn(s.cursors,source.id)?s.cursors[source.id]:null)}catch(e){
    summary.ok=false;summary.sources.push({id:source.id,error:e.safe?e.message:e.code??'READ_FAILED'});continue;
   }
   if(JSON.stringify(s.cursors[source.id])!==JSON.stringify(out.cursor)){
    Object.defineProperty(s.cursors,source.id,{value:out.cursor,writable:true,enumerable:true,configurable:true});changed=true;
   }
   summary.bytesRead+=out.bytes;
   summary.sources.push({id:source.id,offset:out.cursor.offset,processedBytes:out.completedBytes,skipped:out.skipped,rotated:out.rotated});
   for(const item of out.candidates){
    const key=HASH(JSON.stringify([source.project,item.kind,item.fingerprint]));
    if(seen.has(key))continue;
    seen.add(key);
    s.proposals.push({id:key,project:source.project,kind:item.kind,role:item.role,status:'proposal',evidence:{sourceId:source.id,generation:out.cursor.identity,byteOffset:item.at}});
    summary.added++;changed=true;
   }
  }
  if(s.proposals.length>cfg.maxProposals){s.proposals=s.proposals.slice(-cfg.maxProposals);changed=true}
  if(changed)await save(cfg,s);
  return summary;
 });
}
const emit=value=>console.log(JSON.stringify(value));
export async function main(argv){
 const [mode, configPath]=argv;
 if(argv.length!==2||!['once','status','review'].includes(mode))throw error('Usage: node tools/chat-evidence/review.mjs <once|status|review> <config.json>');
 const config=resolve(configPath);
 const cfg=validateConfig(await boundedFile(config,64*1024));
 if([cfg.state,cfg.state+'.lock',...cfg.sources.map(s=>s.path)].some(p=>samePath(config,p)))throw error('Config, state, and source paths must be distinct.');
 if(!samePath(await realpath(dirname(cfg.state)),dirname(cfg.state)))throw error('State directory must use its exact physical path.');
 if(mode==='status'||mode==='review'){
  const s=await readState(cfg);
  emit(mode==='review'?{ok:true,total:s.proposals.length,proposals:s.proposals.slice(-50)}:{ok:true,proposalCount:s.proposals.length,sources:cfg.sources.map(x=>({id:x.id,project:x.project,offset:Object.hasOwn(s.cursors,x.id)?s.cursors[x.id].offset:0}))});
 }else{
  const out=await scan(cfg);emit(out);return out.ok?0:2;
 }
 return 0;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{process.exitCode=await main(process.argv.slice(2))}
 catch(e){emit({ok:false,error:e.safe?e.message:e.code??'INVALID_CONFIG_OR_STATE'});process.exitCode=2}
}
