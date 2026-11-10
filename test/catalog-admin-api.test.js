'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createCatalogAdminApi } = require('../src/catalog-admin-api');
const { createFirebaseAdminIdTokenVerifier } = require('../src/firebase-admin-id-token-verifier');
const { createCatalogApi } = require('../src/catalog-api');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const {
  createCatalogRoleAuthorizer,
} = require('../src/catalog-admin-authorization');
const { createInMemoryCatalogAdminRoleProvider } = require('../src/catalog-admin-role-provider');
const {
  createInMemoryWritableCatalogMetadataProvider,
} = require('../src/in-memory-writable-catalog-metadata-provider');

const ADMIN_PATH = '/api/v1/admin/catalog';
const contentId = createCatalogContentId('movie', 'admin-fixture-1');
const countryFixture = { id: 'IR', labelFa: 'ایران', enabled: true };
const genreFixture = { id: 'drama', labelFa: 'درام', enabled: true };
const roleAuthorizer = createCatalogRoleAuthorizer();

function createAdminApi(writableProvider, {
  roles = ['administrator'],
  subjectId = 'fixture-admin',
  verifyAdminPrincipal,
  roleProvider = createInMemoryCatalogAdminRoleProvider({ [subjectId]: roles }),
  reportRoleResolutionFailure,
  authorizePermission = roleAuthorizer,
  authorizeOwner,
  targetResolver,
  resolveManagerEmail,
  directCategoryWritesEnabled,
} = {}) {
  return createCatalogAdminApi({
    writableProvider,
    verifyAdminPrincipal: verifyAdminPrincipal || (() => ({ authenticated: true, subjectId })),
    roleProvider,
    reportRoleResolutionFailure,
    authorizePermission,
    authorizeOwner,
    targetResolver,
    resolveManagerEmail,
    directCategoryWritesEnabled: directCategoryWritesEnabled === undefined ? true : directCategoryWritesEnabled,
  });
}

function createStore(overrides = {}) {
  return createInMemoryWritableCatalogMetadataProvider({
    contentMetadata: [],
    categories: [],
    taxonomies: { country: [countryFixture], genre: [genreFixture] },
    ...overrides,
  });
}

async function withServer(app, run) {
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server.listening) await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function json(response) {
  return {
    status: response.status,
    body: await response.json(),
    etag: response.headers.get('etag'),
  };
}

const sheetProvider = {
  async readSheet(sheetName) {
    return sheetName === 'سینمایی'
      ? {
        headers: ['کد سیستم', 'اسم فیلم', 'Telegram File ID'],
        rows: [['admin-fixture-1', 'فیلم آزمایشی', 'synthetic-source-file-id']],
      }
      : { headers: ['کد سیستم', 'اسم فیلم'], rows: [] };
  },
};

test('admin API fails closed when authorization is absent or denied', async () => {
  const store = createStore();
  const unconfigured = createCatalogAdminApi({ writableProvider: store });
  await withServer(unconfigured, async (baseUrl) => {
    const response = await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalStatus: 'approved', publicationStatus: 'published' }),
    });
    const result = await json(response);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'ADMIN_AUTH_NOT_CONFIGURED');
    assert.equal(await store.getContentMetadata(contentId), null);
  });

  const missingVerifier = createCatalogAdminApi({
    writableProvider: store,
    authorizePermission: roleAuthorizer,
  });
  await withServer(missingVerifier, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'ADMIN_AUTH_NOT_CONFIGURED');
  });

  const missingPolicy = createCatalogAdminApi({
    writableProvider: store,
    verifyAdminPrincipal: () => ({ authenticated: true, subjectId: 'fixture-admin' }),
  });
  await withServer(missingPolicy, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'ADMIN_AUTH_NOT_CONFIGURED');
  });

  const denied = createAdminApi(store, { roles: ['observer'] });
  await withServer(denied, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`));
    assert.equal(result.status, 404);
  });

  const invalidPrincipals = [
    null,
    { authenticated: false, subjectId: 'fixture-admin' },
    { authenticated: true, subjectId: 'bad subject' },
    { authenticated: true, subjectId: 'fixture-admin', roles: ['administrator'] },
    { authenticated: true, subjectId: 'fixture-admin', extra: 'untrusted' },
    Object.create({ authenticated: true, subjectId: 'fixture-admin' }),
  ];
  for (const principal of invalidPrincipals) {
    const invalid = createAdminApi(store, { verifyAdminPrincipal: () => principal });
    await withServer(invalid, async (baseUrl) => {
      const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
      assert.equal(result.status, 401);
      assert.equal(result.body.error.code, 'UNAUTHENTICATED');
    });
  }

  const throwing = createAdminApi(store, {
    verifyAdminPrincipal: () => { throw new Error('synthetic-private-verifier-detail'); },
  });
  await withServer(throwing, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'AUTHENTICATION_UNAVAILABLE');
    assert.equal(JSON.stringify(result.body).includes('synthetic-private-verifier-detail'), false);
  });

  const rejectedTokens = createAdminApi(store, {
    verifyAdminPrincipal: createFirebaseAdminIdTokenVerifier({
      auth: { async verifyIdToken() { throw new Error('synthetic-invalid-token-detail'); } },
    }),
  });
  await withServer(rejectedTokens, async (baseUrl) => {
    for (const headers of [{}, { authorization: 'Bearer invalid-token' }]) {
      const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`, { headers }));
      assert.equal(result.status, 401);
      assert.equal(result.body.error.code, 'UNAUTHENTICATED');
      assert.equal(JSON.stringify(result.body).includes('synthetic-invalid-token-detail'), false);
    }
  });

  const throwingPolicy = createAdminApi(store, {
    authorizePermission: () => { throw new Error('synthetic-private-policy-detail'); },
  });
  await withServer(throwingPolicy, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'AUTHORIZATION_UNAVAILABLE');
    assert.equal(JSON.stringify(result.body).includes('synthetic-private-policy-detail'), false);
  });
});

