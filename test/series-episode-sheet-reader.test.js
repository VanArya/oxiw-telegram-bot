'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSeriesEpisodeSheetReader } = require('../src/series-episode-sheet-reader');

const headers = [
  'اسم فیلم', 'نوع', 'سازنده', 'ژانر', 'کد سریال', 'کد قسمت',
  'سال شروع', 'سال پایان', 'تعداد فصل و قسمت', 'بازیگران',
  'خلاصه داستان', 'امتیاز', 'زبان', 'پیشنهادی', 'لینک تریلر',
  'پوستر فیلم', 'شناسه URL', 'Telegram File ID',
];
function provider(rows, customHeaders = headers) {
  return { async readSheet(sheetName) {
    assert.equal(sheetName, 'سریال');
    return { headers: [...customHeaders], rows: rows.map((row) => [...row]) };
  } };
}

test('reads only episodes for the selected parent in the live sheet layout', async () => {
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: provider([
    ['سریال مادر', 'سریال', 'ایران', 'درام', '70711', '', '2020', 'در حال پخش', '۱ فصل', '', '', '', '', '', '', '', '', ''],
    ['قسمت 13', 'قسمت', 'ایران', 'درام', '70711', '70711.01.13', '', '', '', '', '', '', '', '', '', '', '', 'file-13'],
    ['قسمت 1 فصل 2', 'قسمت', 'ایران', 'درام', '70711', '70711.02.01', '', '', '', '', '', '', '', '', '', '', '', 'file-201'],
    ['قسمت خارجی', 'قسمت', 'آمریکا', 'درام', '12345', '12345.01.01', '', '', '', '', '', '', '', '', '', '', '', 'file-x'],
  ]) });
  const result = await reader.listEpisodes('70711');
  assert.deepEqual(result.episodes.map((episode) => episode.systemCode), ['70711.01.13', '70711.02.01']);
  assert.deepEqual(result.episodes.map((episode) => episode.episodeTitle), ['قسمت 13', 'قسمت 1 فصل 2']);
  assert.deepEqual(result.episodes.map((episode) => episode.telegramFileId), ['file-13', 'file-201']);
  assert.equal(result.invalidRows.length, 0);
});

test('reports invalid current-layout episode rows only for the requested parent', async () => {
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: provider([
    ['قسمت نامعتبر', 'قسمت', 'ایران', 'درام', '70711', '70711.01.00', '', '', '', '', '', '', '', '', '', '', '', 'file-bad'],
    ['قسمت متعلق به سریال دیگر', 'قسمت', 'آمریکا', 'درام', '12345', '12345.01.01', '', '', '', '', '', '', '', '', '', '', '', 'file-x'],
    ['سریال مادر', 'سریال', 'ایران', 'درام', '70711', '', '2020', '', '', '', '', '', '', '', '', '', '', ''],
  ]) });
  const result = await reader.listEpisodes('70711');
  assert.equal(result.episodes.length, 0);
  assert.deepEqual(result.invalidRows, [{ rowNumber: 2, systemCode: '70711.01.00' }]);
});

test('fails closed if current live-sheet episode columns are missing', async () => {
  const shortHeaders = ['اسم فیلم', 'کد سریال', 'سازنده'];
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: provider([], shortHeaders) });
  await assert.rejects(reader.listEpisodes('70711'), (error) =>
    error.code === 'EPISODE_COLUMNS_UNAVAILABLE' &&
    error.missingHeaders.includes('کد قسمت') &&
    error.missingHeaders.includes('Telegram File ID'));
});

test('rejects invalid parent series codes before reading sheet', async () => {
  let reads = 0;
  const reader = createSeriesEpisodeSheetReader({
    sheetProvider: { async readSheet() { reads += 1; return { headers, rows: [] }; } },
  });
  await assert.rejects(reader.listEpisodes('7071'), /Invalid parent series code/);
  assert.equal(reads, 0);
});

test('lists episodes across all series with parent titles and without returning Telegram file IDs', async () => {
  const reader = createSeriesEpisodeSheetReader({ sheetProvider: provider([
    ['سریال یک', 'سریال', 'ایران', 'درام', '70711', '', '2020', '', '', '', '', '', '', '', '', '', '', ''],
    ['قسمت 13', 'قسمت', 'ایران', 'درام', '70711', '70711.01.13', '', '', '', '', '', '', '', '', '', '', '', 'private-file-1'],
    ['سریال دو', 'سریال', 'آمریکا', 'درام', '80808', '', '2021', '', '', '', '', '', '', '', '', '', '', ''],
    ['قسمت 1', 'قسمت', 'آمریکا', 'درام', '80808', '80808.01.01', '', '', '', '', '', '', '', '', '', '', '', 'private-file-2'],
  ]) });

  const result = await reader.listAllEpisodes();
  assert.equal(result.episodes.length, 2);
  assert.deepEqual(result.episodes.map((episode) => episode.seriesCode), ['70711', '80808']);
  assert.deepEqual(result.episodes.map((episode) => episode.seriesTitle), ['سریال یک', 'سریال دو']);
  assert.deepEqual(result.episodes.map((episode) => episode.episodeCode), ['70711.01.13', '80808.01.01']);
  assert.equal(result.episodes.every((episode) => episode.hasTelegramFile), true);
  assert.equal(JSON.stringify(result.episodes).includes('private-file-'), false);
});
