import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { beginImmediate, normalizeDatabaseBusyError, openConnection } from '../src/database.mjs';
import { sqliteError, nativeStorageCode } from '../src/database-schema.mjs';
import { errorEnvelope, lodestarError } from '../src/errors.mjs';

const ambiguous = [
  ['SQLITE_BUSY', 14], ['SQLITE_LOCKED', 3], ['SQLITE_CORRUPT', 3], ['SQLITE_NOTADB', 5],
  ['SQLITE_PERM', 5], ['SQLITE_CANTOPEN', 11], ['SQLITE_BUSY', 99], ['SQLITE_IOERR', 99],
  ['SQLITE_UNKNOWN', 5], ['SQLITE_BUSYISH', 5], ['SQLITE_CORRUPTION', 11],
  ['ERR_SQLITE_ERROR', -251], ['ERR_SQLITE_ERROR', 4294967301],
];
for (const [code, errcode] of ambiguous)
  test(`ambiguous native evidence ${code}/${errcode} cannot infer a storage diagnosis`, () => {
    const raw = Object.assign(new Error('private native detail'), { code, errcode });
    assert.equal(normalizeDatabaseBusyError(raw, 'witness.db'), raw);
    assert.throws(() => beginImmediate({ exec() { throw raw; } }, 'witness.db'), error => {
      assert.equal(error.code, 'database_error'); assert.equal(error.cause, raw);
      assert.equal(error.identifiers.database, 'witness.db');
      assert.doesNotMatch(JSON.stringify(errorEnvelope(error)), /private native detail/); return true;
    });
  });

const classes = [
  ['SQLITE_BUSY', 5, 'database_busy', /other writer/],
  ['SQLITE_LOCKED', 6, 'database_busy', /other writer/],
  ['SQLITE_CORRUPT', 11, 'database_integrity', /external backup/],
  ['SQLITE_NOTADB', 26, 'database_integrity', /external backup/],
  ['SQLITE_CANTOPEN', 14, 'database_open_failed', /parent-directory access/],
  ['SQLITE_FULL', 13, 'database_storage_full', /free space/],
  ['SQLITE_READONLY', 8, 'database_read_only', /directory permissions/],
  ['SQLITE_IOERR', 10, 'database_io_failed', /device health/],
];
for (const [symbolic, primary, expected, action] of classes)
  for (const [code, errcode] of [[symbolic, undefined], [symbolic, primary], ['ERR_SQLITE_ERROR', primary]])
    test(`verified native evidence ${code}/${errcode ?? 'absent'} preserves ${expected}`, () => {
      const raw = Object.assign(new Error('private native detail'), { code, ...(errcode === undefined ? {} : { errcode }) });
      const observed = sqliteError(raw, 'witness.db');
      assert.equal(observed.code, expected); assert.equal(observed.cause, raw);
      assert.equal(observed.identifiers.database, 'witness.db'); assert.match(observed.action, action);
      if (!['database_busy', 'database_integrity'].includes(expected)) {
        assert.equal(observed.identifiers.storage_directory, path.dirname(path.resolve('witness.db')));
        assert.equal(observed.identifiers.sqlite_errcode, errcode ?? null);
      }
      assert.doesNotMatch(JSON.stringify(errorEnvelope(observed)), /private native detail/);
    });

for (const [code, errcode, journal] of [
  ['ERR_SQLITE_ERROR', 776, 'witness.db-journal'], ['SQLITE_READONLY_ROLLBACK', 776, 'witness.db-journal'],
  ['ERR_SQLITE_ERROR', 264, 'witness.db-wal'], ['SQLITE_READONLY_RECOVERY', 264, 'witness.db-wal'],
]) test(`verified recovery ${code}/${errcode} preserves journal guidance`, () => {
  const raw = Object.assign(new Error('private native detail'), { code, errcode });
  const observed = sqliteError(raw, 'witness.db');
  assert.equal(observed.code, 'database_recovery_required'); assert.equal(observed.cause, raw);
  assert.equal(observed.identifiers.journal, journal); assert.equal(observed.identifiers.sqlite_errcode, errcode);
  assert.match(observed.action, /Do not delete journals/);
});

for (const [code, errcode] of [
  ['SQLITE_UNKNOWN', 776], ['SQLITE_IOERR', 776], ['SQLITE_READONLY_ROLLBACK', 5],
  ['SQLITE_READONLY_RECOVERY', 776], ['SQLITE_READONLY_ROLLBACK', 264],
  ['SQLITE_READONLY_DBMOVED', 776], ['SQLITE_READONLY_UNKNOWN', 264],
  ['SQLITE_BUSY', -1], ['SQLITE_BUSY', 5.5], ['SQLITE_BUSY', 4294967301],
  [`SQLITE_BUSY_${'X'.repeat(5000)}`, 5],
]) test(`unverified family or numeric data stays unknown: ${code.length > 80 ? 'oversized symbolic name' : code}/${errcode}`, () => {
  const raw = Object.assign(new Error('private native detail'), { code, errcode });
  const observed = sqliteError(raw, 'witness.db');
  assert.equal(observed.code, 'database_error'); assert.equal(observed.cause, raw);
  assert.equal(normalizeDatabaseBusyError(raw, 'witness.db'), raw);
  assert.doesNotMatch(JSON.stringify(errorEnvelope(observed)), /private native detail|X{100}/);
});

test('classification preserves branded failures and never reads hostile getters or proxy traps', () => {
  let reads = 0; const hostile = {};
  for (const key of ['code', 'errcode', 'errstr', 'message', 'cause'])
    Object.defineProperty(hostile, key, { get() { reads++; throw new Error('hostile getter'); } });
  assert.equal(normalizeDatabaseBusyError(hostile, 'witness.db'), hostile);
  assert.equal(sqliteError(hostile, 'witness.db').code, 'database_error');
  assert.equal(nativeStorageCode(hostile), null); assert.equal(reads, 0);
  const trap = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('hostile descriptor'); } });
  assert.equal(normalizeDatabaseBusyError(trap, 'witness.db'), trap);
  assert.equal(sqliteError(trap, 'witness.db').code, 'database_error');
  const branded = lodestarError('invalid_database', 'invalid timestamp');
  assert.equal(sqliteError(branded, 'witness.db'), branded);
});

test('actual Node SQLite open failure retains selected path and typed recovery action', () => {
  const file = path.join(import.meta.dirname, 'missing-parent-fixture-never-created', 'state.db');
  assert.throws(() => openConnection(file, { readOnly: true }), error => {
    assert.equal(error.code, 'database_open_failed'); assert.equal(error.identifiers.database, file);
    assert.equal(error.cause.code, 'ERR_SQLITE_ERROR'); assert.equal(error.cause.errcode & 0xff, 14);
    assert.match(error.action, /parent-directory access/); return true;
  });
});
