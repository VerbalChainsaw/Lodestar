import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = process.env.LODESTAR_ENTRY;
assert.ok(entry, 'Set LODESTAR_ENTRY to the installed package entry for real transport integration');
const adapter = fileURLToPath(new URL('../scripts/lodestar-runtime.mjs', import.meta.url));
const transport = pathToFileURL(path.join(path.dirname(entry), 'codex-plugin/scripts/lodestar-runtime.mjs')).href;
const { readMutationContext } = await import(pathToFileURL(adapter));

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
      const { data: observed } = await readMutationContext({ sessionId: 'version-order', cwd: root }, { env });
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
    const { data } = await readMutationContext({ sessionId: 'invalid-runtime', cwd: root }, { env });
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
      import { readMutationContext } from ${JSON.stringify(pathToFileURL(adapter).href)};
      const before = { ...process.env };
      const host = { sessionId: 'launch-fixture', cwd: ${JSON.stringify(root)} };
      const { data: discovered } = await readMutationContext(host);
      const override = Object.freeze({ ...process.env, LODESTAR_NODE: ${JSON.stringify(overriddenNode)},
        LODESTAR_ENTRY: ${JSON.stringify(overriddenEntry)}, LODESTAR_DB: 'explicit-isolated-db',
        LODESTAR_FIXTURE_MARKER: 'explicit-marker' });
      const overrideBefore = { ...override };
      const { data: explicit } = await readMutationContext(host, { env: override });
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


test('one host binding chooses the exact runtime in hook, MCP and direct CLI fixtures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lodestar-shared-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'plugin-data');
  const core = path.join(root, 'selected-core');
  const cli = path.join(core, 'lodestar.mjs');
  const cliSource = `console.log(JSON.stringify({selected: "exact-local-core", entry: process.argv[1], node: process.execPath}));`;
  const config = { schema: 1, node: process.execPath, entry: cli, version: '3.0.3',
    entry_sha256: createHash('sha256').update(cliSource).digest('hex') };
  const fixture = path.join(core, 'codex-plugin/scripts');
  await mkdir(dataDir);
  await mkdir(fixture, { recursive: true });
  await mkdir(path.join(root, '.omx'));
  await writeFile(cli, cliSource);
  await writeFile(path.join(core, 'package.json'), JSON.stringify({ name: 'lodestar-agent-context', version: config.version }));
  await writeFile(path.join(dataDir, 'runtime-binding.json'), JSON.stringify(config));
  await writeFile(path.join(root, '.omx/lodestar-compaction.json'), JSON.stringify({
    version: 1, session_id: 'fixture', project_root: root, intent_record_id: 'fixture-intent',
  }));
  await writeFile(path.join(fixture, 'lodestar-runtime.mjs'), `export async function runInstalledLodestar(args, {env}) {
    if (args[0] === 'start') throw new Error('selected hook runtime: ' + env.LODESTAR_ENTRY);
    throw new Error('Unexpected fixture command');
  }`);
  await writeFile(path.join(fixture, 'lodestar-mcp.mjs'), `export const NATIVE_TOOLS = [{name:'lodestar_describe'}];
    export async function callNativeTool(name, args, {env}) { return {entry:env.LODESTAR_ENTRY,node:env.LODESTAR_NODE}; }`);
  const env = { ...process.env, PLUGIN_DATA: dataDir, HOME: root, USERPROFILE: root,
    LODESTAR_DB: path.join(root, 'never-live.sqlite') };
  delete env.LODESTAR_NODE;
  delete env.LODESTAR_ENTRY;
  const run = (script, input, execPath = process.execPath) => {
    const child = spawnSync(execPath, [script], { input, env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return JSON.parse(child.stdout.trim());
  };
  const hook = fileURLToPath(new URL('../scripts/lodestar-hook.mjs', import.meta.url));
  const mcp = fileURLToPath(new URL('../scripts/lodestar-mcp.mjs', import.meta.url));
  const startup = run(hook, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
    session_id: 'fixture', cwd: root }));
  assert.match(startup.hookSpecificOutput.additionalContext, /Lodestar startup routing/);
  const checkpoint = run(hook, JSON.stringify({ hook_event_name: 'PreCompact',
    session_id: 'fixture', turn_id: 'fixture-turn', cwd: root }));
  assert.equal(checkpoint.continue, false);
  assert.ok(checkpoint.systemMessage.includes('selected hook runtime: ' + cli), checkpoint.systemMessage);
  const query = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'lodestar_describe', arguments: {} } }) + '\n';
  const expectedNode = await realpath(process.execPath), expectedEntry = await realpath(cli);
  // Windows can report the same NTFS file under a short or long path. Verify
  // identity rather than spelling, without accepting a copy of the runtime.
  const identity = async (file) => {
    const { dev, ino } = await stat(file, { bigint: true });
    assert.notEqual(ino, 0n, 'the fixture requires a usable file identity');
    return { dev, ino };
  };
  const identifyRuntime = async ({ node, entry, ...rest }) => ({
    ...rest, node: await identity(node), entry: await identity(entry),
  });
  const expected = await identifyRuntime({ node: expectedNode, entry: expectedEntry });
  assert.deepEqual(await identifyRuntime(run(mcp, query).result.structuredContent), expected);
  assert.deepEqual(await identifyRuntime(run(expectedEntry, '', expectedNode)), { selected: 'exact-local-core', ...expected });

  const { boundRuntimeOptions } = await import(pathToFileURL(adapter));
  const old = boundRuntimeOptions(dataDir, env);
  const original = old.resolveRuntime();
  await writeFile(path.join(dataDir, 'runtime-binding.json'), JSON.stringify({ ...config, version: '0.0.0' }));
  assert.equal(old.resolveRuntime(), original, 'running process must not switch while writing');
  assert.throws(() => boundRuntimeOptions(dataDir, env).resolveRuntime(), /version and entry digest/);
  const failure = run(mcp, query);
  assert.match(failure.error.message, /version and entry digest/);
  await writeFile(path.join(dataDir, 'runtime-binding.json'), JSON.stringify(config));
  assert.throws(() => boundRuntimeOptions(dataDir, { ...env, LODESTAR_ENTRY: cli }).resolveRuntime(), /conflicts/);
  await writeFile(path.join(dataDir, 'runtime-binding.json'), JSON.stringify({ ...config, entry: 'lodestar.mjs' }));
  assert.throws(() => boundRuntimeOptions(dataDir, env).resolveRuntime(), /Absolute local paths/);
});
