'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CatalogAdminRoleResolutionError,
  assertCatalogAdminRoleProvider,
  createInMemoryCatalogAdminRoleProvider,
  normalizeCatalogAdminRoles,
} = require('../src/catalog-admin-role-provider');

test('CatalogAdminRoleProvider resolves only explicit assignments and treats unknown principals as roleless', async () => {
  const provider = createInMemoryCatalogAdminRoleProvider({
    'verified-observer': ['observer'],
  });
  assert.equal(assertCatalogAdminRoleProvider(provider), provider);
  assert.deepEqual(await provider.resolveRoles('verified-observer'), ['observer']);
  assert.deepEqual(await provider.resolveRoles('unknown-principal'), []);
});

test('resolved roles are allowlisted, unique, and immutable; an empty list is a valid no-grant result', () => {
  assert.deepEqual(normalizeCatalogAdminRoles(['editor', 'approver']), ['editor', 'approver']);
  assert.deepEqual(normalizeCatalogAdminRoles([]), []);
  assert.throws(() => normalizeCatalogAdminRoles(['unknown-role']), CatalogAdminRoleResolutionError);
  assert.throws(() => normalizeCatalogAdminRoles(['observer', 'observer']), CatalogAdminRoleResolutionError);
  assert.throws(() => normalizeCatalogAdminRoles(null), CatalogAdminRoleResolutionError);
  assert.throws(() => normalizeCatalogAdminRoles(['administrator', 4]), CatalogAdminRoleResolutionError);
  assert.throws(() => assertCatalogAdminRoleProvider({}), /resolveRoles/);
});

test('fixture provider returns copies and never invents a role assignment', async () => {
  const initial = ['publisher'];
  const provider = createInMemoryCatalogAdminRoleProvider({ 'fixture-user': initial });
  initial.push('administrator');
  const roles = await provider.resolveRoles('fixture-user');
  roles.push('observer');
  assert.deepEqual(await provider.resolveRoles('fixture-user'), ['publisher']);
  await assert.rejects(provider.resolveRoles(''), CatalogAdminRoleResolutionError);
});
