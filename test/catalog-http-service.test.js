'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { categories } = require('./fixtures/catalog-fixtures');
const {
  createFixtureMetadataProvider,
  createFixtureProvider,
} = require('./fixtures/catalog-sheet-source-fixtures');
const {
  ADMIN_CATALOG_PATH,
  REQUIRED_READINESS_CHECKS,
  createCatalogHttpService,
  parseCatalogPort,
} = require('../src/catalog-http-service');
const { createCatalogHttpServer } = require('../src/catalog-http-server');
const {
  CatalogEntrypointError,
  createOperationalCatalogApp,
} = require('../src/catalog-http-entrypoint');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const { createCatalogRoleAuthorizer } = require('../src/catalog-admin-authorization');
const { createInMemoryCatalogAdminRoleProvider } = require('../src/catalog-admin-role-provider');
const {
  createInMemoryWritableCatalogMetadataProvider,
} = require('../src/in-memory-writable-catalog-metadata-provider');

const contentId = createCatalogContentId('movie', 'fixture-movie-ir');
const roleAuthorizer = createCatalogRoleAuthorizer();
const readyChecks = Object.freeze(Object.fromEntries(REQUIRED_READINESS_CHECKS.map((key) => [key, true])));

function createService(overrides = {}) {
  return createCatalogHttpService({
    provider: createFixtureProvider(),
    categories,
    metadataProvider: createFixtureMetadataProvider(),
    writableProvider: createInMemoryWritableCatalogMetadataProvider({
      contentMetadata: [],
      categories: [],
      taxonomies: {
        country: [{ id: 'IR', labelFa: 'ایران', enabled: true }],
        genre: [{ id: 'drama', labelFa: 'درام', enabled: true }],
      },
    }),
    verifyAdminPrincipal: () => ({
      authenticated: true,
      subjectId: 'fixture-admin',
    }),
    roleProvider: createInMemoryCatalogAdminRoleProvider({ 'fixture-admin': ['administrator'] }),
    authorizePermission: roleAuthorizer,
    readinessCheck: async () => readyChecks,
    ...overrides,
  });
}

async function withServer(options, run, { serverFactory } = {}) {
  const app = createService(options);
  const listener = createCatalogHttpServer({
    app,
    port: 0,
    host: '127.0.0.1',
    allowEphemeralPort: true,
    ...(serverFactory === undefined ? {} : { serverFactory }),
  });
  try {
    const server = await listener.start();
    const address = listener.address();
    assert.equal(address.address, '127.0.0.1');
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await listener.stop();
  }
}

async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2500) });
  return {
    response,
    body: await response.json(),
    etag: response.headers.get('etag'),
  };
}

test('composes the existing public catalog API with injected dependencies', { timeout: 7000 }, async () => {
  await withServer({}, async (baseUrl) => {
    const result = await json(`${baseUrl}/api/v1/catalog/items?kind=movie&countryId=IR`);
    assert.equal(result.response.status, 200);
    assert.ok(result.body.data.length > 0);
    assert.ok(result.body.data.every((item) => item.kind === 'movie'));
  });
});

test('keeps the integrated admin API fail-closed when verifier, role provider, or policy is absent', { timeout: 7000 }, async () => {
  await withServer({ verifyAdminPrincipal: undefined, authorizePermission: undefined }, async (baseUrl) => {
    const result = await json(`${baseUrl}${ADMIN_CATALOG_PATH}/categories`);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, 'ADMIN_AUTH_NOT_CONFIGURED');
  });
});

