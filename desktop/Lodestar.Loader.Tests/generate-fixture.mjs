import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = resolve(process.argv[2] ?? './work/loader-fixture');
let search = import.meta.dirname;
while (!existsSync(join(search, 'lodestar.mjs')) && dirname(search) !== search) search = dirname(search);
const cli = join(search, 'lodestar.mjs');
if (!existsSync(cli)) throw new Error('Source lodestar.mjs was not found above the fixture generator.');
const db = join(directory, 'fixture.db');
await mkdir(directory, { recursive: true });
function call(...args) {
  const result = spawnSync(process.execPath, [cli, '--db', db, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const body = result.stdout.trim() || result.stderr.trim();
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error(`${args.join(' ')}: ${result.status}: ${body.slice(0, 1000)}`); }
  return { status: result.status, body: parsed };
}
function expect(operation, result) {
  if (result.status !== 0 || !result.body.ok) throw new Error(`${operation}: ${JSON.stringify(result.body).slice(0, 2000)}`);
  return result.body;
}
expect('init', call('init'));
async function create(record) {
  const missing = call('get', record.id);
  if (missing.body.error?.code !== 'record_not_found') throw new Error(`Expected absence for ${record.id}`);
  const absentBasis = missing.body.error.identifiers.write_basis;
  const basis = record.scope === 'global' ? absentBasis
    : expect('project work basis', call('work', 'status', '--cwd', directory)).data.write_basis;
  if (record.scope !== 'global') {
    if (basis.project_scope !== record.scope || !basis.checkout)
      throw new Error(`Fixture root did not resolve the requested project ${record.scope}.`);
    basis.targets.push(...absentBasis.targets);
  }
  const body = { v: 5, request_id: `fixture-${randomUUID()}`, write_basis: basis,
    input: { mode: 'create', record: { availability: 'known', priority: 1,
      aliases: [], links: [], sources: [], ...record } } };
  const file = join(directory, `${record.id.replaceAll(':', '-')}-create.json`);
  await writeFile(file, JSON.stringify(body));
  expect('put '+ record.id, call('put', '--file', file));
}
const projectId = 'project:loader-fixture';
await create({ id: projectId, kind: 'project', name: 'Loader fixture', scope: 'global',
  data: { roots: [directory], description: 'Disposable project for Loader acceptance.', status: 'active', notes: 'Verify current and history.' },
  semantics: { lifecycle: 'current', context_role: 'orientation', basis: 'asserted',
    applicability: { project: projectId, checkout: null } } });
await create({ id: 'fact:loader-editable', kind: 'fact', name: 'Editable fixture fact', scope: projectId,
  data: { description: 'Edit this note through Loader.', notes: 'Original', nested: { version: 1 } },
  semantics: { lifecycle: 'current', context_role: 'orientation', basis: 'asserted',
    applicability: { project: projectId, checkout: null } } });
await create({ id: 'fact:loader-global', kind: 'fact', name: 'Global knowledge fixture', scope: 'global',
  data: { description: 'This is not owned by a project.' },
  semantics: { lifecycle: 'current', context_role: 'on_demand', basis: 'asserted',
    applicability: { project: null, checkout: null } } });
await create({ id: 'fact:loader-legacy-shaped', kind: 'fact', name: 'Legacy fields fixture', scope: projectId,
  data: { completion: 'recorded', completed_at: '2024-01-02T00:00:00Z', current_work: 'Earlier task', status: 'closed' },
  semantics: { lifecycle: 'current', context_role: 'on_demand', basis: 'asserted',
    applicability: { project: projectId, checkout: null } } });
const config = { v: 1, generation: randomUUID(), runtime: { node: process.execPath,
  cli, database: db }, loader: 'Lodestar.Loader.exe',
  ui: { last_project_id: projectId, theme: 'system', project_sort: 'name' } };
await writeFile(join(directory, 'interfaces.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ directory, config: join(directory, 'interfaces.json'), database: db,
  projectId, editableRecordId: 'fact:loader-editable' }));
