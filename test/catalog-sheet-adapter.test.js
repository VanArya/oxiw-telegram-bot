'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCatalogSheetAdapter } = require('../src/catalog-sheet-adapter');
const { categories } = require('./fixtures/catalog-fixtures');
const {
  createFixtureMetadataProvider,
  createFixtureProvider,
  movieHeaders,
  seriesHeaders,
} = require('./fixtures/catalog-sheet-source-fixtures');
const { createCatalogContentId } = require('../src/catalog-content-identity');

const createAdapter = (provider = createFixtureProvider(), metadataProvider = createFixtureMetadataProvider()) =>
  createCatalogSheetAdapter(provider, { metadataProvider });

test('reads movie and series snapshots through the replaceable provider interface', async () => {
  const adapter = createAdapter();
  const results = await adapter.listItems();
  assert.deepEqual(
    results.map((item) => item.id).sort(),
    [
      'movie:fixture-movie-invalid-country',
      'movie:fixture-movie-ir',
      'movie:fixture-movie-unknown-country',
      'movie:fixture-movie-us',
      'series:fixture-series-ir',
      'series:fixture-series-us',
    ].sort(),
  );
  assert.equal(results.find((item) => item.id === 'series:fixture-series-ir').kind, 'series');
  assert.equal(results.find((item) => item.id === 'movie:fixture-movie-ir').kind, 'movie');
});

test('disabled published content is excluded from public catalog results', async () => {
  const disabledId = createCatalogContentId('movie', 'fixture-movie-ir');
  const metadata = createFixtureMetadataProvider({
    [disabledId]: {
      approvalStatus: 'approved',
      publicationStatus: 'published',
      lifecycleStatus: 'disabled',
      disabledAt: '2026-11-10T12:00:00.000Z',
      disabledBy: 'fixture-admin',
      countryIds: ['IR'],
      genreIds: ['drama'],
    },
  });
  const adapter = createAdapter(createFixtureProvider(), metadata);
  const results = await adapter.listItems();
  assert.equal(results.some((item) => item.id === disabledId), false);
});

test('uses existing Core category filters for Iranian movies and series', async () => {
  const adapter = createAdapter();
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  const seriesCategory = categories.find((category) => category.slug === 'iranian-series');
  assert.deepEqual(
    (await adapter.listCategoryItems(movieCategory)).map((item) => item.id),
    ['movie:fixture-movie-ir'],
  );
  assert.deepEqual(
    (await adapter.listCategoryItems(seriesCategory)).map((item) => item.id),
    ['series:fixture-series-ir'],
  );
});

