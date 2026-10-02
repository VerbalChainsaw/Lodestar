import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MUTATION_INPUTS } from "./cli-commands.mjs";
import { revalidateSelection, sourceDigest } from "./interface-config.mjs";
import { assertTextBytes, JSON_INPUT_MAXIMUM_BYTES, parseJsonText, readTextFileComplete, readStreamComplete } from "./json.mjs";
import { normalizeMutationRequest } from "./records.mjs";
import { lodestarError, wrapError } from "./errors.mjs";
import { resolveIdentity } from "./project.mjs";
import { resolveInputPath } from "./paths.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Only the handle returned for this invocation's newly created directory owns
// retirement. Replays, earlier journals and other producers cannot acquire it.
const ownedCliJournals = new WeakMap();
const writes = new Set(["put", "delete", ...Object.keys(MUTATION_INPUTS)]);
const identity = value => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const invocationId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const subject = request => request.input?.id ?? request.input?.record?.id ?? request.input?.key ?? request.request_id;
export const recoveryRoot = selection => path.join(path.dirname(selection.database), "cli-pending");
const rootList = selection => [...new Set([recoveryRoot(selection),
  path.join(path.dirname(selection.database), "pending"),
  ...(selection.configPath ? [path.join(path.dirname(selection.configPath), "pending"),
    ...(process.platform === "win32" && process.env.LOCALAPPDATA ?
      [path.join(process.env.LOCALAPPDATA,"Lodestar Loader","pending")] : [])] : [])])];
