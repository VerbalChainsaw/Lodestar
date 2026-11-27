import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { errorResult, lodestarError } from '../src/errors.mjs';
import { fixture } from './helpers/contract.mjs';

test('undispatched typo and option errors name usable help and leave database unchanged', async t => {
  const f = await fixture(t), before = await readFile(f.database);
  for (const args of [['putt'], ['get', '--typo']]) {
    const result = await f.cli(args); assert.equal(result.code, 2);
    assert.match(result.value.error.action, /lodestar.*--help/);
    assert.doesNotMatch(result.value.error.action, /receipt|reconcil|exact.*request|doctor/iu);
  }
  assert.deepEqual(await readFile(f.database), before);
});

test('known read failure gives read correction while unknown internal write stays uncertain', async t => {
  const f = await fixture(t); await f.create('note:read-failure', 'note', {});
  const before = await readFile(f.database), original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    if (sql === 'SELECT id FROM records WHERE id = ?') throw new Error('PRIVATE');
    return original.call(this, sql, ...args);
  };
  let result; try { result = await f.cli(['get', 'note:read-failure']); }
  finally { DatabaseSync.prototype.prepare = original; }
  assert.equal(result.value.error.code, 'internal_error'); assert.match(result.value.error.action, /read|inspect/iu);
  assert.doesNotMatch(result.value.error.action, /whether a write|request bytes|before replay/iu);
  assert.deepEqual(await readFile(f.database), before);
  assert.match(errorResult(new Error('PRIVATE')).envelope.error.action, /does not establish whether a write/);
  const explicit = 'Inspect the original receipt before exact replay.';
  assert.equal(errorResult(lodestarError('request_conflict', 'Conflict', { action: explicit })).envelope.error.action, explicit);
});
