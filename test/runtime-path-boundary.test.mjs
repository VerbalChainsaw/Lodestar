import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadInterfaceConfig, directInterfaceSelection } from '../src/interface-config.mjs';
import { runCli } from '../src/cli.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'portable-db-boundary-'));
  const app = path.join(root, 'app');
  try {
    await mkdir(path.join(app, 'core'), { recursive: true });
    await writeFile(path.join(app, 'core', 'lodestar.mjs'), 'fixture');
    await writeFile(path.join(app, 'Loader.exe'), 'fixture');
    await writeFile(path.join(app, 'bundle-manifest.json'), JSON.stringify({ v: 1, files: [
      { path: 'core/lodestar.mjs', bytes: 7, sha256: createHash('sha256').update('fixture').digest('hex') },
    ] }));
    const file = path.join(app, 'interfaces.json');
    async function bind(database, { source = false } = {}) {
      const resolved = path.resolve(app, database);
      await mkdir(path.dirname(resolved), { recursive: true }); await writeFile(resolved, 'existing-store-witness');
      if (source) {
        await rm(path.join(app, 'bundle-manifest.json')); await writeFile(path.join(app, 'lodestar.mjs'), 'source');
      }
      await writeFile(file, JSON.stringify({ v: 1, generation: '12345678-1234-4234-8234-123456789abc',
        runtime: { node: process.execPath, cli: source ? 'lodestar.mjs' : 'core/lodestar.mjs', database }, loader: 'Loader.exe' }));
      return { resolved, config: await readFile(file), store: await readFile(resolved) };
    }
    await run({ root, app, file, bind });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [name, select] of [
  ['inside app', ({ app }) => path.join(app, 'store.db')],
  ['normalized relative inside app', () => 'core/../store.db'],
  ['case variant inside app', ({ app }) => path.join(app.toUpperCase(), 'store.db')],
  ['owned staging directory', ({ app }) => `${app}.lodestar-stage/store.db`],
  ['owned previous generation', ({ app }) => `${app}.lodestar-previous/store.db`],
]) test(`portable runtime rejects database ${name} before public dispatch`, () => fixture(async context => {
  const { resolved, config, store } = await context.bind(select(context));
  await assert.rejects(loadInterfaceConfig(context.file), error => {
    assert.equal(error.code, 'interface_config_invalid');
    assert.equal(error.identifiers.path, context.file); assert.equal(error.identifiers.pointer, '/runtime/database');
    assert.ok(error.message.includes(resolved)); assert.match(error.message, /Next action:/);
    assert.match(error.action, /outside.*app.*staging.*previous/i); return true;
  });
  let stdout = '', stderr = '';
  const code = await runCli(['manager', '--interface-config', context.file], { stdin: { isTTY: true },
    stdout: { isTTY: true, write(chunk) { stdout += chunk; } }, stderr: { write(chunk) { stderr += chunk; } } });
  assert.notEqual(code, 0); assert.equal(stdout, '');
  const presented = JSON.parse(stderr).error;
  assert.equal(presented.code, 'interface_config_invalid'); assert.equal(presented.identifiers.pointer, '/runtime/database');
  assert.deepEqual(await readFile(context.file), config); assert.deepEqual(await readFile(resolved), store);
}));

for (const suffix of ['-external', '.lodestar-stage-external', '.lodestar-previous-external'])
  test(`portable runtime accepts legitimate prefix sibling ${suffix}`, () => fixture(async context => {
    const { resolved, config, store } = await context.bind(`${context.app}${suffix}/store.db`);
    assert.equal((await loadInterfaceConfig(context.file)).database, resolved);
    assert.deepEqual(await readFile(context.file), config); assert.deepEqual(await readFile(resolved), store);
  }));

test('source config and direct selection retain app-local explicit database semantics', () => fixture(async context => {
  const { resolved } = await context.bind('source.db', { source: true });
  assert.equal((await loadInterfaceConfig(context.file)).database, resolved);
  assert.equal((await directInterfaceSelection(resolved)).database, resolved);
}));

test('portable runtime rejects reparse ancestor aliases before dispatch', () => fixture(async context => {
  const { resolved, config, store } = await context.bind('store.db');
  const alias = path.join(context.root, 'external-alias');
  await symlink(context.app, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = path.join(alias, 'store.db');
  await writeFile(context.file, config.toString().replace('"database":"store.db"', `"database":${JSON.stringify(aliased)}`));
  const before = await readFile(context.file);
  await assert.rejects(loadInterfaceConfig(context.file), error => {
    assert.equal(error.code, 'interface_config_invalid'); assert.equal(error.identifiers.pointer, '/runtime/database');
    assert.match(error.action, /plain.*director/i); return true;
  });
  assert.deepEqual(await readFile(context.file), before); assert.deepEqual(await readFile(resolved), store);
}));

test('portable runtime rejects a reparse ancestor of the selected app root', () => fixture(async context => {
  const { resolved, config, store } = await context.bind(`${context.app}-external/store.db`);
  const alias = path.join(context.root, 'app-alias');
  await symlink(context.app, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadInterfaceConfig(path.join(alias, 'interfaces.json')), error => {
    assert.equal(error.code, 'interface_config_invalid'); assert.equal(error.identifiers.pointer, '/runtime/database');
    assert.match(error.action, /plain.*director/i); return true;
  });
  assert.deepEqual(await readFile(context.file), config); assert.deepEqual(await readFile(resolved), store);
}));
