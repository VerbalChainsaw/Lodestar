import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { SCHEMA_V4_SQL } from '../src/schema.mjs';
import { runCli } from '../src/cli.mjs';
import { Readable } from 'node:stream';
async function invoke(database,args){let output='';const code=await runCli(['--db',database,...args],{stdin:Readable.from([]),stdout:{write:value=>output+=value},stderr:{write:value=>output+=value}});return {code,value:JSON.parse(output)};}
test('public migration backup restores a schema-four image and never overwrites its destination',async t=>{
  const f=await fixture(t),source=path.join(f.root,'old.db'),backup=path.join(f.root,'backup.db');
  const raw=new DatabaseSync(source);raw.exec(SCHEMA_V4_SQL);const insert=raw.prepare('INSERT INTO metadata(key,value) VALUES(?,?)');
  for(const [key,value] of Object.entries({schema_version:'4',created_at:'2026-09-06T09:00:00.000Z',database_instance_id:'a'.repeat(64),database_epoch:'b'.repeat(64),database_revision:'0'}))insert.run(key,value);raw.close();
  const before=await readFile(source),result=await invoke(source,['migration-backup',backup]);
  assert.equal(result.code,0,JSON.stringify(result.value));assert.equal(result.value.data.path,backup);
  assert.match(result.value.data.logical_digest,/^[a-f0-9]{64}$/);
  const preflight=await invoke(backup,['doctor','--migration-preflight']);assert.equal(preflight.code,0);
  assert.equal(preflight.value.data.logical_digest,result.value.data.logical_digest);assert.deepEqual(await readFile(source),before);
  const bytes=await readFile(backup),retry=await invoke(source,['migration-backup',backup]);assert.notEqual(retry.code,0);assert.deepEqual(await readFile(backup),bytes);
});
