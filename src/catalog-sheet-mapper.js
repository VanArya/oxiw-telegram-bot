'use strict';

const MOVIE_SHEET = 'سینمایی';
const SERIES_SHEET = 'سریال';
const YEAR_MIN = 1800;
const YEAR_MAX = 3000;
const { createCatalogContentId } = require('./catalog-content-identity');
const { isPubliclyVisible } = require('./catalog-core');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(row, fieldName) {
  const value = row[fieldName];
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isFinite(value)) ||
    String(value).trim() === ''
  ) {
    throw new TypeError(`Missing or invalid required field: ${fieldName}`);
  }
  return String(value).trim();
}

function optionalYear(row, fieldName) {
  const value = row[fieldName];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const year = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{4}$/.test(value.trim())
      ? Number(value.trim())
      : NaN;

  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) {
    throw new TypeError(`Invalid year field: ${fieldName}`);
  }
  return year;
}

function mapCatalogSheetRow(sheetName, row) {
  if (!isRecord(row)) {
    throw new TypeError('Row must be an object keyed by sheet headers.');
  }

  let kind;
  if (sheetName === MOVIE_SHEET) {
    kind = 'movie';
  } else if (sheetName === SERIES_SHEET) {
    kind = 'series';
  } else {
    throw new TypeError('Unsupported catalog sheet.');
  }

  const content = {
    id: createCatalogContentId(kind, requiredText(row, 'کد سیستم')),
    kind,
    title: requiredText(row, 'اسم فیلم'),
  };
  if (kind === 'movie') {
    const releaseYear = optionalYear(row, 'سال');
    if (releaseYear !== undefined) {
      content.releaseYear = releaseYear;
    }
  } else {
    const startYear = optionalYear(row, 'سال شروع');
    const rawEndYear = row['سال پایان'];
    const isOngoing = typeof rawEndYear === 'string' &&
      rawEndYear.normalize('NFC').trim() === 'در حال پخش';
    const endYear = isOngoing ? undefined : optionalYear(row, 'سال پایان');
    if (startYear !== undefined && endYear !== undefined && startYear > endYear) {
      throw new TypeError('Series start year cannot be after end year.');
    }
    content.seriesMetadata = {};
    if (startYear !== undefined) content.seriesMetadata.startYear = startYear;
    if (endYear !== undefined) {
      content.seriesMetadata.endYear = endYear;
      content.seriesMetadata.isOngoing = false;
    }
    if (isOngoing) content.seriesMetadata.isOngoing = true;
    if (row['تعداد فصل و قسمت'] !== undefined) {
      content.seriesMetadata.seasonsAndEpisodes = row['تعداد فصل و قسمت'];
    }
  }

  // Keep the source row for a controlled migration adapter. Never expose this
  // object through the public Catalog API or log it; it may contain file IDs.
  return {
    content,
    mappingWarnings: [],
    sourceRecord: { ...row },
    sourceSheet: sheetName,
  };
}

function toPublicCatalogDto(mappedRecord, { countryLabels = {}, genreLabels = {} } = {}) {
  const content = mappedRecord && mappedRecord.content;
  if (
    !isRecord(content) ||
    !isPubliclyVisible(content) ||
    typeof content.id !== 'string' ||
    !['movie', 'series'].includes(content.kind) ||
    typeof content.title !== 'string'
  ) {
    return null;
  }

  const dto = { id: content.id, kind: content.kind, title: content.title };
  if (Number.isInteger(content.releaseYear)) {
    dto.releaseYear = content.releaseYear;
  }
  if (
    Array.isArray(content.countryIds) &&
    content.countryIds.every((id) => Object.hasOwn(countryLabels, id))
  ) {
    dto.countries = content.countryIds.map((id) => ({ id, labelFa: countryLabels[id] }));
  }
  if (
    Array.isArray(content.genreIds) &&
    content.genreIds.every((id) => Object.hasOwn(genreLabels, id))
  ) {
    dto.genres = content.genreIds.map((id) => ({ id, labelFa: genreLabels[id] }));
  }
  if (content.kind === 'series' && isRecord(content.seriesMetadata)) {
    dto.seriesMetadata = {};
    for (const field of ['startYear', 'endYear', 'isOngoing', 'seasonsAndEpisodes']) {
      if (content.seriesMetadata[field] !== undefined) {
        dto.seriesMetadata[field] = content.seriesMetadata[field];
      }
    }
  }
  return dto;
}

module.exports = { mapCatalogSheetRow, toPublicCatalogDto };
