import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseNativeJson, readHookJson, JSON_MAXIMUM_BYTES } from '../scripts/lodestar-json.mjs';
import { canonical } from '../scripts/lodestar-runtime.mjs';
import { handleHook } from '../scripts/lodestar-hook.mjs';

const hook = fileURLToPath(new URL('../scripts/lodestar-hook.mjs', import.meta.url));
const mcp = fileURLToPath(new URL('../scripts/lodestar-mcp.mjs', import.meta.url));
const invalid = ['1e999', '9007199254740993', '0.10000000000000001', '1e-999',
  '{"same":1,"sa\\u006de":2}', '['.repeat(1025) + '0' + ']'.repeat(1025)];

test('native JSON admission preserves decimal meaning and bounds decoded structure', () => {
  assert.deepEqual(parseNativeJson('{"a":0.125,"b":12.34e-2,"c":9007199254740991,"d":-0,"e":0e999999}'),
    { a: 0.125, b: 0.1234, c: 9007199254740991, d: -0, e: 0 });
  for (const source of invalid) assert.throws(() => parseNativeJson(source));
  assert.throws(() => parseNativeJson('{"a":1,"a":2}'), /duplicate/);
  assert.doesNotThrow(() => parseNativeJson('['.repeat(1024) + '0' + ']'.repeat(1024)));
  assert.throws(() => parseNativeJson('{"private":"DO_NOT_ECHO"'), (error) => !error.message.includes('DO_NOT_ECHO'));
  for (const value of [Infinity, -Infinity, NaN, 9007199254740992]) {
    assert.throws(() => canonical({ nested: [value] }), /numeric/);
  }
  assert.equal(canonical({ optional: undefined, value: 0.125 }), '{"value":0.125}\n');
  assert.equal(parseNativeJson('1.23000e+2'), 123);
  assert(Object.is(parseNativeJson('-0e-999'), -0));
  assert.equal(parseNativeJson('1' + '0'.repeat(100_000) + 'e-100000'), 1);
  const circular = {}; circular.self = circular;
  assert.throws(() => canonical(circular), /circular/);
  let nested = 0;
  for (let depth = 0; depth < 1025; depth += 1) nested = [nested];
  assert.throws(() => canonical(nested), /depth/);
});

test('native JSON admission fails explicitly when numeric source context is unavailable', () => {
  const original = JSON.parse;
  try {
    JSON.parse = (text, reviver) => original(text, reviver && function (field, value) {
      return reviver.call(this, field, value);
    });
    assert.throws(() => parseNativeJson('0.125'), /Source-aware JSON parsing is required/);
  } finally { JSON.parse = original; }
});

test('hook raw input rejects oversized and invalid UTF-8 before host actions', async () => {
  async function* oversized() { yield Buffer.alloc(JSON_MAXIMUM_BYTES); yield Buffer.from('x'); }
  await assert.rejects(readHookJson(oversized()), /16 MiB/);
  for (const input of [Buffer.from([0xff]), Buffer.alloc(JSON_MAXIMUM_BYTES + 1, 0x61), Buffer.from('null'), Buffer.from('[]')]) {
    const child = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', windowsHide: true,
      timeout: 5_000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.equal(child.stderr, '');
    const output = JSON.parse(child.stdout);
    assert.equal(output.continue, false);
    assert.equal(output.stopReason, 'lodestar_invalid_input');
  }
});

test('raw hook and MCP numeric/duplicate/depth rejection preserves authorization, attestation and DB', async (t) => {
  const entry = process.env.LODESTAR_ENTRY;
  assert.ok(entry, 'Set LODESTAR_ENTRY for disposable core integration');
  const core = await import(pathToFileURL(path.join(path.dirname(entry), 'codex-plugin/scripts/lodestar-runtime.mjs')));
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'lodestar-json-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'plugin-data');
  const env = { ...process.env, LODESTAR_NODE: process.execPath, LODESTAR_ENTRY: entry,
    LODESTAR_DB: path.join(root, 'fixture.db'), PLUGIN_DATA: data };
  const host = { session_id: 'json-boundary-session', turn_id: 'json-boundary-turn', cwd: root };
  const run = (script, input) => {
    const child = spawnSync(process.execPath, [script], { input, env, encoding: 'utf8', windowsHide: true,
      timeout: 20_000, maxBuffer: 1024 * 1024 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    assert.doesNotMatch(child.stdout, /DO_NOT_ECHO/);
    return JSON.parse(child.stdout);
  };
  const current = () => core.runInstalledLodestar(['start', '--cwd', root,
    '--session', host.session_id, '--agent', 'codex', '--harness', 'codex'], { env });
  await core.runInstalledLodestar(['init'], { env });
  const before = await current();
  run(hook, JSON.stringify({ ...host, hook_event_name: 'UserPromptSubmit', prompt: 'handoff arm' }));
  const authDirectory = path.join(data, 'authorizations');
  const auth = path.join(authDirectory, (await readdir(authDirectory))[0]);
  const authBytes = await readFile(auth);
  const packet = { goal: 'Preserve exact JSON', rules: [], entries: [], work: {}, nextMove: 'Inspect', evidence: [], custom: 'RAW_VALUE' };
  const rawHook = source => JSON.stringify({ ...host, hook_event_name: 'PreToolUse', tool_use_id: 'exact-json',
    tool_name: 'lodestar_handoff_arm', tool_input: { packet } }).replace('"RAW_VALUE"', source);
  for (const source of invalid) {
    const output = run(hook, rawHook(source));
    assert.equal(output.continue, false);
    assert.equal(output.stopReason, 'lodestar_invalid_input');
    assert.deepEqual(await readFile(auth), authBytes);
  }
  await mkdir(path.join(data, 'attestations'), { recursive: true });
  assert.deepEqual(await readdir(path.join(data, 'attestations')), []);
  const direct = await handleHook({ ...host, hook_event_name: 'PreToolUse', tool_use_id: 'direct',
    tool_name: 'lodestar_handoff_arm', tool_input: { packet: { ...packet, custom: Infinity } } }, data);
  assert.equal(direct.continue, false);
  assert.deepEqual(await readdir(path.join(data, 'attestations')), []);
  assert.equal((await current()).revision, before.revision);

  const safe = '{"fraction":0.125,"exponent":12.34e-2,"integer":9007199254740991,"zero":-0}';
  const attested = run(hook, rawHook(safe)).hookSpecificOutput.updatedInput;
  assert.deepEqual(attested.packet.custom, { fraction: 0.125, exponent: 0.1234, integer: 9007199254740991, zero: 0 });
  const attestation = path.join(data, 'attestations', `${attested._attestation}.json`);
  const attestationBytes = await readFile(attestation);
  const rawMcp = source => JSON.stringify({ jsonrpc: '2.0', id: 'boundary', method: 'tools/call',
    params: { name: 'lodestar_handoff_arm', arguments: { ...attested, packet } } }).replace('"RAW_VALUE"', source) + '\n';
  for (const source of invalid) {
    const output = run(mcp, rawMcp(source));
    assert.equal(output.error.code, -32700);
    assert.deepEqual(await readFile(attestation), attestationBytes);
  }
  assert.equal((await current()).revision, before.revision);
  const accepted = run(mcp, rawMcp(safe));
  assert.equal(accepted.result.isError, false);
  const stored = accepted.result.structuredContent.result.record.data.checkpoint.references[0].packet.custom;
  assert.deepEqual(stored, attested.packet.custom);
});
