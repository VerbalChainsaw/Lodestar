import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { fixture } from './helpers/contract.mjs';

async function createRecord(f, {
  id,
  project = 'project:test',
  checkout = null,
  lifecycle = 'current',
  contextRole = 'on_demand',
  links = [],
}) {
  const mutation = await f.request({
    mode: 'create',
    record: {
      id,
      kind: 'fact',
      name: id,
      scope: project,
      availability: 'known',
      data: { marker: id },
      aliases: [],
      links,
      sources: [],
      semantics: {
        basis: 'asserted',
        lifecycle,
        context_role: contextRole,
        applicability: { project, checkout },
      },
    },
  }, [{ kind: 'record', id }], project);
  if (checkout !== null) mutation.checkout = checkout;
  const result = await f.cli(['put'], mutation);
  assert.equal(result.code, 0, JSON.stringify(result.value));
}

async function projectFixture(t) {
  const f = await fixture(t);
  await f.create('project:test', 'project', { roots: [f.root] }, 'project:test');
  return f;
}

function dependencyError(start, id) {
  return start.value.data.record_errors.find((error) => error.identifiers?.id === id);
}

test('start is incomplete when an included record requires a retired dependency', async (t) => {
  const f = await projectFixture(t);
  await createRecord(f, { id: 'fact:retired-dependency', lifecycle: 'historical' });
  await createRecord(f, {
    id: 'fact:orientation',
    contextRole: 'orientation',
    links: [{ relationship: 'requires', to_id: 'fact:retired-dependency' }],
  });

  const start = await f.cli(['start', '--cwd', f.root]);

  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.deepEqual(start.value.data.context.map(({ id }) => id), ['fact:orientation']);
  assert.equal(start.value.data.complete, false);
  assert.equal(dependencyError(start, 'fact:retired-dependency')?.code,
    'required_dependency_unavailable');
  assert.deepEqual(dependencyError(start, 'fact:retired-dependency')?.identifiers, {
    id: 'fact:retired-dependency',
    required_by: 'fact:orientation',
    lifecycle: 'historical',
  });
  assert.ok(start.value.data.write_basis.targets.some(({ id }) => id === 'fact:retired-dependency'));
});

test('start is incomplete when an included record requires a dependency for another checkout', async (t) => {
  const f = await projectFixture(t);
  const otherCheckout = path.join(f.root, 'other-checkout');
  await createRecord(f, { id: 'fact:other-checkout-dependency', checkout: otherCheckout });
  await createRecord(f, {
    id: 'fact:orientation',
    contextRole: 'orientation',
    links: [{ relationship: 'depends-on', to_id: 'fact:other-checkout-dependency' }],
  });

  const start = await f.cli(['start', '--cwd', f.root]);

  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.deepEqual(start.value.data.context.map(({ id }) => id), ['fact:orientation']);
  assert.equal(start.value.data.complete, false);
  assert.equal(dependencyError(start, 'fact:other-checkout-dependency')?.code,
    'required_dependency_unavailable');
  assert.deepEqual(dependencyError(start, 'fact:other-checkout-dependency')?.identifiers, {
    id: 'fact:other-checkout-dependency',
    required_by: 'fact:orientation',
    checkout: otherCheckout,
  });
  assert.ok(start.value.data.write_basis.targets.some(({ id }) => id === 'fact:other-checkout-dependency'));
});

test('start excludes the dependency subtree of an orientation record for another checkout', async (t) => {
  const f = await projectFixture(t);
  const otherCheckout = path.join(f.root, 'other-checkout');
  await createRecord(f, { id: 'fact:dependency' });
  await createRecord(f, {
    id: 'fact:other-checkout-orientation',
    checkout: otherCheckout,
    contextRole: 'orientation',
    links: [{ relationship: 'requires', to_id: 'fact:dependency' }],
  });

  const start = await f.cli(['start', '--cwd', f.root]);

  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.deepEqual(start.value.data.context, []);
  assert.equal(start.value.data.complete, true);
  assert.deepEqual(start.value.data.record_errors, []);
  assert.ok(!start.value.data.write_basis.targets.some(({ id }) => id === 'fact:dependency'));
});
