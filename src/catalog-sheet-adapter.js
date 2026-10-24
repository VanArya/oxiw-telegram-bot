'use strict';

const {
  filterCatalogItems,
  getCategoryItems,
} = require('./catalog-core');
const {
  mapCatalogSheetRow,
  toPublicCatalogDto,
} = require('./catalog-sheet-mapper');

const SHEETS = Object.freeze(['سینمایی', 'سریال']);
const REQUIRED_HEADERS = Object.freeze(['کد سیستم', 'اسم فیلم']);
const STATUS_HEADER = 'وضعیت انتشار';
const KNOWN_STATUSES = new Set(['draft', 'published', 'archived']);

function validateSnapshot(sheetName, snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.headers) ||
    !Array.isArray(snapshot.rows)
  ) {
    throw new TypeError(`Invalid sheet snapshot: ${sheetName}`);
  }

  if (
    snapshot.headers.some((header) => typeof header !== 'string' || header.trim() === '') ||
    new Set(snapshot.headers).size !== snapshot.headers.length
  ) {
    throw new TypeError(`Invalid or duplicate headers: ${sheetName}`);
  }

  const missing = REQUIRED_HEADERS.filter((header) => !snapshot.headers.includes(header));
  if (missing.length > 0) {
    throw new TypeError(`Missing required headers in ${sheetName}: ${missing.join(', ')}`);
  }

  if (snapshot.rows.some((row) => !Array.isArray(row) || row.length > snapshot.headers.length)) {
    throw new TypeError(`Invalid row structure: ${sheetName}`);
  }
}

function rowToRecord(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
}

function applyExplicitStatus(content, record, headers) {
  if (!headers.includes(STATUS_HEADER)) {
    return;
  }
  const value = record[STATUS_HEADER];
  if (typeof value === 'string' && KNOWN_STATUSES.has(value.trim())) {
    content.status = value.trim();
  }
}

function createCatalogSheetAdapter(provider) {
  if (!provider || typeof provider.readSheet !== 'function') {
    throw new TypeError('Provider must implement readSheet(sheetName).');
  }

  async function loadContents() {
    const snapshots = await Promise.all(SHEETS.map((sheetName) => provider.readSheet(sheetName)));
    const contents = [];

    snapshots.forEach((snapshot, sheetIndex) => {
      const sheetName = SHEETS[sheetIndex];
      validateSnapshot(sheetName, snapshot);

      snapshot.rows.forEach((row, rowIndex) => {
        const record = rowToRecord(snapshot.headers, row);
        let mapped;
        try {
          mapped = mapCatalogSheetRow(sheetName, record);
        } catch (error) {
          throw new TypeError(`Invalid catalog row in ${sheetName} at index ${rowIndex}.`, {
            cause: error,
          });
        }
        applyExplicitStatus(mapped.content, record, snapshot.headers);
        contents.push(mapped.content);
      });
    });

    return contents;
  }

  return Object.freeze({
    async listItems(filter) {
      const contents = await loadContents();
      return filterCatalogItems(contents, filter)
        .map((content) => toPublicCatalogDto({ content }))
        .filter(Boolean);
    },

    async listCategoryItems(category) {
      const contents = await loadContents();
      return getCategoryItems(contents, category)
        .map((content) => toPublicCatalogDto({ content }))
        .filter(Boolean);
    },
  });
}

module.exports = { createCatalogSheetAdapter };
