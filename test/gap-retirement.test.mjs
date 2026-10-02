import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { directInterfaceSelection } from '../src/interface-config.mjs';
import { runManager } from '../src/manager.mjs';

test('Manager exposes guarded retirement and retains the original record history',async t=>{
  const f=await fixture(t);await f.create('project:test','project',{roots:[f.root]},'project:test');
  await f.create('note:retire','note',{body:'Keep this history'},'project:test');
  const answers=['1','1','10','r','Alex','note:retire','No longer current','SAVE','11','9']; let output='';
  const code=await runManager({selection:await directInterfaceSelection(f.database),io:{stdin:{isTTY:true},stdout:{isTTY:true,write:value=>output+=value}},ask:async()=>answers.shift()??null});
  assert.equal(code,0);const record=await f.cli(['get','note:retire']);
  assert.equal(record.value.data.semantics.lifecycle,'historical',output);
  assert.equal(record.value.data.data.body,'Keep this history');
  assert.match(output,/Retire ordinary record/);assert.match(output,/Review exact delete request/);
  const history=await f.cli(['get','note:retire','--history']);assert.equal(history.value.data.versions.length,1);
  assert.match(JSON.stringify(history.value.data.versions[0]),/Keep this history/);
});