test('role resolution follows identity verification and distinguishes no assignment from invalid or unavailable roles', async () => {
  const store = createStore();
  const roleSubjects = [];
  const roleProvider = {
    async resolveRoles(subjectId) {
      roleSubjects.push(subjectId);
      return subjectId === 'verified-observer' ? ['observer'] : [];
    },
  };
  const observer = createAdminApi(store, {
    subjectId: 'verified-observer',
    roleProvider,
    verifyAdminPrincipal: () => ({ authenticated: true, subjectId: 'verified-observer' }),
  });
  await withServer(observer, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories?role=administrator`, {
      headers: { 'x-catalog-role': 'administrator', 'x-catalog-subject': 'attacker' },
    }));
    assert.equal(result.status, 200);
  });
  assert.deepEqual(roleSubjects, ['verified-observer']);

  let resolverCalls = 0;
  const invalidIdentity = createAdminApi(store, {
    verifyAdminPrincipal: () => ({ authenticated: false, subjectId: 'unverified' }),
    roleProvider: { async resolveRoles() { resolverCalls += 1; return ['administrator']; } },
  });
  await withServer(invalidIdentity, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 401);
  });
  assert.equal(resolverCalls, 0, 'unverified identities must never reach the role source');

  const noAssignmentFailures = [];
  const noAssignment = createAdminApi(store, {
    subjectId: 'verified-without-role',
    verifyAdminPrincipal: () => ({ authenticated: true, subjectId: 'verified-without-role' }),
    roleProvider: { async resolveRoles() { return []; } },
    reportRoleResolutionFailure: (event) => noAssignmentFailures.push(event),
  });
  await withServer(noAssignment, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'FORBIDDEN');
  });
  assert.deepEqual(noAssignmentFailures, []);

  for (const { provider: brokenProvider, category } of [
    { provider: { async resolveRoles() { return ['unrecognized-role']; } }, category: 'invalid_assignment' },
    { provider: { async resolveRoles() { return ['observer', 'observer']; } }, category: 'invalid_assignment' },
    { provider: { async resolveRoles() { throw new Error('synthetic-role-database-detail'); } }, category: 'provider_error' },
  ]) {
    const failures = [];
    const unavailable = createAdminApi(store, {
      roleProvider: brokenProvider,
      reportRoleResolutionFailure: (event) => failures.push(event),
    });
    await withServer(unavailable, async (baseUrl) => {
      const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
      assert.equal(result.status, 503);
      assert.equal(result.body.error.code, 'ROLE_RESOLUTION_UNAVAILABLE');
      assert.equal(JSON.stringify(result.body).includes('synthetic-role-database-detail'), false);
    });
    assert.deepEqual(failures, [{ category }]);
    assert.equal(JSON.stringify(failures).includes('synthetic-role-database-detail'), false);
  }
});

test('catalog admin roles enforce least privilege and audit actor comes only from verified principal', async () => {
  const store = createStore();
  const auditActors = [];
  const observedProvider = {
    ...store,
    async upsertContentMetadata(id, value, options) {
      auditActors.push(options.actorId);
      return store.upsertContentMetadata(id, value, options);
    },
  };

  const observer = createAdminApi(store, { roles: ['observer'] });
  await withServer(observer, async (baseUrl) => {
    const read = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(read.status, 200);
    const write = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify({
          approvalStatus: 'pending', publicationStatus: 'draft', countryIds: [], genreIds: [],
        }),
      },
    ));
    assert.equal(write.status, 403);
  });

  const editor = createAdminApi(observedProvider, { roles: ['editor'], subjectId: 'verified-editor' });
  await withServer(editor, async (baseUrl) => {
    const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`;
    const created = await json(await fetch(
      `${url}?role=administrator&subjectId=request-controlled`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'if-none-match': '*',
          'x-catalog-role': 'administrator',
          'x-catalog-subject': 'request-controlled',
        },
        body: JSON.stringify({
          approvalStatus: 'pending', publicationStatus: 'draft', countryIds: [], genreIds: [],
        }),
      },
    ));
    assert.equal(created.status, 201);
    assert.deepEqual(auditActors, ['verified-editor']);
    const edited = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': created.etag },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft', countryIds: ['IR'], genreIds: [],
      }),
    }));
    assert.equal(edited.status, 200);
    assert.deepEqual(auditActors, ['verified-editor', 'verified-editor']);

    const approve = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/approval?role=administrator`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json', 'if-match': edited.etag,
          'x-catalog-role': 'administrator',
          'x-catalog-subject': 'request-controlled',
          'x-actor-id': 'request-controlled',
        },
        body: JSON.stringify({
          approvalStatus: 'approved', role: 'administrator', subjectId: 'request-controlled',
        }),
      },
    ));
    assert.equal(approve.status, 403);
    const publish = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/publication`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': edited.etag },
        body: JSON.stringify({ publicationStatus: 'published' }),
      },
    ));
    assert.equal(publish.status, 403);

    const approvalAttemptId = createCatalogContentId('movie', 'editor-approval-attempt');
    const approvalAttempt = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(approvalAttemptId)}/metadata`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify({
          approvalStatus: 'approved', publicationStatus: 'draft', countryIds: [], genreIds: [],
        }),
      },
    ));
    assert.equal(approvalAttempt.status, 403);

    const publicationAttemptId = createCatalogContentId('movie', 'editor-publication-attempt');
    const initial = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(publicationAttemptId)}/metadata`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify({
          approvalStatus: 'pending', publicationStatus: 'draft', countryIds: [], genreIds: [],
        }),
      },
    ));
    assert.equal(initial.status, 201);
    const publicationAttempt = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(publicationAttemptId)}/metadata`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': initial.etag },
        body: JSON.stringify({
          approvalStatus: 'pending', publicationStatus: 'published', countryIds: [], genreIds: [],
        }),
      },
    ));
    assert.equal(publicationAttempt.status, 403);
  });

  const approver = createAdminApi(store, { roles: ['approver'] });
  await withServer(approver, async (baseUrl) => {
    const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}`;
    const current = await json(await fetch(`${url}/metadata`));
    assert.equal(current.status, 200);
    const approved = await json(await fetch(`${url}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': current.etag },
      body: JSON.stringify({ approvalStatus: 'approved' }),
    }));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.publicationStatus, 'draft');
    const publish = await json(await fetch(`${url}/publication`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': approved.etag },
      body: JSON.stringify({ publicationStatus: 'published' }),
    }));
    assert.equal(publish.status, 403);
  });

  const publisher = createAdminApi(store, { roles: ['publisher'] });
  await withServer(publisher, async (baseUrl) => {
    const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}`;
    const current = await json(await fetch(`${url}/metadata`));
    const approve = await json(await fetch(`${url}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': current.etag },
      body: JSON.stringify({ approvalStatus: 'rejected' }),
    }));
    assert.equal(approve.status, 403);
    const publish = await json(await fetch(`${url}/publication`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': current.etag },
      body: JSON.stringify({ publicationStatus: 'published' }),
    }));
    assert.equal(publish.status, 200);
    assert.equal(publish.body.data.approvalStatus, 'approved');
    assert.equal(publish.body.data.publicationStatus, 'published');
  });

  const taxonomyManager = createAdminApi(store, { roles: ['taxonomy_manager'] });
  await withServer(taxonomyManager, async (baseUrl) => {
    const category = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/example`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        slug: 'example', localizedTitle: { fa: 'نمونه' }, enabled: true, sortOrder: 1,
        filters: { all: [{ field: 'kind', op: 'eq', value: 'movie' }] },
      }),
    }));
    assert.equal(category.status, 201);
    const contentWrite = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify({
          approvalStatus: 'pending', publicationStatus: 'draft', countryIds: [], genreIds: [],
        }),
      },
    ));
    assert.equal(contentWrite.status, 403);
  });
});

