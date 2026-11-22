'use strict';

const { parseSeriesEpisodeCode } = require('./series-episode-code');

const REQUIRED_EPISODE_FIELDS = Object.freeze([
  'کد قسمت',
  'کد سریال',
  'Telegram File ID',
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Episode field "${field}" is required.`);
  }
  return value.trim();
}

/** Map a private episode row using the current Series sheet schema. */
function mapSeriesEpisodeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('Episode source row must be an object.');
  }
  const systemCode = requiredString(row['کد قسمت'], 'کد قسمت');
  const parentSeriesCode = requiredString(row['کد سریال'], 'کد سریال');
  const telegramFileId = requiredString(row['Telegram File ID'], 'Telegram File ID');
  const parsed = parseSeriesEpisodeCode(systemCode);
  if (!parsed) throw new TypeError('Invalid episode code.');
  if (parsed.parentSeriesCode !== parentSeriesCode) {
    throw new TypeError('Episode code parent does not match parent series code.');
  }
  return Object.freeze({
    episodeCode: systemCode,
    parentSeriesCode,
    season: parsed.season,
    episode: parsed.episode,
    seasonNumber: parsed.seasonNumber,
    episodeNumber: parsed.episodeNumber,
    telegramFileId,
    ...(typeof row['اسم فیلم'] === 'string' && row['اسم فیلم'].trim()
      ? { episodeTitle: row['اسم فیلم'].trim() }
      : {}),
  });
}

function isSeriesEpisodeRecord(row) {
  return Boolean(row && typeof row === 'object' && parseSeriesEpisodeCode(
    typeof row['کد قسمت'] === 'string' ? row['کد قسمت'] : '',
  ));
}

module.exports = { REQUIRED_EPISODE_FIELDS, mapSeriesEpisodeRecord, isSeriesEpisodeRecord };