test('serves live status and gates readiness on every injected check plus authorization', { timeout: 7000 }, async () => {
  await withServer({}, async (baseUrl) => {
    const live = await json(`${baseUrl}/health/live`);
    assert.equal(live.response.status, 200);
    assert.deepEqual(live.body, { status: 'live' });

    const ready = await json(`${baseUrl}/health/ready`);
    assert.equal(ready.response.status, 200);
    assert.deepEqual(ready.body, { status: 'ready' });
  });

  await withServer({ readinessCheck: async () => ({ ...readyChecks, metadataStore: false }) }, async (baseUrl) => {
    const result = await json(`${baseUrl}/health/ready`);
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, { status: 'not_ready' });
  });

  await withServer({ readinessCheck: async () => { throw new Error('synthetic-secret-detail'); } }, async (baseUrl) => {
    const result = await json(`${baseUrl}/health/ready`);
    assert.equal(result.response.status, 503);
    assert.equal(JSON.stringify(result.body).includes('synthetic-secret-detail'), false);
  });

  await withServer({ verifyAdminPrincipal: undefined }, async (baseUrl) => {
    const result = await json(`${baseUrl}/health/ready`);
    assert.equal(result.response.status, 503);
  });

  await withServer({ roleProvider: undefined }, async (baseUrl) => {
    const result = await json(`${baseUrl}/health/ready`);
    assert.equal(result.response.status, 503);
    const admin = await json(`${baseUrl}${ADMIN_CATALOG_PATH}/categories`);
    assert.equal(admin.response.status, 503);
    assert.equal(admin.body.error.code, 'ADMIN_AUTH_NOT_CONFIGURED');
  });
});

test('rejects missing composition dependencies instead of silently selecting memory providers', () => {
  assert.throws(
    () => createCatalogHttpService({ readinessCheck: async () => readyChecks }),
    /readSheet provider/,
  );
  assert.throws(
    () => createCatalogHttpService({ provider: createFixtureProvider(), readinessCheck: async () => readyChecks }),
    /CatalogMetadataProvider/,
  );
  assert.throws(
    () => createCatalogHttpService({
      provider: createFixtureProvider(),
      metadataProvider: createFixtureMetadataProvider(),
      readinessCheck: async () => readyChecks,
    }),
    /WritableCatalogMetadataProvider/,
  );
  assert.throws(
    () => createCatalogHttpService({
      provider: createFixtureProvider(),
      metadataProvider: createFixtureMetadataProvider(),
      writableProvider: createInMemoryWritableCatalogMetadataProvider(),
    }),
    /readiness check/,
  );
});

test('validates the future PORT configuration without opening a listener', () => {
  assert.equal(parseCatalogPort(undefined), 8080);
  assert.equal(parseCatalogPort('8088'), 8088);
  for (const invalid of ['', '0', '-1', '1.2', '65536', 'secret', null]) {
    assert.throws(() => parseCatalogPort(invalid), /PORT must be an integer/);
  }
  assert.throws(
    () => createCatalogHttpServer({ app: createService({}), port: 'invalid' }),
    /PORT must be an integer/,
  );
  assert.throws(
    () => createCatalogHttpServer({ app: createService({}), port: 0, host: '0.0.0.0' }),
    /PORT must be an integer/,
  );
});

test('binds through an injected server factory and reports occupied ports safely', { timeout: 7000 }, async () => {
  let factoryReceivedApp = false;
  await withServer({}, async (baseUrl) => {
    const result = await json(`${baseUrl}/health/live`);
    assert.equal(result.response.status, 200);
  }, {
    serverFactory(app) {
      factoryReceivedApp = typeof app === 'function';
      return http.createServer(app);
    },
  });
  assert.equal(factoryReceivedApp, true);

  const blocker = http.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const listener = createCatalogHttpServer({
    app: createService({}),
    port: blocker.address().port,
    host: '127.0.0.1',
  });
  try {
    await assert.rejects(listener.start(), (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      assert.equal(error.message.includes(String(blocker.address().port)), false);
      return true;
    });
  } finally {
    await listener.stop();
    await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  }
});

test('listener defaults to 0.0.0.0 and forwards the validated PORT to the injected server', async () => {
  const fakeServer = new EventEmitter();
  fakeServer.listening = false;
  fakeServer.listen = (port, host) => {
    fakeServer.requestedPort = port;
    fakeServer.requestedHost = host;
    fakeServer.listening = true;
    fakeServer.emit('listening');
  };
  fakeServer.close = (callback) => {
    fakeServer.listening = false;
    callback();
  };
  fakeServer.closeAllConnections = () => {};

  const listener = createCatalogHttpServer({
    app: createService({}),
    port: '9123',
    serverFactory: () => fakeServer,
  });
  await listener.start();
  assert.equal(fakeServer.requestedPort, 9123);
  assert.equal(fakeServer.requestedHost, '0.0.0.0');
  await listener.stop();
  assert.equal(fakeServer.listening, false);
});

