import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync, backup } from 'node:sqlite';
import { fixture } from './helpers/contract.mjs';
import { openReadDatabase } from '../src/database.mjs';
import { startProjection } from '../src/agent-state.mjs';
import { resolveProjectScope } from '../src/project.mjs';
import { recoveryPreflight, promoteRecoveredDatabase } from '../src/schema-migration.mjs';
import { createMigrationBackup, migrateDatabase, migrationPreflight } from '../src/schema-migration.mjs';
import { SCHEMA_V4_SQL } from '../src/schema.mjs';
import { temporaryDirectory } from './helpers/contract.mjs';

test('rejected dependency loads once per projection while each requiring edge stays visible', async (t) => {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  for (const [id, semantics] of [
    ['fact:retired', { lifecycle: 'historical' }],
    ['fact:elsewhere', { lifecycle: 'current' }],
  ]) await f.create(id, 'fact', { text: id }, 'project:test', { context_role: 'on_demand', ...semantics });
  const raw = new DatabaseSync(f.database);
  try {
    raw.function('lodestar_write_contract', () => 5);
    const content = JSON.parse(raw.prepare("SELECT content_json FROM records WHERE id='fact:elsewhere'").get().content_json);
    content._lodestar.semantics.applicability.checkout = path.join(f.root, 'other');
    raw.prepare("UPDATE records SET content_json=? WHERE id='fact:elsewhere'").run(JSON.stringify(content));
  } finally { raw.close(); }
  for (const id of ['fact:a', 'fact:b', 'fact:c']) {
    await f.create(id, 'fact', { text: id }, 'project:test', { lifecycle: 'current', context_role: 'orientation' });
    const request = await f.request({ mode: 'update', id, set: { links: [
      { relationship: 'requires', to_id: 'fact:retired' },
      { relationship: 'requires', to_id: 'fact:elsewhere' },
    ] }, remove: [] }, [{ kind: 'record', id }], 'project:test');
    assert.equal((await f.cli(['put'], request)).code, 0);
  }
  const db = await openReadDatabase(f.database);
  try {
    db.exec('BEGIN');
    const project = { ...resolveProjectScope(db, 'project:test', f.root), cwd: f.root, checkout_root: f.root };
    const original = db.prepare.bind(db);
    let loads = 0;
    db.prepare = (sql) => {
      if (sql === 'SELECT * FROM records WHERE id=?') loads++;
      return original(sql);
    };
    const result = startProjection(db, project, {});
    assert.deepEqual(result.data.context.map(({ id }) => id), ['fact:a', 'fact:b', 'fact:c']);
    const errors = result.data.record_errors.filter(({ code }) => code === 'required_dependency_unavailable');
    assert.equal(errors.length, 6);
    assert.deepEqual(errors.map(({ identifiers }) => [identifiers.id, identifiers.required_by]).sort(),
      ['fact:retired', 'fact:elsewhere'].flatMap((id) => ['fact:a', 'fact:b', 'fact:c'].map((by) => [id, by])).sort());
    t.diagnostic(`dependency singleton SELECTs: ${loads}, edges: 6, distinct targets: 2`);
    assert.equal(loads, 2);
    db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('recovery inventories each locked image once and retains exact accounting and replay', async (t) => {
  const f = await fixture(t);
  await f.create('fact:preserved', 'fact', { bytes: 'exact preserved data' });
  const source = path.join(f.root, 'accepted.db');
  const db = new DatabaseSync(f.database);
  try { await backup(db, source); } finally { db.close(); }
  const recovery = await recoveryPreflight(f.database, source);
  const request = { v: 5, request_id: 'recovery:counter', database_instance_id: recovery.recovered.database_instance_id,
    database_epoch: recovery.recovered.database_epoch, reason: 'counter-test', recovery };
  const original = DatabaseSync.prototype.prepare;
  let inventoryReads = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    if (/^SELECT .+ FROM (metadata|records|aliases|links|sources) ORDER BY /u.test(sql)) inventoryReads++;
    return original.call(this, sql);
  };
  let result;
  try { result = await promoteRecoveredDatabase(f.database, { request }); }
  finally { DatabaseSync.prototype.prepare = original; }
  assert.equal(result.promoted, true);
  assert.notEqual(result.database_epoch, request.database_epoch);
  assert.equal((await f.cli(['get', 'fact:preserved'])).value.data.data.bytes, 'exact preserved data');
  assert.equal((await promoteRecoveredDatabase(f.database, { request })).replayed, true);
  t.diagnostic(`locked inventory SELECTs: ${inventoryReads}`);
  assert.equal(inventoryReads, 10);
});

test('migration retains ordered exact before-images across multiple records and shared source origins', async (t) => {
  const root = await temporaryDirectory(t, 'lodestar-indexed-migration-');
  const file = path.join(root, 'source.db');
  const db = new DatabaseSync(file);
  const original = {};
  try {
    db.exec(SCHEMA_V4_SQL);
    const metadata = db.prepare('INSERT INTO metadata VALUES(?,?)');
    for (const [key, value] of Object.entries({ schema_version: '4', created_at: '2026-09-06T09:00:00.000Z',
      database_instance_id: 'a'.repeat(64), database_revision: '9', database_epoch: 'b'.repeat(64) })) metadata.run(key, value);
    for (let i = 0; i < 12; i++) {
      const id = `fact:${String(i).padStart(2, '0')}`;
      db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id, 'fact', id, 'global',
        `{ "state": "known", "value": { "index": ${i} }, "_lodestar":{"priority":0,"revision":9}}`,
        '2026-09-06T09:00:00.000Z', '2026-09-06T09:00:00.000Z');
      for (const origin of ['shared:second', 'shared:first']) {
        db.prepare('INSERT INTO aliases VALUES(?,?)').run(`${origin}:${i}`, id);
        db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run(id, origin, 'current', `{"legacy":${i}}`);
      }
      db.prepare('INSERT INTO links VALUES(?,?,?,?)').run(id, 'requires', id, '2026-09-06T09:00:00.000Z');
    }
    for (const [table, order] of Object.entries({ records: 'id,type,name,scope,content_json,created_at,updated_at',
      aliases: 'alias,record_id', links: 'from_id,relationship,to_id,created_at', sources: 'record_id,origin,freshness,metadata_json' })) {
      original[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    }
  } finally { db.close(); }
  const preflight = await migrationPreflight(file);
  const backupEvidence = await createMigrationBackup(file, path.join(root, 'backup.db'));
  const request = { v: 5, request_id: 'migration:ordered-index', preflight, backup: backupEvidence };
  const result = await migrateDatabase(file, { request });
  const current = new DatabaseSync(file);
  try {
    const provenance = JSON.parse(current.prepare('SELECT content_json FROM records WHERE id=?').get(result.provenance_id).content_json).value;
    assert.deepEqual(provenance.before_images.map(({ raw_record }) => raw_record), original.records.map((row) => ({ ...row })));
    for (const image of provenance.before_images) {
      for (const table of ['aliases', 'links', 'sources']) assert.deepEqual(image.raw_associations[table],
        original[table].filter((row) => (row.record_id ?? row.from_id) === image.raw_record.id).map((row) => ({ ...row })));
    }
    assert.equal(result.database_instance_id, preflight.database_instance_id);
    assert.equal(result.revision, 10);
    assert.notEqual(result.database_epoch, preflight.database_epoch);
    assert.deepEqual((await migrateDatabase(file, { request })), { ...result, replayed: true });
  } finally { current.close(); }
});
