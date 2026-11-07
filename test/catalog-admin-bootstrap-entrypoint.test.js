'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CatalogAdminBootstrapError,
  CONFIRMATION_VALUE,
  executeCatalogAdminBootstrap,
  main,
  parseBootstrapArguments,
} = require('../src/catalog-admin-bootstrap-entrypoint');

const ENV = Object.freeze({
  CATALOG_GCP_PROJECT_ID: 'oxiw-catalog-test-123',
  CATALOG_SPREADSHEET_ID: 'fixture-spreadsheet',
});
const ACTOR = Object.freeze({
  actorId: 'catalog-bootstrap@oxiw-provisioning.iam.gserviceaccount.com',
  actorType: 'service_account',
  identitySource: 'google_cloud_adc_service_account_impersonation',
});
const APPROVAL = Object.freeze({
  ownerId: 'catalog-owner', ownerIdentitySource: 'firebase_admin_id_token',
  approvalReference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
});

function makeRuntime(bootstrapAdministrator) {
  return {
    runtimeMode: 'operational',
    roleProvider: { bootstrapAdministrator },
  };
}

function request(overrides = {}) {
  return {
    env: ENV,
    targetResolver: async () => 'first-admin',
    confirmation: CONFIRMATION_VALUE,
    trustedActorProvider: async () => ACTOR,
    trustedApprovalProvider: async () => APPROVAL,
    runtimeFactory: async () => makeRuntime(async () => ({ version: 1, eventId: 'event-1' })),
    ...overrides,
  };
}

test('requires exact confirmation and rejects request-controlled target IDs', async () => {
  assert.deepEqual(parseBootstrapArguments(['--confirm', CONFIRMATION_VALUE]), {
    confirmation: CONFIRMATION_VALUE,
  });
  await assert.rejects(
    executeCatalogAdminBootstrap(request({ confirmation: undefined })),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'CONFIRMATION_REQUIRED',
  );
  await assert.rejects(
    executeCatalogAdminBootstrap(request({ env: {} })),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'CONFIGURATION_INVALID',
  );
  assert.throws(() => parseBootstrapArguments(['--target-subject-id', 'first-admin']),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'TARGET_NOT_ACCEPTED');

  let runtimeCalls = 0;
  let actorCalls = 0;
  await assert.rejects(
    executeCatalogAdminBootstrap(request({
      confirmation: 'wrong',
      runtimeFactory: async () => { runtimeCalls += 1; return makeRuntime(() => {}); },
      trustedActorProvider: async () => { actorCalls += 1; return ACTOR; },
    })),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'CONFIRMATION_REQUIRED',
  );
  assert.equal(runtimeCalls, 0);
  assert.equal(actorCalls, 0);
});

test('keeps the executable disabled when no trusted actor source is configured', async () => {
  let runtimeCalls = 0;
  await assert.rejects(
    executeCatalogAdminBootstrap(request({
      trustedActorProvider: undefined,
      runtimeFactory: async () => { runtimeCalls += 1; return makeRuntime(() => {}); },
    })),
    (error) => error instanceof CatalogAdminBootstrapError &&
      error.code === 'TRUSTED_ACTOR_SOURCE_UNCONFIGURED',
  );
  assert.equal(runtimeCalls, 0);
});

test('uses only the injected operational runtime and bootstrapAdministrator transaction seam', async () => {
  const calls = [];
  const result = await executeCatalogAdminBootstrap(request({
    trustedApprovalProvider: async ({ targetSubjectId }) => {
      calls.push(['approval', targetSubjectId]);
      return APPROVAL;
    },
    runtimeFactory: async ({ env }) => {
      calls.push(['runtime', env.CATALOG_GCP_PROJECT_ID]);
      return makeRuntime(async (options) => {
        calls.push(['bootstrap', options]);
        return { version: 1, eventId: 'event-1' };
      });
    },
  }));
  assert.deepEqual(result, { version: 1, eventId: 'event-1' });
  assert.deepEqual(calls, [
    ['approval', 'first-admin'],
    ['runtime', 'oxiw-catalog-test-123'],
    ['bootstrap', { actor: ACTOR, approval: APPROVAL, targetSubjectId: 'first-admin' }],
  ]);
});

test('propagates repeat, inconsistent-state, and audit failures as safe bootstrap errors', async (t) => {
  for (const [code, label] of [
    ['BOOTSTRAP_ALREADY_COMPLETED', 'repeat bootstrap'],
    ['ROLE_CONTROL_INCONSISTENT', 'inconsistent control state'],
    ['ROLE_SOURCE_UNAVAILABLE', 'audit or role source failure'],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(
        executeCatalogAdminBootstrap(request({
          runtimeFactory: async () => makeRuntime(async () => { throw { code }; }),
        })),
        (error) => error instanceof CatalogAdminBootstrapError && error.code === code,
      );
    });
  }
});

test('CLI main accepts confirmation but remains disabled without target wiring', async () => {
  await assert.rejects(
    main({
      argv: ['--confirm', CONFIRMATION_VALUE],
      env: ENV,
    }),
    (error) => error instanceof CatalogAdminBootstrapError &&
      error.code === 'TARGET_SOURCE_UNCONFIGURED',
  );
});

test('bootstrap remains blocked unless independent approval context is injected', async () => {
  let runtimeCalls = 0;
  await assert.rejects(executeCatalogAdminBootstrap(request({
    trustedApprovalProvider: undefined,
    runtimeFactory: async () => { runtimeCalls += 1; return makeRuntime(() => {}); },
  })), (error) => error instanceof CatalogAdminBootstrapError &&
    error.code === 'TRUSTED_APPROVAL_SOURCE_UNCONFIGURED');
  await assert.rejects(executeCatalogAdminBootstrap(request({
    trustedApprovalProvider: async () => ({
      ownerId: 'same-person', ownerIdentitySource: 'environment', approvalReference: 'CHG-1',
    }),
    runtimeFactory: async () => { runtimeCalls += 1; return makeRuntime(() => {}); },
  })), (error) => error instanceof CatalogAdminBootstrapError &&
    error.code === 'TRUSTED_APPROVAL_INVALID');
  assert.equal(runtimeCalls, 0);
});

test('bootstrap remains blocked when the target resolver is not configured', async () => {
  await assert.rejects(executeCatalogAdminBootstrap(request({ targetResolver: undefined })),
    (error) => error instanceof CatalogAdminBootstrapError &&
      error.code === 'TARGET_SOURCE_UNCONFIGURED');
});

test('package exposes a separate bootstrap command while npm start remains the Main Bot', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node index.js');
  assert.equal(packageJson.scripts['catalog:bootstrap-admin'], 'node src/catalog-admin-bootstrap-entrypoint.js');
});
