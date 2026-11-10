'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  CatalogOperationalRuntimeConfigurationError,
  DEFAULT_DATABASE_ID,
  FIREBASE_APP_NAME,
  OWNER_UID_ENV,
  createOperationalCatalogRuntime,
} = require('../src/catalog-operational-runtime-factory');
const {
  CatalogEntrypointError,
  createOperationalCatalogApp,
} = require('../src/catalog-http-entrypoint');
const { getCatalogProviderKind } = require('../src/catalog-provider-kind');

function makeFirestore() {
  const documents = new Map();
  function reference(path) {
    return {
      path,
      id: path.split('/').at(-1),
      async get() {
        const value = documents.get(path);
        return value === undefined
          ? { exists: false }
          : { exists: true, data: () => ({ ...value }) };
      },
    };
  }
  const firestore = {
    collection(name) {
      return {
        path: name,
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
  return firestore;
}

function makeGoogle(state) {
  const authClient = Object.freeze({ marker: 'adc-client' });
  return {
    auth: {
      GoogleAuth: class FakeGoogleAuth {
        constructor(options) { state.googleAuthOptions = options; }
        async getClient() {
          state.googleAuthClient = authClient;
          return authClient;
        }
      },
    },
    sheets(options) {
      state.sheetsOptions = options;
      return {
        spreadsheets: {
          values: {
            async get() { return { data: { values: [] } }; },
            async batchUpdate() { return { data: {} }; },
          },
        },
      };
    },
  };
}

function makeFirebaseAdmin({ firestore = makeFirestore(), failCredential = false } = {}) {
  const state = {
    appOptions: null,
    appName: null,
    credentialCalls: 0,
    authApp: null,
    firestoreArgs: null,
    verifyCalls: [],
    targetLookupCalls: [],
  };
  const auth = {
    async verifyIdToken(token, checkRevoked) {
      state.verifyCalls.push([token, checkRevoked]);
      return { uid: 'admin-user' };
    },
    async getUser(uid) {
      return { uid, email: `${uid}@example.com`, displayName: 'not returned' };
    },
    async getUserByEmail(email) {
      state.targetLookupCalls.push(email);
      return { uid: 'resolved-target-uid', email };
    },
  };
  const app = { name: FIREBASE_APP_NAME, options: { projectId: 'oxiw-catalog-test-123' } };
  return {
    state,
    firebaseAdmin: {
      applicationDefault() {
        state.credentialCalls += 1;
        if (failCredential) throw new Error('private credential detail');
        return { marker: 'application-default' };
      },
      initializeApp(options, name) {
        state.appOptions = options;
        state.appName = name;
        return app;
      },
      getApps() { return []; },
      getApp() { return app; },
      getAuth(value) {
        state.authApp = value;
        return auth;
      },
      getFirestore(value, databaseId) {
        state.firestoreArgs = [value, databaseId];
        return firestore;
      },
    },
  };
}

function env(overrides = {}) {
  return {
    CATALOG_GCP_PROJECT_ID: 'oxiw-catalog-test-123',
    CATALOG_SPREADSHEET_ID: 'spreadsheet-fixture',
    ...overrides,
  };
}

test('builds operational runtime with Firebase Admin, revoked-token verifier, shared Firestore, and Sheets ADC', async () => {
  const state = {};
  const google = makeGoogle(state);
  const firebase = makeFirebaseAdmin();
  const runtime = await createOperationalCatalogRuntime({
    env: env({ CATALOG_FIRESTORE_DATABASE_ID: 'catalog-db', [OWNER_UID_ENV]: 'owner-user' }),
    google,
    firebaseAdmin: firebase.firebaseAdmin,
  });

  assert.equal(runtime.runtimeMode, 'operational');
  assert.equal(runtime.projectId, 'oxiw-catalog-test-123');
  assert.equal(runtime.databaseId, 'catalog-db');
  assert.equal(typeof runtime.authorizeOwner, 'function');
  assert.equal(runtime.authorizeOwner({
    authenticated: true, subjectId: 'owner-user', roles: ['administrator'],
  }), true);
  assert.equal(runtime.authorizeOwner({
    authenticated: true, subjectId: 'other-admin', roles: ['administrator'],
  }), false);
  assert.equal(runtime.authorizeOwner({
    authenticated: true, subjectId: 'owner-user', roles: ['observer'],
  }), false);
  assert.equal(runtime.authorizeOwner({
    authenticated: false, subjectId: 'owner-user', roles: ['administrator'],
  }), false);
  assert.equal(getCatalogProviderKind(runtime.provider), 'google-sheets');
  assert.equal(getCatalogProviderKind(runtime.metadataProvider), 'firestore-read');
  assert.equal(getCatalogProviderKind(runtime.writableProvider), 'firestore-write');
  assert.deepEqual(firebase.state.appOptions, {
    credential: { marker: 'application-default' },
    projectId: 'oxiw-catalog-test-123',
  });
  assert.equal(firebase.state.appName, FIREBASE_APP_NAME);
  assert.equal(firebase.state.firestoreArgs[1], 'catalog-db');
  assert.deepEqual(state.googleAuthOptions, {
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const principal = await runtime.verifyAdminPrincipal({
    headers: { authorization: 'Bearer signed-token' },
  });
  assert.deepEqual(principal, { authenticated: true, subjectId: 'admin-user' });
  assert.deepEqual(firebase.state.verifyCalls, [['signed-token', true]]);
  assert.equal(typeof runtime.targetResolver, 'function');
  assert.equal(await runtime.targetResolver('new-manager@example.com'), 'resolved-target-uid');
  assert.deepEqual(firebase.state.targetLookupCalls, ['new-manager@example.com']);
});

test('uses the compatible (default) Firestore database only when database setting is absent', async () => {
  const firebase = makeFirebaseAdmin();
  const runtime = await createOperationalCatalogRuntime({
    env: env(),
    google: makeGoogle({}),
    firebaseAdmin: firebase.firebaseAdmin,
  });
  assert.equal(runtime.databaseId, DEFAULT_DATABASE_ID);
  assert.equal(firebase.state.firestoreArgs[1], DEFAULT_DATABASE_ID);
});

test('rejects incomplete or invalid operational configuration before initialization', async () => {
  const firebase = makeFirebaseAdmin();
  const google = makeGoogle({});
  for (const invalid of [
    {},
    env({ CATALOG_GCP_PROJECT_ID: 'Bad_Project' }),
    env({ CATALOG_FIRESTORE_DATABASE_ID: 'bad database' }),
    env({ CATALOG_SPREADSHEET_ID: '' }),
    env({ GOOGLE_APPLICATION_CREDENTIALS: '' }),
    env({ [OWNER_UID_ENV]: 'invalid owner uid' }),
  ]) {
    await assert.rejects(
      createOperationalCatalogRuntime({
        env: invalid,
        google,
        firebaseAdmin: firebase.firebaseAdmin,
      }),
      CatalogOperationalRuntimeConfigurationError,
    );
  }
  assert.equal(firebase.state.credentialCalls, 0);
});

test('owner authorization is disabled unless a valid Firebase UID is configured', async () => {
  const unconfigured = await createOperationalCatalogRuntime({
    env: env(),
    google: makeGoogle({}),
    firebaseAdmin: makeFirebaseAdmin().firebaseAdmin,
  });
  assert.equal(unconfigured.authorizeOwner, undefined);

  const configured = await createOperationalCatalogRuntime({
    env: env({ [OWNER_UID_ENV]: 'owner-user' }),
    google: makeGoogle({}),
    firebaseAdmin: makeFirebaseAdmin().firebaseAdmin,
  });
  assert.equal(configured.authorizeOwner({
    authenticated: true, subjectId: 'owner-user', roles: ['administrator'],
  }), true);
  assert.equal(configured.authorizeOwner({
    authenticated: true, subjectId: 'owner-user', roles: ['observer'],
  }), false);
  assert.equal(configured.authorizeOwner({
    authenticated: true, subjectId: 'another-user', roles: ['administrator'],
  }), false);
});

test('fails closed and sanitizes ADC initialization errors', async () => {
  const firebase = makeFirebaseAdmin({ failCredential: true });
  await assert.rejects(
    createOperationalCatalogRuntime({
      env: env(),
      google: makeGoogle({}),
      firebaseAdmin: firebase.firebaseAdmin,
    }),
    (error) => {
      assert.ok(error instanceof CatalogOperationalRuntimeConfigurationError);
      assert.equal(error.message.includes('private credential detail'), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test('operational runtime construction has no Firestore reads or writes', async () => {
  const firestore = makeFirestore();
  const firebase = makeFirebaseAdmin({ firestore });
  const runtime = await createOperationalCatalogRuntime({
    env: env(),
    google: makeGoogle({}),
    firebaseAdmin: firebase.firebaseAdmin,
  });
  assert.deepEqual(await runtime.readinessCheck(), {
    sheetSource: true,
    metadataStore: true,
    writableStore: true,
    auditSink: true,
  });
});

test('operational entrypoint preserves the prebuilt app and its public Firebase web config', async () => {
  const operationalEnv = env({
    CATALOG_FIREBASE_WEB_API_KEY: 'public-web-key',
    CATALOG_FIREBASE_WEB_AUTH_DOMAIN: 'oxiw-catalog-test-123.firebaseapp.com',
    CATALOG_FIREBASE_WEB_PROJECT_ID: 'oxiw-catalog-test-123',
    CATALOG_FIREBASE_WEB_MESSAGING_SENDER_ID: '123456789',
    CATALOG_FIREBASE_WEB_APP_ID: '1:123456789:web:fixture',
  });
  const runtime = await createOperationalCatalogRuntime({
    env: operationalEnv,
    google: makeGoogle({}),
    firebaseAdmin: makeFirebaseAdmin().firebaseAdmin,
  });

  assert.equal(getCatalogProviderKind(runtime.provider), 'google-sheets');
  assert.equal(getCatalogProviderKind(runtime.metadataProvider), 'firestore-read');
  assert.equal(getCatalogProviderKind(runtime.writableProvider), 'firestore-write');

  const app = await createOperationalCatalogApp({
    env: operationalEnv,
    runtimeFactory: async () => runtime,
  });
  assert.strictEqual(app, runtime.app);

  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/config.json`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: {
        apiKey: operationalEnv.CATALOG_FIREBASE_WEB_API_KEY,
        authDomain: operationalEnv.CATALOG_FIREBASE_WEB_AUTH_DOMAIN,
        projectId: operationalEnv.CATALOG_FIREBASE_WEB_PROJECT_ID,
        messagingSenderId: operationalEnv.CATALOG_FIREBASE_WEB_MESSAGING_SENDER_ID,
        appId: operationalEnv.CATALOG_FIREBASE_WEB_APP_ID,
      },
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  await assert.rejects(
    createOperationalCatalogApp({
      env: operationalEnv,
      runtimeFactory: async () => ({ ...runtime, app: undefined }),
    }),
    (error) => error instanceof CatalogEntrypointError && /HTTP app is invalid/.test(error.message),
  );
});
