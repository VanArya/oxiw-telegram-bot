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
  ownerId: 'catalog-owner', approverId: 'second-approver', approvalReference: 'CHG-2026-1042',
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
    targetSubjectId: 'first-admin',
    confirmation: CONFIRMATION_VALUE,
    trustedActorProvider: async () => ACTOR,
    trustedApprovalProvider: async () => APPROVAL,
    runtimeFactory: async () => makeRuntime(async () => ({ version: 1, eventId: 'event-1' })),
    ...overrides,
  };
}

test('requires an explicit target and exact confirmation before any runtime or actor lookup', async () => {
  assert.deepEqual(parseBootstrapArguments(['--target-subject-id', 'first-admin']), {
    targetSubjectId: 'first-admin',
  });
  await assert.rejects(
    executeCatalogAdminBootstrap(request({ confirmation: undefined })),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'CONFIRMATION_REQUIRED',
  );
  await assert.rejects(
    executeCatalogAdminBootstrap(request({ env: {} })),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'CONFIGURATION_INVALID',
  );
  assert.throws(
    () => parseBootstrapArguments(['--target-subject-id']),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'TARGET_REQUIRED',
  );
  assert.throws(
    () => parseBootstrapArguments([
      '--target-subject-id', 'first-admin', '--target-subject-id', 'second-admin',
    ]),
    (error) => error instanceof CatalogAdminBootstrapError && error.code === 'TARGET_REQUIRED',
  );

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

test('CLI main accepts the confirmation flags but remains disabled without trusted actor wiring', async () => {
  await assert.rejects(
    main({
      argv: ['--target-subject-id', 'first-admin', '--confirm', CONFIRMATION_VALUE],
      env: ENV,
    }),
    (error) => error instanceof CatalogAdminBootstrapError &&
      error.code === 'TRUSTED_ACTOR_SOURCE_UNCONFIGURED',
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
      ownerId: 'same-person', approverId: 'same-person', approvalReference: 'CHG-1',
    }),
    runtimeFactory: async () => { runtimeCalls += 1; return makeRuntime(() => {}); },
  })), (error) => error instanceof CatalogAdminBootstrapError &&
    error.code === 'TRUSTED_APPROVAL_INVALID');
  assert.equal(runtimeCalls, 0);
});

test('package exposes a separate bootstrap command while npm start remains the Main Bot', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node index.js');
  assert.equal(packageJson.scripts['catalog:bootstrap-admin'], 'node src/catalog-admin-bootstrap-entrypoint.js');
});
