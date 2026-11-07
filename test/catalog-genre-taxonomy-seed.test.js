'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { GENRE_TERMS, normalizeLabel, planGenreTaxonomySeed, applyGenreTaxonomySeed } = require('../src/catalog-genre-taxonomy-seed');

test('genre seed contains exactly 27 approved new genres and excludes Korean', () => {
  assert.equal(GENRE_TERMS.length, 27);
  assert.equal(GENRE_TERMS.some((term) => term.labelFa === 'کره ای'), false);
  assert.equal(new Set(GENRE_TERMS.map((term) => term.id)).size, 27);
  assert.equal(new Set(GENRE_TERMS.map((term) => normalizeLabel(term.labelFa))).size, 27);
});

test('Persian label normalization removes ZWNJ and whitespace differences', () => {
  assert.equal(normalizeLabel('  علمی‌  تخیلی '), 'علمی تخیلی');
});

test('seed plan creates only missing terms and preserves existing Dream drama term', () => {
  const plan = planGenreTaxonomySeed([{ id: 'Dream', labelFa: 'درام', enabled: true }]);
  assert.equal(plan.create.length, 27);
  assert.deepEqual(plan.alreadyPresent, []);
  assert.deepEqual(plan.conflicts, []);
});

test('seed plan treats matching Persian label as already present without changing its ID', () => {
  const plan = planGenreTaxonomySeed([{ id: 'existing-action', labelFa: 'اکشن', enabled: true }]);
  assert.equal(plan.create.length, 26);
  assert.deepEqual(plan.alreadyPresent, [{ id: 'existing-action', labelFa: 'اکشن' }]);
});

test('seed plan blocks ID collision and ambiguous existing labels', () => {
  const idCollision = planGenreTaxonomySeed([{ id: 'Action', labelFa: 'کنش', enabled: true }]);
  assert.equal(idCollision.conflicts[0].reason, 'TERM_ID_ALREADY_USED');
  const labelCollision = planGenreTaxonomySeed([
    { id: 'a', labelFa: 'اکشن' }, { id: 'b', labelFa: 'اکشن‌' },
  ]);
  assert.equal(labelCollision.conflicts[0].reason, 'DUPLICATE_EXISTING_LABEL');
});

test('apply performs no writes when conflicts exist', async () => {
  let writes = 0;
  const result = await applyGenreTaxonomySeed({
    writableProvider: {
      async listAllTaxonomyTerms() { return [{ id: 'Action', labelFa: 'متفاوت' }]; },
      async upsertTaxonomyTerm() { writes += 1; },
    },
  });
  assert.equal(result.blocked, true);
  assert.equal(writes, 0);
});

test('apply uses create-only expectedVersion zero and preserves existing terms', async () => {
  const writes = [];
  const result = await applyGenreTaxonomySeed({
    writableProvider: {
      async listAllTaxonomyTerms() { return [{ id: 'Dream', labelFa: 'درام', enabled: true }]; },
      async upsertTaxonomyTerm(...args) { writes.push(args); },
    },
  });
  assert.equal(result.created.length, 27);
  assert.equal(writes.length, 27);
  assert.ok(writes.every(([, , , options]) => options.expectedVersion === 0));
});
