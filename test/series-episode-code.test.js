'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseSeriesEpisodeCode,
  createSeriesEpisodeCode,
} = require('../src/series-episode-code');

test('formats season and episode code using the parent series code', () => {
  assert.equal(createSeriesEpisodeCode('70711', 1, 13), '70711.01.13');
  assert.equal(createSeriesEpisodeCode('70711', 2, 5), '70711.02.05');
});

test('parses a code into parent, season, and episode with padded display numbers', () => {
  assert.deepEqual(parseSeriesEpisodeCode('70711.01.13'), {
    code: '70711.01.13',
    parentSeriesCode: '70711',
    season: 1,
    episode: 13,
    seasonNumber: '01',
    episodeNumber: '13',
  });
});

test('rejects malformed codes and zero season or episode', () => {
  for (const invalid of ['70711.1.13', '70711.01.1', '70711.00.13', '70711.01.00', 'S-200.01.01', '7071.01.01', '  ']) {
    assert.equal(parseSeriesEpisodeCode(invalid), null, invalid);
  }
  assert.equal(parseSeriesEpisodeCode(null), null);
});

test('validates parent code and season/episode ranges on creation', () => {
  assert.throws(() => createSeriesEpisodeCode('7071', 1, 1), /five digits/);
  assert.throws(() => createSeriesEpisodeCode('70711', 0, 1), /between 1 and 99/);
  assert.throws(() => createSeriesEpisodeCode('70711', 1, 100), /between 1 and 99/);
  assert.throws(() => createSeriesEpisodeCode('70711', 1.5, 1), /between 1 and 99/);
});
