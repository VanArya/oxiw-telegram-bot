'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CatalogRuntimeConfigurationError,
  GOOGLE_SHEETS_SCOPE,
  createCatalogRuntime,
} = require('../src/catalog-runtime-factory');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const { createOperationalCatalogApp } = require('../src/catalog-http-entrypoint');
const { getCatalogProviderKind } = require('../src/catalog-provider-kind');
const { createInMemoryCatalogAdminRoleProvider } = require('../src/catalog-admin-role-provider');

function makeFirestore() {
  const documents = new Map();
  const calls = [];
  function reference(path) {
    return {
      path,
      async get() {
        const value = documents.get(path);
        return value === undefined
          ? { exists: false }
          : { exists: true, data: () => ({ ...value }) };
      },
    };
  }
  const firestore = {
    calls,
    collection(name) {
      calls.push(['collection', name]);
      return {
        doc(id) { return reference(`${name}/${id}`); },
        async get() { return { docs: [] }; },
      };
    },
    async runTransaction(callback) {
      return callback({
        async get(ref) { return ref.get(); },
        set(ref, value) { documents.set(ref.path, { ...value }); },
        create(ref, value) {
          if (documents.has(ref.path)) throw new Error('duplicate');
          documents.set(ref.path, { ...value });
        },
      });
    },
  };
  return { firestore, documents, calls };
}

function makeGoogle({ failAuth = false } = {}) {
  const state = { authOptions: null, authClient: null, sheetsOptions: null, getCalls: [] };
  const authClient = Object.freeze({ marker: 'fake-auth-client' });
  state.authClient = authClient;
  const google = {
    auth: {
      GoogleAuth: class FakeGoogleAuth {
        constructor(options) {
          state.authOptions = options;
          if (failAuth) throw new Error('sensitive fake credential detail');
        }
        async getClient() {
          if (failAuth) throw new Error('sensitive fake credential detail');
          return authClient;
        }
      },
    },
    sheets(options) {
      state.sheetsOptions = options;
      return {
        spreadsheets: {
          values: {
            async get(params) {
              state.getCalls.push(params);
              return { data: { values: [['کد سیستم', 'اسم فیلم'], ['101', 'Fixture']] } };
            },
            async batchUpdate() { return { data: {} }; },
            async append() { return { data: {} }; },
            async batchUpdate() { return { data: {} }; },
          },
        },
      };
    },
  };
  return { google, state };
}

function validOptions(overrides = {}) {
  const { google } = makeGoogle();
  const { firestore } = makeFirestore();
  return {
    env: { CATALOG_SPREADSHEET_ID: 'fixture-spreadsheet-id' },
    google,
    firestore,
    verifyAdminPrincipal: async () => null,
    roleProvider: createInMemoryCatalogAdminRoleProvider({}),
    authorizePermission: async () => false,
    readinessCheck: async () => ({
      sheetSource: true,
      metadataStore: true,
      writableStore: true,
      auditSink: true,
    }),
    ...overrides,
  };
}

test('factory composes injected Google Sheets, shared Firestore providers, audit, authorization and HTTP app', async () => {
  const { google, state } = makeGoogle();
  const { firestore, calls } = makeFirestore();
  const runtime = await createCatalogRuntime(validOptions({ google, firestore }));

  assert.equal(runtime.runtimeMode, 'injected');
  assert.equal(typeof runtime.app, 'function');
  assert.equal(typeof runtime.verifyAdminPrincipal, 'function');
  assert.equal(typeof runtime.authorizePermission, 'function');
  assert.equal(getCatalogProviderKind(runtime.provider), 'google-sheets');
  assert.equal(getCatalogProviderKind(runtime.metadataProvider), 'firestore-read');
  assert.equal(getCatalogProviderKind(runtime.writableProvider), 'firestore-write');
  assert.deepEqual(state.authOptions, { scopes: [GOOGLE_SHEETS_SCOPE] });
  assert.deepEqual(state.sheetsOptions, { version: 'v4', auth: state.authClient });
  assert.deepEqual(state.getCalls, [], 'client construction must not read a Sheet');

  await runtime.metadataProvider.getContentMetadata('movie:101');
  const contentId = createCatalogContentId('movie', '101');
  const write = await runtime.writableProvider.upsertContentMetadata(contentId, {
    approvalStatus: 'approved',
    publicationStatus: 'draft',
  }, { expectedVersion: 0, actorId: 'fixture-admin' });
  assert.equal(write.value.approvalStatus, 'approved');
  assert.equal(write.value.publicationStatus, 'draft', 'approval must not imply publication');
  assert.ok(calls.some(([, name]) => name === 'catalogContentMetadata'));
  assert.ok(calls.some(([, name]) => name === 'catalogAuditEvents'));
  assert.equal(state.getCalls.length, 0, 'runtime composition and metadata writes do not call Sheets');

  await runtime.provider.readSheet('سینمایی');
  assert.equal(state.getCalls.length, 1);
  assert.equal(state.getCalls[0].range, "'سینمایی'");
  assert.equal(state.getCalls[0].spreadsheetId, 'fixture-spreadsheet-id');
});

test('factory refuses incomplete dependencies and missing verifier, role provider, or policy', async (t) => {
  const cases = [
    ['missing environment', { env: {} }],
    ['missing Google namespace', { google: undefined }],
    ['missing Firestore client', { firestore: undefined }],
    ['missing verifier', { verifyAdminPrincipal: undefined }],
    ['missing role provider', { roleProvider: undefined }],
    ['missing policy', { authorizePermission: undefined }],
    ['missing readiness', { readinessCheck: undefined }],
    ['invalid categories', { categories: {} }],
  ];
  for (const [label, override] of cases) {
    await t.test(label, async () => {
      await assert.rejects(
        createCatalogRuntime(validOptions(override)),
        CatalogRuntimeConfigurationError,
      );
    });
  }
});

test('authentication/client setup errors are sanitized and do not expose credential details', async () => {
  const { google } = makeGoogle({ failAuth: true });
  await assert.rejects(createCatalogRuntime(validOptions({ google })), (error) => {
    assert.ok(error instanceof CatalogRuntimeConfigurationError);
    assert.equal(error.message.includes('sensitive fake credential detail'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('factory never turns its injected runtime into an operational CLI runtime', async () => {
  const runtime = await createCatalogRuntime(validOptions());
  await assert.rejects(
    createOperationalCatalogApp({
      env: {},
      runtimeFactory: async () => runtime,
    }),
    /runtime must explicitly declare operational configuration/,
  );
});

test('invalid Sheets API shape is rejected without contacting a service', async () => {
  const google = {
    auth: { GoogleAuth: class { async getClient() { return {}; } } },
    sheets() { return { spreadsheets: { values: {} } }; },
  };
  await assert.rejects(
    createCatalogRuntime(validOptions({ google })),
    CatalogRuntimeConfigurationError,
  );
});
