'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCatalogAdminContentReader } = require('../src/catalog-admin-content-reader');
const { createInMemoryWritableCatalogMetadataProvider } = require('../src/in-memory-writable-catalog-metadata-provider');
const { createFixtureProvider, sheets } = require('./fixtures/catalog-sheet-source-fixtures');
const { createCatalogContentId } = require('../src/catalog-content-identity');

function makeReader({ source = sheets, contentMetadata = [] } = {}) {
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata,
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
  assert.equal(item.sourceFields['Telegram File ID'], 'fake-file-movie');
  assert.equal(Object.hasOwn(item.sourceFields, 'شناسه URL'), false);
  assert.equal(item.sourceFields['ژانر'], 'درام');
  assert.equal(JSON.stringify(item).includes('sourceRecord'), false);
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
