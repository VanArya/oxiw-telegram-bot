'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCatalogSheetAdapter } = require('../src/catalog-sheet-adapter');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const {
  createFirestoreCatalogMetadataProvider,
} = require('../src/firestore-catalog-metadata-provider');

const iranianMovieId = createCatalogContentId('movie', 'sample-1');
const fixtureCategory = {
  id: 'iranian-movies',
  slug: 'iranian-movies',
  localizedTitle: { fa: 'فیلم سینمایی ایرانی' },
  enabled: true,
  sortOrder: 1,
  filters: {
    all: [
      { field: 'kind', op: 'eq', value: 'movie' },
      { field: 'countryIds', op: 'contains', value: 'IR' },
    ],
  },
};

function makeFirestore({ content = {}, categories = [], taxonomies = {} } = {}) {
  const calls = [];
  const clone = (value) => structuredClone(value);
  const snapshot = (id, value) => ({
    id,
    exists: value !== undefined,
    data: () => value === undefined ? undefined : clone(value),
  });
  const collectionSnapshot = (documents) => ({
    docs: Object.entries(documents).map(([id, value]) => snapshot(id, value)),
  });

  const firestore = {
    collection(name) {
      calls.push(['collection', name]);
      if (name === 'catalogContentMetadata') {
        return {
          doc(id) {
            calls.push(['doc', name, id]);
            return {
              async get() {
                calls.push(['get', name, id]);
                return snapshot(id, content[id]);
              },
            };
          },
        };
      }
      if (name === 'catalogCategories') {
        return {
          async get() {
            calls.push(['get', name]);
            return collectionSnapshot(categories);
          },
        };
      }
      if (name === 'catalogTaxonomies') {
        return {
          doc(type) {
            calls.push(['doc', name, type]);
            return {
              collection(subcollection) {
                calls.push(['subcollection', type, subcollection]);
                return {
                  async get() {
                    calls.push(['get-taxonomy', type]);
                    return collectionSnapshot(taxonomies[type] || {});
                  },
                };
              },
            };
          },
        };
      }
      throw new Error('unexpected collection');
    },
  };
  return { firestore, calls };
}

function createProvider(data = {}) {
  const { firestore, calls } = makeFirestore(data);
  return { provider: createFirestoreCatalogMetadataProvider({ firestore }), calls };
}

test('reads valid content metadata and projects only contract fields', async () => {
  const source = createProvider({
    content: {
      [iranianMovieId]: {
        contentId: iranianMovieId,
        approvalStatus: 'approved',
        publicationStatus: 'published',
        countryIds: ['IR'],
        genreIds: ['drama'],
        telegramFileId: 'synthetic-private-file-id',
        privateDownloadToken: 'synthetic-private-token',
        createdAt: { internal: 'timestamp' },
      },
    },
  });
  assert.deepEqual(await source.provider.getContentMetadata(iranianMovieId), {
    contentId: iranianMovieId,
    approvalStatus: 'approved',
    publicationStatus: 'published',
    countryIds: ['IR'],
    genreIds: ['drama'],
  });
  assert.deepEqual(source.calls.map(([operation]) => operation), ['collection', 'doc', 'get']);
  assert.deepEqual(Object.keys(source.provider), [
    'getContentMetadata', 'listCategories', 'listTaxonomyTerms',
  ]);
});

test('missing and incomplete or invalid content metadata fail closed as null', async () => {
  const invalidIds = [
    createCatalogContentId('movie', 'missing-approval'),
    createCatalogContentId('movie', 'missing-publication'),
    createCatalogContentId('movie', 'invalid-approval'),
    createCatalogContentId('movie', 'invalid-publication'),
    createCatalogContentId('movie', 'invalid-country'),
    createCatalogContentId('movie', 'wrong-content-id'),
  ];
  const content = Object.fromEntries(invalidIds.slice(1).map((id) => [id, {
    contentId: id,
    approvalStatus: 'approved',
    publicationStatus: 'published',
  }]));
  delete content[invalidIds[0]];
  content[invalidIds[1]].publicationStatus = undefined;
  content[invalidIds[2]].approvalStatus = 'published';
  content[invalidIds[3]].publicationStatus = 'approved';
  content[invalidIds[4]].countryIds = ['Iran'];
  content[invalidIds[5]].contentId = createCatalogContentId('series', 'wrong');
  const provider = createProvider({ content }).provider;

  for (const id of invalidIds) {
    assert.equal(await provider.getContentMetadata(id), null, id);
  }
  assert.equal(await provider.getContentMetadata('not-a-content-id'), null);
});

