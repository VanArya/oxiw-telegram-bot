'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCatalogAdminContentReader } = require('../src/catalog-admin-content-reader');
const { createInMemoryWritableCatalogMetadataProvider } = require('../src/in-memory-writable-catalog-metadata-provider');
const { createFixtureProvider, sheets } = require('./fixtures/catalog-sheet-source-fixtures');
const { createCatalogContentId } = require('../src/catalog-content-identity');

function makeReader({ source = sheets, contentMetadata = [], categories = [] } = {}) {
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata,
    categories,
    taxonomies: {
      country: [{ id: 'IR', labelFa: 'ایران', enabled: true }],
      genre: [{ id: 'drama', labelFa: 'درام', enabled: true }],
    },
  });
  return createCatalogAdminContentReader({
    sheetProvider: createFixtureProvider(source),
    writableProvider,
  });
}

test('admin content reader lists unpublished Sheet rows with metadata status and safe projection', async () => {
  const id = createCatalogContentId('movie', 'fixture-movie-ir');
  const reader = makeReader({
    contentMetadata: [{
      contentId: id,
      approvalStatus: 'approved',
      publicationStatus: 'draft',
      countryIds: ['IR'],
      genreIds: ['drama'],
    }],
  });
  const result = await reader.list(new URLSearchParams('page=1&pageSize=100'));
  assert.equal(result.meta.stats.total, 8);
  assert.equal(result.meta.stats.movies, 6);
  assert.equal(result.meta.stats.series, 2);
  assert.equal(result.meta.stats.missingMetadata, 7);
  const item = result.data.find((entry) => entry.id === id);
  assert.equal(item.approvalStatus, 'approved');
  assert.equal(item.publicationStatus, 'draft');
  assert.equal(item.hasMetadata, true);
  assert.deepEqual(item.countryIds, ['IR']);
  assert.equal(item.systemCode, 'fixture-movie-ir');
  assert.ok(result.data.some((entry) => entry.publicationStatus === 'unknown'));
  assert.equal(JSON.stringify(result).includes('fake-file-movie'), false);
  assert.equal(JSON.stringify(result).includes('Telegram File ID'), false);
  assert.equal(JSON.stringify(item).includes('sourceRecord'), false);
});

test('protected source reader returns every sheet column while normal list projection keeps file IDs private', async () => {
  const reader = makeReader();
  const source = await reader.getItemSource(createCatalogContentId('movie', 'fixture-movie-ir'));
  assert.deepEqual(source.headers, sheets['سینمایی'].headers);
  assert.equal(source.record['Telegram File ID'], 'fake-file-movie');
  assert.equal(source.record['اسم فیلم'], 'فیلم ایرانی ساختگی');
  const list = await reader.list(new URLSearchParams('pageSize=100'));
  assert.equal(JSON.stringify(list).includes('fake-file-movie'), false);
});

test('reader creates new movie and series rows using each sheet schema', async () => {
  const source = structuredClone(sheets);
  const hash = (record) => require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  const provider = {
    async readSheet(name) { return { headers: [...source[name].headers], rows: source[name].rows.map((row) => [...row]) }; },
    async getSheetSchema(name) { return [...source[name].headers]; },
    async createCatalogRow({ sheetName, fields }) {
      const record = Object.fromEntries(source[sheetName].headers.map((header) => [header, fields[header] ?? '']));
      source[sheetName].rows.push(source[sheetName].headers.map((header) => record[header]));
      return { record, rowNumber: source[sheetName].rows.length + 1, sourceVersion: hash(record) };
    },
    async updateCatalogRow({ sheetName, systemCode, expectedVersion, fields }) {
      const codeIndex = source[sheetName].headers.indexOf('کد سیستم');
      const rowIndex = source[sheetName].rows.findIndex((row) => row[codeIndex] === systemCode);
      const record = Object.fromEntries(source[sheetName].headers.map((header, index) => [header, source[sheetName].rows[rowIndex][index] ?? '']));
      assert.equal(hash(record), expectedVersion);
      for (const [header, value] of Object.entries(fields)) record[header] = value;
      source[sheetName].rows[rowIndex] = source[sheetName].headers.map((header) => record[header]);
      return { rowNumber: rowIndex + 2, sourceVersion: hash(record) };
    },
  };
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({ contentMetadata: [], categories: [], taxonomies: { country: [], genre: [] } });
  const reader = createCatalogAdminContentReader({ sheetProvider: provider, writableProvider });
  const movie = await reader.createItemSource('movie', {
    'کد سیستم': 'created-movie', 'اسم فیلم': 'فیلم تازه', 'سال': '2025', 'Telegram File ID': 'new-file',
  });
  assert.equal(movie.id, 'movie:created-movie');
  assert.equal(movie.record['Telegram File ID'], 'new-file');
  const series = await reader.createItemSource('series', {
    'کد سیستم': 'created-series', 'اسم فیلم': 'سریال تازه', 'سال شروع': '2023',
    'سال پایان': 'در حال پخش', 'تعداد فصل و قسمت': '۱ فصل، ۸ قسمت',
  });
  assert.equal(series.id, 'series:created-series');
  assert.equal(series.record['سال پایان'], 'در حال پخش');
  const updated = await reader.updateItemSource(movie.id, {
    sourceVersion: movie.sourceVersion, fields: { 'Telegram File ID': 'updated-file', 'اسم فیلم': 'عنوان ویرایش‌شده' },
  });
  assert.equal(updated.record['Telegram File ID'], 'updated-file');
  assert.equal(updated.record['اسم فیلم'], 'عنوان ویرایش‌شده');
});

