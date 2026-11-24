'use strict';

const { parseSeriesEpisodeCode } = require('./series-episode-code');
const { mapSeriesEpisodeRecord } = require('./series-episode-record');

const REQUIRED_HEADERS = Object.freeze(['کد سریال', 'کد قسمت', 'Telegram File ID']);

function createSeriesEpisodeSheetReader({ sheetProvider } = {}) {
  if (!sheetProvider || typeof sheetProvider.readSheet !== 'function') {
    throw new TypeError('A catalog sheet reader is required.');
  }

  return Object.freeze({
    async listEpisodes(parentSeriesCode) {
      if (typeof parentSeriesCode !== 'string' || !/^\d{5}$/.test(parentSeriesCode)) {
        throw new TypeError('Invalid parent series code.');
      }
      const snapshot = await sheetProvider.readSheet('سریال');
      if (!snapshot || !Array.isArray(snapshot.headers) || !Array.isArray(snapshot.rows)) {
        throw new TypeError('Invalid series sheet snapshot.');
      }

      const headers = snapshot.headers;
      let episodeCodeHeader;
      let parentCodeHeader;
      if (headers.includes('کد قسمت') && headers.includes('کد سریال')) {
        episodeCodeHeader = 'کد قسمت';
        parentCodeHeader = 'کد سریال';
      } else if (headers.includes('کد سیستم') && headers.includes('کد سریال مادر')) {
        episodeCodeHeader = 'کد سیستم';
        parentCodeHeader = 'کد سریال مادر';
      } else if (headers.includes('کد سریال') && headers.includes('کد سریال مادر')) {
        episodeCodeHeader = 'کد سریال';
        parentCodeHeader = 'کد سریال مادر';
      }

      const fileHeader = ['Telegram File ID', 'File ID', 'لینک تلگرام']
        .find((header) => headers.includes(header));
      const missingHeaders = [
        ...(parentCodeHeader ? [] : ['کد سریال']),
        ...(episodeCodeHeader ? [] : ['کد قسمت']),
        ...(fileHeader ? [] : ['Telegram File ID']),
      ];
      if (missingHeaders.length) {
        const error = new Error('Episode sheet columns are not configured.');
        error.code = 'EPISODE_COLUMNS_UNAVAILABLE';
        error.missingHeaders = missingHeaders;
        throw error;
      }

      const records = snapshot.rows.map((row, index) => ({
        rowNumber: index + 2,
        record: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])),
      }));
      const episodes = [];
      const invalidRows = [];
      for (const { rowNumber, record } of records) {
        const rawCode = typeof record[episodeCodeHeader] === 'string'
          ? record[episodeCodeHeader].trim()
          : '';
        if (!/^\d{5}\./.test(rawCode)) continue;

        try {
          const parsed = parseSeriesEpisodeCode(rawCode);
          if (!parsed) throw new TypeError('Invalid episode code.');
          const episode = mapSeriesEpisodeRecord(record);
          if (episode.parentSeriesCode !== parentSeriesCode) continue;
          episodes.push(Object.freeze({ ...episode, rowNumber }));
        } catch {
          const parentValue = record[parentCodeHeader];
          if (parentValue === parentSeriesCode) {
            invalidRows.push(Object.freeze({ rowNumber, systemCode: rawCode }));
          }
        }
      }
      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
      return Object.freeze({ episodes: Object.freeze(episodes), invalidRows: Object.freeze(invalidRows) });
    },
  });
}

module.exports = { createSeriesEpisodeSheetReader, REQUIRED_HEADERS };
