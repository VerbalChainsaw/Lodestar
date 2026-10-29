import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = process.env.LODESTAR_ENTRY;
assert.ok(entry, 'Set LODESTAR_ENTRY to the installed package entry for real transport integration');
const adapter = fileURLToPath(new URL('../scripts/lodestar-runtime.mjs', import.meta.url));
const transport = pathToFileURL(path.join(path.dirname(entry), 'codex-plugin/scripts/lodestar-runtime.mjs')).href;
const { startupContext, STARTUP_CONTEXT_PREFIX, STARTUP_CONTEXT_SUFFIX } = await import(pathToFileURL(adapter));

test('Windows discovery orders numeric Node versions and preserves custom-name fallback',
  { skip: process.platform !== 'win32' }, async (t) => {
    const cases = [
      { names: ['node-v9.11.2-win-x64', 'node-v24.15.0-win-x64'], expected: 'node-v24.15.0-win-x64' },
      { names: ['node-v24.9.99-win-x64', 'node-v24.15.9-win-x64', 'node-v24.15.10-win-x64'], expected: 'node-v24.15.10-win-x64' },
      { names: ['node-a-custom', 'node-z-custom', 'node-v24.15.10malformed', 'node-v999999999999999999999.0.0-win-x64'], expected: 'node-z-custom' },
    ];
    for (const { names, expected } of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lodestar-version-order-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      for (const name of names) {
        const runtime = path.join(root, '.local/opt', name);
        const selectedEntry = path.join(runtime, 'node_modules/lodestar-agent-context/lodestar.mjs');
        const scripts = path.join(path.dirname(selectedEntry), 'codex-plugin/scripts');
        await mkdir(scripts, { recursive: true });
        // Only discovery is under test here; the test below exercises the real executable boundary.
        await writeFile(path.join(runtime, 'node.exe'), 'unused discovery fixture');
        await writeFile(selectedEntry, 'unused discovery fixture');
        await writeFile(path.join(scripts, 'lodestar-runtime.mjs'), `
          export async function runInstalledLodestar(args, { env }) {
            return { more: false, data: { complete: true, required_complete: true,
              entry: env.LODESTAR_ENTRY, executable: env.LODESTAR_NODE } };
          }
        `);
      }
      const env = { ...process.env, USERPROFILE: root, HOME: root };
      delete env.LODESTAR_NODE;
      delete env.LODESTAR_ENTRY;
      const text = await startupContext({ session_id: 'version-order', cwd: root }, { env });
      const observed = JSON.parse(text.slice(STARTUP_CONTEXT_PREFIX.length, -STARTUP_CONTEXT_SUFFIX.length));
      assert.equal(path.basename(path.dirname(observed.executable)), expected);
      assert.equal(observed.entry, path.join(path.dirname(observed.executable), 'node_modules/lodestar-agent-context/lodestar.mjs'));
    }
  });

test('Windows discovery skips directory executables and CLI entries',
  { skip: process.platform !== 'win32' }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lodestar-invalid-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const version of ['node-v24.15.0-win-x64', 'node-v25.0.0-win-x64', 'node-v26.0.0-win-x64']) {
      const directory = path.join(root, '.local/opt', version);
      const cli = path.join(directory, 'node_modules/lodestar-agent-context/lodestar.mjs');
      const scripts = path.join(path.dirname(cli), 'codex-plugin/scripts');
      await mkdir(scripts, { recursive: true });
      if (version.includes('v25')) await mkdir(path.join(directory, 'node.exe'));
      else await writeFile(path.join(directory, 'node.exe'), 'discovery fixture');
      if (version.includes('v26')) await mkdir(cli);
      else await writeFile(cli, 'discovery fixture');
      await writeFile(path.join(scripts, 'lodestar-runtime.mjs'), `
        export async function runInstalledLodestar(args, { env }) {
          return { more:false, data:{ complete:true, required_complete:true, executable:env.LODESTAR_NODE } };
        }
      `);
    }
    const env = { ...process.env, USERPROFILE: root, HOME: root };
    delete env.LODESTAR_NODE;
    delete env.LODESTAR_ENTRY;
    const output = await startupContext({ session_id: 'invalid-runtime', cwd: root }, { env });
    const data = JSON.parse(output.slice(STARTUP_CONTEXT_PREFIX.length, -STARTUP_CONTEXT_SUFFIX.length));
    assert.equal(path.basename(path.dirname(data.executable)), 'node-v24.15.0-win-x64');
  });

