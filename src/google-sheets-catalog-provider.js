'use strict';

const crypto = require('node:crypto');
const SHEETS = new Set(['سینمایی', 'سریال']);
const EDITABLE_COLUMNS = Object.freeze({
  title: 'اسم فیلم', releaseYear: 'سال', startYear: 'سال شروع', endYear: 'سال پایان',
  seasonsAndEpisodes: 'تعداد فصل و قسمت', synopsis: 'خلاصه داستان', cast: 'بازیگران',
  language: 'زبان', rating: 'امتیاز', trailerUrl: 'لینک تریلر', posterUrl: 'پوستر فیلم',
});
const { markCatalogProviderKind } = require('./catalog-provider-kind');
const {
  classifyCatalogDependencyError,
  createCatalogDataValidationError,
} = require('./catalog-operational-errors');

function assertSheetClient(sheetsClient) {
  if (
    !sheetsClient ||
    typeof sheetsClient.spreadsheets?.values?.get !== 'function' ||
    typeof sheetsClient.spreadsheets?.values?.batchUpdate !== 'function'
  ) {
    throw new TypeError('A Sheets values client with read and batch-update access is required.');
  }
}

function columnLetter(number) {
  let value = number;
  let result = '';
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

function quoteSheetRange(sheetName) {
  return `'${sheetName.replaceAll("'", "''")}'`;
}

function createGoogleSheetsCatalogProvider({ sheetsClient, spreadsheetId }) {
  assertSheetClient(sheetsClient);
  if (typeof spreadsheetId !== 'string' || spreadsheetId.trim() === '') {
    throw new TypeError('A Spreadsheet ID is required.');
  }

  const provider = {
    async readSheet(sheetName) {
      if (!SHEETS.has(sheetName)) {
        throw new RangeError('Unsupported catalog sheet.');
      }

      let response;
      try {
        response = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: quoteSheetRange(sheetName),
        });
      } catch (error) {
        throw classifyCatalogDependencyError(
          'sheets', 'sheet_read', error, 'Unable to read catalog sheet.',
        );
      }

      const values = response?.data?.values;
      if (values === undefined) {
        return { headers: [], rows: [] };
      }
      if (!Array.isArray(values) || values.some((row) => !Array.isArray(row))) {
        throw createCatalogDataValidationError(
          'sheets', 'sheet_response_validation', 'Invalid catalog sheet response.',
        );
      }
      if (values.length === 0) {
        return { headers: [], rows: [] };
      }

      const headers = values[0];
      if (headers.some((header) => typeof header !== 'string')) {
        throw createCatalogDataValidationError(
          'sheets', 'sheet_response_validation', 'Invalid catalog sheet header row.',
        );
      }

      return {
        headers: [...headers],
        rows: values.slice(1).map((row) => [...row]),
      };
    },
  };
  let writeQueue = Promise.resolve();
  provider.updateCatalogRow = async function updateCatalogRow({
    sheetName, systemCode, expectedVersion, fields,
  } = {}) {
    if (!SHEETS.has(sheetName) || typeof systemCode !== 'string' || !systemCode.trim() ||
        typeof expectedVersion !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(expectedVersion) ||
        !fields || typeof fields !== 'object' || Array.isArray(fields) ||
        Object.keys(fields).length === 0 ||
        Object.keys(fields).some((key) => !Object.hasOwn(EDITABLE_COLUMNS, key))) {
      throw Object.assign(new Error('Invalid catalog row update.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet(sheetName);
      const codeIndex = snapshot.headers.indexOf('کد سیستم');
      if (codeIndex < 0) throw new Error('Catalog identity column is unavailable.');
      const matches = snapshot.rows.map((row, index) => ({ row, index }))
        .filter(({ row }) => String(row[codeIndex] ?? '').trim() === systemCode.trim());
      if (matches.length !== 1) {
        throw Object.assign(new Error('Catalog row identity is missing or ambiguous.'), { code: 'ROW_NOT_FOUND' });
      }
      const { row, index } = matches[0];
      const record = Object.fromEntries(snapshot.headers.map((header, i) => [header, row[i] ?? '']));
      const currentVersion = crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url');
      if (currentVersion !== expectedVersion) {
        throw Object.assign(new Error('Catalog row changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      const data = [];
      for (const [field, value] of Object.entries(fields)) {
        const header = EDITABLE_COLUMNS[field];
        const columnIndex = snapshot.headers.indexOf(header);
        if (columnIndex < 0) throw Object.assign(new Error('Editable catalog column is unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
        data.push({
          range: `${quoteSheetRange(sheetName)}!${columnLetter(columnIndex + 1)}${index + 2}`,
          values: [[value]],
        });
      }
      try {
        await sheetsClient.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data },
        });
      } catch (error) {
        throw classifyCatalogDependencyError('sheets', 'sheet_write', error, 'Unable to update catalog row.');
      }
      const updatedRecord = { ...record };
      for (const [field, value] of Object.entries(fields)) updatedRecord[EDITABLE_COLUMNS[field]] = String(value);
      return {
        sourceVersion: crypto.createHash('sha256').update(JSON.stringify(updatedRecord)).digest('base64url'),
        rowNumber: index + 2,
      };
    };
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };
  return Object.freeze(markCatalogProviderKind(provider, 'google-sheets'));
}

module.exports = { createGoogleSheetsCatalogProvider };
