'use strict';

const EPISODE_CODE_PATTERN = /^(\d{5})\.(\d{2})\.(\d{2})$/;

function parseSeriesEpisodeCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const match = EPISODE_CODE_PATTERN.exec(normalized);
  if (!match) return null;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (season < 1 || episode < 1) return null;
  return Object.freeze({
    code: normalized,
    parentSeriesCode: match[1],
    season,
    episode,
    seasonNumber: match[2],
    episodeNumber: match[3],
  });
}

function createSeriesEpisodeCode(parentSeriesCode, season, episode) {
  if (typeof parentSeriesCode !== 'string' || !/^\d{5}$/.test(parentSeriesCode)) {
    throw new TypeError('Parent series code must be exactly five digits.');
  }
  if (!Number.isInteger(season) || season < 1 || season > 99) {
    throw new RangeError('Season must be an integer between 1 and 99.');
  }
  if (!Number.isInteger(episode) || episode < 1 || episode > 99) {
    throw new RangeError('Episode must be an integer between 1 and 99.');
  }
  return `${parentSeriesCode}.${String(season).padStart(2, '0')}.${String(episode).padStart(2, '0')}`;
}

module.exports = {
  EPISODE_CODE_PATTERN,
  parseSeriesEpisodeCode,
  createSeriesEpisodeCode,
};
