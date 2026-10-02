import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';

async function invoke(args) {
  let stdout='', stderr='';
  const code=await runCli(args,{stdin:Readable.from([]), stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}}});
  return {code,stdout,stderr,value:JSON.parse(stdout||stderr)};
}
async function dir(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'lodestar-gap-cli-'));
  t.after(()=>rm(root,{recursive:true,force:true})); return root;
}
test('failed read output preserves complete original error and a verifiable receipt', async t=>{
  const root=await dir(t), db=path.join(root,'store.db'), output=path.join(root,'error ü & %.json');
  assert.equal((await invoke(['--db',db,'init'])).code,0);
  const result=await invoke(['--db',db,'get','note:absent','--output',output]);
  assert.equal(result.code,3); assert.equal(result.value.ok,false);
  assert.equal(result.value.error.code,'record_not_found');
  const bytes=await readFile(output), saved=JSON.parse(bytes);
  assert.deepEqual(saved.error,result.value.error);
  assert.equal(saved.operation,'get'); assert.equal(saved.ok,false);
  assert.equal(result.value.data.output_file.bytes,bytes.length);
  assert.equal(result.value.data.output_file.sha256,createHash('sha256').update(bytes).digest('hex'));
  const conflict=await invoke(['--db',db,'get','note:absent','--output',output]);
  assert.equal(conflict.value.error.code,'output_conflict'); assert.deepEqual(await readFile(output),bytes);
});
test('parse refusal with reserved output saves its actionable error',async t=>{
  const root=await dir(t),output=path.join(root,'argument-error.json');
  const result=await invoke(['get','--output',output]);
  assert.equal(result.code,2); assert.equal(result.value.error.code,'missing_argument');
  const saved=JSON.parse(await readFile(output,'utf8'));
  assert.equal(saved.error.code,'missing_argument'); assert.match(saved.error.action,/get/);
  assert.ok(result.value.data.output_file.bytes>0);
});
test('output collision prevents initialization and preserves existing bytes',async t=>{
  const root=await dir(t),output=path.join(root,'keep.json'),db=path.join(root,'absent.db');
  await writeFile(output,'keep exact bytes');
  const result=await invoke(['--db',db,'init','--output',output]);
  assert.equal(result.value.error.code,'output_conflict');
  assert.equal(await readFile(output,'utf8'),'keep exact bytes');
  await assert.rejects(access(db),{code:'ENOENT'});
});
for (const spelling of ['--file','--file-missing']) test(`plain init refuses an ignored ${spelling} before store creation`,async t=>{
  const root=await dir(t),db=path.join(root,'absent.db'),input=path.join(root,'request.json');
  await writeFile(input,JSON.stringify({v:5,request_id:'conversion',preflight:{},backup:{}}));
  const flags=['--file',spelling==='--file'?input:path.join(root,'absent-input.json')];
  const result=await invoke(['--db',db,'init',...flags]);
  assert.equal(result.code,2); assert.equal(result.value.error.code,'invalid_input');
  assert.match(result.value.error.action,/--migrate.*--promote-recovery|--promote-recovery.*--migrate/);
  await assert.rejects(access(db),{code:'ENOENT'});
});
test('ignored init file refusal preserves an existing current store',async t=>{
  const root=await dir(t),db=path.join(root,'store.db'),input=path.join(root,'request.json');
  await invoke(['--db',db,'init']); const before=await readFile(db);
  await writeFile(input,'{}'); const result=await invoke(['--db',db,'init','--file',input]);
  assert.equal(result.code,2); assert.equal(result.value.ok,false); assert.deepEqual(await readFile(db),before);
});