const keyFor = folder => hash(path.resolve(folder));
const fail = (message, folder, code = "recovery_journal_invalid") => lodestarError(code, message, {
  identifiers: { journal: folder }, action: `Preserve '${folder}' and its exact request. Inspect context.json, request.json and the original receipt with the configured Lodestar before replay or a new request.`,
});
async function plain(candidate) {
  for (let walk=path.resolve(candidate);;) {
    try { if ((await lstat(walk)).isSymbolicLink()) throw fail("Recovery path contains a symlink or reparse link.", candidate); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent=path.dirname(walk); if(parent===walk) break; walk=parent;
  }
}
const journalLimit = file => path.basename(file)==="response.json" ? 64*1024*1024 : JSON_INPUT_MAXIMUM_BYTES;
async function json(file) { await plain(file); return parseJsonText(await readTextFileComplete(file,{resource:"recovery journal",maximum:journalLimit(file)})); }
async function optionalJson(file) { try{return await json(file);}catch(error){if(error.code==="ENOENT"||error.cause?.code==="ENOENT")return null;throw error;} }
async function publish(file, value) {
  await plain(file); const temporary=`${file}.${randomUUID()}.tmp`;
  const text=JSON.stringify(value)+"\n";
  assertTextBytes(text,journalLimit(file),"recovery state",{path:file});
  await writeFile(temporary,text,{flag:"wx",flush:true,mode:0o600});
  await rename(temporary,file);
}
async function proofs(selection) {
  const node=await stat(selection.node,{bigint:true});
  const ticks=node.mtimeNs/100n+621355968000000000n;
  const source=await sourceDigest(path.dirname(selection.configPath??selection.cli),selection.cli);
  return { native: hash([selection.generation,selection.node,String(node.size),String(ticks),
    selection.cli,source,selection.database].join("\n")) };
}
function receiptFor(request) {
  return "mutation-receipt:"+hash(JSON.stringify([request.database_instance_id,request.database_epoch,request.request_id]));
}
function cliBinding(selection,request,bytes,operation,args){
  const logical=[...args];
  logical[logical.indexOf("--file")+1]=path.join(recoveryRoot(selection),"cli-"+hash(request.request_id),"request.json");
  return hash(JSON.stringify([hash(bytes),operation,logical,selection.node,selection.cli,selection.runtimeFingerprint]));
}
function settles(response, request, operation, priorUnknown) {
  if(response?.v!==5||response.operation!==operation||response.more!==false||!Array.isArray(response.next))return false;
  if(response.ok===true){
    const identityMatches = response.database_instance_id===request.database_instance_id &&
    response.database_epoch===request.database_epoch && response.request?.id===request.request_id &&
    typeof response.request.replayed==="boolean" && Number.isSafeInteger(response.request.committed_revision) &&
    response.request.committed_revision>0 && response.revision===response.request.committed_revision &&
    response.receipt_id===receiptFor(request);
    if(!identityMatches)return false;
    if(['put','delete'].includes(operation))return response.data?.id===subject(request) && (operation!=='delete'||response.data.retired===true);
    if(operation==='pending.drop')return response.data?.record?.id===subject(request);
    if(operation==='decision.set')return typeof response.data?.changed==='boolean' &&
      (response.data.changed?response.data.record?.data?.key:response.data.current?.key)===subject(request);
    return true;
  }
  return response.ok===false && !priorUnknown && typeof response.error?.code==="string" &&
    typeof response.error.message==="string" && typeof response.error.action==="string" &&
    (response.database_instance_id==null||response.database_instance_id===request.database_instance_id) &&
    (response.database_epoch==null||response.database_epoch===request.database_epoch) &&
    (response.request==null||response.request.id===request.request_id) &&
    response.error.identifiers?.committed!==true && response.error.identifiers?.committed!=="unknown" &&
    !["internal_error","response_delivery_failed","database_commit_outcome_unknown"].includes(response.error.code);
}

// Read adapters preserve legacy native/Manager bytes. They verify the producer's
// actual binding rather than interpreting a different producer's hash as equal.
async function admit(selection, folder, proof) {
  await plain(folder);
  const context=await json(path.join(folder,"context.json"));
  await plain(path.join(folder,"request.json"));
  const text=await readTextFileComplete(path.join(folder,"request.json"),{resource:"saved request"});
  const bytes=Buffer.from(text,"utf8");
  const request=normalizeMutationRequest(parseJsonText(text));
  const operation=context.operation??"put", file=path.join(folder,"request.json");
  if(!writes.has(operation)||context.database!==selection.database||!identity(context.request_sha256)||
    hash(bytes)!==context.request_sha256||context.database_instance_id!==request.database_instance_id||
    context.database_epoch!==request.database_epoch)throw fail("Saved operation, exact bytes or database identity does not match its context.",folder);
  let args;
  if(context.recovery_v!==undefined){
    if(context.recovery_v!==1||context.producer!=="cli"||context.request_id!==request.request_id||
      context.node!==selection.node||context.cli!==selection.cli||context.runtime_fingerprint!==selection.runtimeFingerprint||
      typeof context.prior_outcome_unknown!=="boolean" ||
      !Array.isArray(context.arguments)||context.arguments.some(a=>typeof a!=="string"||a.includes("\0"))||
      context.arguments_sha256!==hash(JSON.stringify(context.arguments)))throw fail("Unsupported or changed CLI recovery context.",folder);
    args=context.arguments;
    const leading=operation.split(".");
    if(leading.some((a,i)=>args[i]!==a)||args.filter(a=>a==="--file").length!==1||
      args[args.indexOf("--file")+1]!==file||args.some(a=>["--db","--args-file","--args-stdin","--output","--help","--version"].includes(a)))throw fail("Saved CLI argument binding is invalid.",folder);
    const prefix="cli-"+hash(request.request_id);
    if(context.invocation_id!==undefined||context.binding_sha256!==undefined){
      if(!invocationId(context.invocation_id)||!identity(context.binding_sha256)||
        context.binding_sha256!==cliBinding(selection,request,bytes,operation,args)||
        path.basename(folder)!==`${prefix}-${context.binding_sha256}-${context.invocation_id}`)
        throw fail("Unsupported or changed invocation-owned CLI recovery binding.",folder);
    }else if(path.basename(folder)!==prefix)throw fail("Unsupported or changed CLI recovery context.",folder);
  }else if(context.config!==undefined){
    if(context.request_id!==request.request_id||context.record_id!==subject(request)||
      context.config!==selection.configPath||context.generation!==selection.generation||context.fingerprint!==proof.native||
      path.basename(folder)!==request.request_id||!['put','delete','decision.set','pending.drop'].includes(operation))throw fail("Native recovery binding is incomplete or changed.",folder);
    const legacy = operation==='put' && request.input.mode==='update' && parseJsonText(text).write_basis;
    if(!legacy && !(request.actor?.id?.startsWith('user:') && request.actor.agent==='human' && request.actor.harness==='loader' && request.actor.session===null))throw fail("Native journal actor is not its original human operator binding.",folder);
    if(context.project_root && (context.project_root!==request.checkout || context.project_scope!==request.project_scope))throw fail("Native project binding conflicts with its saved request.",folder);
    if(context.dispatch_sha256!==undefined && context.dispatch_sha256!==hash(JSON.stringify({operation,cwd:context.project_root??null,request_sha256:context.request_sha256})))throw fail("Native dispatch binding conflicts with its saved request.",folder);
    const cwd=context.project_root;
    args=[...operation.split("."),...(cwd&&!['put','delete'].includes(operation)?["--cwd",cwd]:[]),"--file",file];
  }else{
    if(path.dirname(folder)!==path.join(path.dirname(selection.configPath??selection.database),"pending")||
      context.node!==selection.node||context.cli!==selection.cli||context.generation!==selection.generation||
      context.fingerprint!==selection.fingerprint||context.runtime_fingerprint!==selection.runtimeFingerprint||
      path.basename(folder)!==request.request_id)throw fail("Manager recovery binding is incomplete or changed.",folder);
    const legacy = operation==='put' && request.input.mode==='update' && parseJsonText(text).write_basis;
    if(!['put','delete','decision.set','pending.drop'].includes(operation) || (!legacy && !(request.actor?.id?.startsWith('user:') && request.actor.agent==='human' && request.actor.harness==='manager' && request.actor.session===null)))throw fail("Manager journal actor or operation is unsupported.",folder);
    args=[...operation.split("."),...(context.cwd&&!['put','delete'].includes(operation)?["--cwd",context.cwd]:[]),"--file",file];
  }
  const response=await optionalJson(path.join(folder,"response.json"));
  const uncertainty=await optionalJson(path.join(folder,"response.uncertainty.json"));
  if(uncertainty){
    for(const [actual,expected] of [[uncertainty.operation,operation],[uncertainty.request_id,request.request_id],
      [uncertainty.request_sha256,hash(bytes)],[uncertainty.database_instance_id,request.database_instance_id],
      [uncertainty.database_epoch,request.database_epoch],[uncertainty.request?.id,request.request_id]]){
      if(actual!==undefined && actual!==null && actual!==expected)throw fail("Retained uncertainty conflicts with the saved request.",folder);
    }
    if(!(uncertainty.mayHaveCommitted===true || uncertainty.error?.identifiers?.committed===true ||
      uncertainty.error?.identifiers?.committed==="unknown" || ["response_delivery_failed","database_commit_outcome_unknown"].includes(uncertainty.error?.code)))throw fail("Retained report does not establish uncertainty.",folder);
  }
  const priorUnknown=uncertainty!==null || context.prior_outcome_unknown!==false;
  return {folder,context,request,bytes,operation,args,settled:settles(response,request,operation,priorUnknown),response};
}
async function recordedCliRejection(selection,folder){
  const context=await json(path.join(folder,"context.json"));
  if(context.recovery_v!==1||context.producer!=="cli"||context.database!==selection.database||
    context.prior_outcome_unknown!==false||typeof context.node!=="string"||!path.isAbsolute(context.node)||
    typeof context.cli!=="string"||!path.isAbsolute(context.cli)||!identity(context.runtime_fingerprint))return null;
  if((await optionalJson(path.join(folder,"response.json")))?.ok!==false)return null;
  // Old runtimes need not still exist. Validate the saved context against its
  // own complete binding, then accept only a definite recorded no-commit.
  // This never admits an unknown dispatch under a different runtime or caller.
  const saved={...selection,node:context.node,cli:context.cli,runtimeFingerprint:context.runtime_fingerprint};
  const journal=await admit(saved,folder,null);
  const response=journal.response;
  if(!journal.settled||response?.ok!==false||!response.scope||typeof response.scope!=="object"||
    Array.isArray(response.scope)||["project","cwd","session","actor"].some(key=>!Object.hasOwn(response.scope,key))||
    !response.error.identifiers||typeof response.error.identifiers!=="object"||Array.isArray(response.error.identifiers))return null;
  const entries=await readdir(folder,{withFileTypes:true});
  const names=["request.json","context.json","response.json"];
  if(entries.length!==names.length||entries.some(entry=>!names.includes(entry.name)||!entry.isFile()||entry.isSymbolicLink()))return null;
  for(const name of names)if((await lstat(path.join(folder,name))).nlink!==1)return null;
  return journal;
}
function rejectionArguments(args){
  const semantic=[];
  for(let i=0;i<args.length;i++){
    if(["--session","--agent","--harness"].includes(args[i])){i++;continue;}
    semantic.push(args[i]);
    if(args[i]==="--file"){semantic.push("<exact-saved-request>");i++;}
  }
  return JSON.stringify(semantic);
}
export async function listRecovery(selection) {
  const proof=await proofs(selection), journals=[], settled=[], errors=[]; let otherDatabases=0;
  for(const root of rootList(selection)){
    let entries;
    try{await plain(root);entries=await readdir(root,{withFileTypes:true});}
    catch(error){if(error.code==="ENOENT")continue;errors.push({root,code:error.code??"journal_read_failed",message:error.message,action:`Preserve '${root}'. Restore readable direct local storage and refresh recovery; no replay was dispatched.`});continue;}
    for(const entry of entries){
      const folder=path.join(root,entry.name);
      const item={key:keyFor(folder),request_id:entry.name,record_id:"",operation:"unknown",database:selection.database,
        folder,created_at:null,replay_eligible:false,issue:null,action:`Preserve '${folder}' and inspect its request/context with the selected runtime.`};
      try{
        if(!entry.isDirectory()||entry.isSymbolicLink())throw fail("Journal entry is not a direct directory.",folder);
        const context=await json(path.join(folder,"context.json"));
        if(typeof context.database==="string" && context.database!==selection.database){otherDatabases++;continue;}
        const journal=await recordedCliRejection(selection,folder)??await admit(selection,folder,proof);
        if(journal.settled){
          settled.push({folder,request_id:journal.request.request_id,receipt_id:journal.response.receipt_id??null,
            context_sha256:hash(await readTextFileComplete(path.join(folder,"context.json"),{resource:"recovery context"})),
            request_sha256:hash(journal.bytes)});
          continue;
        }
        Object.assign(item,{request_id:journal.request.request_id,record_id:subject(journal.request),operation:journal.operation,
          replay_eligible:true,created_at:(await stat(folder)).birthtime.toISOString(),
          issue:"Original outcome remains unresolved. Exact replay preserves the saved request and ID.",
          action:`Use recovery replay ${item.key} with the selected database and interface config; do not prepare a different request.`});
      }catch(error){item.issue=error.message;item.action=`Preserve '${folder}' and its exact request. ${error.action??item.action}`;}
      journals.push(item);
    }
  }
  journals.sort((a,b)=>a.folder<b.folder?-1:a.folder>b.folder?1:0);
  return {journals,settled_journals:settled,errors,complete:errors.length===0,other_database_journals:otherDatabases};
}
export async function prepareCliJournal(selection, operation, parsed, arguments_, io) {
  try { return await prepareJournal(selection,operation,parsed,arguments_,io); }
  catch(error){throw wrapError(error,"recovery_journal_failed","No current write was dispatched; exact recovery storage could not be prepared.",{
    identifiers:{journal_root:recoveryRoot(selection),committed:false},
    action:"Preserve existing journals, the exact request bytes and ID, and the selected database. Correct the reported input, binding or local storage access before retrying this undispatched request. For older uncertain attempts, use the configured Lodestar runtime with the same --db selection: doctor and get --raw -- <id> for the known receipt and current record. Reconcile those attempts before an exact saved-request replay."});}
}
async function admitPublishedPeer(selection,folder){
  return readPublishedPeer(folder,async()=>admit(selection,folder,await proofs(selection)));
}
async function readPublishedPeer(folder,read){
  // A peer owns its retirement. Retry only a missing-file race, and accept its
  // disappearance; persistent malformed/inaccessible journals still refuse.
  for(let attempt=0;;attempt++){
    try{return await read();}
    catch(error){
      if(error.code!=="ENOENT"&&(error.code!=="input_unreadable"||error.cause?.code!=="ENOENT"))throw error;
      try{await lstat(folder);}catch(missing){if(missing.code==="ENOENT")return undefined;throw missing;}
      if(attempt===50)throw error;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
}
async function checkCliPeers(selection,request,bytes,operation,args,binding,ownFolder=null){
  const root=recoveryRoot(selection),prefix="cli-"+hash(request.request_id);let priorUnknown=false;
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(entry.name!==prefix&&!entry.name.startsWith(prefix+"-"))continue;
    const folder=path.join(root,entry.name);if(folder===ownFolder)continue;
    await plain(folder);
    if(!entry.isDirectory()||entry.isSymbolicLink())throw fail("Same-ID recovery entry is not a direct directory.",folder);
    if(!entry.name.endsWith(".preparing")){
      const rejected=await readPublishedPeer(folder,()=>recordedCliRejection(selection,folder));
      if(rejected===undefined)continue;
      if(rejected){
        if(!rejected.bytes.equals(bytes)||rejected.operation!==operation||rejectionArguments(rejected.args)!==rejectionArguments(args))
          throw fail("Request ID collides with different saved bytes or semantic dispatch arguments; no new write was dispatched.",folder,"recovery_request_conflict");
        continue;
      }
    }
    if(entry.name===prefix){
      const prior=await admit(selection,folder,await proofs(selection));
      if(!prior.bytes.equals(bytes)||prior.operation!==operation||prior.context.arguments_sha256!==hash(JSON.stringify(args)))
        throw fail("Request ID collides with different saved bytes or dispatch arguments; no new write was dispatched.",folder,"recovery_request_conflict");
      priorUnknown ||= !prior.settled;continue;
    }
    const suffix=entry.name.slice(prefix.length+1),match=/^([0-9a-f]{64})-([0-9a-f-]{36})(\.preparing)?$/u.exec(suffix);
    if(!match||!invocationId(match[2]))throw fail("Same-ID invocation recovery name is malformed.",folder);
    if(match[1]!==binding)throw fail("Request ID collides with different exact bytes, arguments or runtime; no new write was dispatched.",folder,"recovery_request_conflict");
    // A preparing directory cannot be dispatched: its frozen --file points to
    // the final directory, published atomically only after capture completes.
    if(!match[3]&&!(await admitPublishedPeer(selection,folder)))continue;
    priorUnknown=true;
  }
  return priorUnknown;
}
async function prepareJournal(selection, operation, parsed, arguments_, io) {
  if(!writes.has(operation))return null;
  const resource = ['put', 'delete'].includes(operation) ? `${operation}_input` : 'mutation input';
  const text=parsed.options["--file"] ? await readTextFileComplete(path.resolve(parsed.options["--file"]),{resource}) :
    await readStreamComplete(io.stdin,{resource});
  if(!text.trim())throw lodestarError("missing_argument","No mutation JSON was supplied; no write was dispatched.",{
    action:"Pass --file <request.json> or pipe a complete version-5 mutation request to stdin. Read the command's --help for its input and write-basis schema."});
  const request=normalizeMutationRequest(parseJsonText(text));
  const bytes=Buffer.from(text,"utf8");
  if(parsed.options["--file"]){
    const existing=path.resolve(parsed.options["--file"]), folder=path.dirname(existing);
    if(path.basename(existing)==="request.json"){
      const context=await optionalJson(path.join(folder,"context.json"));
      if(context?.recovery_v===undefined && context?.database===selection.database && context.operation===operation &&
        context.request_sha256===hash(bytes) && context.database_instance_id===request.database_instance_id &&
        context.database_epoch===request.database_epoch){
        // An interface already froze these exact bytes before dispatch. Avoid a
        // second capture; recovery admission still validates its full binding.
        return null;
      }
    }
  }
  const root=recoveryRoot(selection),logicalFolder=path.join(root,"cli-"+hash(request.request_id));
  const logicalArgs=frozenArguments(operation,parsed,arguments_,logicalFolder);
  const binding=cliBinding(selection,request,bytes,operation,logicalArgs),invocation=randomUUID();
  const folder=path.join(root,`cli-${hash(request.request_id)}-${binding}-${invocation}`),preparing=folder+".preparing";
  const args = frozenArguments(operation, parsed, arguments_, folder);
  await plain(root);await mkdir(root,{recursive:true,mode:0o700});
  const priorUnknown=await checkCliPeers(selection,request,bytes,operation,logicalArgs,binding);
  await mkdir(preparing,{mode:0o700});
  const context={recovery_v:1,producer:"cli",request_id:request.request_id,record_id:subject(request),operation,
      database:selection.database,database_instance_id:request.database_instance_id,database_epoch:request.database_epoch,
      node:selection.node,cli:selection.cli,runtime_fingerprint:selection.runtimeFingerprint,request_sha256:hash(bytes),
      arguments:args,arguments_sha256:hash(JSON.stringify(args)),prior_outcome_unknown:priorUnknown,
      invocation_id:invocation,binding_sha256:binding};
  await writeFile(path.join(preparing,"request.json"),bytes,{flag:"wx",flush:true,mode:0o600});
  await publish(path.join(preparing,"context.json"),context);
  await rename(preparing,folder);
  const laterPeer=await checkCliPeers(selection,request,bytes,operation,logicalArgs,binding,folder);
  if(laterPeer&&!context.prior_outcome_unknown){context.prior_outcome_unknown=true;await publish(path.join(folder,"context.json"),context);}
  parsed.options["--file"]=path.join(folder,"request.json");
  const journal = {folder,context,request,operation};
  ownedCliJournals.set(journal,{folder,request:structuredClone(request),operation,bytes,
    contextText:JSON.stringify(context)+"\n",priorUnknown:context.prior_outcome_unknown,
    directory:await lstat(folder,{bigint:true}),responseText:null});
  return journal;
}
function frozenArguments(operation, parsed, arguments_, folder) {
  const args = [];
  for (let i = 0; i < arguments_.length; i++) {
    if (arguments_[i] === "--file") { i++; continue; }
    if (arguments_[i] === "--") continue;
    if (arguments_[i] === "--cwd") {
      args.push("--cwd", resolveInputPath(arguments_[++i], { name: "project cwd" }));
    } else args.push(arguments_[i]);
  }
  args.push("--file", path.join(folder, "request.json"));
  if (operation.includes(".")) {
    // Freeze implicit shell context: a resumed task must deliberately replay the
    // original project and caller instead of inheriting the new task's context.
    if (!parsed.options["--cwd"]) args.push("--cwd", process.cwd());
    const caller = resolveIdentity({ session: parsed.options["--session"],
      agent: parsed.options["--agent"], harness: parsed.options["--harness"] });
    for (const field of ["session", "agent", "harness"]) {
      if (caller[field] && !parsed.options[`--${field}`]) args.push(`--${field}`, caller[field]);
    }
  }
  return args;
}
export async function storeCliResponse(journal,envelope){
  if(!journal)return;
  await publish(path.join(journal.folder,"response.json"),envelope);
  const owned=ownedCliJournals.get(journal);
  if(owned)owned.responseText=JSON.stringify(envelope)+"\n";
}
export async function retireCliJournal(journal,envelope){
  const owned=journal&&ownedCliJournals.get(journal);
  if(!owned)return false;
  const {folder,request,operation}=owned;
  // A later rejection cannot settle an earlier dispatch with an unknown outcome.
  // Keep both copies until a matching success receipt reconciles the request.
  if(envelope?.ok===false && !settles(envelope,request,operation,owned.priorUnknown))return false;
  if(journal.folder!==folder || !settles(envelope,request,operation,owned.priorUnknown) ||
    !envelope.scope || typeof envelope.scope!=="object" || Array.isArray(envelope.scope) ||
    ["project","cwd","session","actor"].some(key=>!Object.hasOwn(envelope.scope,key)) ||
    (envelope.ok===true&&!Object.hasOwn(envelope,"data")) ||
    owned.responseText!==JSON.stringify(envelope)+"\n")throw fail("A complete matching settled response is required for owned journal retirement.",folder);
  const names=["request.json","context.json","response.json"];
  async function verifyDirectory(){
    await plain(folder);
    const current=await lstat(folder,{bigint:true});
    if(!current.isDirectory()||current.dev!==owned.directory.dev||current.ino!==owned.directory.ino||
      current.birthtimeNs!==owned.directory.birthtimeNs)throw fail("Owned recovery directory identity changed before retirement.",folder);
  }
  await verifyDirectory();
  const entries=await readdir(folder,{withFileTypes:true});
  if(entries.length!==names.length||entries.some(entry=>!names.includes(entry.name)||!entry.isFile()||entry.isSymbolicLink()))
    throw fail("Owned journal contains foreign or non-file storage; retirement was refused.",folder);
  const expected=[owned.bytes,Buffer.from(owned.contextText),Buffer.from(owned.responseText)];
  async function verifyFile(i){
    const file=path.join(folder,names[i]);await plain(file);
    const metadata=await lstat(file);
    if(!metadata.isFile()||metadata.nlink!==1)throw fail("Owned recovery file is not direct unaliased storage.",folder);
    const actual=Buffer.from(await readTextFileComplete(file,{resource:"owned recovery state",maximum:journalLimit(file)}));
    if(!actual.equals(expected[i]))throw fail("Owned recovery content changed before retirement.",folder);
  }
  for(let i=0;i<names.length;i++)await verifyFile(i);
  // Keep the settled response until exact request/context removal finishes.
  // No recursive removal: unexpected files or a replaced directory are retained.
  for(let i=0;i<names.length;i++){await verifyDirectory();await verifyFile(i);await unlink(path.join(folder,names[i]));}
  await verifyDirectory();await rmdir(folder);ownedCliJournals.delete(journal);
  return true;
}
export async function recoveryReplay(selection,key,execute){
  if(!/^[0-9a-f]{64}$/u.test(key??""))throw fail("Recovery key must be one listed opaque key; no replay was dispatched.",recoveryRoot(selection));
  const listing=await listRecovery(selection),item=listing.journals.find(row=>row.key===key);
  if(!item && !listing.complete)throw fail("Recovery roots could not be fully inspected; restore their reported access before selecting a request. No replay was dispatched.",recoveryRoot(selection));
  if(!item||!item.replay_eligible)throw fail(item?.issue??"No eligible saved request with that key was found.",item?.folder??recoveryRoot(selection));
  await revalidateSelection(selection);
  const journal=await admit(selection,item.folder,await proofs(selection));
  // Preserve prior uncertainty before the deliberate replay. A later rejection
  // never proves that an earlier dispatched attempt did not commit.
  const marker={kind:"MissingResponse",mayHaveCommitted:true,operation:journal.operation,request_id:journal.request.request_id,
    request_sha256:hash(journal.bytes),database_instance_id:journal.request.database_instance_id,database_epoch:journal.request.database_epoch};
  try{await writeFile(path.join(journal.folder,"response.uncertainty.json"),JSON.stringify(marker)+"\n",{flag:"wx",flush:true,mode:0o600});}
  catch(error){if(error.code!=="EEXIST")throw error;}
  const result=await execute(selection,{operation:journal.operation,args:journal.args,
    journalFolder:journal.folder,
    effect:journal.operation.includes(".")?"domain_write":"record_write"});
  if(result.envelope){
    try{await publish(path.join(journal.folder,"response.json"),result.envelope);}
    catch(error){throw lodestarError("response_delivery_failed","The exact replay completed but its local response could not be saved.",{
      identifiers:{journal:journal.folder,committed:true,request_id:journal.request.request_id,
        database_instance_id:journal.request.database_instance_id,database_epoch:journal.request.database_epoch,
        committed_revision:result.envelope.revision,receipt_id:result.envelope.receipt_id,
        receipt_read_args:["--db",selection.database,"get",result.envelope.receipt_id]},
      action:`Preserve '${journal.folder}'. Read the named original receipt before any further replay; restore writable local storage.`,cause:error});}
  }
  return result;
}
