import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {archivedReceiptPointer,decodeReceiptRow} from '../src/receipt-storage.mjs';

function fixture(t) {
  const root=mkdtempSync(path.join(tmpdir(),'lodestar-cache-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cache=path.join(root,'archive-cache','restored.db');mkdirSync(path.dirname(cache));
  const id=`mutation-receipt:${'a'.repeat(64)}`;
  const db=new DatabaseSync(cache);
  db.exec('CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE records(id TEXT,type TEXT,name TEXT,scope TEXT,content_json TEXT,created_at TEXT,updated_at TEXT)');
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('schema_version','5');
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id,'mutation-receipt','original','global','{"state":"known","value":{"safe":true}}','x','x');db.close();
  const s=statSync(cache,{bigint:true});
  const hash=createHash('sha256').update(readFileSync(cache)).digest('hex');
  const manifest=path.join(root,'manifest.json');
  writeFileSync(manifest,JSON.stringify({format:'isolated-lean-candidate-v1',archive_sha256:'b'.repeat(64),snapshot_sha256:hash,snapshot_bytes:Number(s.size),snapshot_metadata:{schema_version:'5'}}));
  const receipt={state:'verified_restore',sha256:hash,archive_sha256:'b'.repeat(64),cache_identity:{size:s.size.toString(),mtime_ns:s.mtimeNs.toString(),ino:s.ino.toString()}};
  writeFileSync(cache+'.receipt.json',JSON.stringify(receipt));
  const row={id,type:'mutation-receipt',content_json:archivedReceiptPointer(id,1,manifest,'b'.repeat(64))};
  return {cache,receipt,row,manifest};
}
test('verified unchanged cache remains readable',t=>{
 const {row}=fixture(t);assert.equal(decodeReceiptRow(row).name,'original');
});
test('same-size cache change invalidates the old verification receipt without reading changed content',t=>{
 const {cache,row}=fixture(t),before=statSync(cache).size;
 const db=new DatabaseSync(cache);db.prepare('UPDATE records SET name=?').run('modified');db.close();
 utimesSync(cache,new Date(),new Date(Date.now()+5000));
 assert.equal(statSync(cache).size,before);
 assert.throws(()=>decodeReceiptRow(row),error=>error.code==='archive_restore_required');
});
test('legacy verification receipt requires explicit revalidation, never automatic restore',t=>{
 const {cache,receipt,row}=fixture(t);delete receipt.cache_identity;
 writeFileSync(cache+'.receipt.json',JSON.stringify(receipt));
 assert.throws(()=>decodeReceiptRow(row),error=>error.code==='archive_restore_required');
});
test('Python explicit revalidation produces a Windows/Node-compatible cache identity',t=>{
 const {cache,row,manifest}=fixture(t);
 const result=spawnSync('python',[fileURLToPath(new URL('../tools/restore-archive.py',import.meta.url)),
   '--manifest',manifest,'--target',cache,'--max-bytes',String(statSync(cache).size),'--reserve-bytes','0','--explicit-restore','--verify-existing'],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);
 assert.equal(decodeReceiptRow(row).name,'original');
});