test('metadata approval and publication are separate and only their approved/published pair is public', async () => {
  const store = createStore();
  const admin = createAdminApi(store);
  const publicApi = createCatalogApi({ provider: sheetProvider, metadataProvider: store });

  await withServer(admin, async (baseUrl) => {
    const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`;
    const created = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: ['drama'],
        downloadToken: 'synthetic-private-download-token',
      }),
    }));
    assert.equal(created.status, 400);
    assert.equal(await store.getContentMetadata(contentId), null);

    const validCreated = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: ['drama'],
      }),
    }));
    assert.equal(validCreated.status, 201);
    assert.equal(Object.hasOwn(validCreated.body.data, '_version'), false);

    const fetchedMetadata = await json(await fetch(url));
    assert.equal(fetchedMetadata.status, 200);
    assert.equal(fetchedMetadata.body.data.approvalStatus, 'pending');
    assert.equal(fetchedMetadata.etag,
      `"catalog-v1.${Buffer.from(`content:${contentId}`).toString('base64url')}.v1"`);
    const editedMetadata = await json(await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-match': fetchedMetadata.etag,
      },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: [],
      }),
    }));
    assert.equal(editedMetadata.status, 200);
    assert.deepEqual(editedMetadata.body.data.genreIds, []);
    assert.notEqual(editedMetadata.etag, fetchedMetadata.etag);

    const missingPrecondition = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft', countryIds: ['IR'], genreIds: [],
      }),
    }));
    assert.equal(missingPrecondition.status, 428);

    const stalePrecondition = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': fetchedMetadata.etag },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft', countryIds: ['IR'], genreIds: [],
      }),
    }));
    assert.equal(stalePrecondition.status, 412);

    const invalidCombinedStatus = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'published',
        countryIds: ['IR'], genreIds: ['drama'],
      }),
    }));
    assert.equal(invalidCombinedStatus.status, 409);
    assert.equal(invalidCombinedStatus.body.error.code, 'APPROVAL_REQUIRED');

    const clientVersionField = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: [], _version: 1,
      }),
    }));
    assert.equal(clientVersionField.status, 400);

    const existingCreate = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: [],
      }),
    }));
    assert.equal(existingCreate.status, 409);
    assert.equal(existingCreate.body.error.code, 'ALREADY_EXISTS');

    const invalidEtag = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': 'W/"catalog-v1-invalid"' },
      body: JSON.stringify({ approvalStatus: 'approved' }),
    }));
    assert.equal(invalidEtag.status, 400);
    assert.equal(invalidEtag.body.error.code, 'INVALID_PRECONDITION');

    const prematurePublication = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/publication`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': editedMetadata.etag },
        body: JSON.stringify({ publicationStatus: 'published' }),
      },
    ));
    assert.equal(prematurePublication.status, 409);
    assert.equal(prematurePublication.body.error.code, 'APPROVAL_REQUIRED');

    const approved = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': editedMetadata.etag },
      body: JSON.stringify({ approvalStatus: 'approved' }),
    }));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.publicationStatus, 'draft');
    assert.equal('sourceRecord' in approved.body.data, false);
    assert.equal(Object.hasOwn(approved.body.data, '_version'), false);

  });

  await withServer(publicApi, async (baseUrl) => {
    const response = await json(await fetch(`${baseUrl}/api/v1/catalog/items`));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  await withServer(admin, async (baseUrl) => {
    const current = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`));
    assert.equal(current.status, 200);
    const published = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/publication`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': current.etag },
      body: JSON.stringify({ publicationStatus: 'published' }),
    }));
    assert.equal(published.status, 200);
    assert.equal(published.body.data.approvalStatus, 'approved');
  });

  await withServer(publicApi, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}/api/v1/catalog/items`));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, [{
      id: contentId,
      kind: 'movie',
      title: 'فیلم آزمایشی',
      countries: [{ id: 'IR', labelFa: 'ایران' }],
      genres: [],
    }]);
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes('synthetic-source-file-id'), false);
    assert.equal(serialized.includes('approvalStatus'), false);
    assert.equal(serialized.includes('publicationStatus'), false);
  });

  await withServer(admin, async (baseUrl) => {
    const current = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`));
    const rejected = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': current.etag },
      body: JSON.stringify({ approvalStatus: 'rejected' }),
    }));
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.publicationStatus, 'published');
  });
  await withServer(publicApi, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}/api/v1/catalog/items`));
    assert.deepEqual(result.body.data, []);
  });
});

test('admin API creates and edits categories and country/genre taxonomy with validation', async () => {
  const store = createStore();
  const app = createAdminApi(store);
  await withServer(app, async (baseUrl) => {
    const categoryUrl = `${baseUrl}${ADMIN_PATH}/categories/iranian-movies`;
    const category = {
      slug: 'iranian-movies',
      localizedTitle: { fa: 'فیلم ایرانی' },
      enabled: true,
      sortOrder: 10,
      filters: { all: [
        { field: 'kind', op: 'eq', value: 'movie' },
        { field: 'countryIds', op: 'contains', value: 'IR' },
      ] },
    };
    const created = await json(await fetch(categoryUrl, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify(category),
    }));
    assert.equal(created.status, 201);
    const updated = await json(await fetch(categoryUrl, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': created.etag },
      body: JSON.stringify({ ...category, sortOrder: 20 }),
    }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.sortOrder, 20);
    const fetchedCategory = await json(await fetch(categoryUrl));
    assert.equal(fetchedCategory.status, 200);
    assert.equal(fetchedCategory.body.data.slug, 'iranian-movies');
    assert.notEqual(fetchedCategory.etag, created.etag);

    const invalidCategory = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/bad-category`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({ ...category, filters: { field: 'secretField', op: 'eq', value: 'x' } }),
    }));
    assert.equal(invalidCategory.status, 400);

    const duplicateSlug = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/other-category`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify(category),
    }));
    assert.equal(duplicateSlug.status, 409);

    const newCountry = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country/US`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({ labelFa: 'آمریکا', enabled: false, sortOrder: 2 }),
    }));
    assert.equal(newCountry.status, 201);
    const fetchedCountry = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country/US`));
    assert.equal(fetchedCountry.status, 200);
    assert.equal(fetchedCountry.body.data.enabled, false);
    const updatedCountry = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country/US`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': fetchedCountry.etag },
      body: JSON.stringify({ labelFa: 'آمریکا', enabled: true, sortOrder: 2 }),
    }));
    assert.equal(updatedCountry.status, 200);
    assert.notEqual(updatedCountry.etag, fetchedCountry.etag);
    const countries = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country`));
    assert.equal(countries.status, 200);
    assert.deepEqual(countries.body.data.map(({ id }) => id).sort(), ['IR', 'US']);
    assert.equal(countries.body.data.find(({ id }) => id === 'US').enabled, true);

    const newGenre = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/genre/comedy`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({ labelFa: 'کمدی', enabled: true }),
    }));
    assert.equal(newGenre.status, 201);
    const fetchedGenre = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/genre/comedy`));
    assert.equal(fetchedGenre.status, 200);
    assert.equal(fetchedGenre.body.data.labelFa, 'کمدی');
    const invalidType = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/language`));
    assert.equal(invalidType.status, 400);

    const deleteAttempt = await json(await fetch(categoryUrl, { method: 'DELETE' }));
    assert.equal(deleteAttempt.status, 428);
    assert.equal((await store.listCategories()).length, 1);
  });
});

