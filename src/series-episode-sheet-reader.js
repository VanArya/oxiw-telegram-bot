'use strict';

const { parseSeriesEpisodeCode } = require('./series-episode-code');
const { createSeriesEpisodeRecord } = require('./series-episode-record');

const REQUIRED_HEADERS = Object.freeze(['کد سیستم', 'کد سریال مادر', 'لینک تلگرام']);

function createSeriesEpisodeSheetReader({ sheetProvider } = {}) {
  if (!sheetProvider || typeof sheetProvider.readSheet !== 'function') {
    throw new TypeError('A catalog sheet reader is required.');
  }

  return Object.freeze({
    async listEpisodes(parentSeriesCode) {
      if (typeof parentSeriesCode !== 'string' || !/^\\d{5}$/.test(parentSeriesCode)) {
        throw new TypeError('Invalid parent series code.');
      }
      const snapshot = await sheetProvider.readSheet('سریال');
      if (!snapshot || !Array.isArray(snapshot.headers) || !Array.isArray(snapshot.rows)) {
        throw new TypeError('Invalid series sheet snapshot.');
      }
      const missingHeaders = REQUIRED_HEADERS.filter((header) => !snapshot.headers.includes(header));
      if (missingHeaders.length) {
        const error = new Error('Episode sheet columns are not configured.');
        error.code = 'EPISODE_COLUMNS_UNAVAILABLE';
        error.missingHeaders = missingHeaders;
        throw error;
      }
      const records = snapshot.rows.map((row, index) => ({
        rowNumber: index + 2,
        record: Object.fromEntries(snapshot.headers.map((header, column) => [header, row[column] ?? ''])),
      }));
      const episodes = [];
      const invalidRows = [];
      for (const { rowNumber, record } of records) {
        try {
          const parsed = parseSeriesEpisodeCode(record['کد سیستم']);
          if (!parsed) continue;
          const episode = createSeriesEpisodeRecord(record);
          if (episode.parentSeriesCode !== parentSeriesCode) continue;
          episodes.push(Object.freeze({ ...episode, rowNumber }));
        } catch {
          // Rows with dotted episode-code patterns are reported; ordinary series codes are ignored.
          if (typeof record['کد سیستم'] === 'string' && /^\\d{5}\\.\\d{2}\\.\\d{2}$/.test(record['کد سیستم'].trim())) {
            invalidRows.push(Object.freeze({ rowNumber, systemCode: record['کد سیستم'] }));
          }
        }
      }
      episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
      return Object.freeze({ episodes: Object.freeze(episodes), invalidRows: Object.freeze(invalidRows) });
    },
  });
}

module.exports = { createSeriesEpisodeSheetReader, REQUIRED_HEADERS };
