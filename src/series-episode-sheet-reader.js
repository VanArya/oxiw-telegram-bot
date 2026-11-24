'use strict';

const crypto = require('node:crypto');
const { parseSeriesEpisodeCode } = require('./series-episode-code');
const { mapSeriesEpisodeRecord } = require('./series-episode-record');

const REQUIRED_HEADERS = Object.freeze(['کد سریال', 'کد قسمت', 'Telegram File ID']);

function resolveEpisodeLayout(headers) {
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
    .find((header) => headers.includes(header)) || null;
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

  return { parentCodeHeader, episodeCodeHeader, fileHeader };
}

function rowToRecord(headers, row) {
  return Object.fromEntries(headers.map((header, column) => [header, row[column] ?? '']));
}

function createSeriesEpisodeSheetReader({ sheetProvider } = {}) {
  if (!sheetProvider || typeof sheetProvider.readSheet !== 'function') {
    throw new TypeError('A catalog sheet reader is required.');
  }

  async function readAllEpisodes() {
    const snapshot = await sheetProvider.readSheet('سریال');
    if (!snapshot || !Array.isArray(snapshot.headers) || !Array.isArray(snapshot.rows)) {
      throw new TypeError('Invalid series sheet snapshot.');
    }

    const headers = snapshot.headers;
    const { parentCodeHeader, episodeCodeHeader, fileHeader } = resolveEpisodeLayout(headers);
    const records = snapshot.rows.map((row, index) => ({
      rowNumber: index + 2,
      record: rowToRecord(headers, row),
    }));

    // Resolve parent titles from the series rows in the same sheet. In the
    // current layout the parent is "کد سریال"; older layouts used "کد سیستم".
    const parentTitleByCode = new Map();
    const legacyParentHeader = parentCodeHeader === 'کد سریال'
      ? 'کد سریال'
      : (headers.includes('کد سیستم') ? 'کد سیستم' : parentCodeHeader);
    for (const { record } of records) {
      const candidateCode = String(record[legacyParentHeader] ?? '').normalize('NFC').trim();
      const hasEpisodeCode = typeof record[episodeCodeHeader] === 'string' &&
        /^\d{5}\.\d{2}\.\d{2}$/.test(record[episodeCodeHeader].trim());
      const title = typeof record['اسم فیلم'] === 'string' ? record['اسم فیلم'].trim() : '';
      if (!hasEpisodeCode && /^\d{5}$/.test(candidateCode) && title) {
        parentTitleByCode.set(candidateCode, title);
      }
    }

    const episodes = [];
    const invalidRows = [];
    for (const { rowNumber, record } of records) {
      const rawCode = typeof record[episodeCodeHeader] === 'string'
        ? record[episodeCodeHeader].trim()
        : '';
      if (!/^\d{5}\.\d{2}\.\d{2}$/.test(rawCode)) continue;

      try {
        const parsed = parseSeriesEpisodeCode(rawCode);
        if (!parsed) throw new TypeError('Invalid episode code.');
        const episode = mapSeriesEpisodeRecord(record);
        const fileValue = String(record[fileHeader] ?? '').trim();
        episodes.push(Object.freeze({
          ...episode,
          seriesCode: episode.parentSeriesCode,
          seriesTitle: parentTitleByCode.get(episode.parentSeriesCode) || 'سریال بدون عنوان',
          episodeCode: episode.systemCode,
          episodeTitle: episode.episodeTitle || 'بدون عنوان',
          rowNumber,
          sourceVersion: crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url'),
          hasTelegramFile: Boolean(fileValue),
        }));
      } catch {
        const parentValue = String(record[parentCodeHeader] ?? '').normalize('NFC').trim();
        if (/^\d{5}$/.test(parentValue) && parentValue === String(record[parentCodeHeader] ?? '').trim()) {
          invalidRows.push(Object.freeze({ rowNumber, systemCode: rawCode }));
        }
      }
    }

    episodes.sort((a, b) =>
      a.seriesCode.localeCompare(b.seriesCode) ||
      a.season - b.season ||
      a.episode - b.episode);
    return { episodes, invalidRows };
  }

  return Object.freeze({
    async listEpisodes(parentSeriesCode) {
      if (typeof parentSeriesCode !== 'string' || !/^\d{5}$/.test(parentSeriesCode)) {
        throw new TypeError('Invalid parent series code.');
      }
      const result = await readAllEpisodes();
      const episodes = result.episodes.filter((episode) => episode.seriesCode === parentSeriesCode);
      const invalidRows = result.invalidRows.filter((row) => {
        const codeParent = row.systemCode.slice(0, 5);
        return codeParent === parentSeriesCode;
      });
      return Object.freeze({
        episodes: Object.freeze(episodes),
        invalidRows: Object.freeze(invalidRows),
      });
    },
    async getEpisode(episodeCode) {
      if (typeof episodeCode !== 'string' || !/^\\d{5}\\.\\d{2}\\.\\d{2}$/.test(episodeCode)) {
        throw new TypeError('Invalid episode code.');
      }
      const snapshot = await sheetProvider.readSheet('سریال');
      if (!snapshot || !Array.isArray(snapshot.headers) || !Array.isArray(snapshot.rows)) {
        throw new TypeError('Invalid series sheet snapshot.');
      }
      const { episodeCodeHeader, fileHeader } = resolveEpisodeLayout(snapshot.headers);
      const index = snapshot.headers.indexOf(episodeCodeHeader);
      const matches = snapshot.rows.map((row, rowIndex) => ({
        rowNumber: rowIndex + 2,
        row,
        record: rowToRecord(snapshot.headers, row),
      })).filter(({ row }) => String(row[index] ?? '').normalize('NFC').trim() === episodeCode);
      if (matches.length !== 1) return null;
      const { rowNumber, record } = matches[0];
      const episode = mapSeriesEpisodeRecord(record);
      const all = await readAllEpisodes();
      const projected = all.episodes.find((item) => item.episodeCode === episodeCode);
      return Object.freeze({
        episodeCode,
        seriesCode: episode.parentSeriesCode,
        seriesTitle: projected?.seriesTitle || 'سریال بدون عنوان',
        season: episode.season,
        episode: episode.episode,
        episodeTitle: episode.episodeTitle || 'بدون عنوان',
        sourceRowNumber: rowNumber,
        sourceVersion: crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url'),
        fileHeader,
        fields: Object.freeze({
          title: String(record['اسم فیلم'] ?? ''),
          country: String(record['سازنده'] ?? ''),
          telegramFileId: String(record[fileHeader] ?? ''),
        }),
      });
    },
    async listAllEpisodes() {
      const result = await readAllEpisodes();
      const episodes = result.episodes.map((episode) => {
        const { telegramFileId, telegramUrl, ...safeEpisode } = episode;
        return Object.freeze(safeEpisode);
      });
      return Object.freeze({
        episodes: Object.freeze(episodes),
        invalidRows: Object.freeze(result.invalidRows),
      });
    },
  });
}

module.exports = { createSeriesEpisodeSheetReader, REQUIRED_HEADERS };
