'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createCatalogApi } = require('../src/catalog-api');
const { categories } = require('./fixtures/catalog-fixtures');
const {
  createFixtureMetadataProvider,
  createFixtureProvider,
} = require('./fixtures/catalog-sheet-source-fixtures');

async function withApiServer(options, run) {
  const server = http.createServer(createCatalogApi(options));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }
}

async function jsonResponse(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

const options = () => ({
  provider: createFixtureProvider(),
  categories,
  metadataProvider: createFixtureMetadataProvider(),
});

test('lists only public fixture DTOs with supported filters and bounded pagination', async () => {
  await withApiServer(options(), async (baseUrl) => {
    const { response, body } = await jsonResponse(
      `${baseUrl}/api/v1/catalog/items?kind=movie&countryId=IR&page=1&pageSize=1`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.map((item) => item.id), ['movie:fixture-movie-ir']);
    assert.deepEqual(body.meta, {
      page: 1,
      pageSize: 1,
      total: 1,
      filtersApplied: { kind: 'movie', countryId: 'IR' },
    });
  });
});

test('exposes active season episodes and enabled download links only for public series', async () => {
  const seriesId = 'series:fixture-series-ir';
  const metadataProvider = createFixtureMetadataProvider({
    [seriesId]: {
      approvalStatus: 'approved',
      publicationStatus: 'published',
      lifecycleStatus: 'active',
      countryIds: ['IR'],
      genreIds: ['drama'],
    },
  });
  const structure = [{
    value: { seasonNumber: 1, title: 'فصل اول', lifecycleStatus: 'active' },
    version: 1,
    episodes: [{
      value: {
        episodeNumber: 1,
        title: 'قسمت اول',
        lifecycleStatus: 'active',
        downloadLinks: [
          { id: '720p', label: '720p', url: 'https://download.example/720', enabled: true, sortOrder: 0 },
          { id: '1080p', label: '1080p', url: 'https://download.example/1080', enabled: false, sortOrder: 1 },
        ],
      },
      version: 1,
    }],
  }];
  const seriesStructureProvider = {
    async listStructure(id, options) {
      assert.equal(id, seriesId);
      assert.equal(options.parentLifecycleStatus, 'active');
      return structure;
    },
  };
  await withApiServer({ ...options(), metadataProvider, seriesStructureProvider }, async (baseUrl) => {
    const { response, body } = await jsonResponse(
      `${baseUrl}/api/v1/catalog/items/${encodeURIComponent(seriesId)}/seasons`,
    );
    assert.equal(response.status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].episodes.length, 1);
    assert.deepEqual(body.data[0].episodes[0].downloadLinks.map((link) => link.label), ['720p']);
  });
});

test('rejects invalid and not-yet-supported filters without running them', async () => {
  await withApiServer(options(), async (baseUrl) => {
    for (const [query, expectedCode] of [
      ['kind=film', 'INVALID_FILTER'],
      ['countryId=ZZ', 'INVALID_FILTER'],
      ['year=1700', 'INVALID_FILTER'],
      ['kind=series&year=2020', 'INVALID_FILTER'],
      ['genreId=missing', 'INVALID_FILTER'],
      ['q=title', 'FILTER_NOT_READY'],
      ['unknown=value', 'INVALID_FILTER'],
      ['kind=movie&kind=series', 'INVALID_FILTER'],
    ]) {
      const { response, body } = await jsonResponse(
        `${baseUrl}/api/v1/catalog/items?${query}`,
      );
      assert.equal(response.status, 400, query);
      assert.equal(body.error.code, expectedCode, query);
      assert.equal(typeof body.error.requestId, 'string');
    }
  });
});

test('validates pagination and caps page size', async () => {
  await withApiServer(options(), async (baseUrl) => {
    const invalid = await jsonResponse(`${baseUrl}/api/v1/catalog/items?page=0`);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_PAGINATION');

    const tooLarge = await jsonResponse(`${baseUrl}/api/v1/catalog/items?pageSize=101`);
    assert.equal(tooLarge.response.status, 400);
    assert.equal(tooLarge.body.error.code, 'INVALID_PAGINATION');

    const secondPage = await jsonResponse(`${baseUrl}/api/v1/catalog/items?page=2&pageSize=2`);
    assert.equal(secondPage.response.status, 200);
    assert.equal(secondPage.body.meta.total, 6);
    assert.equal(secondPage.body.data.length, 2);
  });
});

test('details return published content but hide unpublished and unknown IDs identically', async () => {
  await withApiServer(options(), async (baseUrl) => {
    const found = await jsonResponse(`${baseUrl}/api/v1/catalog/items/series:fixture-series-ir`);
    assert.equal(found.response.status, 200);
    assert.equal(found.body.data.kind, 'series');

    const unpublished = await jsonResponse(`${baseUrl}/api/v1/catalog/items/movie:fixture-movie-draft`);
    const unknown = await jsonResponse(`${baseUrl}/api/v1/catalog/items/no-such-content`);
    assert.equal(unpublished.response.status, 404);
    assert.equal(unknown.response.status, 404);
    assert.equal(unpublished.body.error.code, 'NOT_FOUND');
    assert.equal(unknown.body.error.code, 'NOT_FOUND');
    assert.equal(unpublished.body.error.message, unknown.body.error.message);
  });
});

test('serves data-driven Iranian categories and only implemented taxonomy terms', async () => {
  await withApiServer(options(), async (baseUrl) => {
    const categoryResult = await jsonResponse(`${baseUrl}/api/v1/catalog/categories`);
    assert.equal(categoryResult.response.status, 200);
    assert.deepEqual(categoryResult.body.data.map((item) => item.slug), [
      'iranian-movies', 'iranian-series',
    ]);

    const taxonomies = await jsonResponse(`${baseUrl}/api/v1/catalog/taxonomies`);
    assert.equal(taxonomies.response.status, 200);
    assert.deepEqual(taxonomies.body.meta.availableTypes, ['country', 'genre']);
    assert.deepEqual(taxonomies.body.data.country.map((term) => term.id), ['IR', 'US']);
    assert.deepEqual(taxonomies.body.data.genre.map((term) => term.id), ['drama', 'comedy']);
  });
});

test('never serializes source rows, file IDs, secrets, or provider errors', async () => {
  await withApiServer(options(), async (baseUrl) => {
    const list = await jsonResponse(`${baseUrl}/api/v1/catalog/items`);
    const detail = await jsonResponse(`${baseUrl}/api/v1/catalog/items/movie:fixture-movie-ir`);
    const serialized = JSON.stringify([list.body, detail.body]);
    for (const forbidden of ['fake-file-', 'sourceRecord', 'Telegram File ID', 'token']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  const throwingProvider = {
    async readSheet() {
      throw new Error('private credential detail');
    },
  };
  await withApiServer({ provider: throwingProvider, categories }, async (baseUrl) => {
    const { response, body } = await jsonResponse(`${baseUrl}/api/v1/catalog/items`);
    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(body).includes('private credential detail'), false);
    assert.equal(JSON.stringify(body).includes('stack'), false);
  });
});

test('exposes no write or download operations', async () => {
  await withApiServer(options(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/catalog/items`, { method: 'POST' });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});
