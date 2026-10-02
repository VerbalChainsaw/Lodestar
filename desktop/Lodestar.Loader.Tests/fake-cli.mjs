import { readFileSync } from 'node:fs';
const mode = process.env.LODESTAR_FAKE_MODE ?? process.argv.at(-1);
if (mode.startsWith('case:')) {
  const fixture = JSON.parse(readFileSync(new URL('./cli-protocol-cases.json', import.meta.url), 'utf8'));
  const entry = fixture.cases.find(({ id }) => id === mode.slice(5));
  if (!entry) throw new Error('Unknown protocol case.');
  const envelope = (ok) => {
    const result = { v: 5, ok, operation: entry.operation,
    revision: 7, database_instance_id: 'a'.repeat(64), database_epoch: 'b'.repeat(64),
    ...(ok ? { data: { reference: 'public:opaque-handoff-ref' } } : { error: {
      code: 'revision_conflict', message: 'Observed revision changed.',
      action: 'Read the current basis and resolve the saved request.',
      identifiers: { request_id: 'll-fixture', record_id: 'handoff:public' } } }),
      more: false, next: [] };
    for (const name of entry.omit ?? []) delete result[name];
    return JSON.stringify(Object.assign(result, entry.set ?? {}));
  };
  const render = (part) => part === '@success' ? envelope(true) :
    part === '@error' ? envelope(false) : part;
  for (const part of entry.stdout) console.log(render(part));
  for (const part of entry.stderr) console.error(render(part));
  process.exitCode = entry.exitCode;
} else {
const response = (operation, ok = true, data = {}) => JSON.stringify({
  v: 5, ok, operation, revision: 3,
  database_instance_id: 'a'.repeat(64), database_epoch: 'b'.repeat(64),
  data, error: ok ? undefined : { code: 'fixture_error', message: 'Fixture rejected the request.' },
  more: false, next: []
});
if (mode === 'success') console.log(response('get', true, { id: 'k', kind: 'note', scope: 'global' }));
else if (mode === 'warning') { console.error('ExperimentalWarning: harmless fixture'); console.log(response('get')); }
else if (mode === 'error') { console.error(response('get', false)); process.exitCode = 2; }
else if (mode === 'exit4') { console.log(response('doctor', true, { healthy: false })); process.exitCode = 4; }
else if (mode === 'bad') console.log('not json');
else if (mode === 'overflow') console.log('x'.repeat(17 * 1024 * 1024));
else if (mode === 'overflow-hang') { console.error('PRIVATE_BODY_MARKER');
  process.stdout.write('x'.repeat(17 * 1024 * 1024)); setTimeout(() => {}, 30000); }
else if (mode === 'timeout') setTimeout(() => console.log(response('put')), 5000);
else if (mode === 'timeout-secret') { console.error('ExperimentalWarning: PRIVATE_BODY_MARKER');
  setTimeout(() => console.log(response('put')), 5000); }
else if (mode === 'duplicate') { console.log(response('get')); console.error(response('get')); }
else if (mode === 'delivery-failed') {
  const db = process.argv[process.argv.indexOf('--db') + 1];
  console.error(JSON.stringify({ v: 5, ok: false, operation: 'put', revision: 6,
    database_instance_id: 'a', database_epoch: 'b', more: false, next: [],
    request: { id: 'll-fixture' }, error: { code: 'response_delivery_failed',
      message: 'Committed write response could not be delivered.',
      action: 'Inspect the exact saved request and receipt.',
      identifiers: { request_id: 'll-fixture', committed_revision: 6,
        receipt_id: 'receipt:fixture', receipt_read_args: ['--db', db, 'get', 'receipt:fixture'],
        database_instance_id: 'a', database_epoch: 'b' } } }));
  process.exitCode = 5;
}
}
