import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadInterfaceConfig, revalidateSelection } from '../src/interface-config.mjs';
import { runCli } from '../src/cli.mjs';
import { errorPayload } from '../src/errors.mjs';

async function fixture(run) {
  const parent = await mkdtemp(path.join(tmpdir(), 'runtime-config-'));
  const root = path.join(parent, 'app');
  try {
    await mkdir(path.join(root, 'core'), { recursive: true });
    await writeFile(path.join(root, 'core', 'lodestar.mjs'), 'fixture');
    await writeFile(path.join(root, '../a.db'), 'a');
    await writeFile(path.join(root, '../b.db'), 'b');
    const config = JSON.stringify({ v: 1, generation: '12345678-1234-4234-8234-123456789abc',
      runtime: { node: process.execPath, cli: 'core/lodestar.mjs', database: '../a.db' }, legacy: { extra: true } });
    const hash = createHash('sha256').update('fixture').digest('hex');
    const manifest = JSON.stringify({ v: 1, files: [{ path: 'core/lodestar.mjs', bytes: 7, sha256: hash }] });
    const file = path.join(root, 'interfaces.json');
    const manifestFile = path.join(root, 'bundle-manifest.json');
    await writeFile(file, config); await writeFile(manifestFile, manifest);
    await run({ root, file, manifestFile, config, manifest, hash });
  } finally { await rm(parent, { recursive: true, force: true }); }
}

