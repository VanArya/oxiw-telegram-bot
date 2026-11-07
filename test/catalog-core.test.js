'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterCatalogItems,
  findPublishedItem,
  getCategoryItems,
  listCategories,
} = require('../src/catalog-core');
const { categories, items } = require('./fixtures/catalog-fixtures');

test('categories are data-driven, enabled-only, and sorted', () => {
  const result = listCategories(categories);
  assert.deepEqual(
    result.map((category) => category.slug),
    ['iranian-movies', 'iranian-series'],
  );
});

test('Iranian movie category selects published movies from Iran', () => {
  const category = categories.find((item) => item.slug === 'iranian-movies');
  const result = getCategoryItems(items, category);
  assert.deepEqual(result.map((item) => item.id), ['fixture-movie-ir-1']);
});

test('Iranian series category selects published series from Iran', () => {
  const category = categories.find((item) => item.slug === 'iranian-series');
  const result = getCategoryItems(items, category);
  assert.deepEqual(result.map((item) => item.id), ['fixture-series-ir-1']);
});

test('Iranian categories exclude foreign and unknown-country content', () => {
  const movieCategory = categories.find((item) => item.slug === 'iranian-movies');
  const seriesCategory = categories.find((item) => item.slug === 'iranian-series');
  assert.deepEqual(
    getCategoryItems(items, movieCategory).map((item) => item.id),
    ['fixture-movie-ir-1'],
  );
  assert.deepEqual(
    getCategoryItems(items, seriesCategory).map((item) => item.id),
    ['fixture-series-ir-1'],
  );
  assert.equal(items.find((item) => item.id === 'fixture-movie-country-unknown').countryIds, undefined);
});

test('country and genre filters combine without category-specific code', () => {
  const result = filterCatalogItems(items, {
    all: [
      { field: 'countryIds', op: 'contains', value: 'IR' },
      { field: 'genreIds', op: 'contains', value: 'drama' },
    ],
  });
  assert.deepEqual(
    result.map((item) => item.id),
    ['fixture-movie-ir-1', 'fixture-series-ir-1'],
  );
});

test('public catalog filters exclude unpublished items', () => {
  const result = filterCatalogItems(items, {
    field: 'countryIds',
    op: 'contains',
    value: 'IR',
  });
  assert.equal(result.some((item) => (
    item.approvalStatus !== 'approved' || item.publicationStatus !== 'published'
  )), false);
});

test('public visibility requires independent approved and published states', () => {
  const variants = [
    { id: 'approval-pending', approvalStatus: 'pending', publicationStatus: 'published' },
    { id: 'approval-rejected', approvalStatus: 'rejected', publicationStatus: 'published' },
    { id: 'approval-unknown', approvalStatus: 'unknown', publicationStatus: 'published' },
    { id: 'publication-draft', approvalStatus: 'approved', publicationStatus: 'draft' },
    { id: 'publication-archived', approvalStatus: 'approved', publicationStatus: 'archived' },
    { id: 'publication-unknown', approvalStatus: 'approved', publicationStatus: 'unknown' },
    { id: 'missing-approval', publicationStatus: 'published' },
    { id: 'missing-publication', approvalStatus: 'approved' },
    { id: 'legacy-visibility', visibility: 'approved' },
    { id: 'legacy-status', status: 'published' },
    { id: 'invalid-states', approvalStatus: 'published', publicationStatus: 'approved' },
    { id: 'public', approvalStatus: 'approved', publicationStatus: 'published' },
  ].map((state) => ({ kind: 'movie', countryIds: ['IR'], ...state }));

  const result = filterCatalogItems(variants, { field: 'kind', op: 'eq', value: 'movie' });
  assert.deepEqual(result.map(({ id }) => id), ['public']);
  assert.equal(findPublishedItem(variants, 'legacy-visibility'), null);
  assert.equal(findPublishedItem(variants, 'legacy-status'), null);
});

test('unsupported fields are rejected', () => {
  assert.throws(
    () => filterCatalogItems(items, { field: 'telegramFileId', op: 'eq', value: 'x' }),
    /Unsupported filter field/,
  );
  assert.throws(
    () => filterCatalogItems(items, { field: 'status', op: 'eq', value: 'published' }),
    /Unsupported filter field/,
  );
});

test('invalid operators are rejected', () => {
  assert.throws(
    () => filterCatalogItems(items, { field: 'kind', op: 'contains', value: 'movie' }),
    /Invalid kind condition/,
  );
});

test('boolean filters reject more than 32 child conditions', () => {
  assert.throws(
    () => filterCatalogItems(items, {
      all: Array.from({ length: 33 }, () => ({
        field: 'kind',
        op: 'eq',
        value: 'movie',
      })),
    }),
    /Boolean filters cannot contain more than 32 conditions/,
  );
});

test('disabled categories return no results', () => {
  const category = categories.find((item) => item.slug === 'disabled-category');
  assert.deepEqual(getCategoryItems(items, category), []);
});

test('details are available only for published items', () => {
  assert.equal(findPublishedItem(items, 'fixture-movie-ir-1').title, 'فیلم نمونه یک');
  assert.equal(findPublishedItem(items, 'fixture-movie-ir-draft'), null);
});

test('manual and hybrid categories union direct and dynamic membership without duplicates', () => {
  const visible = items.filter((item) => item.approvalStatus === 'approved' && item.publicationStatus === 'published');
  const direct = { ...visible[0], categoryIds: ['manual-only'] };
  const dynamic = { ...visible[1], categoryIds: ['hybrid'] };
  const duplicate = { ...visible[0], categoryIds: ['hybrid'] };
  const manual = getCategoryItems([direct, dynamic], { id: 'manual-only', mode: 'manual', enabled: true });
  assert.deepEqual(manual.map(({ id }) => id), [direct.id]);
  const hybrid = getCategoryItems([duplicate, dynamic], {
    id: 'hybrid', mode: 'hybrid', enabled: true, filters: { field: 'kind', op: 'eq', value: dynamic.kind },
  });
  assert.equal(new Set(hybrid.map(({ id }) => id)).size, hybrid.length);
  assert.deepEqual(hybrid.map(({ id }) => id).sort(), [duplicate.id, dynamic.id].sort());
});
