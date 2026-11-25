'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRODUCER_COUNTRIES,
  getProducerCountry,
  isProducerCountry,
  normalizeProducerCountryLabel,
} = require('../src/catalog-producer-country');

test('defines the seven owner-approved producer countries with stable ISO IDs', () => {
  assert.deepEqual(PRODUCER_COUNTRIES, [
    { id: 'IR', labelFa: 'ایران' },
    { id: 'US', labelFa: 'آمریکا' },
    { id: 'KR', labelFa: 'کره جنوبی' },
    { id: 'JP', labelFa: 'ژاپن' },
    { id: 'IN', labelFa: 'هند' },
    { id: 'EG', labelFa: 'مصر' },
    { id: 'ES', labelFa: 'اسپانیا' },
  ]);
});

test('normalizes harmless Persian/Arabic character and spacing differences only', () => {
  assert.equal(normalizeProducerCountryLabel('  کره‌ي   جنوبی '), 'کره ی جنوبی');
  assert.deepEqual(getProducerCountry('کره‌ي جنوبی'), { id: 'KR', labelFa: 'کره جنوبی' });
  assert.equal(getProducerCountry('آمريكا').id, 'US');
});

test('does not infer a country from an unapproved or ambiguous label', () => {
  assert.equal(getProducerCountry('انگلستان'), null);
  assert.equal(getProducerCountry('ایالات متحده'), null);
  assert.equal(getProducerCountry(''), null);
  assert.equal(isProducerCountry('اسپانیا'), true);
  assert.equal(isProducerCountry('اسپانیا و آمریکا'), false);
});
