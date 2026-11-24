'use strict';

const { parseSeriesEpisodeCode } = require('./series-episode-code');

// Canonical live-sheet columns. Legacy layouts are still mapped below.
const REQUIRED_EPISODE_FIELDS = Object.freeze(['کد سریال', 'کد قسمت', 'Telegram File ID']);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Episode field "${field}" is required.`);
  }
  return value.trim();
}

function looksLikeEpisodeCode(value) {
  return typeof value === 'string' && /^\d{5}\./.test(value.trim());
}

function mapSeriesEpisodeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('Episode source row must be an object.');
  }

  const codeField = ['کد قسمت', 'کد سیستم', 'کد سریال']
    .find((field) => looksLikeEpisodeCode(row[field]));
  if (!codeField) throw new TypeError('Episode code is missing.');

  const systemCode = requiredString(row[codeField], codeField);
  const parsed = parseSeriesEpisodeCode(systemCode);
  if (!parsed) throw new TypeError('Invalid episode system code.');

  const parentField = codeField === 'کد قسمت'
    ? (typeof row['کد سریال'] === 'string' && row['کد سریال'].trim()
      ? 'کد سریال' : 'کد سریال مادر')
    : (codeField === 'کد سیستم'
      ? (typeof row['کد سریال مادر'] === 'string' && row['کد سریال مادر'].trim()
        ? 'کد سریال مادر' : 'کد سریال')
      : 'کد سریال مادر');
  const parentSeriesCode = requiredString(row[parentField], parentField);
  if (parsed.parentSeriesCode !== parentSeriesCode) {
    throw new TypeError('Episode code parent does not match parent series code.');
  }

  const fileField = ['Telegram File ID', 'File ID', 'لینک تلگرام']
    .find((field) => typeof row[field] === 'string' && row[field].trim() !== '');
  if (!fileField) throw new TypeError('Episode Telegram file reference is required.');
  const fileValue = requiredString(row[fileField], fileField);
  if (fileField === 'لینک تلگرام' && !/^https?:\/\//i.test(fileValue)) {
    throw new TypeError('Episode Telegram link must be an http(s) URL.');
  }

  return Object.freeze({
    systemCode,
    parentSeriesCode,
    season: parsed.season,
    episode: parsed.episode,
    seasonNumber: parsed.seasonNumber,
    episodeNumber: parsed.episodeNumber,
    ...(fileField === 'لینک تلگرام' ? { telegramUrl: fileValue } : { telegramFileId: fileValue }),
    ...(typeof row['عنوان قسمت'] === 'string' && row['عنوان قسمت'].trim()
      ? { episodeTitle: row['عنوان قسمت'].trim() }
      : typeof row['اسم فیلم'] === 'string' && row['اسم فیلم'].trim()
        ? { episodeTitle: row['اسم فیلم'].trim() }
        : {}),
  });
}

function isSeriesEpisodeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  return ['کد قسمت', 'کد سیستم', 'کد سریال'].some((field) => looksLikeEpisodeCode(row[field]));
}

module.exports = {
  REQUIRED_EPISODE_FIELDS,
  mapSeriesEpisodeRecord,
  isSeriesEpisodeRecord,
};
