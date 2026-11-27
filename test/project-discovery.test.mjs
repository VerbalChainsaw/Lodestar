import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { openReadDatabase } from '../src/database.mjs';
import { errorPayload } from '../src/errors.mjs';
import { hash, normalizeMachinePath, resolveProject } from '../src/project.mjs';
import { fixture } from './helpers/contract.mjs';

async function withGit(t, result, action) {
  const mock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, 'git');
    assert.equal(options.windowsHide, true);
    assert.deepEqual(args.slice(2), ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
    return result;
  });
  syncBuiltinESMExports();
  try { return await action(); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
}

const failures = [
  { name: 'missing Git executable', code: 'ENOENT', message: /Git.*(?:unavailable|not found)/i,
    action: /(?:install|restore).*Git/i },
  { name: 'blocked Git execution', code: 'EPERM', message: /Git.*(?:blocked|denied)/i,
    action: /host.*(?:permit|allow)|execution access/i },
  { name: 'denied Git execution', code: 'EACCES', message: /Git.*(?:blocked|denied)/i,
    action: /host.*(?:permit|allow)|execution access/i },
  { name: 'other spawn failure', code: 'E2BIG', message: /Git.*could not run/i,
    action: /process error|execution environment/i },
  { name: 'interrupted discovery', code: null, signal: 'SIGTERM', message: /Git.*(?:interrupted|terminated)/i,
    action: /retry/i },
  { name: 'missing completion status', code: null, message: /Git.*(?:completion|complete)/i,
    action: /retry/i },
];

for (const failure of failures) {
  test(`project discovery reports ${failure.name} truthfully and preserves fail-closed identity`, async (t) => {
    const f = await fixture(t);
    await f.create('project:mapped', 'project', { roots: [f.root] }, 'project:mapped');
    const db = await openReadDatabase(f.database);
    try {
      await withGit(t, { status: null, signal: failure.signal ?? null, stdout: 'private stdout', stderr: 'private stderr',
        ...(failure.code ? { error: Object.assign(new Error('private-token=super-secret'), { code: failure.code }) } : {}) }, () => {
        assert.throws(() => resolveProject(db, f.root), (error) => {
          const payload = errorPayload(error);
          assert.equal(payload.code, 'project_discovery_failed');
          assert.match(payload.message, failure.message);
          assert.match(payload.action, failure.action);
          assert.equal(payload.identifiers.cause_code, failure.code);
          assert.equal(payload.identifiers.signal, failure.signal ?? null);
          assert.doesNotMatch(payload.action, /mapped project root/i);
          assert.doesNotMatch(JSON.stringify(payload), /super-secret|private stdout|private stderr/);
          if (failure.code !== 'ENOENT') assert.doesNotMatch(payload.action, /install Git/i);
          return true;
        });
      });
    } finally { db.close(); }
  });
}

test('healthy discovery preserves mapped identity and required binding evidence', async (t) => {
  const f = await fixture(t);
  const created = await f.create('project:mapped', 'project', { roots: [f.root] }, 'project:mapped');
  const db = await openReadDatabase(f.database);
  try {
    await withGit(t, { status: 128, stdout: '', stderr: 'not a git repository' }, () => {
      const project = resolveProject(db, f.root);
      assert.equal(project.id, 'project:mapped');
      assert.equal(project.scope, 'project:mapped');
      assert.equal(project.checkout_root, normalizeMachinePath(f.root));
      assert.equal(project.identity_source, 'stored_project_root');
      assert.deepEqual(project.binding_preconditions,
        [{ target: { kind: 'record', id: 'project:mapped' }, expected_revision: created.value.data.revision }]);
    });
  } finally { db.close(); }
});