test('Windows discovery carries the selected executable and entry into the actual transport',
  { skip: process.platform !== 'win32' }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lodestar-launch-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const selectedNode = path.join(root, '.local/opt/node-fixture/node.exe');
    const selectedEntry = path.join(path.dirname(selectedNode), 'node_modules/lodestar-agent-context/lodestar.mjs');
    const overriddenEntry = path.join(root, 'explicit-package/lodestar.mjs');
    const overriddenNode = path.join(path.dirname(overriddenEntry), 'node.exe');
    const fixtureCli = `
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      console.log(JSON.stringify({ v: 5, ok: true, operation: 'start', more: false,
        next: [], revision: 0, database_instance_id: 'fixture', database_epoch: 'fixture',
        data: { complete: true, required_complete: true, executable: process.execPath,
          entry: process.argv[1], args: JSON.parse(input), database: process.env.LODESTAR_DB,
          marker: process.env.LODESTAR_FIXTURE_MARKER } }));
    `;
    for (const cli of [selectedEntry, overriddenEntry]) {
      const scripts = path.join(path.dirname(cli), 'codex-plugin/scripts');
      await mkdir(scripts, { recursive: true });
      await writeFile(cli, fixtureCli);
      // Import the installed transport, including its real process-launch boundary.
      await writeFile(path.join(scripts, 'lodestar-runtime.mjs'), `export * from ${JSON.stringify(transport)};\n`);
    }
    await copyFile(process.execPath, selectedNode);
    await copyFile(process.execPath, overriddenNode);
    const runner = path.join(root, 'runner.mjs');
    await writeFile(runner, `
      import assert from 'node:assert/strict';
      import { startupContext, STARTUP_CONTEXT_PREFIX, STARTUP_CONTEXT_SUFFIX } from ${JSON.stringify(pathToFileURL(adapter).href)};
      const before = { ...process.env };
      const host = { session_id: 'launch-fixture', cwd: ${JSON.stringify(root)} };
      const unpack = (text) => JSON.parse(text.slice(STARTUP_CONTEXT_PREFIX.length, -STARTUP_CONTEXT_SUFFIX.length));
      const discovered = unpack(await startupContext(host));
      const override = Object.freeze({ ...process.env, LODESTAR_NODE: ${JSON.stringify(overriddenNode)},
        LODESTAR_ENTRY: ${JSON.stringify(overriddenEntry)}, LODESTAR_DB: 'explicit-isolated-db',
        LODESTAR_FIXTURE_MARKER: 'explicit-marker' });
      const overrideBefore = { ...override };
      const explicit = unpack(await startupContext(host, { env: override }));
      assert.deepEqual({ ...process.env }, before, 'parent process environment must remain unchanged');
      assert.deepEqual(override, overrideBefore, 'caller environment must remain unchanged');
      console.log(JSON.stringify({ parent: process.execPath, discovered, explicit }));
    `);
    const env = { ...process.env, USERPROFILE: root, HOME: root,
      LODESTAR_DB: 'discovery-isolated-db', LODESTAR_FIXTURE_MARKER: 'discovery-marker' };
    delete env.LODESTAR_NODE;
    delete env.LODESTAR_ENTRY;
    const child = spawnSync(process.execPath, [runner], { env, encoding: 'utf8', windowsHide: true,
      timeout: 20_000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const result = JSON.parse(child.stdout.trim());
    assert.notEqual(path.resolve(result.parent), path.resolve(selectedNode));
    for (const [observed, expectedNode, expectedEntry, database, marker] of [
      [result.discovered, selectedNode, selectedEntry, 'discovery-isolated-db', 'discovery-marker'],
      [result.explicit, overriddenNode, overriddenEntry, 'explicit-isolated-db', 'explicit-marker'],
    ]) {
      assert.equal(path.resolve(observed.executable), path.resolve(expectedNode));
      assert.equal(path.resolve(observed.entry), path.resolve(expectedEntry));
      assert.deepEqual(observed.args, ['start', '--cwd', root, '--session', 'launch-fixture',
        '--agent', 'codex', '--harness', 'codex']);
      assert.equal(observed.database, database);
      assert.equal(observed.marker, marker);
    }
  });