test('entrypoint refuses to start without an explicit operational runtime factory', async () => {
  await assert.rejects(
    createOperationalCatalogApp({
      env: {},
    }),
    (error) => error instanceof CatalogEntrypointError && /runtime factory is not configured/.test(error.message),
  );

  await assert.rejects(
    createOperationalCatalogApp({
      env: { PORT: '8080' },
      runtimeFactory: async () => ({ runtimeMode: 'test' }),
    }),
    (error) => error instanceof CatalogEntrypointError && /must explicitly declare operational configuration/.test(error.message),
  );

  await assert.rejects(
    createOperationalCatalogApp({
      env: { PORT: '8080' },
      runtimeFactory: async () => ({
        runtimeMode: 'operational',
        provider: createFixtureProvider(),
        metadataProvider: createFixtureMetadataProvider(),
        writableProvider: createInMemoryWritableCatalogMetadataProvider(),
      }),
    }),
    (error) => error instanceof CatalogEntrypointError && /not approved operational adapters/.test(error.message),
  );
});

test('keeps npm start assigned to Main Bot and adds a separate Catalog command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node index.js');
  assert.equal(packageJson.scripts['catalog:start'], 'node src/catalog-operational-entrypoint.js');
});

test('preserves create ETag, If-Match updates, approval/publication separation, and stale-version rejection', { timeout: 7000 }, async () => {
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata: [],
    categories: [],
    taxonomies: {
      country: [{ id: 'IR', labelFa: 'ایران', enabled: true }],
      genre: [{ id: 'drama', labelFa: 'درام', enabled: true }],
    },
  });
  await withServer({ writableProvider, metadataProvider: writableProvider }, async (baseUrl) => {
    const path = `${ADMIN_CATALOG_PATH}/items/${encodeURIComponent(contentId)}/metadata`;
    const create = await json(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending',
        publicationStatus: 'draft',
        countryIds: ['IR'],
        genreIds: ['drama'],
      }),
    });
    assert.equal(create.response.status, 201);
    assert.match(create.etag, /^"catalog-v1\.[A-Za-z0-9_-]+\.v1"$/);

    const read = await json(`${baseUrl}${path}`);
    assert.equal(read.response.status, 200);
    assert.equal(read.etag, create.etag);

    const approvalPath = `${ADMIN_CATALOG_PATH}/items/${encodeURIComponent(contentId)}/approval`;
    const approved = await json(`${baseUrl}${approvalPath}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': create.etag },
      body: JSON.stringify({ approvalStatus: 'approved' }),
    });
    assert.equal(approved.response.status, 200);
    assert.notEqual(approved.etag, create.etag);

    const stillPrivate = await json(`${baseUrl}/api/v1/catalog/items/${encodeURIComponent(contentId)}`);
    assert.equal(stillPrivate.response.status, 404);

    const stale = await json(`${baseUrl}${approvalPath}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': create.etag },
      body: JSON.stringify({ approvalStatus: 'rejected' }),
    });
    assert.equal(stale.response.status, 412);

    const publicationPath = `${ADMIN_CATALOG_PATH}/items/${encodeURIComponent(contentId)}/publication`;
    const published = await json(`${baseUrl}${publicationPath}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': approved.etag },
      body: JSON.stringify({ publicationStatus: 'published' }),
    });
    assert.equal(published.response.status, 200);

    const publicItem = await json(`${baseUrl}/api/v1/catalog/items/${encodeURIComponent(contentId)}`);
    assert.equal(publicItem.response.status, 200);
    assert.equal(publicItem.body.data.id, contentId);
    assert.equal(JSON.stringify(publicItem.body).includes('sourceRecord'), false);
    assert.equal(JSON.stringify(publicItem.body).includes('Telegram File ID'), false);
  });
});

test('maps internal failures to safe JSON and closes loopback server handles', { timeout: 7000 }, async () => {
  let server;
  await withServer({
    provider: { async readSheet() { throw new Error('synthetic-internal-secret'); } },
  }, async (baseUrl, activeServer) => {
    server = activeServer;
    const result = await json(`${baseUrl}/api/v1/catalog/items`);
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(result.body).includes('synthetic-internal-secret'), false);
    assert.equal(JSON.stringify(result.body).includes('stack'), false);
  });
  assert.equal(server.listening, false);
});
