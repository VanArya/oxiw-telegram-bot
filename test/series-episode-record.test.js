'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mapSeriesEpisodeRecord,
  isSeriesEpisodeRecord,
  REQUIRED_EPISODE_FIELDS,
} = require('../src/series-episode-record');

const validRow = {
  'کد سیستم': '70711.01.13',
  'کد سریال مادر': '70711',
  'عنوان قسمت': 'قسمت سیزدهم',
  'لینک تلگرام': 'https://t.me/example/123',
};

test('episode source row maps to a non-catalog episode record', () => {
  assert.deepEqual(mapSeriesEpisodeRecord(validRow), {
    systemCode: '70711.01.13',
    parentSeriesCode: '70711',
    season: 1,
    episode: 13,
    seasonNumber: '01',
    episodeNumber: '13',
    telegramUrl: 'https://t.me/example/123',
    episodeTitle: 'قسمت سیزدهم',
  });
  assert.deepEqual(REQUIRED_EPISODE_FIELDS, ['کد سیستم', 'کد سریال مادر', 'لینک تلگرام']);
});

test('episode row detection uses the dotted episode-code shape', () => {
  assert.equal(isSeriesEpisodeRecord(validRow), true);
  assert.equal(isSeriesEpisodeRecord({ 'کد سیستم': '70711' }), false);
});

test('rejects missing required fields and mismatched parent codes', () => {
  for (const field of REQUIRED_EPISODE_FIELDS) {
    assert.throws(() => mapSeriesEpisodeRecord({ ...validRow, [field]: '' }), /required/);
  }
  assert.throws(
    () => mapSeriesEpisodeRecord({ ...validRow, 'کد سریال مادر': '70712' }),
    /parent does not match/,
  );
});

test('rejects invalid codes and non-http telegram links', () => {
  assert.throws(
    () => mapSeriesEpisodeRecord({ ...validRow, 'کد سیستم': '70711.1.13' }),
    /Invalid episode system code/,
  );
  assert.throws(
    () => mapSeriesEpisodeRecord({ ...validRow, 'لینک تلگرام': 'javascript:alert(1)' }),
    /http\(s\) URL/,
  );
  assert.throws(() => mapSeriesEpisodeRecord(null), /object/);
});
