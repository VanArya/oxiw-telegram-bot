'use strict';

const PRODUCER_COUNTRIES = Object.freeze([
  Object.freeze({ id: 'IR', labelFa: 'ایران' }),
  Object.freeze({ id: 'US', labelFa: 'آمریکا' }),
  Object.freeze({ id: 'KR', labelFa: 'کره جنوبی' }),
  Object.freeze({ id: 'JP', labelFa: 'ژاپن' }),
  Object.freeze({ id: 'IN', labelFa: 'هند' }),
  Object.freeze({ id: 'EG', labelFa: 'مصر' }),
  Object.freeze({ id: 'ES', labelFa: 'اسپانیا' }),
]);

function normalizeProducerCountryLabel(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC')
    .replace(/[ي]/gu, 'ی')
    .replace(/[ك]/gu, 'ک')
    .replace(/[\u200c\u200d\u00a0\s]+/gu, ' ')
    .trim();
}

const COUNTRY_BY_LABEL = new Map(
  PRODUCER_COUNTRIES.map((country) => [normalizeProducerCountryLabel(country.labelFa), country]),
);

function getProducerCountry(value) {
  return COUNTRY_BY_LABEL.get(normalizeProducerCountryLabel(value)) || null;
}

function isProducerCountry(value) {
  return getProducerCountry(value) !== null;
}

module.exports = {
  PRODUCER_COUNTRIES,
  getProducerCountry,
  isProducerCountry,
  normalizeProducerCountryLabel,
};
