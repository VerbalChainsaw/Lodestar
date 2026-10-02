// Disposable benchmark data only. Never accepts an existing directory or database.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const [directoryArg, coreArg, countArg = '1467', projectsArg = '134'] = process.argv.slice(2);
if (!directoryArg || !coreArg) throw new Error('Usage: node generate-catalog.mjs NEW_DIRECTORY CORE_ROOT [nonProjectRecords] [projects]');
const directory = resolve(directoryArg), core = resolve(coreArg);
const count = Number(countArg), projects = Number(projectsArg);
if (!Number.isSafeInteger(count) || count < 1 || count > 200000 ||
    !Number.isSafeInteger(projects) || projects < 1 || projects > 2000) throw new Error('Unsupported fixture size.');
if (existsSync(directory) && (await readdir(directory)).length) throw new Error('Fixture directory must be new or empty.');
if (!existsSync(join(core, 'lodestar.mjs'))) throw new Error('Core root is missing lodestar.mjs.');
await mkdir(directory, { recursive: true });
const { openConnection, initializeConnection, admittedTransaction } = await import(pathToFileURL(join(core, 'src/database.mjs')));
const { allocateRevision } = await import(pathToFileURL(join(core, 'src/revisions.mjs')));
const dbPath = join(directory, 'fixture.db');
const db = openConnection(dbPath);
initializeConnection(db, { createdAt: new Date().toISOString() });
const semantics = project => ({ lifecycle: 'current', context_role: 'orientation', basis: 'asserted',
  applicability: { project, checkout: null } });
try {
  admittedTransaction(db, () => {
    const insert = db.prepare('INSERT INTO records(id,type,name,scope,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
    const revision = allocateRevision(db);
    for (let i = 0; i < projects; i++) {
      const id = `project:benchmark-${i.toString().padStart(4, '0')}`;
      const date = new Date(Date.UTC(2026, 8, 1 + i % 27)).toISOString();
      const content = { state: 'known', value: { roots: [], description: 'Disposable operator performance fixture.',
        status: ['active', 'paused', 'complete'][i % 3] },
        _lodestar: { revision, priority: 1, semantics: semantics(id) } };
      insert.run(id, 'project', `Benchmark project ${i.toString().padStart(4, '0')}`, 'global', JSON.stringify(content), date, date);
    }
    for (let i = 0; i < count; i++) {
      const project = `project:benchmark-${(i % projects).toString().padStart(4, '0')}`;
      const date = new Date(Date.UTC(2026, 8, 1 + i % 27, i % 24)).toISOString();
      const content = { state: i % 19 === 0 ? 'stale' : 'known', value: {
        description: `Benchmark record ${i} for search and readable inspection.`,
        status: ['open', 'closed', 'blocked'][i % 3], notes: 'Synthetic local data; contains no real project content.',
        iteration: i, enabled: i % 2 === 0, nested: { example: true, missing: null }, tags: ['benchmark', `group-${i % 7}`] },
        _lodestar: { revision, priority: i % 5, semantics: semantics(project) } };
      insert.run(`fact:benchmark-${i.toString().padStart(6, '0')}`, i % 3 === 0 ? 'note' : 'fact',
        `Benchmark record ${i.toString().padStart(6, '0')}`, project, JSON.stringify(content), date, date);
    }
  });
} finally { db.close(); }
const manifest = { v: 1, fixture: 'synthetic-benchmark', created_at: new Date().toISOString(),
  projects, nonProjectRecords: count, currentRecords: projects + count,
  scannedRows: projects * 2 + count, database: dbPath, core };
await writeFile(join(directory, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(join(directory, 'interfaces.json'), JSON.stringify({ v: 1, generation: randomUUID(),
  runtime: { node: process.execPath, cli: join(core, 'lodestar.mjs'), database: dbPath },
  loader: 'Lodestar.Loader.exe', ui: { theme: 'dark', project_sort: 'name' } }, null, 2));
console.log(JSON.stringify(manifest));