test('both independent states are retained; non-public combinations stay non-public in the adapter', async () => {
  const draftId = createCatalogContentId('movie', 'draft');
  const pendingId = createCatalogContentId('movie', 'pending');
  const publishedPendingId = createCatalogContentId('movie', 'published-pending');
  const source = createProvider({
    content: {
      [draftId]: { contentId: draftId, approvalStatus: 'approved', publicationStatus: 'draft' },
      [pendingId]: { contentId: pendingId, approvalStatus: 'pending', publicationStatus: 'draft' },
      [publishedPendingId]: { contentId: publishedPendingId, approvalStatus: 'pending', publicationStatus: 'published' },
    },
  });
  assert.equal((await source.provider.getContentMetadata(draftId)).publicationStatus, 'draft');
  assert.equal((await source.provider.getContentMetadata(publishedPendingId)).approvalStatus, 'pending');

  const sheetProvider = {
    async readSheet(sheetName) {
      return sheetName === 'سینمایی'
        ? { headers: ['کد سیستم', 'اسم فیلم'], rows: [['draft', 'ساختگی'], ['pending', 'ساختگی'], ['published-pending', 'ساختگی']] }
        : { headers: ['کد سیستم', 'اسم فیلم'], rows: [] };
    },
  };
  const adapter = createCatalogSheetAdapter(sheetProvider, { metadataProvider: source.provider });
  assert.deepEqual(await adapter.listItems(), []);
});

test('returns only active categories and active country and genre taxonomy terms', async () => {
  const source = createProvider({
    categories: {
      [fixtureCategory.id]: fixtureCategory,
      'inactive-category': {
        ...fixtureCategory,
        id: 'inactive-category',
        slug: 'inactive-category',
        enabled: false,
      },
    },
    taxonomies: {
      country: {
        IR: { id: 'IR', labelFa: 'ایران', enabled: true },
        US: { id: 'US', labelFa: 'ایالات متحده', enabled: false },
      },
      genre: {
        drama: { id: 'drama', labelFa: 'درام', enabled: true },
        comedy: { id: 'comedy', labelFa: 'کمدی', enabled: false },
      },
    },
  });
  assert.deepEqual(await source.provider.listCategories(), [fixtureCategory]);
  assert.deepEqual(await source.provider.listTaxonomyTerms('country'), [
    { id: 'IR', labelFa: 'ایران', enabled: true },
  ]);
  assert.deepEqual(await source.provider.listTaxonomyTerms('genre'), [
    { id: 'drama', labelFa: 'درام', enabled: true },
  ]);
  assert.deepEqual(await source.provider.listTaxonomyTerms('language'), []);
});

test('invalid active category or taxonomy data fails without exposing stored values', async () => {
  const badCategory = createProvider({
    categories: {
      bad: { ...fixtureCategory, id: 'other-id', enabled: true },
    },
  }).provider;
  await assert.rejects(badCategory.listCategories(), (error) => (
    error.message === 'Unable to read catalog metadata.' && !error.cause
  ));

  const badTaxonomy = createProvider({
    taxonomies: { country: { Iran: { id: 'Iran', labelFa: 'synthetic private value', enabled: true } } },
  }).provider;
  await assert.rejects(badTaxonomy.listTaxonomyTerms('country'), (error) => (
    error.message === 'Unable to read catalog metadata.' &&
    !error.message.includes('synthetic private value') && !error.cause
  ));

  const duplicateSlugs = createProvider({
    categories: {
      first: { ...fixtureCategory, id: 'first', slug: 'same-slug' },
      second: { ...fixtureCategory, id: 'second', slug: 'same-slug' },
    },
  }).provider;
  await assert.rejects(duplicateSlugs.listCategories(), /Unable to read catalog metadata/);
});

test('Firestore errors become generic and no credential or request is needed', async () => {
  const firestore = {
    collection() {
      return { doc: () => ({ async get() { throw new Error('synthetic credential detail'); } }) };
    },
  };
  const provider = createFirestoreCatalogMetadataProvider({ firestore });
  await assert.rejects(provider.getContentMetadata(iranianMovieId), (error) => (
    error.message === 'Unable to read catalog metadata.' &&
    !error.message.includes('synthetic credential detail') && !error.cause
  ));
});

test('Firestore-backed adapter returns a public DTO without metadata internals', async () => {
  const metadataProvider = createProvider({
    content: {
      [iranianMovieId]: {
        contentId: iranianMovieId,
        approvalStatus: 'approved',
        publicationStatus: 'published',
        countryIds: ['IR'],
        telegramFileId: 'synthetic-private-file-id',
        downloadToken: 'synthetic-private-token',
      },
    },
    taxonomies: { country: { IR: { id: 'IR', labelFa: 'ایران', enabled: true } } },
  }).provider;
  const sheets = {
    async readSheet(sheetName) {
      return sheetName === 'سینمایی'
        ? { headers: ['کد سیستم', 'اسم فیلم', 'Telegram File ID'], rows: [['sample-1', 'فیلم ساختگی', 'source-private-file']] }
        : { headers: ['کد سیستم', 'اسم فیلم'], rows: [] };
    },
  };
  const adapter = createCatalogSheetAdapter(sheets, { metadataProvider });
  const items = await adapter.listItems();
  assert.deepEqual(items, [{
    id: iranianMovieId,
    kind: 'movie',
    title: 'فیلم ساختگی',
    countries: [{ id: 'IR', labelFa: 'ایران' }],
  }]);
  const serialized = JSON.stringify(items);
  for (const privateValue of ['source-private-file', 'synthetic-private-file', 'private-token', 'approvalStatus', 'publicationStatus']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});