test('admin content reader searches title or system code and applies filters before pagination', async () => {
  const reader = makeReader();
  const byTitle = await reader.list(new URLSearchParams('q=%D8%B3%D8%B1%DB%8C%D8%A7%D9%84&kind=series'));
  assert.equal(byTitle.meta.total, 2);
  const byCode = await reader.list(new URLSearchParams('q=fixture-movie-draft&approvalStatus=unknown'));
  assert.equal(byCode.meta.total, 1);
  assert.equal(byCode.data[0].systemCode, 'fixture-movie-draft');
  const page = await reader.list(new URLSearchParams('page=2&pageSize=3'));
  assert.equal(page.meta.page, 2);
  assert.equal(page.data.length, 3);
});

test('admin content reader combines taxonomy and category filters before pagination', async () => {
  const movieId = createCatalogContentId('movie', 'fixture-movie-ir');
  const reader = makeReader({
    contentMetadata: [{
      contentId: movieId, approvalStatus: 'approved', publicationStatus: 'draft',
      countryIds: ['IR'], genreIds: ['drama'],
    }],
  });
  const country = await reader.list(new URLSearchParams('countryId=IR&pageSize=100'));
  assert.equal(country.meta.total, 1);
  assert.equal(country.data[0].id, movieId);
  const genre = await reader.list(new URLSearchParams('genreId=drama&pageSize=100'));
  assert.equal(genre.meta.total, 1);
  await assert.rejects(reader.list(new URLSearchParams('countryId=US')), {
    name: 'CatalogAdminListInputError',
  });
});


test('admin content reader filters dynamic, manual, and hybrid category membership', async () => {
  const id = createCatalogContentId('movie', 'fixture-movie-ir');
  const reader = makeReader({
    contentMetadata: [{
      contentId: id, approvalStatus: 'pending', publicationStatus: 'draft',
      countryIds: ['IR'], genreIds: ['drama'], categoryIds: ['manual-pick'],
    }],
    categories: [
      { id: 'dynamic-iran', slug: 'dynamic-iran', localizedTitle: { fa: 'ایرانی پویا' },
        enabled: true, mode: 'dynamic',
        filters: { all: [{ field: 'countryIds', op: 'contains', value: 'IR' }] } },
      { id: 'manual-pick', slug: 'manual-pick', localizedTitle: { fa: 'انتخاب دستی' },
        enabled: true, mode: 'manual' },
      { id: 'hybrid-pick', slug: 'hybrid-pick', localizedTitle: { fa: 'ترکیبی' },
        enabled: true, mode: 'hybrid',
        filters: { all: [{ field: 'genreIds', op: 'contains', value: 'drama' }] } },
    ],
  });
  for (const categoryId of ['dynamic-iran', 'manual-pick', 'hybrid-pick']) {
    const result = await reader.list(new URLSearchParams(`categoryId=${categoryId}&pageSize=100`));
    assert.equal(result.meta.total, 1, categoryId);
    assert.equal(result.data[0].id, id);
  }
});

test('admin content reader rejects invalid query and ambiguous source identities', async () => {
  const reader = makeReader();
  await assert.rejects(reader.list(new URLSearchParams('pageSize=101')),
    { name: 'CatalogAdminListInputError' });

  const duplicateSource = structuredClone(sheets);
  duplicateSource['سینمایی'].rows.push([...duplicateSource['سینمایی'].rows[0]]);
  const duplicateReader = makeReader({ source: duplicateSource });
  await assert.rejects(duplicateReader.list(new URLSearchParams()), TypeError);
});

test('admin content reader preserves a Firestore metadata validation diagnostic stage and code', async () => {
  const writableProvider = {
    getContentMetadataWithVersion: async () => null,
    listContentMetadataWithVersion: async () => {
      const error = new Error('safe validation failure');
      error.dependency = 'firestore';
      error.stage = 'metadata_validation';
      error.errorCode = 'FIRESTORE_DATA_VALIDATION';
      throw error;
    },
  };
  const reader = createCatalogAdminContentReader({
    sheetProvider: createFixtureProvider(sheets),
    writableProvider,
  });
  await assert.rejects(
    reader.list(new URLSearchParams()),
    (error) => error.name === 'CatalogAdminListStageError' &&
      error.dependency === 'firestore' &&
      error.stage === 'metadata_validation' &&
      error.errorCode === 'FIRESTORE_DATA_VALIDATION',
  );
});
