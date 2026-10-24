'use strict';

const MOVIE_SHEET = 'سینمایی';
const SERIES_SHEET = 'سریال';
const YEAR_MIN = 1800;
const YEAR_MAX = 3000;
const COUNTRY_COLUMN = 'کشور سازنده';
const COUNTRY_LABELS_FA = Object.freeze({
  IR: 'ایران',
  US: 'ایالات متحده',
});

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

function optionalCountryIds(row) {
  const value = row[COUNTRY_COLUMN];
  if (value === undefined || value === null || value === '') {
    return { countryIds: undefined, warnings: [] };
  }
  if (typeof value !== 'string') {
    return { countryIds: undefined, warnings: ['invalid-country-values'] };
  }

  const ids = value.split('|').map((part) => part.trim());
  if (
    ids.some((id) => !/^[A-Z]{2}$/.test(id) || !Object.hasOwn(COUNTRY_LABELS_FA, id))
  ) {
    return { countryIds: undefined, warnings: ['invalid-country-values'] };
  }

  return { countryIds: [...new Set(ids)], warnings: [] };
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
    id: requiredText(row, 'کد سیستم'),
    kind,
    title: requiredText(row, 'اسم فیلم'),
  };
  const countryResult = optionalCountryIds(row);
  if (countryResult.countryIds !== undefined) {
    content.countryIds = countryResult.countryIds;
  }

  if (kind === 'movie') {
    const releaseYear = optionalYear(row, 'سال');
    if (releaseYear !== undefined) {
      content.releaseYear = releaseYear;
    }
  } else {
    const startYear = optionalYear(row, 'سال شروع');
    const endYear = optionalYear(row, 'سال پایان');
    if (startYear !== undefined && endYear !== undefined && startYear > endYear) {
      throw new TypeError('Series start year cannot be after end year.');
    }
    content.seriesMetadata = {};
    if (startYear !== undefined) content.seriesMetadata.startYear = startYear;
    if (endYear !== undefined) content.seriesMetadata.endYear = endYear;
    if (row['تعداد فصل و قسمت'] !== undefined) {
      content.seriesMetadata.seasonsAndEpisodes = row['تعداد فصل و قسمت'];
    }
  }

  // Keep the source row for a controlled migration adapter. Never expose this
  // object through the public Catalog API or log it; it may contain file IDs.
  return {
    content,
    mappingWarnings: countryResult.warnings,
    sourceRecord: { ...row },
    sourceSheet: sheetName,
  };
}

function toPublicCatalogDto(mappedRecord) {
  const content = mappedRecord && mappedRecord.content;
  if (
    !isRecord(content) ||
    content.status !== 'published' ||
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
    content.countryIds.every((id) => Object.hasOwn(COUNTRY_LABELS_FA, id))
  ) {
    dto.countries = content.countryIds.map((id) => ({ id, labelFa: COUNTRY_LABELS_FA[id] }));
  }
  if (content.kind === 'series' && isRecord(content.seriesMetadata)) {
    dto.seriesMetadata = {};
    for (const field of ['startYear', 'endYear', 'seasonsAndEpisodes']) {
      if (content.seriesMetadata[field] !== undefined) {
        dto.seriesMetadata[field] = content.seriesMetadata[field];
      }
    }
  }
  return dto;
}

module.exports = { mapCatalogSheetRow, toPublicCatalogDto };
