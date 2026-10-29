"""Explicit bounded cold restore/revalidation. Never called automatically by a reader."""
import argparse,gzip,hashlib,json,os,pathlib,shutil,sqlite3,time

def identity(target):
    stat=target.stat()
    return {'size':str(stat.st_size),'mtime_ns':str(stat.st_mtime_ns),'ino':str(stat.st_ino)}

def publish_receipt(target,receipt):
    destination=target.with_suffix(target.suffix+'.receipt.json')
    pending=destination.with_suffix(destination.suffix+'.partial')
    if pending.exists():
        previous=json.loads(pending.read_text())
        keys=('state','restored_bytes','sha256','snapshot','archive_sha256','cache_identity')
        if any(previous.get(key)!=receipt[key] for key in keys):
            raise FileExistsError('Different pending verification receipt exists; reconcile before retry')
    else:
        with pending.open('x',encoding='utf-8') as stream:
            json.dump(receipt,stream,indent=2);stream.flush();os.fsync(stream.fileno())
    os.replace(pending,destination)

def restore(manifest_path,target,max_bytes,reserve_bytes,deadline_seconds=900,*,verify_existing=False):
    manifest_path=pathlib.Path(manifest_path).resolve();root=manifest_path.parent
    target=pathlib.Path(target).resolve();cache=(root/'archive-cache').resolve()
    if cache not in target.parents: raise ValueError('Restore target must be in this candidate archive-cache')
    partial=target.with_suffix(target.suffix+'.partial')
    if not verify_existing and (target.exists() or partial.exists()):
        raise FileExistsError('Restore target or partial already exists; use explicit --verify-existing for a completed target, or reconcile the partial')
    if verify_existing and not target.is_file(): raise FileNotFoundError('Existing restore target is required')
    m=json.loads(manifest_path.read_text());expected=m['snapshot_bytes']
    if not isinstance(expected,int) or expected<=0 or max_bytes<=0 or reserve_bytes<0 or deadline_seconds<=0: raise ValueError('Invalid restore limits')
    if expected>max_bytes: raise ValueError('Explicit restore byte budget is insufficient')
    started=time.monotonic()
    if not verify_existing:
        if shutil.disk_usage(root).free < expected+reserve_bytes: raise OSError('Insufficient free space for restore plus reserve')
        archive=pathlib.Path(m['archive'])
        if archive.stat().st_size!=m['archive_bytes']: raise ValueError('Archive size mismatch')
        archive_hash=hashlib.sha256()
        with archive.open('rb') as stream:
            while block:=stream.read(4*1024**2):
                archive_hash.update(block)
                if time.monotonic()-started>deadline_seconds: raise RuntimeError('Archive verification exceeded time budget; no restore started')
        if archive_hash.hexdigest()!=m['archive_sha256']: raise ValueError('Archive hash mismatch')
        target.parent.mkdir(parents=True,exist_ok=True)
    source=target if verify_existing else partial
    before=identity(target) if verify_existing else None
    h=hashlib.sha256();n=0
    if verify_existing:
        if target.stat().st_size!=expected: raise ValueError('Existing restore size mismatch')
        with target.open('rb') as inp:
            while block:=inp.read(4*1024**2):
                n+=len(block);h.update(block)
                if n>expected or time.monotonic()-started>deadline_seconds: raise RuntimeError('Existing restore verification exceeded byte or time budget')
    else:
        with gzip.open(archive,'rb') as inp,partial.open('xb') as out:
            while block:=inp.read(4*1024**2):
                n+=len(block)
                if n>expected or time.monotonic()-started>deadline_seconds: raise RuntimeError('Restore exceeded exact byte or time budget; partial retained')
                if shutil.disk_usage(root).free<reserve_bytes: raise OSError('Restore reserve reached; partial retained')
                h.update(block);out.write(block)
            out.flush();os.fsync(out.fileno())
    if n!=expected or h.hexdigest()!=m['snapshot_sha256']: raise ValueError('Restored bytes differ from verified snapshot; bytes retained')
    if before is not None and identity(target)!=before: raise ValueError('Existing cache changed during verification')
    db=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=1)
    try:
        metadata=dict(db.execute('SELECT key,value FROM metadata'))
        for key,value in m['snapshot_metadata'].items():
            if metadata.get(key)!=value: raise ValueError('Restored database identity mismatch')
    finally:db.close()
    if time.monotonic()-started>deadline_seconds: raise RuntimeError('Restore verification exceeded time budget')
    if before is not None and identity(target)!=before: raise ValueError('Existing cache changed during metadata verification')
    if not verify_existing:
        # Preserve any competing target instead of overwriting it. Hard-link
        # publication is exclusive and stays on the same cache filesystem.
        os.link(partial,target)
        # Retain the verified partial until receipt publication succeeds.
    receipt={'state':'verified_restore','restored_bytes':n,'sha256':h.hexdigest(),'snapshot':str(target),
             'archive_sha256':m['archive_sha256'],'cache_identity':identity(target),
             'elapsed_seconds':round(time.monotonic()-started,3)}
    publish_receipt(target,receipt)
    # Removing our same-inode staging link does not remove the published data.
    if not verify_existing and partial.stat().st_ino==target.stat().st_ino:partial.unlink()
    return receipt

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--target',required=True)
    p.add_argument('--max-bytes',type=int,required=True);p.add_argument('--reserve-bytes',type=int,default=16*1024**3)
    p.add_argument('--explicit-restore',action='store_true',required=True)
    p.add_argument('--verify-existing',action='store_true',help='Rehash an existing restored target and atomically repair its verification receipt; no decompression or database writes')
    a=p.parse_args();print(json.dumps(restore(a.manifest,a.target,a.max_bytes,a.reserve_bytes,verify_existing=a.verify_existing),indent=2))
