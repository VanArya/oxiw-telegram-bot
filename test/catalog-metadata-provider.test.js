'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createCatalogApi } = require('../src/catalog-api');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const { createCatalogSheetAdapter } = require('../src/catalog-sheet-adapter');
const { createInMemoryCatalogMetadataProvider } = require('../src/in-memory-catalog-metadata-provider');
const { categories } = require('./fixtures/catalog-fixtures');
const { createFixtureProvider } = require('./fixtures/catalog-sheet-source-fixtures');

const headers = ['کد سیستم', 'اسم فیلم', 'سال', 'کشور سازنده', 'وضعیت انتشار', 'Telegram File ID'];
const seriesHeaders = [...headers, 'سال شروع'];
const countries = [
  { id: 'IR', labelFa: 'ایران', enabled: true },
  { id: 'US', labelFa: 'ایالات متحده', enabled: true },
];
const genres = [
  { id: 'drama', labelFa: 'درام', enabled: true },
  { id: 'comedy', labelFa: 'کمدی', enabled: true },
];

function metadataFixture(overrides = {}) {
  return createInMemoryCatalogMetadataProvider({
    contentMetadata: {
      [createCatalogContentId('movie', 'shared-code')]: {
        approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['IR'], genreIds: ['drama'],
      },
      [createCatalogContentId('series', 'shared-code')]: {
        approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['US'], genreIds: ['comedy'],
      },
      [createCatalogContentId('series', 'series-ir')]: {
        approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['IR'], genreIds: ['drama'],
      },
      [createCatalogContentId('movie', 'movie-us')]: {
        approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['US'], genreIds: ['drama'],
      },
      [createCatalogContentId('movie', 'hidden')]: {
        approvalStatus: 'approved', publicationStatus: 'archived', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'unknown')]: {
        approvalStatus: 'unknown', publicationStatus: 'published', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'bad-country')]: {
        approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['ZZ'],
      },
      [createCatalogContentId('movie', 'bad-genre')]: {
        approvalStatus: 'approved', publicationStatus: 'published', genreIds: ['not-in-taxonomy'],
      },
      [createCatalogContentId('movie', 'pending')]: {
        approvalStatus: 'pending', publicationStatus: 'published', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'rejected')]: {
        approvalStatus: 'rejected', publicationStatus: 'published', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'draft')]: {
        approvalStatus: 'approved', publicationStatus: 'draft', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'publication-unknown')]: {
        approvalStatus: 'approved', publicationStatus: 'unknown', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'approval-missing')]: {
        publicationStatus: 'published', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'publication-missing')]: {
        approvalStatus: 'approved', countryIds: ['IR'],
      },
      [createCatalogContentId('movie', 'invalid-combination')]: {
        approvalStatus: 'published', publicationStatus: 'approved', countryIds: ['IR'],
      },
      ...overrides,
    },
    categories,
    taxonomies: { country: countries, genre: genres },
  });
}

function metadataSource(rows = {}, headerOverrides = {}) {
  return createFixtureProvider({
    'سینمایی': {
      headers: headerOverrides.movie || headers,
      rows: rows.movie || [
        ['shared-code', 'عنوان فیلم', '2020', 'US', 'published', 'synthetic-file-movie'],
        ['movie-us', 'فیلم آمریکایی', '2021', 'IR', 'published', 'synthetic-file-us'],
        ['hidden', 'عنوان پنهان', '2022', 'IR', 'published', 'synthetic-file-hidden'],
        ['unknown', 'عنوان نامشخص', '2023', 'IR', 'published', 'synthetic-file-unknown'],
        ['missing', 'بدون metadata', '2024', 'IR', 'published', 'synthetic-file-missing'],
        ['bad-country', 'کشور نامعتبر', '2020', 'IR', 'published', 'synthetic-file-bad-country'],
        ['bad-genre', 'ژانر نامعتبر', '2020', 'IR', 'published', 'synthetic-file-bad-genre'],
        ['pending', 'در انتظار تأیید', '2020', 'IR', 'published', 'synthetic-file-pending'],
        ['rejected', 'ردشده', '2020', 'IR', 'published', 'synthetic-file-rejected'],
        ['draft', 'پیش‌نویس', '2020', 'IR', 'published', 'synthetic-file-draft'],
        ['publication-unknown', 'انتشار نامعلوم', '2020', 'IR', 'published', 'synthetic-file-unknown-publication'],
        ['approval-missing', 'بدون تأیید', '2020', 'IR', 'published', 'synthetic-file-no-approval'],
        ['publication-missing', 'بدون انتشار', '2020', 'IR', 'published', 'synthetic-file-no-publication'],
        ['invalid-combination', 'ترکیب نامعتبر', '2020', 'IR', 'published', 'synthetic-file-invalid-combination'],
      ],
    },
    'سریال': {
      headers: headerOverrides.series || seriesHeaders,
      rows: rows.series || [
        ['shared-code', 'عنوان سریال', '2019', 'IR', 'published', 'synthetic-file-series', '2019'],
        ['series-ir', 'سریال ایرانی', '2018', 'US', 'published', 'synthetic-file-series-ir', '2018'],
      ],
    },
  });
}

