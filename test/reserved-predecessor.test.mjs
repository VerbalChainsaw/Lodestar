import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/contract.mjs';
import { openReadDatabase } from '../src/database.mjs';
import { DatabaseSync } from 'node:sqlite';

test('ordinary replace must preserve an accepted receipt and exact replay', async (t) => {
  const f = await fixture(t);
  const original = await f.request({ mode: 'create', record: {
    id: 'fact:protected', kind: 'fact', name: 'Protected', scope: 'global', availability: 'known',
    data: { example: true }, aliases: [], links: [], sources: []
  } }, [{ kind: 'record', id: 'fact:protected' }]);
  const accepted = await f.cli(['put'], original);
  assert.equal(accepted.code, 0);
  const receiptId = accepted.value.receipt_id;
  let db = await openReadDatabase(f.database);
  const before = db.prepare('SELECT type,content_json FROM records WHERE id=?').get(receiptId);
  db.close();
  const replacement = await f.request({ mode: 'replace', record: {
    id: receiptId, kind: 'fact', name: 'Wrong replacement', scope: 'global', availability: 'known',
    data: { example: true }, aliases: [], links: [], sources: []
  } }, [{ kind: 'record', id: receiptId }]);
  const result = await f.cli(['put'], replacement);
  db = await openReadDatabase(f.database);
  const after = db.prepare('SELECT type,content_json FROM records WHERE id=?').get(receiptId);
  db.close();
  const replay = await f.cli(['put'], original);
  console.log(JSON.stringify({ case: 'immutable-receipt-replace', replacement_exit: result.code,
    receipt_type_before: before.type, receipt_type_after: after.type,
    receipt_bytes_preserved: before.content_json === after.content_json,
    replay_exit: replay.code, replay_error: replay.value.error?.code ?? null }));
  assert.notEqual(result.code, 0, 'Replacing domain receipt with ordinary fact must fail');
  assert.deepEqual(after, before);
  assert.equal(replay.code, 0);
  assert.equal(replay.value.request.replayed, true);
});

test('ordinary type replacement and exact receipt replay stay available', async (t) => {
  const f = await fixture(t);
  const accepted = await f.create('fact:ordinary', 'fact', { example: true });
  const replace = await f.request({ mode: 'replace', record: {
    id: 'fact:ordinary', kind: 'knowledge', name: 'Ordinary', scope: 'global', availability: 'known',
    data: { example: false }, aliases: [], links: [], sources: []
  } }, [{ kind: 'record', id: 'fact:ordinary' }]);
  const result = await f.cli(['put'], replace);
  assert.equal(result.code, 0);
  assert.equal(result.value.data.kind, 'knowledge');
  const replay = await f.cli(['put'], replace);
  assert.equal(replay.code, 0);
  assert.equal(replay.value.request.replayed, true);
  const history = await f.cli(['get', 'fact:ordinary', '--history']);
  assert.equal(history.code, 0);
  assert.equal(history.value.data.versions.length, 1);
});

for (const domain of ['decision-event', 'work-event', 'work', 'pending']) {
  test(`ordinary replace must preserve existing ${domain}`, async (t) => {
    const f = await fixture(t);
    await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
    const actor = { id: 'agent:core-fixture', agent: 'fixture', session: 'core-fixture', harness: 'test' };
    let id;
    const invoke = async (family, action, input, targets) => f.cli([family, action, '--cwd', f.root],
      await f.request(input, [...targets, { kind: 'record', id: 'project:test' }], 'project:test', actor));
    if (domain === 'decision-event') {
      const created = await invoke('decision', 'set', { key: 'core-fixture', value: 'test', reason: 'Fixture', status: 'accepted' },
        [{ kind: 'decision', scope: 'project:test', key: 'core-fixture' }]);
      assert.equal(created.code, 0);
      id = created.value.data.record.id;
    } else if (domain === 'pending') {
      id = 'pending:core-fixture';
      assert.equal((await invoke('pending', 'add', { id, text: 'Fixture' }, [{ kind: 'record', id }])).code, 0);
    } else {
      id = 'work:core-fixture';
      assert.equal((await invoke('work', 'start', { id, description: 'Fixture' }, [{ kind: 'record', id }])).code, 0);
      if (domain === 'work-event') {
        const changed = await invoke('work', 'done', { id, description: 'Fixture finished', outcome: 'completed', action_id: 'fixture:done' },
          [{ kind: 'record', id }]);
        assert.equal(changed.code, 0);
        id = changed.value.data.event_id;
      }
    }
    const before = await f.cli(['get', id, '--raw']);
    assert.equal(before.code, 0);
    const replace = await f.request({ mode: 'replace', record: {
      id, kind: 'fact', name: 'Wrong replacement', scope: 'project:test', availability: 'known',
      data: { example: true }, aliases: [], links: [], sources: []
    } }, [{ kind: 'record', id }], 'project:test');
    const result = await f.cli(['put'], replace);
    const after = await f.cli(['get', id, '--raw']);
    console.log(JSON.stringify({ case: `reserved-${domain}-replace`, replacement_exit: result.code,
      type_after: after.value.data.raw_record.type,
      bytes_preserved: before.value.data.raw_record.content_json === after.value.data.raw_record.content_json }));
    assert.notEqual(result.code, 0);
    assert.deepEqual(after.value.data.raw_record, before.value.data.raw_record);
  });
}

test('an exact confirmed replacement receipt replays before new predecessor admission', async (t) => {
  const f = await fixture(t);
  await f.create('fact:replay-predecessor', 'fact', { example: true });
  const original = await f.request({ mode: 'replace', record: {
    id: 'fact:replay-predecessor', kind: 'knowledge', name: 'Replay predecessor', scope: 'global',
    availability: 'known', data: { example: false }, aliases: [], links: [], sources: []
  } }, [{ kind: 'record', id: 'fact:replay-predecessor' }]);
  assert.equal((await f.cli(['put'], original)).code, 0);
  // The confirmed receipt must remain authoritative even if later target state
  // would be refused for a new request. This disposable corruption does not
  // authenticate a domain record; it only proves replay/admission ordering.
  const db = new DatabaseSync(f.database);
  db.function('lodestar_write_contract', () => 5);
  db.prepare("UPDATE records SET type='work' WHERE id=?").run('fact:replay-predecessor');
  db.close();
  const before = await f.cli(['export']);
  const replay = await f.cli(['put'], original);
  assert.equal(replay.code, 0);
  assert.equal(replay.value.request.replayed, true);
  assert.equal(replay.value.data.kind, 'knowledge');
  assert.deepEqual((await f.cli(['export'])).value.data, before.value.data);
});
