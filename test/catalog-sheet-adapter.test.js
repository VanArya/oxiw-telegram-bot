'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCatalogSheetAdapter } = require('../src/catalog-sheet-adapter');
const { categories } = require('./fixtures/catalog-fixtures');
const {
  createFixtureProvider,
  movieHeaders,
  seriesHeaders,
} = require('./fixtures/catalog-sheet-source-fixtures');

test('reads movie and series snapshots through the replaceable provider interface', async () => {
  const adapter = createCatalogSheetAdapter(createFixtureProvider());
  const results = await adapter.listItems();
  assert.deepEqual(
    results.map((item) => item.id).sort(),
    [
      'fixture-movie-invalid-country',
      'fixture-movie-ir',
      'fixture-movie-unknown-country',
      'fixture-movie-us',
      'fixture-series-ir',
      'fixture-series-us',
    ].sort(),
  );
  assert.equal(results.find((item) => item.id === 'fixture-series-ir').kind, 'series');
  assert.equal(results.find((item) => item.id === 'fixture-movie-ir').kind, 'movie');
});

test('uses existing Core category filters for Iranian movies and series', async () => {
  const adapter = createCatalogSheetAdapter(createFixtureProvider());
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  const seriesCategory = categories.find((category) => category.slug === 'iranian-series');
  assert.deepEqual(
    (await adapter.listCategoryItems(movieCategory)).map((item) => item.id),
    ['fixture-movie-ir'],
  );
  assert.deepEqual(
    (await adapter.listCategoryItems(seriesCategory)).map((item) => item.id),
    ['fixture-series-ir'],
  );
});

test('legacy rows without country remain readable but stay out of Iranian categories', async () => {
  const legacyHeaders = ['کد سیستم', 'اسم فیلم', 'سال'];
  const legacyProvider = createFixtureProvider({
    'سینمایی': { headers: legacyHeaders, rows: [['legacy-movie-1', 'فیلم قدیمی', '2010']] },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  const adapter = createCatalogSheetAdapter(legacyProvider);
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  assert.deepEqual(await adapter.listItems(), []);
  assert.deepEqual(await adapter.listCategoryItems(movieCategory), []);
});

test('missing, draft, and unknown publication states are excluded', async () => {
  const adapter = createCatalogSheetAdapter(createFixtureProvider());
  const results = await adapter.listItems();
  const ids = results.map((item) => item.id);
  assert.equal(ids.includes('fixture-movie-draft'), false);
  assert.equal(ids.includes('fixture-movie-unknown-status'), false);

  const noStatusProvider = createFixtureProvider({
    'سینمایی': {
      headers: movieHeaders.filter((header) => header !== 'وضعیت انتشار'),
      rows: [['unknown-status-movie', 'فیلم بدون وضعیت', '2020', 'IR', 'fake-file']],
    },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  assert.deepEqual(await createCatalogSheetAdapter(noStatusProvider).listItems(), []);
});

test('missing required columns and incomplete rows fail with structural errors', async () => {
  const missingColumnProvider = createFixtureProvider({
    'سینمایی': { headers: ['اسم فیلم', 'وضعیت انتشار'], rows: [['فیلم', 'published']] },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  await assert.rejects(
    createCatalogSheetAdapter(missingColumnProvider).listItems(),
    /Missing required headers in سینمایی/,
  );

  const incompleteRowProvider = createFixtureProvider({
    'سینمایی': { headers: movieHeaders, rows: [['', 'عنوان', '2020', 'IR', 'published', 'fake']] },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  await assert.rejects(
    createCatalogSheetAdapter(incompleteRowProvider).listItems(),
    /Invalid catalog row in سینمایی at index 0/,
  );
});

test('invalid country values cannot match Iranian categories', async () => {
  const provider = createFixtureProvider({
    'سینمایی': {
      headers: movieHeaders,
      rows: [['bad-country', 'فیلم ساختگی', '2020', 'IR|ZZ', 'published', 'fake-file']],
    },
    'سریال': { headers: seriesHeaders, rows: [] },
  });
  const adapter = createCatalogSheetAdapter(provider);
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  const results = await adapter.listItems();
  assert.deepEqual(results.map((item) => item.id), ['bad-country']);
  assert.equal(results[0].countries, undefined);
  assert.deepEqual(await adapter.listCategoryItems(movieCategory), []);
});

test('public DTOs do not expose raw rows, Telegram file IDs, or mapper internals', async () => {
  const results = await createCatalogSheetAdapter(createFixtureProvider()).listItems();
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
  const result = await createCatalogSheetAdapter(replacementProvider).listItems();
  assert.equal(calls, 2);
  assert.deepEqual(result, [{ id: 'replacement-movie', kind: 'movie', title: 'فیلم منبع جایگزین' }]);
});

test('provider contract is checked when the adapter is created', () => {
  assert.throws(() => createCatalogSheetAdapter({}), /Provider must implement readSheet/);
});
