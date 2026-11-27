import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageFrames } from '../scripts/lodestar-mcp.mjs';

const script = fileURLToPath(new URL('../scripts/lodestar-mcp.mjs', import.meta.url));

test('MCP rejects malformed requests and still serves the following ping', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'lodestar-mcp-protocol-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const invalid = [
    ['{', -32700, null],
    ['null', -32600, null],
    ['[]', -32600, null],
    ['"text"', -32600, null],
    ['0', -32600, null],
    ['true', -32600, null],
    ['{"id":1,"method":"ping"}', -32600, 1],
    ['{"jsonrpc":"2.0","id":2,"method":null}', -32600, 2],
    ['{"jsonrpc":"2.0","id":{},"method":"ping"}', -32600, null],
    ['{"jsonrpc":"2.0","id":3,"method":"ping","params":null}', -32600, 3],
    ['{"jsonrpc":"2.0","id":4,"method":"ping","params":"text"}', -32600, 4],
    ['{"jsonrpc":"2.0","id":1e999,"method":"ping"}', -32700, null],
    ['{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}', -32700, null],
    ['{"jsonrpc":"2.0","id":5,"method":"unknown"}', -32601, 5],
  ];
  const input = [
    ...invalid.map(([line]) => line),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":"still-alive","method":"ping"}',
  ].join('\n') + '\n';
  const child = spawnSync(process.execPath, [script], {
    input, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
    windowsHide: true, env: { ...process.env, PLUGIN_DATA: data },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, '', 'stdio must not leak diagnostics');
  const messages = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.length, invalid.length + 1);
  for (const [index, [, code, id]] of invalid.entries()) {
    assert.equal(messages[index].jsonrpc, '2.0');
    assert.equal(messages[index].id, id);
    assert.equal(messages[index].error.code, code);
    assert.equal(typeof messages[index].error.message, 'string');
    assert.equal(Object.hasOwn(messages[index], 'result'), false);
  }
  assert.deepEqual(messages.at(-1), { jsonrpc: '2.0', id: 'still-alive', result: {} });
});

test('one native MCP exposes both host-attested and checked core tools on the selected runtime', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'lodestar-combined-mcp-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const entry = process.env.LODESTAR_ENTRY;
  assert.ok(entry, 'Set LODESTAR_ENTRY to the exact core candidate.');
  const db = path.join(data, 'fixture.db');
  const env = { ...process.env, LODESTAR_ENTRY: entry, LODESTAR_NODE: process.execPath,
    LODESTAR_DB: db, PLUGIN_DATA: path.join(data, 'plugin') };
  const init = spawnSync(process.execPath, [entry, 'init', '--db', db], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(init.status, 0, init.stderr);
  const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const call = (id, name, args = {}) => rpc(id, 'tools/call', { name, arguments: args });
  const input = [rpc(1, 'tools/list'), call(2, 'lodestar_describe'),
    call(3, 'lodestar_read', { operation: 'start', arguments: ['--cwd', data, '--compact'] }),
    call(4, 'lodestar_read', { operation: 'get', arguments: ['--', 'knowledge:absent-fixture'] }),
    call(5, 'lodestar_work_status'), rpc(6, 'ping')].map((msg) => JSON.stringify(msg)).join('\n') + '\n';
  const child = spawnSync(process.execPath, [script], { input, env, encoding: 'utf8', timeout: 20_000,
    windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const [list, describe, read, missing, native, ping] = child.stdout.trim().split('\n').map(JSON.parse);
  const names = list.result.tools.map(({ name }) => name);
  assert.equal(names.length, 11);
  assert.equal(new Set(names).size, names.length);
  for (const name of ['lodestar_read', 'lodestar_mutate', 'lodestar_describe', 'lodestar_work_status', 'lodestar_handoff_checkpoint']) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(describe.result.structuredContent.contract, 5);
  assert.equal(read.result.structuredContent.ok, true);
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.error.code, 'record_not_found');
  assert.match(native.error.message, /attestation/i);
  assert.deepEqual(ping.result, {});
});

test('MCP discards an oversized frame, rejects invalid UTF-8 and serves an EOF-tail ping', () => {
  const input = Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":"too-large","method":"ping","padding":"'),
    Buffer.alloc(16 * 1024 * 1024 + 1, 0x61),
    Buffer.from('"}\r\n{"jsonrpc":"2.0","id":"bad-utf8","method":"ping","padding":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n{"jsonrpc":"2.0","id":"tail","method":"ping"}'),
  ]);
  const child = spawnSync(process.execPath, [script], {
    input, encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const messages = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].id, null);
  assert.equal(messages[0].error.code, -32000);
  assert.match(messages[0].error.message, /exceeds 16 MiB/);
  assert.equal(messages[1].id, null);
  assert.equal(messages[1].error.code, -32700);
  assert.equal(messages[1].error.message, 'Invalid UTF-8');
  assert.deepEqual(messages[2], { jsonrpc: '2.0', id: 'tail', result: {} });
});

test('MCP byte framing preserves split Unicode, CRLF, multiple frames and EOF tails', async () => {
  async function* chunks() {
    yield Buffer.from('\n{"text":"');
    yield Buffer.from([0xc3]);
    yield Buffer.from([0xa9]);
    yield Buffer.from('"}\r');
    yield Buffer.from('\n\n{"id":2}\n{"id":');
    yield Buffer.from('3}');
  }
  const frames = [];
  for await (const frame of messageFrames(chunks())) {
    assert.equal(frame.error, undefined);
    frames.push(new TextDecoder('utf-8', { fatal: true }).decode(frame.bytes));
  }
  assert.deepEqual(frames, ['{"text":"é"}', '{"id":2}', '{"id":3}']);
});

test('MCP exits with a controlled diagnostic when its response pipe disconnects', async (t) => {
  const child = spawn(process.execPath, [script], { windowsHide: true });
  const timer = setTimeout(() => child.kill(), 5_000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  child.stdout.destroy();
  child.stdin.end('{"jsonrpc":"2.0","id":"disconnect","method":"ping"}\n');
  const result = await closed;
  clearTimeout(timer);
  assert.equal(result.signal, null, 'transport must stop without timing out');
  assert.equal(result.status, 1);
  assert.match(stderr, /^Lodestar MCP response delivery failed \((?:EPIPE|ECONNRESET)\)\./);
  assert.doesNotMatch(stderr, /Unhandled|\n\s+at |node:events/);
});
