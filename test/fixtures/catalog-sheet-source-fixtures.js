'use strict';

const movieHeaders = [
  'کد سیستم',
  'اسم فیلم',
  'سال',
  'کشور سازنده',
  'وضعیت انتشار',
  'Telegram File ID',
];
const { createCatalogContentId } = require('../../src/catalog-content-identity');
const { createInMemoryCatalogMetadataProvider } = require('../../src/in-memory-catalog-metadata-provider');
const { categories } = require('./catalog-fixtures');

const seriesHeaders = [
  'کد سیستم',
  'اسم فیلم',
  'سال شروع',
  'سال پایان',
  'تعداد فصل و قسمت',
  'کشور سازنده',
  'وضعیت انتشار',
  'Telegram File ID',
];

const sheets = {
  'سینمایی': {
    headers: movieHeaders,
    rows: [
      ['fixture-movie-ir', 'فیلم ایرانی ساختگی', '2020', 'IR', 'published', 'fake-file-movie'],
      ['fixture-movie-us', 'فیلم خارجی ساختگی', '2021', 'US', 'published', 'fake-file-us'],
      ['fixture-movie-unknown-country', 'فیلم با کشور نامعلوم', '2022', '', 'published', 'fake-file-unknown'],
      ['fixture-movie-invalid-country', 'فیلم کشور نامعتبر', '2023', 'IR|ZZ', 'published', 'fake-file-invalid'],
      ['fixture-movie-draft', 'فیلم پیش‌نویس', '2024', 'IR', 'draft', 'fake-file-draft'],
      ['fixture-movie-unknown-status', 'فیلم وضعیت نامعلوم', '2024', 'IR', 'pending', 'fake-file-pending'],
    ],
  },
  'سریال': {
    headers: seriesHeaders,
    rows: [
      ['fixture-series-ir', 'سریال ایرانی ساختگی', '2018', '2022', '۲ فصل، ۱۸ قسمت', 'IR', 'published', 'fake-file-series'],
      ['fixture-series-us', 'سریال خارجی ساختگی', '2019', '2021', '۳ فصل، ۲۴ قسمت', 'US', 'published', 'fake-file-series-us'],
    ],
  },
};

function createFixtureProvider(sourceSheets = sheets) {
  return {
    async readSheet(sheetName) {
      const snapshot = sourceSheets[sheetName];
      if (!snapshot) {
        throw new TypeError('Unknown fixture sheet.');
      }
      return {
        headers: [...snapshot.headers],
        rows: snapshot.rows.map((row) => [...row]),
      };
    },
  };
}

function createFixtureMetadataProvider(overrides = {}) {
  return createInMemoryCatalogMetadataProvider({
    contentMetadata: {
      [createCatalogContentId('movie', 'fixture-movie-ir')]: { approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['IR'], genreIds: ['drama'] },
      [createCatalogContentId('movie', 'fixture-movie-us')]: { approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['US'], genreIds: ['drama'] },
      [createCatalogContentId('movie', 'fixture-movie-unknown-country')]: { approvalStatus: 'approved', publicationStatus: 'published', genreIds: ['drama'] },
      [createCatalogContentId('movie', 'fixture-movie-invalid-country')]: { approvalStatus: 'approved', publicationStatus: 'published' },
      [createCatalogContentId('movie', 'fixture-movie-draft')]: { approvalStatus: 'approved', publicationStatus: 'draft', countryIds: ['IR'] },
      [createCatalogContentId('movie', 'fixture-movie-unknown-status')]: { approvalStatus: 'unknown', publicationStatus: 'published', countryIds: ['IR'] },
      [createCatalogContentId('series', 'fixture-series-ir')]: { approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['IR'], genreIds: ['drama'] },
      [createCatalogContentId('series', 'fixture-series-us')]: { approvalStatus: 'approved', publicationStatus: 'published', countryIds: ['US'], genreIds: ['drama'] },
      ...overrides,
    },
    categories,
    taxonomies: {
      country: [
        { id: 'IR', labelFa: 'ایران', enabled: true },
        { id: 'US', labelFa: 'ایالات متحده', enabled: true },
      ],
      genre: [
        { id: 'drama', labelFa: 'درام', enabled: true },
        { id: 'comedy', labelFa: 'کمدی', enabled: true },
      ],
    },
  });
}

module.exports = {
  createFixtureMetadataProvider,
  createFixtureProvider,
  movieHeaders,
  seriesHeaders,
  sheets,
};
