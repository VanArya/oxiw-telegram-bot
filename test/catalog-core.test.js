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
  assert.equal(result.some((item) => item.status !== 'published'), false);
});

test('unsupported fields are rejected', () => {
  assert.throws(
    () => filterCatalogItems(items, { field: 'telegramFileId', op: 'eq', value: 'x' }),
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