test('only one concurrent write using the same ETag succeeds', async () => {
  const store = createStore();
  const app = createAdminApi(store);
  await withServer(app, async (baseUrl) => {
    const metadataUrl = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`;
    const missingCreatePrecondition = await json(await fetch(metadataUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: ['drama'],
      }),
    }));
    assert.equal(missingCreatePrecondition.status, 428);

    const created = await json(await fetch(metadataUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: ['drama'],
      }),
    }));
    assert.equal(created.status, 201);

    const approvalUrl = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/approval`;
    const responses = await Promise.all([
      fetch(approvalUrl, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': created.etag },
        body: JSON.stringify({ approvalStatus: 'approved' }),
      }),
      fetch(approvalUrl, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': created.etag },
        body: JSON.stringify({ approvalStatus: 'rejected' }),
      }),
    ]);
    const statuses = responses.map(({ status }) => status).sort((left, right) => left - right);
    assert.deepEqual(statuses, [200, 412]);
    assert.equal((await store.getContentMetadataWithVersion(contentId)).version, 2);
  });
});

test('source editor API exposes all sheet columns, allows identity changes, and creates sheet rows', async () => {
  const store = createStore();
  const item = {
    id: contentId, kind: 'movie', systemCode: 'admin-fixture-1',
    sourceVersion: 'a'.repeat(43),
    headers: ['کد سیستم', 'اسم فیلم', 'سال', 'Telegram File ID'],
    record: { 'کد سیستم': 'admin-fixture-1', 'اسم فیلم': 'عنوان قدیمی', 'سال': '2020', 'Telegram File ID': 'file-secret' },
  };
  let created = null;
  const contentReader = {
    async getItemSource(id) { return id === item.id ? structuredClone(item) : null; },
    async getSheetSchema(kind) { return { kind, sheetName: kind === 'movie' ? 'سینمایی' : 'سریال', headers: item.headers }; },
    async updateItemSource(id, options) {
      assert.equal(id, contentId);
      assert.equal(options.sourceVersion, 'a'.repeat(43));
      assert.equal(options.actorId, 'fixture-admin');
      Object.assign(item.record, options.fields);
      if (options.fields['کد سیستم']) {
        item.systemCode = options.fields['کد سیستم'];
        item.id = `movie:${encodeURIComponent(item.systemCode)}`;
      }
      item.sourceVersion = 'b'.repeat(43);
      return structuredClone(item);
    },
    async createItemSource(kind, fields) {
      created = { kind, fields };
      return { id: `${kind}:new-record`, kind, systemCode: fields['کد سیستم'], record: fields };
    },
  };
  const app = createCatalogAdminApi({
    writableProvider: store, contentReader,
    verifyAdminPrincipal: () => ({ authenticated: true, subjectId: 'fixture-admin' }),
    roleProvider: createInMemoryCatalogAdminRoleProvider({ 'fixture-admin': ['administrator'] }),
    authorizePermission: roleAuthorizer,
  });
  await withServer(app, async (baseUrl) => {
    const read = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/source`));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.record['Telegram File ID'], 'file-secret');

    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/source`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceVersion: 'a'.repeat(43), fields: { 'اسم فیلم': 'عنوان تازه', 'Telegram File ID': 'new-file-id' } }),
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.data.record['Telegram File ID'], 'new-file-id');

    assert.equal(result.body.data.id, 'movie:changed');
    const invalid = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(item.id)}/source`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceVersion: 'b'.repeat(43), fields: { 'کد سیستم': '' } }),
    }));
    assert.equal(invalid.status, 400);

    const schema = await json(await fetch(`${baseUrl}${ADMIN_PATH}/source-schema/movie`));
    assert.equal(schema.status, 200);
    const add = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/source`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', fields: { 'کد سیستم': 'new-record', 'اسم فیلم': 'فیلم تازه', 'سال': '2025', 'Telegram File ID': 'new-file' } }),
    }));
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal(created.fields['Telegram File ID'], 'new-file');
  });
});


