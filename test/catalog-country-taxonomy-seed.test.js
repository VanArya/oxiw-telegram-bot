'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COUNTRY_CATEGORIES,
  COUNTRY_TERMS,
  FOREIGN_COUNTRY_IDS,
  applyCountryTaxonomySeed,
  planCountryTaxonomySeed,
} = require('../src/catalog-country-taxonomy-seed');

test('country taxonomy seed contains the seven approved countries in stable order', () => {
  assert.deepEqual(COUNTRY_TERMS.map(({ id, labelFa }) => [id, labelFa]), [
    ['IR', 'ایران'],
    ['US', 'آمریکا'],
    ['KR', 'کره جنوبی'],
    ['JP', 'ژاپن'],
    ['IN', 'هند'],
    ['EG', 'مصر'],
    ['ES', 'اسپانیا'],
  ]);
  assert.deepEqual(FOREIGN_COUNTRY_IDS, ['US', 'KR', 'JP', 'IN', 'EG', 'ES']);
});

test('country seed plans four data-driven Iranian and foreign categories', () => {
  assert.deepEqual(COUNTRY_CATEGORIES.map(({ slug }) => slug), [
    'iranian-movies', 'iranian-series', 'foreign-movies', 'foreign-series',
  ]);
  const foreign = COUNTRY_CATEGORIES.find((category) => category.slug === 'foreign-movies');
  assert.deepEqual(foreign.filters.all[1].any.map((condition) => condition.value), FOREIGN_COUNTRY_IDS);
});

test('empty seed plan creates seven terms and four categories without overwriting anything', () => {
  const plan = planCountryTaxonomySeed([], []);
  assert.equal(plan.createTerms.length, 7);
  assert.equal(plan.updateTerms.length, 0);
  assert.equal(plan.createCategories.length, 4);
  assert.equal(plan.updateCategories.length, 0);
  assert.deepEqual(plan.conflicts, []);
});

test('seed plan safely normalizes an existing country label and reconciles system categories', () => {
  const terms = COUNTRY_TERMS.map((term) => ({ ...term }));
  terms[1] = { ...terms[1], labelFa: 'ایالات متحده', sortOrder: 20 };
  const categories = COUNTRY_CATEGORIES.map((category) => structuredClone(category));
  categories[2] = {
    ...categories[2],
    filters: { field: 'kind', op: 'eq', value: 'movie' },
  };

  const plan = planCountryTaxonomySeed(terms, categories);
  assert.deepEqual(plan.updateTerms.map(({ id }) => id), ['US']);
  assert.equal(plan.updateTerms[0].value.labelFa, 'آمریکا');
  assert.deepEqual(plan.updateCategories.map(({ id }) => id), ['foreign-movies']);
  assert.equal(plan.createTerms.length, 0);
  assert.equal(plan.createCategories.length, 0);
});

test('seed plan blocks a country label assigned to another ID and a category slug collision', () => {
  const terms = [{ id: 'USA', labelFa: 'آمریکا', enabled: true }];
  const categories = [{
    id: 'custom-foreign-movies',
    slug: 'foreign-movies',
    localizedTitle: { fa: 'فیلم خارجی' },
    enabled: true,
    filters: { field: 'kind', op: 'eq', value: 'movie' },
  }];
  const plan = planCountryTaxonomySeed(terms, categories);
  assert.ok(plan.conflicts.some((conflict) => conflict.entity === 'country' && conflict.reason === 'LABEL_OWNED_BY_OTHER_ID'));
  assert.ok(plan.conflicts.some((conflict) => conflict.entity === 'category' && conflict.reason === 'SLUG_OWNED_BY_OTHER_ID'));
});

test('non-dynamic categories are not overwritten by the producer-country seed', () => {
  const categories = COUNTRY_CATEGORIES.map((category) => structuredClone(category));
  categories[2] = { ...categories[2], mode: 'hybrid' };
  const plan = planCountryTaxonomySeed(COUNTRY_TERMS, categories);
  assert.ok(plan.conflicts.some((conflict) =>
    conflict.id === 'foreign-movies' && conflict.reason === 'NON_DYNAMIC_CATEGORY_REQUIRES_REVIEW'));
});

