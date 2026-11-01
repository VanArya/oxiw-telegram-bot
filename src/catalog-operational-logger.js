'use strict';

const crypto = require('node:crypto');
const { ERROR_CODES, VALID_STAGES } = require('./catalog-operational-errors');

const ROUTE = '/api/v1/catalog/items';
const EVENT = 'catalog_request_failed';
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAPPING_SHEETS = new Set(['سینمایی', 'سریال']);
const MAPPING_FIELDS = new Set([
  'system_code', 'title', 'movie_year', 'series_start_year',
  'series_end_year', 'series_year_range', 'unknown',
]);

function isSafeMappingDiagnostic(context) {
  return context && typeof context === 'object' && !Array.isArray(context) &&
    MAPPING_SHEETS.has(context.sheetName) &&
    Number.isSafeInteger(context.rowNumber) &&
    context.rowNumber >= 2 &&
    context.rowNumber <= 10000000 &&
    MAPPING_FIELDS.has(context.field);
}

function isSafeFailure(record) {
  return record && typeof record === 'object' &&
    REQUEST_ID_PATTERN.test(record.requestId) &&
    ['sheets', 'firestore', 'catalog'].includes(record.dependency) &&
    VALID_STAGES.has(record.stage) &&
    ERROR_CODES[record.dependency]?.includes(record.errorCode);
}

function createCatalogOperationalLogger({
  write = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (typeof write !== 'function') throw new TypeError('Logger writer must be a function.');

  return Object.freeze({
    logFailure(record) {
      try {
        if (!isSafeFailure(record)) return false;
        const safeRecord = {
          event: EVENT,
          requestId: record.requestId,
          route: ROUTE,
          dependency: record.dependency,
          stage: record.stage,
          errorCode: record.errorCode,
        };
        if (
          record.stage === 'sheet_row_mapping' &&
          isSafeMappingDiagnostic(record.diagnosticContext)
        ) {
          safeRecord.sheetName = record.diagnosticContext.sheetName;
          safeRecord.rowNumber = record.diagnosticContext.rowNumber;
          safeRecord.field = record.diagnosticContext.field;
        }

        const result = write(JSON.stringify(safeRecord));
        if (result && typeof result.then === 'function') result.catch(() => {});
        return true;
      } catch {
        return false;
      }
    },
  });
}

function reportCatalogRequestFailure(logger, record) {
  try {
    if (logger && typeof logger.logFailure === 'function') {
      const result = logger.logFailure(record);
      if (result && typeof result.then === 'function') result.catch(() => {});
    }
  } catch {
    // Diagnostics must never alter the API response.
  }
}

function createRequestId() {
  return crypto.randomUUID();
}

module.exports = {
  EVENT,
  ROUTE,
  createCatalogOperationalLogger,
  createRequestId,
  reportCatalogRequestFailure,
};
