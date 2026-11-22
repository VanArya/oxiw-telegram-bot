'use strict';

const { parseSeriesEpisodeCode } = require('./series-episode-code');

const REQUIRED_EPISODE_FIELDS = Object.freeze([
  'کد سیستم',
  'کد سریال مادر',
  'لینک تلگرام',
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Episode field "${field}" is required.`);
  }
  return value.trim();
}

/**
 * Validates and maps a series-episode source row into a private episode record.
 * Episodes are not catalog items; callers must keep them out of public listing DTOs.
 */
function mapSeriesEpisodeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('Episode source row must be an object.');
  }
  const codeField = typeof row['کد سریال'] === 'string' ? 'کد سریال' : 'کد سیستم';
  const systemCode = requiredString(row[codeField], codeField);
  const parentSeriesCode = requiredString(row['کد سریال مادر'], 'کد سریال مادر');
  const telegramUrl = requiredString(row['لینک تلگرام'], 'لینک تلگرام');
  const parsed = parseSeriesEpisodeCode(systemCode);
  if (!parsed) throw new TypeError('Invalid episode system code.');
  if (parsed.parentSeriesCode !== parentSeriesCode) {
    throw new TypeError('Episode code parent does not match parent series code.');
  }
  if (!/^https?:\/\//i.test(telegramUrl)) {
    throw new TypeError('Episode Telegram link must be an http(s) URL.');
  }
  return Object.freeze({
    systemCode,
    parentSeriesCode,
    season: parsed.season,
    episode: parsed.episode,
    seasonNumber: parsed.seasonNumber,
    episodeNumber: parsed.episodeNumber,
    telegramUrl,
    ...(typeof row['عنوان قسمت'] === 'string' && row['عنوان قسمت'].trim()
      ? { episodeTitle: row['عنوان قسمت'].trim() }
      : {}),
  });
}

function isSeriesEpisodeRecord(row) {
  const code = row && typeof row === 'object'
    ? (typeof row['کد سریال'] === 'string' ? row['کد سریال'] : row['کد سیستم'])
    : '';
  return Boolean(parseSeriesEpisodeCode(typeof code === 'string' ? code : ''));
}


module.exports = {
  REQUIRED_EPISODE_FIELDS,
  mapSeriesEpisodeRecord,
  isSeriesEpisodeRecord,
};