for (const [name, transform, field] of [
  ['duplicate database', s => s.replace('"database":"../a.db"', '"database":"../a.db","database":"../b.db"'), '/runtime/database'],
  ['duplicate generation', s => s.replace('"v":1', '"generation":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","v":1'), '/generation'],
  ['escaped duplicate database', s => s.replace('"database":"../a.db"', '"database":"../a.db","data\\u0062ase":"../b.db"'), '/runtime/database'],
  ['invalid UTF8', s => Buffer.concat([Buffer.from(s.slice(0, -1) + ',"extra":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]), 'UTF-8'],
]) test(`binding rejects ${name} without changing bytes`, () => fixture(async ({ file, config }) => {
  await writeFile(file, transform(config)); const before = await readFile(file);
  await assert.rejects(loadInterfaceConfig(file, { requireLoader: false }), error => {
    assert.equal(error.code, 'interface_config_invalid'); assert.ok(error.message.includes(file));
    assert.ok(error.message.includes(field)); assert.match(error.message, /Next action:/); return true;
  });
  assert.deepEqual(await readFile(file), before);
}));

test('manifest rejects conflicting duplicate hashes and preserves bytes', () => fixture(async ({ file, manifestFile, manifest, hash }) => {
  await writeFile(manifestFile, manifest.replace(`"sha256":"${hash}"`, `"sha256":"${'0'.repeat(64)}","sha256":"${hash}"`));
  const before = await readFile(manifestFile);
  await assert.rejects(loadInterfaceConfig(file, { requireLoader: false }), error => {
    assert.ok(error.message.includes(manifestFile)); assert.ok(error.message.includes('/files/0/sha256'));
    assert.match(error.message, /Next action:/); return true;
  });
  assert.deepEqual(await readFile(manifestFile), before);
}));

test('manifest rejects invalid UTF8 and preserves bytes', () => fixture(async ({ file, manifestFile, manifest }) => {
  const bytes = Buffer.concat([Buffer.from(manifest.slice(0, -1) + ',"extra":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  await writeFile(manifestFile, bytes);
  await assert.rejects(loadInterfaceConfig(file, { requireLoader: false }), error => {
    assert.ok(error.message.includes(manifestFile)); assert.match(error.message, /UTF-8/);
    assert.match(error.message, /Next action:/); return true;
  });
  assert.deepEqual(await readFile(manifestFile), bytes);
}));

for (const document of ['config', 'manifest'])
  test(`${document} still rejects nested escaped duplicates after ignored legacy numbers`, () => fixture(async ({ file, manifestFile, config, manifest }) => {
    const target = document === 'config' ? file : manifestFile;
    const original = document === 'config' ? config : manifest;
    const bytes = Buffer.from('{"legacyNumber":9007199254740992,"nested":[{"a/b~c":0.1234567890123456789,"a\\u002fb~c":2}],' + original.slice(1));
    await writeFile(target, bytes);
    await assert.rejects(loadInterfaceConfig(file, { requireLoader: false }), error => {
      assert.equal(error.code, 'interface_config_invalid');
      assert.equal(error.identifiers.path, target);
      assert.equal(error.identifiers.pointer, '/nested/0/a~1b~0c');
      assert.match(error.action, /unique member names/); return true;
    });
    assert.deepEqual(await readFile(target), bytes);
  }));

test('ordinary valid legacy config loads without BOM', () => fixture(async ({ file, root }) => {
  assert.equal((await loadInterfaceConfig(file, { requireLoader: false })).database, path.join(root, '../a.db'));
}));

for (const numeric of ['9007199254740992', '0.1234567890123456789'])
  test(`ignored legacy numeric fields remain compatible and byte preserved: ${numeric}`, () => fixture(async ({ file, manifestFile, config, manifest, root }) => {
    const configBytes = Buffer.from(config.replace('"extra":true', `"extra":true,"number":${numeric}`));
    const manifestBytes = Buffer.from(manifest.slice(0, -1) + `,"legacy":{"number":${numeric}}}`);
    await writeFile(file, configBytes); await writeFile(manifestFile, manifestBytes);
    assert.equal((await loadInterfaceConfig(file, { requireLoader: false })).database, path.join(root, '../a.db'));
    assert.deepEqual(await readFile(file), configBytes); assert.deepEqual(await readFile(manifestFile), manifestBytes);
  }));

for (const [name, document, transform, pointer] of [
  ['config version', 'config', text => text.replace('"v":1', '"v":1.0000000000000001'), '/v'],
  ['manifest version', 'manifest', text => text.replace('"v":1', '"v":1.0000000000000001'), '/v'],
  ['core bytes', 'manifest', text => text.replace('"bytes":7', '"bytes":6.9999999999999999'), '/files/0/bytes'],
  ['core bytes after ignored entry', 'manifest', text => text.replace('"files":[', '"files":[{"path":"other/ignored","bytes":0.1234567890123456789},').replace('"bytes":7', '"bytes":6.9999999999999999'), '/files/1/bytes'],
]) test(`binding rejects lossy meaningful ${name} with public numeric correction`, () => fixture(async ({ root, file, manifestFile, config, manifest }) => {
  await writeFile(path.join(root, 'Loader.exe'), 'fixture');
  const validConfig = config.slice(0, -1) + ',"loader":"Loader.exe"}';
  await writeFile(file, validConfig);
  const target = document === 'config' ? file : manifestFile;
  const bytes = Buffer.from(transform(document === 'config' ? validConfig : manifest));
  await writeFile(target, bytes);
  await assert.rejects(loadInterfaceConfig(file, { requireLoader: false }), error => {
    assert.equal(error.code, 'interface_config_invalid');
    assert.equal(error.identifiers.path, target); assert.equal(error.identifiers.pointer, pointer);
    assert.match(error.action, /exact.*numeric/); assert.doesNotMatch(error.action, /use a string/i); return true;
  });
  let stderr = '';
  await runCli(['manager', '--interface-config', file], { stdin: { isTTY: true },
    stdout: { isTTY: true, write() { throw new Error('unexpected dispatch'); } },
    stderr: { write(text) { stderr += text; } } });
  const error = JSON.parse(stderr).error;
  assert.equal(error.code, 'interface_config_invalid');
  assert.equal(error.identifiers.path, target); assert.equal(error.identifiers.pointer, pointer);
  assert.match(error.action, /exact.*numeric/); assert.doesNotMatch(error.action, /use a string/i);
  assert.deepEqual(await readFile(target), bytes);
}));

test('ignored config fields and non-core manifest bytes retain numeric compatibility', () => fixture(async ({ file, manifestFile, config, manifest, root }) => {
  const configBytes = Buffer.from(config.slice(0, -1) + ',"bytes":6.9999999999999999,"files":[{"path":"core/ignored","bytes":9007199254740992}],"ui":{"v":1.0000000000000001}}');
  const manifestBytes = Buffer.from(manifest.replace('"files":[', '"files":[{"path":"other/ignored","bytes":6.9999999999999999,"v":1.0000000000000001},').replace('"bytes":7,', '"bytes":7,"metadata":{"bytes":9007199254740992},'));
  await writeFile(file, configBytes); await writeFile(manifestFile, manifestBytes);
  assert.equal((await loadInterfaceConfig(file, { requireLoader: false })).database, path.join(root, '../a.db'));
  assert.deepEqual(await readFile(file), configBytes); assert.deepEqual(await readFile(manifestFile), manifestBytes);
}));

test('public syntax failure explains valid JSON correction without numeric-domain blame', () => fixture(async ({ file }) => {
  await writeFile(file, '{"v":1,'); let stderr = '';
  await runCli(['manager', '--interface-config', file], { stdin: { isTTY: true },
    stdout: { isTTY: true, write() { throw new Error('unexpected dispatch'); } },
    stderr: { write(chunk) { stderr += chunk; } } });
  const error = JSON.parse(stderr).error;
  assert.equal(error.code, 'interface_config_invalid');
  assert.equal(error.identifiers.path, file); assert.equal(error.identifiers.pointer, '/');
  assert.match(error.message, /valid JSON/); assert.match(error.action, /valid JSON/);
}));

test('public Manager entry preserves binding field and correction in branded error envelope', () => fixture(async ({ file, config }) => {
  await writeFile(file, config.replace('"database":"../a.db"', '"database":"../a.db","database":"../b.db"'));
  let stderr = '', stdout = '';
  const code = await runCli(['manager', '--interface-config', file], {
    stdin: { isTTY: true },
    stdout: { isTTY: true, write(chunk) { stdout += chunk; return true; } },
    stderr: { write(chunk) { stderr += chunk; return true; } },
  });
  assert.notEqual(code, 0); assert.equal(stdout, '');
  const envelope = JSON.parse(stderr);
  assert.equal(envelope.error.code, 'interface_config_invalid');
  assert.equal(envelope.error.identifiers.path, file);
  assert.equal(envelope.error.identifiers.pointer, '/runtime/database');
  assert.ok(envelope.error.message.includes(file));
  assert.match(envelope.error.action, /unique member names/);
  assert.deepEqual(envelope.next, [envelope.error.action]);
}));

test('known runtime drift remains branded and corrective after error presentation', () => fixture(async ({ file, config }) => {
  const selection = await loadInterfaceConfig(file, { requireLoader: false });
  await writeFile(file, config.replace('"extra":true', '"extra":false'));
  await assert.rejects(revalidateSelection(selection), error => {
    const presented = errorPayload(error);
    assert.equal(presented.code, 'interface_config_changed');
    assert.equal(presented.identifiers.path, file);
    assert.match(presented.action, /reload/i); return true;
  });
}));

test('legacy extra fields and UTF8 BOM load unchanged in config and manifest', () => fixture(async ({ file, manifestFile, config, manifest, root }) => {
  await writeFile(file, '\uFEFF' + config); await writeFile(manifestFile, '\uFEFF' + manifest);
  const before = await readFile(file);
  assert.equal((await loadInterfaceConfig(file, { requireLoader: false })).database, path.join(root, '../a.db'));
  assert.deepEqual(await readFile(file), before);
}));
