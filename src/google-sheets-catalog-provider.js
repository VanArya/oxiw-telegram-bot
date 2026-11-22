'use strict';

const SHEETS = new Set(['سینمایی', 'سریال']);
const { markCatalogProviderKind } = require('./catalog-provider-kind');
const {
  classifyCatalogDependencyError,
  createCatalogDataValidationError,
} = require('./catalog-operational-errors');

function assertSheetClient(sheetsClient) {
  if (
    !sheetsClient ||
    typeof sheetsClient.spreadsheets?.values?.get !== 'function' || typeof sheetsClient.spreadsheets?.values?.append !== 'function'
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
    async appendEpisode(input) {
      const snapshot = await provider.readSheet('سریال');
      const headers = snapshot.headers;
      const codeHeader = headers.includes('کد قسمت') ? 'کد قسمت' : (headers.includes('کد سیستم') ? 'کد سیستم' : null);
      const parentHeader = headers.includes('کد سریال') ? 'کد سریال' : (headers.includes('کد سریال مادر') ? 'کد سریال مادر' : null);
      const fileHeader = headers.includes('Telegram File ID') ? 'Telegram File ID' : null;
      if (!codeHeader || !parentHeader || !fileHeader || !headers.includes('اسم فیلم') || !headers.includes('سازنده')) {
        const error = new Error('Required episode columns missing'); error.code = 'EPISODE_COLUMNS_UNAVAILABLE'; throw error;
      }
      const parentIndex = headers.indexOf(parentHeader); const codeIndex = headers.indexOf(codeHeader);
      if (!snapshot.rows.some(row => String(row[parentIndex] || '').trim() === input.seriesCode ||
        String(row[headers.indexOf('کد سیستم')] || '').trim() === input.seriesCode)) {
        const error = new Error('Parent series not found'); error.code = 'EPISODE_PARENT_NOT_FOUND'; throw error;
      }
      if (snapshot.rows.some(row => String(row[codeIndex] || '').trim() === input.code)) {
        const error = new Error('Episode duplicate'); error.code = 'EPISODE_DUPLICATE'; throw error;
      }
      const values = headers.map(header => header === codeHeader ? input.code :
        header === parentHeader ? input.seriesCode : header === fileHeader ? input.telegramFileId.trim() :
        header === 'اسم فیلم' ? (input.title?.trim() || ('فصل ' + input.season + ' قسمت ' + input.episode)) :
        header === 'سازنده' ? input.country : header === 'نوع' ? 'قسمت' : '');
      try {
        await sheetsClient.spreadsheets.values.append({ spreadsheetId, range: quoteSheetRange('سریال'),
          valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] } });
      } catch (error) { throw classifyCatalogDependencyError('sheets', 'sheet_append', error, 'Unable to append episode row.'); }
      return { episodeCode: input.code, parentSeriesCode: input.seriesCode, season: input.season,
        episode: input.episode, title: input.title || '', country: input.country };
    },
  };
  return Object.freeze(markCatalogProviderKind(provider, 'google-sheets'));
}

module.exports = { createGoogleSheetsCatalogProvider };
