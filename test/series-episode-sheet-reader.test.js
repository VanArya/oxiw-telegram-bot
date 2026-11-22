'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSeriesEpisodeSheetReader } = require('../src/series-episode-sheet-reader');

const headers = ['کد قسمت', 'کد سریال', 'Telegram File ID', 'اسم فیلم'];
function provider(rows, customHeaders = headers) {
  return { async readSheet(sheetName) {
    assert.equal(sheetName, 'سریال');
    return { headers: [...customHeaders], rows: rows.map((row) => [...row]) };
  } };
}

test('reads only episodes for requested parent and sorts by season then episode', async () => {
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: provider([
    ['70711.02.01', '70711', 'file-1', 'شروع فصل دوم'],
    ['70711.01.13', '70711', 'file-2', 'قسمت سیزدهم'],
    ['12345.01.01', '12345', 'file-3', ''],
    ['70711', '', '', 'سریال مادر'],
  ]) });
  const result = await reader.listEpisodes('70711');
  assert.deepEqual(result.episodes.map((episode) => episode.episodeCode), ['70711.01.13', '70711.02.01']);
  assert.deepEqual(result.episodes.map((episode) => episode.episodeTitle), ['قسمت سیزدهم', 'شروع فصل دوم']);
  assert.equal(result.invalidRows.length, 0);
});

test('reports malformed episode records without exposing unrelated series', async () => {
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: provider([
    ['70711.01.02', '70711', '', ''],
    ['70711', '', '', 'سریال مادر'],
    ['12345.01.01', '12345', 'file-x', ''],
  ]) });
  const result = await reader.listEpisodes('70711');
  assert.equal(result.episodes.length, 0);
  assert.deepEqual(result.invalidRows, [{ rowNumber: 2, episodeCode: '70711.01.02' }]);
});

test('fails closed if required episode columns are missing', async () => {
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: provider([], ['کد قسمت', 'اسم فیلم']) });
  await assert.rejects(reader.listEpisodes('70711'), (error) =>
    error.code === 'EPISODE_COLUMNS_UNAVAILABLE' &&
    error.missingHeaders.includes('کد سریال') &&
    error.missingHeaders.includes('Telegram File ID'));
});

test('rejects invalid parent series codes before reading sheet', async () => {
  let reads = 0;
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: { async readSheet() { reads += 1; return { headers, rows: [] }; } } });
  await assert.rejects(reader.listEpisodes('7071'), /Invalid parent series code/);
  assert.equal(reads, 0);
});
