import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './contract.mjs';
import { loadInterfaceConfig } from '../../src/interface-config.mjs';
import { executeCli } from '../../src/interface-client.mjs';
import { runManager } from '../../src/manager.mjs';

async function setup(t) {
  const f = await fixture(t), a = 'project:operator-a', b = 'project:operator-b';
  await f.create(a, 'project', { roots: [f.root] }, a);
  const second = path.join(f.root, 'second'); await mkdir(second);
  await f.create(b, 'project', { roots: [second] }, b);
  await f.create('knowledge:intent', 'knowledge', { intent: { version: 1, brief: 'Deliver the selected branch', user_reference: 'Operator request', boundaries: ['One store'], non_goals: ['No daemon'], requirements: [{id:'R1', text:'Capture evidence', acceptance:'Review actual evidence'},{id:'R2',text:'Preserve sibling',acceptance:'Inspect sibling'}] }, continuation: { active_requirement_ids:['R1'], next_action:'Inspect result', context:{version:1,mission_record_ids:[],requirements:[]} } }, a);
  const config = path.join(f.root, 'interfaces.json'), loader = path.join(f.root, 'loader.exe');
  await writeFile(loader, 'fixture'); await writeFile(config, JSON.stringify({v:1,generation:randomUUID(),loader,runtime:{node:process.execPath,cli:fileURLToPath(new URL('../../lodestar.mjs',import.meta.url)),database:f.database}}));
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
export { setup, journey, option, captureAnswers };