test('successful Git identity and ordinary non-repository identity retain their existing rules', async (t) => {
  const f = await fixture(t);
  const db = await openReadDatabase(f.database);
  try {
    const root = normalizeMachinePath(f.root), common = `${root}/.git`;
    await withGit(t, { status: 0, stdout: `${common}\n${root}\n`, stderr: '' }, () => {
      const project = resolveProject(db, root);
      const key = hash(process.platform === 'win32' ? common.toLowerCase() : common);
      assert.equal(project.scope, `project:git:${key}`);
      assert.equal(project.identity_source, 'git_common_directory');
      assert.equal(project.git_common_directory, common);
      assert.equal(project.checkout_root, root);
      assert.deepEqual(project.binding_preconditions, []);
    });
    await withGit(t, { status: 128, stdout: '', stderr: 'not a git repository' }, () => {
      const project = resolveProject(db, root);
      const key = hash(process.platform === 'win32' ? root.toLowerCase() : root);
      assert.equal(project.scope, `project:cwd:${key}`);
      assert.equal(project.identity_source, 'canonical_cwd');
      assert.deepEqual(project.binding_preconditions, []);
    });
  } finally { db.close(); }
});

test('public discovery errors provide cause and recovery while direct record reads still work', async (t) => {
  const f = await fixture(t);
  await f.create('fact:available', 'fact', { text: 'Known record' });
  await withGit(t, { status: null, signal: null,
    error: Object.assign(new Error('private-token=super-secret'), { code: 'EPERM' }) }, async () => {
    const start = await f.cli(['start', '--cwd', f.root]);
    assert.notEqual(start.code, 0);
    assert.equal(start.value.ok, false);
    assert.equal(start.value.error.code, 'project_discovery_failed');
    assert.equal(start.value.error.identifiers.cause_code, 'EPERM');
    assert.match(start.value.error.action, /host.*permits Git/);
    assert.match(start.value.error.action, /lodestar get <id>/);
    assert.doesNotMatch(JSON.stringify(start.value), /super-secret|Install Git|mapped project root/);
    const direct = await f.cli(['get', 'fact:available']);
    assert.equal(direct.code, 0, JSON.stringify(direct.value));
    assert.equal(direct.value.data.id, 'fact:available');
  });
});

test('filesystem-root mappings include descendants and preserve their binding evidence', async (t) => {
  const f = await fixture(t);
  const filesystemRoot = path.parse(f.root).root;
  const created = await f.create('project:filesystem-root', 'project', { roots: [filesystemRoot] }, 'project:filesystem-root');
  const db = await openReadDatabase(f.database);
  try {
    await withGit(t, { status: 128, stdout: '', stderr: 'not a git repository' }, () => {
      for (const cwd of [filesystemRoot, f.root]) {
        const project = resolveProject(db, cwd);
        assert.equal(project.id, 'project:filesystem-root', `cwd ${cwd}`);
        assert.equal(project.scope, 'project:filesystem-root');
        assert.equal(project.identity_source, 'stored_project_root');
        assert.deepEqual(project.binding_preconditions,
          [{ target: { kind: 'record', id: 'project:filesystem-root' }, expected_revision: created.value.data.revision }]);
      }
    });
  } finally { db.close(); }
});

test('root matching keeps component boundaries and prefers the most specific overlapping mapping', async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.root, 'nested');
  await f.create('project:parent', 'project', { roots: [f.root] }, 'project:parent');
  await f.create('project:nested', 'project', { roots: [nested] }, 'project:nested');
  const db = await openReadDatabase(f.database);
  try {
    await withGit(t, { status: 128, stdout: '', stderr: 'not a git repository' }, () => {
      assert.equal(resolveProject(db, f.root).id, 'project:parent');
      assert.equal(resolveProject(db, path.join(f.root, 'child')).id, 'project:parent');
      assert.equal(resolveProject(db, nested).id, 'project:nested');
      assert.equal(resolveProject(db, path.join(nested, 'child')).id, 'project:nested');
      assert.equal(resolveProject(db, `${f.root}-sibling`).identity_source, 'canonical_cwd');
    });
  } finally { db.close(); }
});
