'use strict';

const SHEETS = new Set(['سینمایی', 'سریال']);
const { markCatalogProviderKind } = require('./catalog-provider-kind');

function assertSheetClient(sheetsClient) {
  if (
    !sheetsClient ||
    typeof sheetsClient.spreadsheets?.values?.get !== 'function'
  ) {
    throw new TypeError('A read-only Sheets values client is required.');
  }
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
      } catch {
        throw new Error('Unable to read catalog sheet.');
      }

      const values = response?.data?.values;
      if (values === undefined) {
        return { headers: [], rows: [] };
      }
      if (!Array.isArray(values) || values.some((row) => !Array.isArray(row))) {
        throw new TypeError('Invalid catalog sheet response.');
      }
      if (values.length === 0) {
        return { headers: [], rows: [] };
      }

      const headers = values[0];
      if (headers.some((header) => typeof header !== 'string')) {
        throw new TypeError('Invalid catalog sheet header row.');
      }

      return {
        headers: [...headers],
        rows: values.slice(1).map((row) => [...row]),
      };
    },
  };
  return Object.freeze(markCatalogProviderKind(provider, 'google-sheets'));
}

module.exports = { createGoogleSheetsCatalogProvider };