async function withServer(options, run) {
  const server = http.createServer(createCatalogApi(options));
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

test('composite identity separates equal system codes across content kinds', async () => {
  const adapter = createCatalogSheetAdapter(metadataSource(), { metadataProvider: metadataFixture() });
  const items = await adapter.listItems();
  assert.deepEqual(items.map(({ id }) => id).sort(), [
    'movie:shared-code', 'movie:movie-us', 'series:shared-code',
    'series:series-ir',
  ].sort());
  assert.equal(items.find(({ id }) => id === 'movie:shared-code').countries[0].id, 'IR');
  assert.equal(items.find(({ id }) => id === 'series:shared-code').countries[0].id, 'US');
});
test('duplicate identities within one kind fail closed without exposing the code', async () => {
  const source = metadataSource({
    movie: [
      ['duplicate-code', 'عنوان اول', '2020', '', '', 'synthetic-file-1'],
      [' duplicate-code ', 'عنوان دوم', '2021', '', '', 'synthetic-file-2'],
    ],
    series: [],
  });
  await assert.rejects(
    createCatalogSheetAdapter(source, { metadataProvider: metadataFixture() }).listItems(),
    (error) => error.message.includes('Duplicate catalog identity') && !error.message.includes('duplicate-code'),
  );
});

test('empty or invalid system codes fail closed without entering public results', async () => {
  const empty = metadataSource({ movie: [['  ', 'عنوان', '2020', '', '', 'synthetic-file']], series: [] });
  await assert.rejects(
    createCatalogSheetAdapter(empty, { metadataProvider: metadataFixture() }).listItems(),
    /Invalid catalog row in سینمایی at index 0/,
  );
  assert.throws(() => createCatalogContentId('unknown-kind', 'code'), /Invalid content kind/);
  assert.throws(() => createCatalogContentId('movie', '   '), /Invalid system code/);
  assert.equal(createCatalogContentId('movie', 0), 'movie:0');
  assert.equal(createCatalogContentId('movie', '  A/B درصد  '), 'movie:A%2FB%20%D8%AF%D8%B1%D8%B5%D8%AF');
  assert.equal(createCatalogContentId('movie', ' cafe\u0301 '), 'movie:caf%C3%A9');
});

test('title edits and row reordering do not change the composite identity', async () => {
  const metadataProvider = metadataFixture();
  const first = createCatalogSheetAdapter(metadataSource({
    movie: [
      ['shared-code', 'عنوان پیشین', '2020', '', '', 'synthetic-file-1'],
      ['movie-us', 'عنوان دوم', '2021', '', '', 'synthetic-file-2'],
    ],
    series: [],
  }), { metadataProvider });
  const second = createCatalogSheetAdapter(metadataSource({
    movie: [
      ['movie-us', 'عنوان دوم', '2021', '', '', 'synthetic-file-2'],
      ['shared-code', 'عنوان تازه', '2020', '', '', 'synthetic-file-1'],
    ],
    series: [],
  }), { metadataProvider });
  const firstItems = await first.listItems();
  const secondItems = await second.listItems();
  assert.equal(firstItems.find(({ id }) => id === 'movie:shared-code').id,
    secondItems.find(({ title }) => title === 'عنوان تازه').id);
  assert.equal(secondItems[0].id, 'movie:movie-us');
});

test('missing, malformed, or non-public approval/publication metadata stays out of DTOs', async () => {
  const adapter = createCatalogSheetAdapter(metadataSource(), { metadataProvider: metadataFixture() });
  const items = await adapter.listItems();
  assert.deepEqual(items.map(({ id }) => id).sort(), [
    'movie:shared-code', 'movie:movie-us', 'series:shared-code', 'series:series-ir',
  ].sort());
  const rawRows = JSON.stringify(items);
  for (const privateValue of ['synthetic-file-', 'sourceRecord', 'hidden', 'unknown']) {
    assert.equal(rawRows.includes(privateValue), false);
  }
});

test('metadata under a legacy or wrong-kind key never attaches by raw code', async () => {
  const provider = createInMemoryCatalogMetadataProvider({
    contentMetadata: {
      'shared-code': { approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['IR'] },
      [createCatalogContentId('movie', 'shared-code')]: { visibility: 'approved', countryIds: ['IR'] },
    },
    categories,
    taxonomies: { country: countries, genre: genres },
  });
  const adapter = createCatalogSheetAdapter(metadataSource({
    movie: [['shared-code', 'فیلم', '2020', 'IR', 'published', 'private-file']], series: [],
  }), { metadataProvider: provider });
  assert.deepEqual(await adapter.listItems(), []);
});

test('metadata categories use Core DSL definitions for Iranian and foreign content', async () => {
  const provider = metadataFixture();
  const adapter = createCatalogSheetAdapter(metadataSource(), { metadataProvider: provider });
  const movieCategory = categories.find(({ slug }) => slug === 'iranian-movies');
  const seriesCategory = categories.find(({ slug }) => slug === 'iranian-series');
  assert.deepEqual((await adapter.listCategoryItems(movieCategory)).map(({ id }) => id), ['movie:shared-code']);
  assert.deepEqual((await adapter.listCategoryItems(seriesCategory)).map(({ id }) => id), ['series:series-ir']);

  const foreignCategory = {
    id: 'fixture-foreign-movies', slug: 'foreign-movies', enabled: true,
    localizedTitle: { fa: 'فیلم غیرایرانی' }, sortOrder: 30,
    filters: { all: [
      { field: 'kind', op: 'eq', value: 'movie' },
      { field: 'countryIds', op: 'contains', value: 'US' },
    ] },
  };
  const foreignProvider = createInMemoryCatalogMetadataProvider({
    contentMetadata: {
      [createCatalogContentId('movie', 'movie-us')]: {
        approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['US'],
      },
    },
    categories: [foreignCategory],
    taxonomies: { country: countries, genre: genres },
  });
  const foreignAdapter = createCatalogSheetAdapter(metadataSource({
    movie: [['movie-us', 'فیلم آمریکا', '2021', '', '', 'private-file']], series: [],
  }), { metadataProvider: foreignProvider });
  assert.deepEqual((await foreignAdapter.listCategoryItems(foreignCategory)).map(({ id }) => id), ['movie:movie-us']);
});

test('metadata-aware API exposes categories, taxonomies, genre filters, and category filters', async () => {
  const options = {
    provider: metadataSource(),
    metadataProvider: metadataFixture(),
  };
  await withServer(options, async (baseUrl) => {
    const categoriesResponse = await fetch(`${baseUrl}/api/v1/catalog/categories`);
    const categoriesBody = await categoriesResponse.json();
    assert.equal(categoriesBody.data.some(({ slug }) => slug === 'iranian-movies'), true);

    const taxonomyResponse = await fetch(`${baseUrl}/api/v1/catalog/taxonomies`);
    const taxonomyBody = await taxonomyResponse.json();
    assert.deepEqual(taxonomyBody.meta.availableTypes, ['country', 'genre']);
    assert.deepEqual(taxonomyBody.data.genre.map(({ id }) => id), ['drama', 'comedy']);

    const iranian = await fetch(`${baseUrl}/api/v1/catalog/items?category=iranian-movies`);
    const iranianBody = await iranian.json();
    assert.deepEqual(iranianBody.data.map(({ id }) => id), ['movie:shared-code']);

    const iranianSeries = await fetch(`${baseUrl}/api/v1/catalog/items?category=iranian-series`);
    const iranianSeriesBody = await iranianSeries.json();
    assert.deepEqual(iranianSeriesBody.data.map(({ id }) => id), ['series:series-ir']);

    const genre = await fetch(`${baseUrl}/api/v1/catalog/items?genreId=comedy`);
    const genreBody = await genre.json();
    assert.deepEqual(genreBody.data.map(({ id }) => id), ['series:shared-code']);

    const invalid = await fetch(`${baseUrl}/api/v1/catalog/items?genreId=unknown`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_FILTER');
  });
});

test('metadata provider errors are returned as generic API errors', async () => {
  const provider = {
    async getContentMetadata() { throw new Error('synthetic private metadata failure'); },
    async listCategories() { return categories; },
    async listTaxonomyTerms(type) { return type === 'country' ? countries : genres; },
  };
  await withServer({ provider: metadataSource(), metadataProvider: provider }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/catalog/items`);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(body).includes('synthetic private metadata failure'), false);
    assert.equal(JSON.stringify(body).includes('stack'), false);
  });
});
