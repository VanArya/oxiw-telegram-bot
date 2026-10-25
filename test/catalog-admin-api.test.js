'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createCatalogAdminApi } = require('../src/catalog-admin-api');
const { createCatalogApi } = require('../src/catalog-api');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const {
  createInMemoryWritableCatalogMetadataProvider,
} = require('../src/in-memory-writable-catalog-metadata-provider');

const ADMIN_PATH = '/api/v1/admin/catalog';
const contentId = createCatalogContentId('movie', 'admin-fixture-1');
const countryFixture = { id: 'IR', labelFa: 'ایران', enabled: true };
const genreFixture = { id: 'drama', labelFa: 'درام', enabled: true };

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
  return { status: response.status, body: await response.json() };
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

  const denied = createCatalogAdminApi({
    writableProvider: store,
    authorizeAdmin: async () => false,
  });
  await withServer(denied, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'FORBIDDEN');
  });

  const throwing = createCatalogAdminApi({
    writableProvider: store,
    authorizeAdmin: () => { throw new Error('synthetic-private-authorizer-detail'); },
  });
  await withServer(throwing, async (baseUrl) => {
    const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(result.body).includes('synthetic-private-authorizer-detail'), false);
  });
});

test('metadata approval and publication are separate and only their approved/published pair is public', async () => {
  const store = createStore();
  const admin = createCatalogAdminApi({ writableProvider: store, authorizeAdmin: () => true });
  const publicApi = createCatalogApi({ provider: sheetProvider, metadataProvider: store });

  await withServer(admin, async (baseUrl) => {
    const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/metadata`;
    const created = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: ['drama'],
      }),
    }));
    assert.equal(validCreated.status, 201);

    const fetchedMetadata = await json(await fetch(url));
    assert.equal(fetchedMetadata.status, 200);
    assert.equal(fetchedMetadata.body.data.approvalStatus, 'pending');
    const editedMetadata = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'draft',
        countryIds: ['IR'], genreIds: [],
      }),
    }));
    assert.equal(editedMetadata.status, 200);
    assert.deepEqual(editedMetadata.body.data.genreIds, []);

    const invalidCombinedStatus = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalStatus: 'pending', publicationStatus: 'published',
        countryIds: ['IR'], genreIds: ['drama'],
      }),
    }));
    assert.equal(invalidCombinedStatus.status, 409);
    assert.equal(invalidCombinedStatus.body.error.code, 'APPROVAL_REQUIRED');

    const prematurePublication = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/publication`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicationStatus: 'published' }),
      },
    ));
    assert.equal(prematurePublication.status, 409);
    assert.equal(prematurePublication.body.error.code, 'APPROVAL_REQUIRED');

    const approved = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalStatus: 'approved' }),
    }));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.publicationStatus, 'draft');
    assert.equal('sourceRecord' in approved.body.data, false);

  });

  await withServer(publicApi, async (baseUrl) => {
    const response = await json(await fetch(`${baseUrl}/api/v1/catalog/items`));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  await withServer(admin, async (baseUrl) => {
    const published = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/publication`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
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
    const rejected = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(contentId)}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
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
  const app = createCatalogAdminApi({ writableProvider: store, authorizeAdmin: () => true });
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
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(category),
    }));
    assert.equal(created.status, 201);
    const updated = await json(await fetch(categoryUrl, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...category, sortOrder: 20 }),
    }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.sortOrder, 20);
    const fetchedCategory = await json(await fetch(categoryUrl));
    assert.equal(fetchedCategory.status, 200);
    assert.equal(fetchedCategory.body.data.slug, 'iranian-movies');

    const invalidCategory = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/bad-category`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...category, filters: { field: 'secretField', op: 'eq', value: 'x' } }),
    }));
    assert.equal(invalidCategory.status, 400);

    const duplicateSlug = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/other-category`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(category),
    }));
    assert.equal(duplicateSlug.status, 409);

    const newCountry = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country/US`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labelFa: 'آمریکا', enabled: false, sortOrder: 2 }),
    }));
    assert.equal(newCountry.status, 201);
    const fetchedCountry = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country/US`));
    assert.equal(fetchedCountry.status, 200);
    assert.equal(fetchedCountry.body.data.enabled, false);
    const countries = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/country`));
    assert.equal(countries.status, 200);
    assert.deepEqual(countries.body.data.map(({ id }) => id).sort(), ['IR', 'US']);
    assert.equal(countries.body.data.find(({ id }) => id === 'US').enabled, false);

    const newGenre = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/genre/comedy`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labelFa: 'کمدی', enabled: true }),
    }));
    assert.equal(newGenre.status, 201);
    const fetchedGenre = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/genre/comedy`));
    assert.equal(fetchedGenre.status, 200);
    assert.equal(fetchedGenre.body.data.labelFa, 'کمدی');
    const invalidType = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/language`));
    assert.equal(invalidType.status, 400);

    const deleteAttempt = await json(await fetch(categoryUrl, { method: 'DELETE' }));
    assert.equal(deleteAttempt.status, 404);
    assert.equal((await store.listCategories()).length, 1);
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
