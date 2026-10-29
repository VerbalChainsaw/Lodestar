import gzip,hashlib,importlib.util,json,pathlib,sqlite3,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('restore_archive',pathlib.Path(__file__).resolve().parents[1]/'tools'/'restore-archive.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Restore(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.root=pathlib.Path(self.tmp.name);source=self.root/'source.db'
  db=sqlite3.connect(source);db.execute('CREATE TABLE metadata(key TEXT,value TEXT)');db.execute("INSERT INTO metadata VALUES('schema_version','5')");db.commit();db.close()
  self.raw=source.read_bytes();self.archive=self.root/'source.gz';self.archive.write_bytes(gzip.compress(self.raw))
  self.manifest=self.root/'manifest.json';self.manifest.write_text(json.dumps({'archive':str(self.archive),'archive_bytes':self.archive.stat().st_size,'archive_sha256':hashlib.sha256(self.archive.read_bytes()).hexdigest(),'snapshot_bytes':len(self.raw),'snapshot_sha256':hashlib.sha256(self.raw).hexdigest(),'snapshot_metadata':{'schema_version':'5'}}))
  self.target=self.root/'archive-cache'/'restored.db'
 def run_restore(self,**kwargs):return module.restore(self.manifest,self.target,len(self.raw),0,**kwargs)
 def test_existing_complete_target_can_be_explicitly_verified_after_interrupted_publication(self):
  self.target.parent.mkdir();self.target.write_bytes(self.raw)
  result=self.run_restore(verify_existing=True)
  self.assertEqual(result['state'],'verified_restore');self.assertEqual(self.target.read_bytes(),self.raw)
  self.assertIn('cache_identity',json.loads(pathlib.Path(str(self.target)+'.receipt.json').read_text()))
 def test_changed_existing_target_rejected_and_preserved(self):
  self.target.parent.mkdir();bad=self.raw[:-1]+bytes([self.raw[-1]^1]);self.target.write_bytes(bad)
  with self.assertRaises(ValueError):self.run_restore(verify_existing=True)
  self.assertEqual(self.target.read_bytes(),bad)
 def test_byte_budget_fails_before_any_restore(self):
  with self.assertRaises(ValueError):module.restore(self.manifest,self.target,1,0)
  self.assertFalse(self.target.exists())
 def test_normal_restore_is_verified_and_never_overwrites(self):
  result=self.run_restore();self.assertEqual(result['sha256'],hashlib.sha256(self.raw).hexdigest())
  with self.assertRaises(FileExistsError):self.run_restore()
 def test_interrupted_receipt_publication_is_recoverable_without_decompression(self):
  with patch.object(module.os,'replace',side_effect=OSError('fixture receipt interruption')):
   with self.assertRaises(OSError):self.run_restore()
  self.assertEqual(self.target.read_bytes(),self.raw)
  with patch.object(module.gzip,'open',side_effect=AssertionError('must not decompress again')):
   result=self.run_restore(verify_existing=True)
  self.assertEqual(result['state'],'verified_restore')
  self.assertTrue(pathlib.Path(str(self.target)+'.receipt.json').is_file())
 def test_truncated_archive_does_not_publish_target(self):
  data=self.archive.read_bytes()[:-8];self.archive.write_bytes(data)
  manifest=json.loads(self.manifest.read_text());manifest.update(archive_bytes=len(data),archive_sha256=hashlib.sha256(data).hexdigest());self.manifest.write_text(json.dumps(manifest))
  with self.assertRaises(EOFError):self.run_restore()
  self.assertFalse(self.target.exists())
 def test_insufficient_space_does_not_start_decompression(self):
  with patch.object(module.shutil,'disk_usage',return_value=module.shutil._ntuple_diskusage(100,99,1)):
   with self.assertRaises(OSError):self.run_restore()
  self.assertFalse(self.target.exists())
if __name__=='__main__':unittest.main()
