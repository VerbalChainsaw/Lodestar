// Physical receipt representation only. Domain validation and request admission remain in records.mjs.
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {constants as bufferConstants} from 'node:buffer';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonicalStringify} from './json.mjs';
import {lodestarError} from './errors.mjs';
const FORMAT='lodestar-receipt-storage-v1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const receiptId=id=>typeof id==='string'&&/^mutation-receipt:[0-9a-f]{64}$/.test(id);
function invalid(id){throw lodestarError('database_integrity','Stored receipt encoding failed its identity or integrity check.',{identifiers:{id},action:'Preserve this database and the verified archive; do not replay this request.'});}
function header(content,storage){return {state:content.state,_lodestar:content._lodestar,_lodestar_storage:storage};}
export function retiredReceiptFence(id,revision,archiveSha256){
  if(!receiptId(id)||!Number.isSafeInteger(revision)||revision<1||!/^[0-9a-f]{64}$/.test(archiveSha256))invalid(id);
  return canonicalStringify({state:'unavailable',reason:'Corrupt historical receipt removed by explicit Director authorization; request permanently fenced.',
    _lodestar:{priority:0,revision,semantics:{lifecycle:'historical',context_role:'on_demand',basis:'asserted',applicability:{project:'global',checkout:null}}},
    _lodestar_storage:{format:FORMAT,codec:'retired',id,reason:'director_authorized_corrupt_receipt_removal',archive_sha256:archiveSha256}});
}
export function isRetiredReceipt(text,{id=null}={}){
  if(!text.includes('"_lodestar_storage"'))return false;
  const outer=JSON.parse(text),s=outer?._lodestar_storage;
  if(s?.format!==FORMAT||s.codec!=='retired')return false;
  if(!receiptId(s.id)||(id!==null&&id!==s.id)||s.reason!=='director_authorized_corrupt_receipt_removal'||!/^[0-9a-f]{64}$/.test(s.archive_sha256)||outer.state!=='unavailable')invalid(id??s.id);
  return true;
}
export function encodeReceiptStorage(text,id){
  if(!receiptId(id))invalid(id);
  const content=JSON.parse(text),raw=Buffer.from(text),compressed=gzipSync(raw,{level:1});
  const encoded=canonicalStringify(header(content,{format:FORMAT,codec:'gzip',id,raw_bytes:raw.length,raw_sha256:hash(raw),payload:compressed.toString('base64')}));
  return Buffer.byteLength(encoded)<raw.length?encoded:text;
}
export function archivedReceiptHeader(text,id,manifestPath,archiveSha256){
  if(!receiptId(id)||!path.isAbsolute(manifestPath)||!/^[0-9a-f]{64}$/.test(archiveSha256))invalid(id);
  const content=JSON.parse(text),raw=Buffer.from(text);
  return canonicalStringify(header(content,{format:FORMAT,codec:'archive',id,raw_bytes:raw.length,raw_sha256:hash(raw),manifest:path.resolve(manifestPath),archive_sha256:archiveSha256}));
}
export function archivedReceiptPointer(id,revision,manifestPath,archiveSha256){
  if(!receiptId(id)||!path.isAbsolute(manifestPath)||!Number.isSafeInteger(revision)||revision<1||!/^[0-9a-f]{64}$/.test(archiveSha256))invalid(id);
  return canonicalStringify({state:'unavailable',reason:'Cold receipt catalog entry; original row metadata and payload require explicit archive access.',
    _lodestar:{priority:0,revision,semantics:{lifecycle:'historical',context_role:'on_demand',basis:'asserted',applicability:{project:'global',checkout:null}}},
    _lodestar_storage:{format:FORMAT,codec:'archive-pointer',id,manifest:path.resolve(manifestPath),archive_sha256:archiveSha256}});
}
function cacheIdentity(cache){
  const s=statSync(cache,{bigint:true});
  return {size:s.size.toString(),mtime_ns:s.mtimeNs.toString(),ino:s.ino.toString()};
}
function requireCurrentCache(cache,receipt,storage){
  const current=cacheIdentity(cache),expected=receipt.cache_identity;
  if(!expected||Object.keys(current).some(key=>current[key]!==expected[key]))
    throw lodestarError('archive_restore_required','The cold-cache verification is absent or stale.',
      {identifiers:{id:storage.id,manifest:storage.manifest},
       action:'Explicitly revalidate the existing cache with restore-archive.py --verify-existing and a disk/time budget. No restore or replay has occurred.'});
}
function archiveRow(storage){
  let manifest;
  try{manifest=JSON.parse(readFileSync(storage.manifest,'utf8'));}catch{throw lodestarError('archive_restore_required','The verified cold archive manifest is unavailable.',{identifiers:{id:storage.id},action:'Locate the existing verified archive; never retry this as new work.'});}
  if(manifest.archive_sha256!==storage.archive_sha256||manifest.format!=='isolated-lean-candidate-v1')invalid(storage.id);
  const cache=path.join(path.dirname(storage.manifest),'archive-cache','restored.db');
  let receipt;
  try{receipt=JSON.parse(readFileSync(cache+'.receipt.json','utf8'));
    if(statSync(cache).size!==manifest.snapshot_bytes)invalid(storage.id);
  }catch(error){
    if(error.code==='database_integrity')throw error;
    throw lodestarError('archive_restore_required','This receipt is preserved in the compressed cold archive; an explicit bounded restore is required.',{identifiers:{id:storage.id,manifest:storage.manifest,required_bytes:manifest.snapshot_bytes},action:'Use the verified archive restore operation with an explicit disk budget. No automatic restore or mutation has occurred.'});
  }
  if(receipt.state!=='verified_restore'||receipt.sha256!==manifest.snapshot_sha256||receipt.archive_sha256!==manifest.archive_sha256)invalid(storage.id);
  requireCurrentCache(cache,receipt,storage);
  const db=new DatabaseSync(cache,{readOnly:true,timeout:1000,allowExtension:false});
  try{
    db.exec('PRAGMA query_only=ON');
    const metadata=Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(x=>[x.key,x.value]));
    for(const [k,v] of Object.entries(manifest.snapshot_metadata))if(metadata[k]!==v)invalid(storage.id);
    const size=db.prepare('SELECT type,octet_length(content_json) bytes FROM records WHERE id=?').get(storage.id);
    if(!size||size.type!=='mutation-receipt'||size.bytes>bufferConstants.MAX_STRING_LENGTH||(storage.raw_bytes!==undefined&&size.bytes!==storage.raw_bytes))invalid(storage.id);
    const row={...db.prepare('SELECT id,type,name,scope,content_json,created_at,updated_at FROM records WHERE id=?').get(storage.id)};
    requireCurrentCache(cache,receipt,storage);
    return row;
  }finally{db.close();}
}
export function decodeReceiptRow(row){
  if(row.type!=='mutation-receipt')return row;
  const s=JSON.parse(row.content_json)?._lodestar_storage;
  if(s?.format===FORMAT&&s.codec==='archive-pointer'){
    if(s.id!==row.id||!receiptId(s.id)||!path.isAbsolute(s.manifest??'')||!/^[0-9a-f]{64}$/.test(s.archive_sha256))invalid(row.id);
    return archiveRow(s);
  }
  return {...row,content_json:decodeReceiptStorage(row.content_json,{id:row.id,allowRetired:true})};
}
export function decodeReceiptStorage(text,{id=null,allowRetired=false}={}){
  // Avoid a second parse of the large legacy receipts which do not have this encoding.
  if(!text.includes('"_lodestar_storage"'))return text;
  const outer=JSON.parse(text),s=outer?._lodestar_storage;
  if(s?.format!==FORMAT)return text;
  if(isRetiredReceipt(text,{id})){
    if(allowRetired)return text;
    throw lodestarError('receipt_retired','This corrupt receipt was explicitly removed; its request remains permanently fenced.',{identifiers:{id:s.id,archive_sha256:s.archive_sha256},action:'Do not replay this request. Original bytes remain in the compressed recovery archive.'});
  }
  if(s.codec==='archive-pointer'){
    if(!receiptId(s.id)||(id!==null&&id!==s.id)||!path.isAbsolute(s.manifest??'')||!/^[0-9a-f]{64}$/.test(s.archive_sha256))invalid(id??s.id);
    return archiveRow(s).content_json;
  }
  if(!receiptId(s.id)||(id!==null&&id!==s.id)||!Number.isSafeInteger(s.raw_bytes)||s.raw_bytes<1||s.raw_bytes>bufferConstants.MAX_STRING_LENGTH||!/^[0-9a-f]{64}$/.test(s.raw_sha256))invalid(id??s.id);
  let raw;
  if(s.codec==='gzip'){
    if(typeof s.payload!=='string')invalid(s.id);
    const packed=Buffer.from(s.payload,'base64');if(packed.toString('base64')!==s.payload)invalid(s.id);
    try{raw=gunzipSync(packed,{maxOutputLength:s.raw_bytes});}catch{invalid(s.id);}
  }else if(s.codec==='archive'){
    if(typeof s.manifest!=='string'||!path.isAbsolute(s.manifest)||!/^[0-9a-f]{64}$/.test(s.archive_sha256))invalid(s.id);
    raw=Buffer.from(archiveRow(s).content_json);
  }else invalid(s.id);
  if(raw.length!==s.raw_bytes||hash(raw)!==s.raw_sha256)invalid(s.id);
  const decoded=raw.toString('utf8'),content=JSON.parse(decoded);
  if(content._lodestar_storage?.format===FORMAT||content.state!==outer.state||canonicalStringify(content._lodestar)!==canonicalStringify(outer._lodestar))invalid(s.id);
  return decoded;
}
