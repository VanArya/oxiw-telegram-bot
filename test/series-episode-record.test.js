'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mapSeriesEpisodeRecord,
  isSeriesEpisodeRecord,
  REQUIRED_EPISODE_FIELDS,
} = require('../src/series-episode-record');

const validRow = {
  'اسم فیلم': 'فصل 1 قسمت 13',
  'کد سریال': '70711',
  'کد قسمت': '70711.01.13',
  'Telegram File ID': 'synthetic-file-id',
};

const legacyRow = {
  'کد سیستم': '70711.01.13',
  'کد سریال مادر': '70711',
  'عنوان قسمت': 'قسمت سیزدهم',
  'لینک تلگرام': 'https://t.me/example/123',
};

test('maps the current live-sheet episode columns without requiring extra columns', () => {
  assert.deepEqual(mapSeriesEpisodeRecord(validRow), {
    systemCode: '70711.01.13',
    parentSeriesCode: '70711',
    season: 1,
    episode: 13,
    seasonNumber: '01',
    episodeNumber: '13',
    telegramFileId: 'synthetic-file-id',
    episodeTitle: 'فصل 1 قسمت 13',
  });
  assert.deepEqual(REQUIRED_EPISODE_FIELDS, ['کد سریال', 'کد قسمت', 'Telegram File ID']);
});

test('continues to read legacy episode rows', () => {
  assert.deepEqual(mapSeriesEpisodeRecord(legacyRow), {
    systemCode: '70711.01.13',
    parentSeriesCode: '70711',
    season: 1,
    episode: 13,
    seasonNumber: '01',
    episodeNumber: '13',
    telegramUrl: 'https://t.me/example/123',
    episodeTitle: 'قسمت سیزدهم',
  });
});

test('episode row detection supports current and legacy series code headers', () => {
  assert.equal(isSeriesEpisodeRecord(validRow), true);
  assert.equal(isSeriesEpisodeRecord({ 'کد سریال': '70711', 'کد قسمت': '' }), false);
  assert.equal(isSeriesEpisodeRecord({ 'کد سریال': '70711.01.13' }), true);
  assert.equal(isSeriesEpisodeRecord({ 'کد سریال': '70711', 'کد قسمت': '70711.01.13' }), true);
});

test('rejects missing required fields and mismatched parent codes', () => {
  for (const field of REQUIRED_EPISODE_FIELDS) {
    assert.throws(() => mapSeriesEpisodeRecord({ ...validRow, [field]: '' }));
  }
  assert.throws(
    () => mapSeriesEpisodeRecord({ ...validRow, 'کد سریال': '70712' }),
    /parent does not match/,
  );
});

test('rejects invalid codes and non-http telegram links', () => {
  assert.throws(
    () => mapSeriesEpisodeRecord({ ...validRow, 'کد قسمت': '70711.1.13' }),
    /Invalid episode system code/,
  );
  assert.throws(
    () => mapSeriesEpisodeRecord({ ...legacyRow, 'لینک تلگرام': 'javascript:alert(1)' }),
    /http\(s\) URL/,
  );
  assert.throws(() => mapSeriesEpisodeRecord(null), /object/);
});
