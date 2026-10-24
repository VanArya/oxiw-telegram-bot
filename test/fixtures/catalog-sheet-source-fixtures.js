'use strict';

const movieHeaders = [
  'کد سیستم',
  'اسم فیلم',
  'سال',
  'کشور سازنده',
  'وضعیت انتشار',
  'Telegram File ID',
];

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

module.exports = { createFixtureProvider, movieHeaders, seriesHeaders, sheets };