function writableProvider({ terms = [], categories = [], staleTerm = false } = {}) {
  const termState = new Map(terms.map((term) => [term.id, { value: structuredClone(term), version: 1 }]));
  const categoryState = new Map(categories.map((category) => [category.id, { value: structuredClone(category), version: 1 }]));
  const writes = [];
  return {
    writes,
    async listAllTaxonomyTerms() { return [...termState.values()].map(({ value }) => structuredClone(value)); },
    async listCategories() { return [...categoryState.values()].map(({ value }) => structuredClone(value)); },
    async getTaxonomyTermWithVersion(type, id) {
      assert.equal(type, 'country');
      const current = termState.get(id);
      if (!current) return null;
      const value = staleTerm && id === 'US'
        ? { ...current.value, labelFa: 'تغییر هم‌زمان' }
        : current.value;
      return { value: structuredClone(value), version: current.version };
    },
    async getCategoryWithVersion(id) {
      const current = categoryState.get(id);
      return current ? { value: structuredClone(current.value), version: current.version } : null;
    },
    async upsertTaxonomyTerm(type, id, value, options) {
      writes.push({ entity: 'country', type, id, value, options });
      const current = termState.get(id);
      if ((options.expectedVersion === 0 && current) ||
          (options.expectedVersion > 0 && (!current || current.version !== options.expectedVersion))) {
        throw Object.assign(new Error('version conflict'), { code: 'VERSION_CONFLICT' });
      }
      termState.set(id, { value: structuredClone(value), version: (current?.version || 0) + 1 });
    },
    async upsertCategory(id, value, options) {
      writes.push({ entity: 'category', id, value, options });
      const current = categoryState.get(id);
      if ((options.expectedVersion === 0 && current) ||
          (options.expectedVersion > 0 && (!current || current.version !== options.expectedVersion))) {
        throw Object.assign(new Error('version conflict'), { code: 'VERSION_CONFLICT' });
      }
      categoryState.set(id, { value: structuredClone(value), version: (current?.version || 0) + 1 });
    },
  };
}

test('apply creates all missing country terms and categories with create-only versions', async () => {
  const provider = writableProvider();
  const result = await applyCountryTaxonomySeed({ writableProvider: provider });
  assert.equal(result.blocked, false);
  assert.equal(result.createdTerms.length, 7);
  assert.equal(result.createdCategories.length, 4);
  assert.equal(provider.writes.length, 11);
  assert.ok(provider.writes.every((write) => write.options.expectedVersion === 0));
  assert.ok(provider.writes.every((write) => write.options.actorId === 'country-taxonomy-seed'));
});

test('apply updates only planned records using the latest version and preserves existing IDs', async () => {
  const terms = COUNTRY_TERMS.map((term) => ({ ...term }));
  terms[1] = { ...terms[1], labelFa: 'ایالات متحده' };
  const categories = COUNTRY_CATEGORIES.map((category) => structuredClone(category));
  categories[2] = { ...categories[2], filters: { field: 'kind', op: 'eq', value: 'movie' } };
  const provider = writableProvider({ terms, categories });
  const result = await applyCountryTaxonomySeed({ writableProvider: provider });
  assert.deepEqual(result.updatedTerms, ['US']);
  assert.deepEqual(result.updatedCategories, ['foreign-movies']);
  assert.equal(provider.writes.length, 2);
  assert.ok(provider.writes.every((write) => write.options.expectedVersion === 1));
});

test('apply performs no writes when the plan contains conflicts', async () => {
  const provider = writableProvider({
    terms: [{ id: 'USA', labelFa: 'آمریکا', enabled: true }],
  });
  const result = await applyCountryTaxonomySeed({ writableProvider: provider });
  assert.equal(result.blocked, true);
  assert.equal(provider.writes.length, 0);
});

test('apply rejects a stale country plan rather than overwriting concurrent edits', async () => {
  const terms = COUNTRY_TERMS.map((term) => ({ ...term }));
  terms[1] = { ...terms[1], labelFa: 'ایالات متحده' };
  const provider = writableProvider({ terms, staleTerm: true });
  await assert.rejects(
    applyCountryTaxonomySeed({ writableProvider: provider }),
    { code: 'SEED_PLAN_STALE' },
  );
  assert.equal(provider.writes.length, 0);
});
