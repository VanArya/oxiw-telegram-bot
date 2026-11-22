'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mapSeriesEpisodeRecord, isSeriesEpisodeRecord, REQUIRED_EPISODE_FIELDS } = require('../src/series-episode-record');

const validRow = {
  'کد قسمت': '70711.01.13',
  'کد سریال': '70711',
  'اسم فیلم': 'قسمت سیزدهم',
  'Telegram File ID': 'file-id-example',
};

test('episode source row maps to a non-catalog episode record using current headers', () => {
  assert.deepEqual(mapSeriesEpisodeRecord(validRow), {
    episodeCode: '70711.01.13',
    parentSeriesCode: '70711',
    season: 1,
    episode: 13,
    seasonNumber: '01',
    episodeNumber: '13',
    telegramFileId: 'file-id-example',
    episodeTitle: 'قسمت سیزدهم',
  });
  assert.deepEqual(REQUIRED_EPISODE_FIELDS, ['کد قسمت', 'کد سریال', 'Telegram File ID']);
});

test('episode detection uses dotted episode-code shape in current episode-code column', () => {
  assert.equal(isSeriesEpisodeRecord(validRow), true);
  assert.equal(isSeriesEpisodeRecord({ 'کد قسمت': '70711' }), false);
});

test('rejects missing required fields and mismatched parent codes', () => {
  for (const field of REQUIRED_EPISODE_FIELDS) {
    assert.throws(() => mapSeriesEpisodeRecord({ ...validRow, [field]: '' }), /required/);
  }
  assert.throws(() => mapSeriesEpisodeRecord({ ...validRow, 'کد سریال': '70712' }), /parent does not match/);
});

test('rejects malformed episode codes and non-string file IDs', () => {
  assert.throws(() => mapSeriesEpisodeRecord({ ...validRow, 'کد قسمت': '70711.1.13' }), /Invalid episode code/);
  assert.throws(() => mapSeriesEpisodeRecord({ ...validRow, 'Telegram File ID': 123 }), /required/);
  assert.throws(() => mapSeriesEpisodeRecord(null), /object/);
});
