// Creates only a new disposable fixture directory, using the selected bundle's core.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [rootArg, cliArg, nodeArg, loaderArg] = process.argv.slice(2);
if (!rootArg || !cliArg || !nodeArg || !loaderArg) throw new Error('Expected new fixture root, packaged CLI, Node, Loader.');
const root = resolve(rootArg), cli = resolve(cliArg), node = resolve(nodeArg), loader = resolve(loaderArg);
if (existsSync(root)) throw new Error('Fixture root already exists; refusing reuse: ' + root);
for (const file of [cli, node, loader]) if (!existsSync(file)) throw new Error('Missing runtime file: ' + file);
await mkdir(root);
const database = join(root, 'fixture.db');
function call(...args) {
  const result = spawnSync(node, [cli, '--db', database, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  const output = result.stdout.trim() || result.stderr.trim();
  let body;
  try { body = JSON.parse(output); } catch { throw new Error(`${args[0]} returned ${result.status}: ${output.slice(0, 600)}`); }
  return { status: result.status, body };
}
function good(label, result) {
  if (result.status !== 0 || !result.body.ok) throw new Error(`${label}: ${JSON.stringify(result.body).slice(0, 1200)}`);
  return result.body;
}
good('init', call('init'));
async function create(record) {
  const absent = call('get', record.id);
  if (absent.body.error?.code !== 'record_not_found' || !absent.body.error?.identifiers?.write_basis)
    throw new Error('Expected missing record and write basis: ' + record.id);
  const request = { v: 5, request_id: 'fixture-' + randomUUID(),
    write_basis: absent.body.error.identifiers.write_basis,
    input: { mode: 'create', record: { availability: 'known', priority: 1,
      aliases: [], links: [], sources: [], ...record } } };
  const path = join(root, record.id.replaceAll(':', '-') + '-create.json');
  await writeFile(path, JSON.stringify(request));
  good('create ' + record.id, call('put', '--file', path));
}
const projectId = 'project:loader-fixture';
await create({ id: projectId, kind: 'project', name: 'Loader fixture', scope: 'global',
  data: { roots: [root], description: 'Disposable project for Loader UI regression.', status: 'active', notes: 'Fixture only.' },
  semantics: { lifecycle: 'current', context_role: 'orientation', basis: 'asserted',
    applicability: { project: projectId, checkout: null } } });
await create({ id: 'fact:loader-editable', kind: 'fact', name: 'Editable fixture fact', scope: projectId,
  data: { description: 'Edit through Loader.', notes: 'Original', nested: { version: 1 } },
  semantics: { lifecycle: 'current', context_role: 'orientation', basis: 'asserted',
    applicability: { project: projectId, checkout: null } } });
await create({ id: 'fact:loader-global', kind: 'fact', name: 'Global knowledge fixture', scope: 'global',
  data: { description: 'Global fixture.' },
  semantics: { lifecycle: 'current', context_role: 'on_demand', basis: 'asserted',
    applicability: { project: null, checkout: null } } });
await create({ id: 'fact:loader-legacy-shaped', kind: 'fact', name: 'Legacy fields fixture', scope: projectId,
  data: { completion: 'recorded', completed_at: '2024-01-02T00:00:00Z', current_work: 'Earlier task', status: 'closed' },
  semantics: { lifecycle: 'current', context_role: 'on_demand', basis: 'asserted',
    applicability: { project: projectId, checkout: null } } });
const config = { v: 1, generation: randomUUID(), runtime: { node, cli, database }, loader,
  ui: { last_project_id: projectId, theme: 'system', project_sort: 'name' } };
const configPath = join(root, 'interfaces.json');
await writeFile(configPath, JSON.stringify(config, null, 2));
await writeFile(join(root, 'fixture-owner.json'), JSON.stringify({ kind: 'lodestar-loader-ui-regression', v: 1,
  packaged_cli: cli, loader, database, config: configPath }, null, 2));
console.log(JSON.stringify({ root, config: configPath, database, projectId, recordId: 'fact:loader-editable' }));
