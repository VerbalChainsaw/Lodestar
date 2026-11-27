import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
let source=import.meta.dirname;
while(!existsSync(path.join(source,'lodestar.mjs'))&&path.dirname(source)!==source)source=path.dirname(source);
const root=path.resolve(process.argv[2]),cli=path.join(source,'lodestar.mjs'),database=path.join(root,'store','lodestar.db');
await mkdir(path.dirname(database),{recursive:true});await mkdir(path.join(root,'config'),{recursive:true});
function call(args){const child=spawnSync(process.execPath,[cli,'--db',database,...args],{encoding:'utf8'});const envelope=JSON.parse(child.stdout||child.stderr);if(child.status!==0)throw new Error(JSON.stringify(envelope));return envelope;}
call(['init']);
const config=path.join(root,'config','interfaces.json');await writeFile(config,JSON.stringify({v:1,generation:randomUUID(),runtime:{node:process.execPath,cli,database}}));
const {loadInterfaceConfig,directInterfaceSelection}=await import(pathToFileURL(path.join(source,'src','interface-config.mjs')));
const {prepareCliJournal}=await import(pathToFileURL(path.join(source,'src','recovery-journal.mjs')));
const selection=await loadInterfaceConfig(config,{requireLoader:false});const identity=call(['find','--all','--limit','1']);
function request(id,harness){return {v:5,request_id:'ll-'+randomUUID(),database_instance_id:identity.database_instance_id,database_epoch:identity.database_epoch,project_scope:null,checkout:null,actor:{id:'user:fixture',agent:'human',harness,session:null},preconditions:[{target:{kind:'record',id},expected_revision:null}],input:{mode:'create',record:{id,name:id,kind:'note',scope:'global',availability:'known',data:{},aliases:[],links:[],sources:[]}}};}
const manager=request('note:manager-pending','manager'),folder=path.join(root,'config','pending',manager.request_id);await mkdir(folder,{recursive:true});
const bytes=Buffer.from(JSON.stringify(manager)+'\n');await writeFile(path.join(folder,'request.json'),bytes);
await writeFile(path.join(folder,'context.json'),JSON.stringify({generation:selection.generation,fingerprint:selection.fingerprint,runtime_fingerprint:selection.runtimeFingerprint,node:selection.node,cli,database,operation:'put',cwd:null,project_id:null,database_instance_id:manager.database_instance_id,database_epoch:manager.database_epoch,request_sha256:createHash('sha256').update(bytes).digest('hex')}));
const bare=request('note:cli-pending','fixture'),input=path.join(root,'bare.json');await writeFile(input,JSON.stringify(bare));
await prepareCliJournal(await directInterfaceSelection(database),'put',{options:{'--file':input}},['put','--file',input],{});
await writeFile(path.join(root,'expected.json'),JSON.stringify({manager:manager.request_id,bare:bare.request_id,manager_folder:folder}));
console.log(config);