test('category and taxonomy delete endpoints require current ETags and call guarded provider deletes', async () => {
  const base = createStore({
    categories: [{ id: 'remove-category', slug: 'remove-category', localizedTitle: { fa: 'حذف آزمایشی' }, enabled: true }],
  });
  const writableProvider = {
    ...base,
    async deleteCategory(id, options) {
      const current = await base.getCategoryWithVersion(id);
      if (!current || current.version !== options.expectedVersion) throw Object.assign(new Error(), { code: 'VERSION_CONFLICT' });
      return { value: current.value, version: current.version + 1 };
    },
    async deleteTaxonomyTerm(type, id, options) {
      const current = await base.getTaxonomyTermWithVersion(type, id);
      if (!current || current.version !== options.expectedVersion) throw Object.assign(new Error(), { code: 'VERSION_CONFLICT' });
      return { value: current.value, version: current.version + 1 };
    },
  };
  const app = createAdminApi(writableProvider);
  await withServer(app, async (baseUrl) => {
    const category = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/remove-category`));
    assert.equal(category.status, 200);
    const removedCategory = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/remove-category`, {
      method: 'DELETE', headers: { 'If-Match': category.etag },
    }));
    assert.equal(removedCategory.status, 200);
    assert.equal(removedCategory.body.data.deleted, true);

    const country = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country/IR`));
    assert.equal(country.status, 200);
    const removedCountry = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country/IR`, {
      method: 'DELETE', headers: { 'If-Match': country.etag },
    }));
    assert.equal(removedCountry.status, 200);
    assert.equal(removedCountry.body.data.deleted, true);
  });
});

