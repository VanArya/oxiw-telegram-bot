'use strict';

const crypto = require('node:crypto');
const SHEETS = new Set(['سینمایی', 'سریال']);
const codeHeaderFor = (sheetName) => sheetName === 'سریال' ? 'کد سریال' : 'کد سیستم';

const { markCatalogProviderKind } = require('./catalog-provider-kind');
const {
  classifyCatalogDependencyError,
  createCatalogDataValidationError,
} = require('./catalog-operational-errors');

function assertSheetClient(sheetsClient) {
  if (
    !sheetsClient ||
    typeof sheetsClient.spreadsheets?.values?.get !== 'function' ||
    typeof sheetsClient.spreadsheets?.values?.batchUpdate !== 'function' ||
    typeof sheetsClient.spreadsheets?.values?.append !== 'function'
  ) {
    throw new TypeError('A Sheets values client with read, append, and batch-update access is required.');
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

      const headers = values[0].map((header) => typeof header === 'string' ? header.normalize('NFC').trim() : header);
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
        Object.keys(fields).some((key) => typeof key !== 'string' || !key.trim() || key === '__proto__' ||
          key.length > 200 || /[\u0000]/.test(key))) {
      throw Object.assign(new Error('Invalid catalog row update.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet(sheetName);
      const codeHeader = codeHeaderFor(sheetName);
      const codeIndex = snapshot.headers.indexOf(codeHeader);
      if (codeIndex < 0) throw new Error('Catalog identity column is unavailable.');
      const matches = snapshot.rows.map((row, index) => ({ row, index }))
        .filter(({ row }) => String(row[codeIndex] ?? '').trim() === systemCode.trim());
      if (matches.length !== 1) {
        throw Object.assign(new Error('Catalog row identity is missing or ambiguous.'), { code: 'ROW_NOT_FOUND' });
      }
      const { row, index } = matches[0];
      const record = Object.fromEntries(snapshot.headers.map((header, i) => [header, row[i] ?? '']));
      if (Object.hasOwn(fields, codeHeader)) {
        const nextCode = String(fields[codeHeader]).normalize('NFC').trim();
        if (!nextCode) throw Object.assign(new Error('Invalid system code.'), { code: 'INVALID_INPUT' });
        const duplicate = snapshot.rows.some((candidate, rowIndex) => rowIndex !== index &&
          String(candidate[codeIndex] ?? '').normalize('NFC').trim() === nextCode);
        if (duplicate) throw Object.assign(new Error('System code already exists.'), { code: 'ALREADY_EXISTS' });
      }
      const currentVersion = crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url');
      if (currentVersion !== expectedVersion) {
        throw Object.assign(new Error('Catalog row changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      const data = [];
      for (const [field, value] of Object.entries(fields)) {
        const header = field;
        const columnIndex = snapshot.headers.indexOf(header);
        if (columnIndex < 0) throw Object.assign(new Error('Editable catalog column is unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
        data.push({
          range: `${quoteSheetRange(sheetName)}!${columnLetter(columnIndex + 1)}${index + 2}`,
          values: [[field === codeHeader ? String(value).normalize('NFC').trim() : value]],
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
      for (const [field, value] of Object.entries(fields)) {
        updatedRecord[field] = field === codeHeader
          ? String(value).normalize('NFC').trim()
          : String(value);
      }
      if (Object.hasOwn(updatedRecord, codeHeader)) {
        updatedRecord[codeHeader] = String(updatedRecord[codeHeader]).normalize('NFC').trim();
      }
      return {
        sourceVersion: crypto.createHash('sha256').update(JSON.stringify(updatedRecord)).digest('base64url'),
        rowNumber: index + 2,
      };
    };
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };
  provider.getSheetSchema = async function getSheetSchema(sheetName) {
    const snapshot = await provider.readSheet(sheetName);
    return Object.freeze([...snapshot.headers]);
  };
  provider.createCatalogRow = async function createCatalogRow({ sheetName, fields } = {}) {
    if (!SHEETS.has(sheetName) || !fields || typeof fields !== 'object' || Array.isArray(fields) ||
        typeof fields[codeHeaderFor(sheetName)] !== 'string' || !fields[codeHeaderFor(sheetName)].trim() ||
        typeof fields['اسم فیلم'] !== 'string' || !fields['اسم فیلم'].trim()) {
      throw Object.assign(new Error('Invalid new catalog row.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet(sheetName);
      const codeHeader = codeHeaderFor(sheetName);
      if (!snapshot.headers.includes(codeHeader) || !snapshot.headers.includes('اسم فیلم')) {
        throw Object.assign(new Error('Required catalog columns are unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
      }
      if (Object.keys(fields).some((header) => !snapshot.headers.includes(header) || header === '__proto__')) {
        throw Object.assign(new Error('Unknown catalog column.'), { code: 'INVALID_INPUT' });
      }
      const code = fields[codeHeader].normalize('NFC').trim();
      const codeIndex = snapshot.headers.indexOf(codeHeader);
      if (snapshot.rows.some((row) => String(row[codeIndex] ?? '').normalize('NFC').trim() === code)) {
        throw Object.assign(new Error('Catalog system code already exists.'), { code: 'ALREADY_EXISTS' });
      }
      const values = snapshot.headers.map((header) => fields[header] === undefined ? '' : String(fields[header]));
      try {
        const response = await sheetsClient.spreadsheets.values.append({
          spreadsheetId,
          range: `${quoteSheetRange(sheetName)}!A:ZZZ`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [values] },
        });
        const updatedRecord = Object.fromEntries(snapshot.headers.map((header, index) => [header, values[index]]));
        const rowNumber = Number(/!A(\d+):/.exec(response?.data?.updates?.updatedRange || '')?.[1]) || snapshot.rows.length + 2;
        return {
          sourceVersion: crypto.createHash('sha256').update(JSON.stringify(updatedRecord)).digest('base64url'),
          rowNumber,
          record: updatedRecord,
        };
      } catch (error) {
        throw classifyCatalogDependencyError('sheets', 'sheet_append', error, 'Unable to create catalog row.');
      }
    };
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };
  provider.createSeriesEpisodeRow = async function createSeriesEpisodeRow({
    seriesCode, episodeCode, fields,
  } = {}) {
    if (typeof seriesCode !== 'string' || !/^\d{5}$/.test(seriesCode) ||
        typeof episodeCode !== 'string' || !/^\d{5}\.\d{2}\.\d{2}$/.test(episodeCode) ||
        !fields || typeof fields !== 'object' || Array.isArray(fields) ||
        Object.keys(fields).length === 0) {
      throw Object.assign(new Error('Invalid series episode row.'), { code: 'INVALID_INPUT' });
    }

    const operation = async () => {
      const snapshot = await provider.readSheet('سریال');
      const headers = snapshot.headers;
      // Current catalog layout stores the parent code in "کد سریال" and
      // the dotted episode identity in "کد قسمت". Legacy columns remain
      // readable for older sheets, but the current layout is preferred.
      const parentHeader = headers.includes('کد سریال')
        ? 'کد سریال'
        : headers.includes('کد سریال مادر') ? 'کد سریال مادر' : null;
      const episodeHeader = headers.includes('کد قسمت')
        ? 'کد قسمت'
        : headers.includes('کد سیستم') ? 'کد سیستم' : null;
      const fileHeader = ['Telegram File ID', 'File ID', 'لینک تلگرام']
        .find((header) => headers.includes(header)) || null;
      const required = [parentHeader, episodeHeader, 'اسم فیلم', fileHeader];
      if (required.some((header) => !header)) {
        throw Object.assign(new Error('Series episode columns are unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
      }
      if (fields[parentHeader] !== seriesCode || fields[episodeHeader] !== episodeCode ||
          typeof fields['اسم فیلم'] !== 'string' || !fields['اسم فیلم'].trim() ||
          typeof fields[fileHeader] !== 'string' || !fields[fileHeader].trim() ||
          Object.keys(fields).some((header) => !headers.includes(header) || header === '__proto__')) {
        throw Object.assign(new Error('Invalid series episode fields.'), { code: 'INVALID_INPUT' });
      }
      const parentIndex = headers.indexOf(parentHeader);
      const episodeIndex = headers.indexOf(episodeHeader);
      const parentExists = snapshot.rows.some((row) =>
        String(row[parentIndex] ?? '').normalize('NFC').trim() === seriesCode &&
        String(row[episodeIndex] ?? '').normalize('NFC').trim() === '');
      if (!parentExists) {
        throw Object.assign(new Error('Parent series was not found.'), { code: 'PARENT_SERIES_NOT_FOUND' });
      }
      const duplicate = snapshot.rows.some((row) =>
        String(row[episodeIndex] ?? '').normalize('NFC').trim() === episodeCode);
      if (duplicate) {
        throw Object.assign(new Error('Series episode already exists.'), { code: 'ALREADY_EXISTS' });
      }

      const values = headers.map((header) => fields[header] === undefined ? '' : String(fields[header]));
      const record = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
      try {
        const response = await sheetsClient.spreadsheets.values.append({
          spreadsheetId,
          range: `${quoteSheetRange('سریال')}!A:ZZZ`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [values] },
        });
        const rowNumber = Number(/!A(\\d+):/.exec(response?.data?.updates?.updatedRange || '')?.[1]) ||
          snapshot.rows.length + 2;
        return Object.freeze({
          rowNumber,
          record: Object.freeze(record),
          sourceVersion: crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url'),
        });
      } catch (error) {
        throw classifyCatalogDependencyError('sheets', 'sheet_append', error, 'Unable to create series episode.');
      }
    };

    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  return Object.freeze(markCatalogProviderKind(provider, 'google-sheets'));
}

module.exports = { createGoogleSheetsCatalogProvider };