test('legacy rows without country remain readable but stay out of Iranian categories', async () => {
  const legacyHeaders = ['کد سیستم', 'اسم فیلم', 'سال'];
  const legacyProvider = createFixtureProvider({
    'سینمایی': { headers: legacyHeaders, rows: [['legacy-movie-1', 'فیلم قدیمی', '2010']] },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  const adapter = createAdapter(legacyProvider);
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  assert.deepEqual(await adapter.listItems(), []);
  assert.deepEqual(await adapter.listCategoryItems(movieCategory), []);
});

test('missing metadata and non-public approval/publication states are excluded', async () => {
  const adapter = createAdapter();
  const results = await adapter.listItems();
  const ids = results.map((item) => item.id);
  assert.equal(ids.includes('movie:fixture-movie-draft'), false);
  assert.equal(ids.includes('movie:fixture-movie-unknown-status'), false);

  const noStatusProvider = createFixtureProvider({
    'سینمایی': {
      headers: movieHeaders.filter((header) => header !== 'وضعیت انتشار'),
      rows: [['unknown-status-movie', 'فیلم بدون وضعیت', '2020', 'IR', 'fake-file']],
    },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  assert.deepEqual(await createAdapter(noStatusProvider).listItems(), []);
});

test('legacy visibility or Sheet status cannot publish content without both metadata states', async () => {
  const provider = createFixtureProvider({
    'سینمایی': {
      headers: movieHeaders,
      rows: [['no-metadata', 'فیلم ساختگی', '2020', 'IR', 'published', 'private-file']],
    },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  const legacyVisibility = createFixtureMetadataProvider({
    [createCatalogContentId('movie', 'no-metadata')]: { visibility: 'approved' },
  });
  assert.deepEqual(await createCatalogSheetAdapter(provider, { metadataProvider: legacyVisibility }).listItems(), []);
});

test('missing required columns and incomplete rows fail with structural errors', async () => {
  const missingColumnProvider = createFixtureProvider({
    'سینمایی': { headers: ['اسم فیلم', 'وضعیت انتشار'], rows: [['فیلم', 'published']] },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  await assert.rejects(
    createAdapter(missingColumnProvider).listItems(),
    /Missing required headers in سینمایی/,
  );

  const incompleteRowProvider = createFixtureProvider({
    'سینمایی': { headers: movieHeaders, rows: [['', 'عنوان', '2020', 'IR', 'published', 'fake']] },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  await assert.rejects(
    createAdapter(incompleteRowProvider).listItems(),
    /Invalid catalog row in سینمایی at index 0/,
  );
});

test('mapping failures carry only safe sheet, row, and field diagnostics', async () => {
  const provider = createFixtureProvider({
    'سینمایی': {
      headers: movieHeaders,
      rows: [['', 'عنوان محرمانه', '2020', 'IR', 'published', 'private-file-id']],
    },
    'سریال': { headers: seriesHeaders, rows: [] },
  });

  await assert.rejects(createAdapter(provider).listItems(), (error) => {
    assert.equal(error.stage, 'sheet_row_mapping');
    assert.deepEqual(error.diagnosticContext, {
      sheetName: 'سینمایی',
      rowNumber: 2,
      field: 'system_code',
    });
    assert.equal(error.message.includes('عنوان محرمانه'), false);
    assert.equal(error.message.includes('private-file-id'), false);
    return true;
  });
});

test('country values in Sheet rows cannot supply metadata or classify content', async () => {
  const provider = createFixtureProvider({
    'سینمایی': {
      headers: movieHeaders,
      rows: [['bad-country', 'فیلم ساختگی', '2020', 'IR|ZZ', 'published', 'fake-file']],
    },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  const adapter = createAdapter(provider);
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  const results = await adapter.listItems();
  assert.deepEqual(results, []);
  assert.deepEqual(await adapter.listCategoryItems(movieCategory), []);
});

test('public DTOs do not expose raw rows, Telegram file IDs, or mapper internals', async () => {
  const results = await createAdapter().listItems();
  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes('fake-file-'), false);
  assert.equal(serialized.includes('sourceRecord'), false);
  assert.equal(serialized.includes('mappingWarnings'), false);
  assert.equal(serialized.includes('وضعیت انتشار'), false);
});

test('a replacement provider works without changing the Core or adapter', async () => {
  let calls = 0;
  const replacementProvider = {
    async readSheet(sheetName) {
      calls += 1;
      if (sheetName === 'سینمایی') {
        return {
          headers: ['کد سیستم', 'اسم فیلم', 'وضعیت انتشار'],
          rows: [['replacement-movie', 'فیلم منبع جایگزین', 'published']],
        };
      }
      return { headers: ['کد سیستم', 'اسم فیلم'], rows: [] };
    },
  };
  const result = await createAdapter(
    replacementProvider,
    createFixtureMetadataProvider({
      [createCatalogContentId('movie', 'replacement-movie')]: {
        approvalStatus: 'approved', publicationStatus: 'published',
      },
    }),
  ).listItems();
  assert.equal(calls, 2);
  assert.deepEqual(result, [{ id: 'movie:replacement-movie', kind: 'movie', title: 'فیلم منبع جایگزین' }]);
});

test('provider contract is checked when the adapter is created', () => {
  assert.throws(() => createCatalogSheetAdapter({}), /Provider must implement readSheet/);
});
