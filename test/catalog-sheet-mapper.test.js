'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapCatalogSheetRow, toPublicCatalogDto } = require('../src/catalog-sheet-mapper');
const { getCategoryItems } = require('../src/catalog-core');
const { categories } = require('./fixtures/catalog-fixtures');

const movieRow = {
  'اسم فیلم': 'فیلم نمونه',
  'نوع': 'فیلم',
  'ژانر': 'درام',
  'کد سیستم': 'M-100',
  'کشور سازنده': 'IR',
  'سال': '2020',
  'بازیگران': 'بازیگر نمونه',
  'خلاصه داستان': 'خلاصهٔ ساختگی',
  'امتیاز': '8.1',
  'زبان': 'فارسی',
  'پیشنهادی': 'بله',
  'لینک تریلر': 'https://example.invalid/trailer',
  'پوستر فیلم': 'https://example.invalid/poster',
  'شناسه URL': 'movie-sample',
  'Telegram File ID': 'fake-file-id',
};

const seriesRow = {
  'اسم فیلم': 'سریال نمونه',
  'نوع': 'سریال',
  'ژانر': 'درام',
  'کد سیستم': 'S-200',
  'کشور سازنده': 'IR',
  'سال شروع': '2018',
  'سال پایان': '2022',
  'تعداد فصل و قسمت': '۴ فصل، ۳۲ قسمت',
  'بازیگران': 'بازیگر نمونه',
  'خلاصه داستان': 'خلاصهٔ ساختگی',
  'امتیاز': '7.9',
  'زبان': 'فارسی',
  'پیشنهادی': 'خیر',
  'لینک تریلر': 'https://example.invalid/series-trailer',
  'پوستر فیلم': 'https://example.invalid/series-poster',
  'شناسه URL': 'series-sample',
};

test('maps only the supported movie identity and year fields', () => {
  const result = mapCatalogSheetRow('سینمایی', movieRow);
  assert.deepEqual(result.content, {
    id: 'M-100',
    kind: 'movie',
    title: 'فیلم نمونه',
    countryIds: ['IR'],
    releaseYear: 2020,
  });
  assert.equal(result.sourceRecord['Telegram File ID'], 'fake-file-id');
  assert.deepEqual(result.content.countryIds, ['IR']);
  assert.equal('genreIds' in result.content, false);
  assert.equal('status' in result.content, false);
});

test('maps series years and keeps combined season/episode data unparsed', () => {
  const result = mapCatalogSheetRow('سریال', seriesRow);
  assert.deepEqual(result.content, {
    id: 'S-200',
    kind: 'series',
    title: 'سریال نمونه',
    countryIds: ['IR'],
    seriesMetadata: {
      startYear: 2018,
      endYear: 2022,
      seasonsAndEpisodes: '۴ فصل، ۳۲ قسمت',
    },
  });
  assert.equal('releaseYear' in result.content, false);
});

test('legacy rows without country stay valid and cannot enter Iranian categories', () => {
  const legacyRow = { ...movieRow };
  delete legacyRow['کشور سازنده'];
  const mapped = mapCatalogSheetRow('سینمایی', legacyRow);
  assert.equal(mapped.content.countryIds, undefined);
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  assert.deepEqual(getCategoryItems([mapped.content], movieCategory), []);
  assert.deepEqual(getCategoryItems([{ ...mapped.content, status: null }], movieCategory), []);
  assert.equal(toPublicCatalogDto(mapped), null);
  assert.equal(
    toPublicCatalogDto({ ...mapped, content: { ...mapped.content, status: null } }),
    null,
  );
});

test('multi-country values use pipe-separated stable IDs', () => {
  const mapped = mapCatalogSheetRow('سینمایی', { ...movieRow, 'کشور سازنده': 'IR | US' });
  assert.deepEqual(mapped.content.countryIds, ['IR', 'US']);
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  assert.equal(
    getCategoryItems([{ ...mapped.content, status: 'published' }], movieCategory).length,
    1,
  );
});

test('invalid or unsupported country values are omitted and cannot classify as Iranian', () => {
  const mapped = mapCatalogSheetRow('سینمایی', { ...movieRow, 'کشور سازنده': 'IR|ZZ' });
  assert.deepEqual(mapped.mappingWarnings, ['invalid-country-values']);
  assert.equal(mapped.content.countryIds, undefined);
  const movieCategory = categories.find((category) => category.slug === 'iranian-movies');
  assert.deepEqual(getCategoryItems([{ ...mapped.content, status: 'published' }], movieCategory), []);
});

test('public DTO allowlists fields and excludes source row and Telegram file IDs', () => {
  const mapped = mapCatalogSheetRow('سینمایی', movieRow);
  mapped.content.status = 'published';
  const dto = toPublicCatalogDto(mapped);
  assert.deepEqual(dto, {
    id: 'M-100',
    kind: 'movie',
    title: 'فیلم نمونه',
    releaseYear: 2020,
    countries: [{ id: 'IR', labelFa: 'ایران' }],
  });
  assert.equal(JSON.stringify(dto).includes('fake-file-id'), false);
  assert.equal('sourceRecord' in dto, false);
});

test('rejects missing required identity or title fields', () => {
  assert.throws(
    () => mapCatalogSheetRow('سینمایی', { ...movieRow, 'کد سیستم': '  ' }),
    /Missing or invalid required field/,
  );
  assert.throws(
    () => mapCatalogSheetRow('سینمایی', { ...movieRow, 'کد سیستم': Number.NaN }),
    /Missing or invalid required field/,
  );
  assert.throws(
    () => mapCatalogSheetRow('سریال', { ...seriesRow, 'اسم فیلم': null }),
    /Missing or invalid required field/,
  );
});

test('rejects invalid years and reversed series year ranges', () => {
  assert.throws(
    () => mapCatalogSheetRow('سینمایی', { ...movieRow, 'سال': 'نامعتبر' }),
    /Invalid year field/,
  );
  assert.throws(
    () => mapCatalogSheetRow('سریال', { ...seriesRow, 'سال شروع': '2024' }),
    /start year cannot be after end year/,
  );
});

test('rejects unknown sheets and invalid row structures', () => {
  assert.throws(() => mapCatalogSheetRow('سینمایی ایرانی', movieRow), /Unsupported catalog sheet/);
  assert.throws(() => mapCatalogSheetRow('سینمایی', []), /Row must be an object/);
});