test('bulk approval and publication process selected records independently with approval gating', async () => {
  const secondId = createCatalogContentId('series', 'admin-fixture-2');
  const store = createStore({ contentMetadata: [
    { contentId, approvalStatus: 'pending', publicationStatus: 'draft' },
    { contentId: secondId, approvalStatus: 'pending', publicationStatus: 'draft' },
  ] });
  const app = createAdminApi(store);
  await withServer(app, async (baseUrl) => {
    const approved = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/bulk/approval`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentIds: [contentId, secondId], approvalStatus: 'approved' }),
    }));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.meta.succeeded, 2);
    assert.equal(approved.body.meta.failed, 0);
    assert.equal((await store.getContentMetadata(contentId)).approvalStatus, 'approved');

    const published = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/bulk/publication`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentIds: [contentId, secondId], publicationStatus: 'published' }),
    }));
    assert.equal(published.status, 200);
    assert.equal(published.body.meta.succeeded, 2);
    assert.equal((await store.getContentMetadata(secondId)).publicationStatus, 'published');
  });
});

test('bulk publication reports unapproved and missing metadata items without aborting the batch', async () => {
  const secondId = createCatalogContentId('series', 'admin-fixture-2');
  const store = createStore({ contentMetadata: [
    { contentId, approvalStatus: 'pending', publicationStatus: 'draft' },
  ] });
  const app = createAdminApi(store);
  await withServer(app, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/bulk/publication`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentIds: [contentId, secondId], publicationStatus: 'published' }),
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.meta.succeeded, 0);
    assert.equal(result.body.meta.failed, 2);
    assert.deepEqual(result.body.data.map((item) => item.code), ['APPROVAL_REQUIRED', 'METADATA_REQUIRED']);
  });
});

test('in-memory writer rejects duplicate keys, invalid metadata and disabling referenced taxonomy', async () => {
  assert.throws(() => createInMemoryWritableCatalogMetadataProvider({
    contentMetadata: [
      { contentId, approvalStatus: 'pending', publicationStatus: 'draft' },
      { contentId, approvalStatus: 'approved', publicationStatus: 'draft' },
    ],
  }), /Catalog update conflicts/);

  const store = createStore({
    contentMetadata: [{
      contentId,
      approvalStatus: 'approved',
      publicationStatus: 'draft',
      countryIds: ['IR'],
    }],
  });
  await assert.rejects(
    store.upsertContentMetadata(contentId, {
      contentId: createCatalogContentId('series', 'different'),
      approvalStatus: 'approved',
      publicationStatus: 'draft',
    }),
    /Invalid catalog input/,
  );
  await assert.rejects(
    store.upsertTaxonomyTerm('country', 'IR', { labelFa: 'ایران', enabled: false }),
    /Catalog update conflicts/,
  );
});

test('legacy HTTP bootstrap route is not exposed', async () => {
  const store = createStore();
  const roleProvider = {
    async resolveRoles() { return []; },
  };
  const app = createCatalogAdminApi({
    writableProvider: store,
    verifyAdminPrincipal: async () => ({ authenticated: true, subjectId: 'fixture-admin' }),
    roleProvider,
    authorizePermission: roleAuthorizer,
  });
  await withServer(app, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'not-used' }),
    }));
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'NOT_FOUND');
  });
});

function createManagerRoleProvider({ initial = [], failAudit = false } = {}) {
  const assignments = new Map(initial.map((assignment) => [assignment.subjectId, structuredClone(assignment)]));
  const auditEvents = [];
  return {
    auditEvents,
    async resolveRoles(subjectId) {
      const assignment = assignments.get(subjectId);
      return assignment?.active ? [...assignment.roles] : [];
    },
    async listAssignments({ activeOnly = false } = {}) {
      return [...assignments.values()]
        .filter((assignment) => !activeOnly || assignment.active)
        .map((assignment) => structuredClone(assignment));
    },
    async getAssignment(subjectId) {
      const assignment = assignments.get(subjectId);
      return assignment ? structuredClone(assignment) : null;
    },
    async changeAssignment(options) {
      const current = assignments.get(options.targetSubjectId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== options.expectedVersion) {
        const error = new Error('version conflict');
        error.code = 'VERSION_CONFLICT';
        throw error;
      }
      const currentRoles = current?.roles ?? [];
      const sameRoles = currentRoles.length === options.roles.length &&
        options.roles.every((role) => currentRoles.includes(role));
      if (current?.active && options.active && sameRoles) {
        const error = new Error('no change');
        error.code = 'NO_CHANGE';
        throw error;
      }
      const activeAdministrators = [...assignments.values()].filter((item) =>
        item.active && item.roles.includes('administrator')).length;
      const wasAdministrator = Boolean(current?.active && currentRoles.includes('administrator'));
      const remainsAdministrator = Boolean(options.active && options.roles.includes('administrator'));
      if (wasAdministrator && !remainsAdministrator && activeAdministrators <= 1) {
        const error = new Error('last administrator');
        error.code = 'LAST_ADMINISTRATOR';
        throw error;
      }
      if (failAudit) throw new Error('audit failure');
      const next = {
        subjectId: options.targetSubjectId,
        roles: [...options.roles],
        active: options.active,
        version: actualVersion + 1,
      };
      assignments.set(next.subjectId, next);
      const isSubset = currentRoles.length > options.roles.length &&
        options.roles.every((role) => currentRoles.includes(role));
      auditEvents.push({
        operation: !current ? 'assignment.created'
          : (!current.active && options.active ? 'assignment.reactivated'
            : (!options.active ? 'assignment.disabled' : (isSubset ? 'role.revoked' : 'roles.changed'))),
        actorId: options.actorId,
        rolesBefore: [...currentRoles],
        rolesAfter: [...options.roles],
      });
      return { version: next.version, eventId: `event-${auditEvents.length}` };
    },
  };
}

test('owner-only manager API adds, lists, and revokes managers with audit and preconditions', async () => {
  const roleProvider = createManagerRoleProvider({
    initial: [{ subjectId: 'first-admin', roles: ['administrator'], active: true, version: 1 }],
  });
  const app = createAdminApi(createStore(), {
    subjectId: 'owner-user',
    roleProvider,
    authorizeOwner: (principal) => principal.subjectId === 'owner-user',
    targetResolver: async (email) => email === 'new-admin@example.com' ? 'new-admin' : 'bad uid',
    resolveManagerEmail: async (subjectId) => `${subjectId}@example.com`,
  });
  await withServer(app, async (baseUrl) => {
    const added = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new-admin@example.com', roles: ['observer'] }),
    }));
    assert.equal(added.status, 201);
    assert.equal(added.body.data.subjectId, 'new-admin');
    assert.equal(added.body.data.reactivated, false);
    assert.equal(roleProvider.auditEvents[0].operation, 'assignment.created');

    const roleEtag = `"catalog-v1.${Buffer.from('manager:new-admin').toString('base64url')}.v1"`;
    const changedRoles = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/new-admin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': roleEtag },
      body: JSON.stringify({ roles: ['editor', 'approver'] }),
    }));
    assert.equal(changedRoles.status, 200);
    assert.deepEqual(changedRoles.body.data.roles, ['editor', 'approver']);
    assert.equal(changedRoles.body.data.version, 2);
    assert.equal(roleProvider.auditEvents[1].operation, 'roles.changed');

    const listed = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`));
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.data.map((item) => item.subjectId), ['first-admin', 'new-admin']);
    assert.deepEqual(listed.body.data.map((item) => item.email), [
      'first-admin@example.com', 'new-admin@example.com',
    ]);

    const etag = `"catalog-v1.${Buffer.from('manager:new-admin').toString('base64url')}.v2"`;
    const revoked = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/new-admin`, {
      method: 'DELETE', headers: { 'if-match': etag },
    }));
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.active, false);
    assert.equal(roleProvider.auditEvents[2].operation, 'assignment.disabled');

    const reactivated = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new-admin@example.com', roles: ['observer'] }),
    }));
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.active, true);
    assert.equal(reactivated.body.data.reactivated, true);
    assert.equal(reactivated.body.data.version, 4);
    assert.deepEqual(reactivated.body.data.roles, ['editor', 'approver']);
    assert.equal(roleProvider.auditEvents[3].operation, 'assignment.reactivated');
  });
});

test('manager list fails safely when an injected Firebase email lookup fails', async () => {
  const roleProvider = createManagerRoleProvider({
    initial: [{ subjectId: 'first-admin', roles: ['administrator'], active: true, version: 1 }],
  });
  const app = createAdminApi(createStore(), {
    subjectId: 'owner-user', roleProvider, authorizeOwner: () => true,
    resolveManagerEmail: async () => { throw Object.assign(new Error('hidden'), { code: 'MANAGER_EMAIL_LOOKUP_FAILED' }); },
  });
  await withServer(app, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'MANAGER_EMAIL_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result.body), /hidden|first-admin/);
  });
});

test('manager API denies non-owner administrators and rejects duplicate, invalid, stale, and last-admin changes', async () => {
  const roleProvider = createManagerRoleProvider({
    initial: [{ subjectId: 'only-admin', roles: ['administrator'], active: true, version: 1 }],
  });
  const app = createAdminApi(createStore(), {
    subjectId: 'administrator-user',
    roleProvider,
    authorizeOwner: () => false,
    targetResolver: async () => 'new-admin',
  });
  await withServer(app, async (baseUrl) => {
    const denied = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'OWNER_REQUIRED');
  });

  const ownerApp = createAdminApi(createStore(), {
    subjectId: 'owner-user', roleProvider,
    authorizeOwner: () => true,
    targetResolver: async (email) => email === 'bad@example.com' ? 'bad uid' : 'only-admin',
  });
  await withServer(ownerApp, async (baseUrl) => {
    const duplicate = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'existing@example.com' }),
    }));
    assert.equal(duplicate.status, 409);
    const invalid = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bad@example.com' }),
    }));
    assert.equal(invalid.status, 400);
    const etag = `"catalog-v1.${Buffer.from('manager:only-admin').toString('base64url')}.v1"`;
    const last = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/only-admin`, {
      method: 'DELETE', headers: { 'if-match': etag },
    }));
    assert.equal(last.status, 409);
    assert.equal(last.body.error.code, 'LAST_ADMINISTRATOR');
    const stale = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/only-admin`, {
      method: 'DELETE', headers: { 'if-match': `"catalog-v1.${Buffer.from('manager:only-admin').toString('base64url')}.v9"` },
    }));
    assert.equal(stale.status, 412);
  });
});


test('manager role API validates role sets, requires current ETag, and records role revocation', async () => {
  const roleProvider = createManagerRoleProvider({
    initial: [
      { subjectId: 'first-admin', roles: ['administrator'], active: true, version: 1 },
      { subjectId: 'managed-admin', roles: ['administrator', 'editor'], active: true, version: 1 },
    ],
  });
  const app = createAdminApi(createStore(), {
    subjectId: 'owner-user', roleProvider, authorizeOwner: () => true,
  });
  const etag = `"catalog-v1.${Buffer.from('manager:managed-admin').toString('base64url')}.v1"`;
  await withServer(app, async (baseUrl) => {
    const missingPrecondition = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/managed-admin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['editor'] }),
    }));
    assert.equal(missingPrecondition.status, 428);

    const invalidRole = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/managed-admin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ roles: ['unknown'] }),
    }));
    assert.equal(invalidRole.status, 400);

    const emptyRoles = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/managed-admin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ roles: [] }),
    }));
    assert.equal(emptyRoles.status, 400);

    const changed = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/managed-admin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ roles: ['editor'] }),
    }));
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.data.roles, ['editor']);
    assert.equal(roleProvider.auditEvents[0].operation, 'role.revoked');

    const stale = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/managed-admin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ roles: ['publisher'] }),
    }));
    assert.equal(stale.status, 412);
  });
});

test('manager role API cannot remove administrator role from the last active administrator', async () => {
  const roleProvider = createManagerRoleProvider({
    initial: [{ subjectId: 'only-admin', roles: ['administrator', 'editor'], active: true, version: 1 }],
  });
  const app = createAdminApi(createStore(), {
    subjectId: 'owner-user', roleProvider, authorizeOwner: () => true,
  });
  const etag = `"catalog-v1.${Buffer.from('manager:only-admin').toString('base64url')}.v1"`;
  await withServer(app, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/only-admin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ roles: ['editor'] }),
    }));
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'LAST_ADMINISTRATOR');
    assert.deepEqual((await roleProvider.getAssignment('only-admin')).roles, ['administrator', 'editor']);
  });
});

test('owner cannot revoke administrator role or disable the configured owner account', async () => {
  const roleProvider = createManagerRoleProvider({
    initial: [
      { subjectId: 'owner-user', roles: ['administrator', 'editor'], active: true, version: 1 },
      { subjectId: 'backup-admin', roles: ['administrator'], active: true, version: 1 },
    ],
  });
  const app = createAdminApi(createStore(), {
    subjectId: 'owner-user', roleProvider,
    authorizeOwner: (principal) => principal.subjectId === 'owner-user',
  });
  const etag = `"catalog-v1.${Buffer.from('manager:owner-user').toString('base64url')}.v1"`;
  await withServer(app, async (baseUrl) => {
    const roleChange = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/owner-user`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': etag },
      body: JSON.stringify({ roles: ['editor'] }),
    }));
    assert.equal(roleChange.status, 409);
    assert.equal(roleChange.body.error.code, 'OWNER_ADMIN_REQUIRED');

    const disable = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers/owner-user`, {
      method: 'DELETE',
      headers: { 'if-match': etag },
    }));
    assert.equal(disable.status, 409);
    assert.equal(disable.body.error.code, 'OWNER_ADMIN_REQUIRED');

    const owner = await roleProvider.getAssignment('owner-user');
    assert.equal(owner.active, true);
    assert.deepEqual(owner.roles, ['administrator', 'editor']);
  });
});

test('manager API rolls back when the injected role audit fails', async () => {
  const roleProvider = createManagerRoleProvider({ failAudit: true });
  const app = createAdminApi(createStore(), {
    subjectId: 'owner-user', roleProvider, authorizeOwner: () => true,
    targetResolver: async () => 'new-admin',
  });
  await withServer(app, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/managers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', roles: ['observer'] }),
    }));
    assert.equal(result.status, 500);
    assert.equal((await roleProvider.listAssignments()).length, 0);
    assert.equal(roleProvider.auditEvents.length, 0);
  });
});

test('direct category writes stay disabled when the server flag is false', async () => {
  const app = createAdminApi(createStore(), { directCategoryWritesEnabled: false });
  await withServer(app, async (baseUrl) => {
    const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`;
    const result = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft', countryIds: [], genreIds: [],
        categoryIds: ['featured'],
      }),
    }));
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'FEATURE_DISABLED');
  });
});
