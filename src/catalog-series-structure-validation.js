'use strict';

const { isCanonicalContentId } = require('./catalog-metadata-validation');

const LIFECYCLE_STATUSES = new Set(['active', 'disabled']);
const MAX_SEASON_NUMBER = 1000;
const MAX_EPISODE_NUMBER = 10000;
const MAX_DOWNLOAD_LINKS = 20;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class CatalogSeriesStructureInputError extends Error {
  constructor(code = 'INVALID_INPUT') {
    super('Invalid series structure input.');
    this.name = 'CatalogSeriesStructureInputError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value, maximum, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximum || value.trim() === '') {
    throw new CatalogSeriesStructureInputError(`INVALID_${field.toUpperCase()}`);
  }
  return value.trim();
}

function validateSeriesId(seriesId) {
  if (typeof seriesId !== 'string' || !isCanonicalContentId(seriesId) || !seriesId.startsWith('series:')) {
    throw new CatalogSeriesStructureInputError('INVALID_SERIES_ID');
  }
  return seriesId;
}

function seasonDocumentId(seasonNumber) {
  return `season-${seasonNumber}`;
}

function episodeDocumentId(episodeNumber) {
  return `episode-${episodeNumber}`;
}

function validateSeason(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => (
    !['seasonNumber', 'title', 'description', 'lifecycleStatus'].includes(key)
  ))) throw new CatalogSeriesStructureInputError();
  if (!Number.isSafeInteger(value.seasonNumber) || value.seasonNumber < 1 ||
      value.seasonNumber > MAX_SEASON_NUMBER ||
      (value.lifecycleStatus !== undefined && !LIFECYCLE_STATUSES.has(value.lifecycleStatus))) {
    throw new CatalogSeriesStructureInputError('INVALID_SEASON');
  }
  return {
    seasonNumber: value.seasonNumber,
    ...(value.title === undefined ? {} : { title: optionalText(value.title, 200, 'season_title') }),
    ...(value.description === undefined ? {} : { description: optionalText(value.description, 10000, 'season_description') }),
    lifecycleStatus: value.lifecycleStatus ?? 'active',
  };
}

function validateDownloadLinks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DOWNLOAD_LINKS) {
    throw new CatalogSeriesStructureInputError('INVALID_DOWNLOAD_LINKS');
  }
  const ids = new Set();
  return value.map((link, index) => {
    if (!isRecord(link) || Object.keys(link).some((key) => (
      !['id', 'label', 'url', 'sizeBytes', 'sortOrder', 'enabled'].includes(key)
    ))) throw new CatalogSeriesStructureInputError('INVALID_DOWNLOAD_LINK');
    if (typeof link.id !== 'string' || !ID_PATTERN.test(link.id) || ids.has(link.id) ||
        typeof link.label !== 'string' || link.label.trim() === '' || link.label.length > 80 ||
        typeof link.url !== 'string' || link.url.trim() === '' || link.url.length > 2000 ||
        (link.sizeBytes !== undefined && (!Number.isSafeInteger(link.sizeBytes) || link.sizeBytes < 0)) ||
        (link.sortOrder !== undefined && (!Number.isSafeInteger(link.sortOrder) || link.sortOrder < 0)) ||
        (link.enabled !== undefined && typeof link.enabled !== 'boolean')) {
      throw new CatalogSeriesStructureInputError('INVALID_DOWNLOAD_LINK');
    }
    ids.add(link.id);
    return {
      id: link.id,
      label: link.label.trim(),
      url: link.url.trim(),
      ...(link.sizeBytes === undefined ? {} : { sizeBytes: link.sizeBytes }),
      sortOrder: link.sortOrder ?? index,
      enabled: link.enabled ?? true,
    };
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

function validateEpisode(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => (
    !['episodeNumber', 'title', 'description', 'releaseDate', 'lifecycleStatus', 'downloadLinks'].includes(key)
  ))) throw new CatalogSeriesStructureInputError();
  if (!Number.isSafeInteger(value.episodeNumber) || value.episodeNumber < 1 ||
      value.episodeNumber > MAX_EPISODE_NUMBER ||
      (value.lifecycleStatus !== undefined && !LIFECYCLE_STATUSES.has(value.lifecycleStatus)) ||
      (value.releaseDate !== undefined && (
        typeof value.releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.releaseDate) ||
        !Number.isFinite(Date.parse(`${value.releaseDate}T00:00:00.000Z`)) ||
        new Date(`${value.releaseDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.releaseDate
      ))) throw new CatalogSeriesStructureInputError('INVALID_EPISODE');
  return {
    episodeNumber: value.episodeNumber,
    ...(value.title === undefined ? {} : { title: optionalText(value.title, 200, 'episode_title') }),
    ...(value.description === undefined ? {} : { description: optionalText(value.description, 10000, 'episode_description') }),
    ...(value.releaseDate === undefined ? {} : { releaseDate: value.releaseDate }),
    lifecycleStatus: value.lifecycleStatus ?? 'active',
    downloadLinks: validateDownloadLinks(value.downloadLinks),
  };
}

module.exports = {
  CatalogSeriesStructureInputError,
  LIFECYCLE_STATUSES,
  MAX_DOWNLOAD_LINKS,
  MAX_EPISODE_NUMBER,
  MAX_SEASON_NUMBER,
  episodeDocumentId,
  seasonDocumentId,
  validateDownloadLinks,
  validateEpisode,
  validateSeason,
  validateSeriesId,
};
