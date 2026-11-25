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
  async function deleteSheetRows(sheetName, rowNumbers) {
    if (typeof sheetsClient.spreadsheets?.get !== 'function' ||
        typeof sheetsClient.spreadsheets?.batchUpdate !== 'function') {
      throw Object.assign(new Error('Sheet row deletion is not configured.'), {
        code: 'DELETE_NOT_CONFIGURED',
      });
    }
    const uniqueRows = [...new Set(rowNumbers)].filter((row) => Number.isSafeInteger(row) && row >= 2);
    if (!uniqueRows.length) return;
    try {
      const metadata = await sheetsClient.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(sheetId,title)',
      });
      const sheet = (metadata?.data?.sheets || [])
        .map((entry) => entry.properties)
        .find((properties) => properties?.title === sheetName);
      if (!Number.isSafeInteger(sheet?.sheetId)) {
        throw Object.assign(new Error('Sheet identity is unavailable.'), { code: 'SHEET_NOT_FOUND' });
      }
      const requests = uniqueRows.sort((a, b) => b - a).map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId: sheet.sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      }));
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
    } catch (error) {
      if (error?.code === 'SHEET_NOT_FOUND' || error?.code === 'DELETE_NOT_CONFIGURED') throw error;
      throw classifyCatalogDependencyError('sheets', 'sheet_delete', error, 'Unable to delete catalog rows.');
    }
  }

  function recordFor(snapshot, row) {
    return Object.fromEntries(snapshot.headers.map((header, index) => [header, row[index] ?? '']));
  }

  function versionFor(record) {
    return crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  }


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

  provider.deleteCatalogRow = async function deleteCatalogRow({
    sheetName, systemCode, expectedVersion,
  } = {}) {
    if (sheetName !== 'سینمایی' || typeof systemCode !== 'string' || !systemCode.trim() ||
        typeof expectedVersion !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(expectedVersion)) {
      throw Object.assign(new Error('Invalid catalog row deletion.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet(sheetName);
      const codeHeader = codeHeaderFor(sheetName);
      const codeIndex = snapshot.headers.indexOf(codeHeader);
      if (codeIndex < 0) throw Object.assign(new Error('Catalog identity column is unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
      const matches = snapshot.rows.map((row, index) => ({ row, index }))
        .filter(({ row }) => String(row[codeIndex] ?? '').normalize('NFC').trim() === systemCode.trim());
      if (matches.length !== 1) throw Object.assign(new Error('Catalog row is missing or ambiguous.'), { code: 'ROW_NOT_FOUND' });
      const { row, index } = matches[0];
      const record = recordFor(snapshot, row);
      if (versionFor(record) !== expectedVersion) {
        throw Object.assign(new Error('Catalog row changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      await deleteSheetRows(sheetName, [index + 2]);
      return Object.freeze({ deleted: true, deletedRows: 1, record: Object.freeze(record) });
    };
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  provider.deleteSeriesWithEpisodes = async function deleteSeriesWithEpisodes({
    seriesCode, expectedVersion,
  } = {}) {
    if (typeof seriesCode !== 'string' || !/^\d{5}$/.test(seriesCode) ||
        typeof expectedVersion !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(expectedVersion)) {
      throw Object.assign(new Error('Invalid series deletion.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet('سریال');
      const parentHeader = snapshot.headers.includes('کد سریال') ? 'کد سریال' : 'کد سریال مادر';
      const episodeHeader = snapshot.headers.includes('کد قسمت') ? 'کد قسمت' : 'کد سیستم';
      const parentIndex = snapshot.headers.indexOf(parentHeader);
      const episodeIndex = snapshot.headers.indexOf(episodeHeader);
      if (parentIndex < 0 || episodeIndex < 0) {
        throw Object.assign(new Error('Series identity columns are unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
      }
      const matchingRows = snapshot.rows.map((row, index) => ({ row, index, record: recordFor(snapshot, row) }))
        .filter(({ row }) => String(row[parentIndex] ?? '').normalize('NFC').trim() === seriesCode);
      const parents = matchingRows.filter(({ row }) => String(row[episodeIndex] ?? '').trim() === '');
      if (parents.length !== 1) {
        throw Object.assign(new Error('Parent series row is missing or ambiguous.'), { code: 'ROW_NOT_FOUND' });
      }
      const parent = parents[0];
      if (versionFor(parent.record) !== expectedVersion) {
        throw Object.assign(new Error('Parent series changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      const rowsToDelete = matchingRows.map(({ index }) => index + 2);
      const episodeCount = matchingRows.length - 1;
      await deleteSheetRows('سریال', rowsToDelete);
      return Object.freeze({
        deleted: true,
        deletedRows: rowsToDelete.length,
        deletedEpisodes: episodeCount,
        record: Object.freeze(parent.record),
      });
    };
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  provider.updateSeriesEpisodeRow = async function updateSeriesEpisodeRow({
    episodeCode, expectedVersion, fields,
  } = {}) {
    if (typeof episodeCode !== 'string' || !/^\d{5}\.\d{2}\.\d{2}$/.test(episodeCode) ||
        typeof expectedVersion !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(expectedVersion) ||
        !fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
      throw Object.assign(new Error('Invalid episode update.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet('سریال');
      const episodeHeader = snapshot.headers.includes('کد قسمت') ? 'کد قسمت' : 'کد سیستم';
      const fileHeader = ['Telegram File ID', 'File ID', 'لینک تلگرام']
        .find((header) => snapshot.headers.includes(header));
      const allowed = new Set(['اسم فیلم', 'سازنده', fileHeader].filter(Boolean));
      if (!snapshot.headers.includes(episodeHeader) || Object.keys(fields).some((key) => !allowed.has(key))) {
        throw Object.assign(new Error('Episode editable columns are unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
      }
      const codeIndex = snapshot.headers.indexOf(episodeHeader);
      const matches = snapshot.rows.map((row, index) => ({ row, index }))
        .filter(({ row }) => String(row[codeIndex] ?? '').normalize('NFC').trim() === episodeCode);
      if (matches.length !== 1) throw Object.assign(new Error('Episode row is missing or ambiguous.'), { code: 'ROW_NOT_FOUND' });
      const { row, index } = matches[0];
      const record = recordFor(snapshot, row);
      if (versionFor(record) !== expectedVersion) {
        throw Object.assign(new Error('Episode row changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      if (Object.hasOwn(fields, 'اسم فیلم') &&
          (typeof fields['اسم فیلم'] !== 'string' || !fields['اسم فیلم'].trim() || fields['اسم فیلم'].length > 200)) {
        throw Object.assign(new Error('Invalid episode title.'), { code: 'INVALID_INPUT' });
      }
      if (Object.hasOwn(fields, 'سازنده') &&
          (typeof fields['سازنده'] !== 'string' || !fields['سازنده'].trim())) {
        throw Object.assign(new Error('Invalid episode country.'), { code: 'INVALID_INPUT' });
      }
      if (fileHeader && Object.hasOwn(fields, fileHeader) &&
          (typeof fields[fileHeader] !== 'string' || !fields[fileHeader].trim() || fields[fileHeader].length > 4096)) {
        throw Object.assign(new Error('Invalid Telegram file reference.'), { code: 'INVALID_INPUT' });
      }
      const data = [];
      for (const [header, value] of Object.entries(fields)) {
        const columnIndex = snapshot.headers.indexOf(header);
        data.push({
          range: `${quoteSheetRange('سریال')}!${columnLetter(columnIndex + 1)}${index + 2}`,
          values: [[String(value)]],
        });
      }
      try {
        await sheetsClient.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data },
        });
      } catch (error) {
        throw classifyCatalogDependencyError('sheets', 'sheet_write', error, 'Unable to update series episode.');
      }
      const updatedRecord = { ...record, ...fields };
      return Object.freeze({
        rowNumber: index + 2,
        record: Object.freeze(updatedRecord),
        sourceVersion: versionFor(updatedRecord),
      });
    };
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  provider.deleteSeriesEpisodeRow = async function deleteSeriesEpisodeRow({
    episodeCode, expectedVersion,
  } = {}) {
    if (typeof episodeCode !== 'string' || !/^\d{5}\.\d{2}\.\d{2}$/.test(episodeCode) ||
        typeof expectedVersion !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(expectedVersion)) {
      throw Object.assign(new Error('Invalid episode deletion.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet('سریال');
      const episodeHeader = snapshot.headers.includes('کد قسمت') ? 'کد قسمت' : 'کد سیستم';
      const codeIndex = snapshot.headers.indexOf(episodeHeader);
      if (codeIndex < 0) throw Object.assign(new Error('Episode identity column is unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
      const matches = snapshot.rows.map((row, index) => ({ row, index }))
        .filter(({ row }) => String(row[codeIndex] ?? '').normalize('NFC').trim() === episodeCode);
      if (matches.length !== 1) throw Object.assign(new Error('Episode row is missing or ambiguous.'), { code: 'ROW_NOT_FOUND' });
      const { row, index } = matches[0];
      const record = recordFor(snapshot, row);
      if (versionFor(record) !== expectedVersion) {
        throw Object.assign(new Error('Episode row changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      await deleteSheetRows('سریال', [index + 2]);
      return Object.freeze({ deleted: true, deletedRows: 1, record: Object.freeze(record) });
    };
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  provider.deleteSeriesSeasonRows = async function deleteSeriesSeasonRows({
    seriesCode, season, expectedVersion,
  } = {}) {
    if (typeof seriesCode !== 'string' || !/^\d{5}$/.test(seriesCode) ||
        !Number.isInteger(season) || season < 1 || season > 99 ||
        typeof expectedVersion !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(expectedVersion)) {
      throw Object.assign(new Error('Invalid season deletion.'), { code: 'INVALID_INPUT' });
    }
    const operation = async () => {
      const snapshot = await provider.readSheet('سریال');
      const parentHeader = snapshot.headers.includes('کد سریال') ? 'کد سریال' : 'کد سریال مادر';
      const episodeHeader = snapshot.headers.includes('کد قسمت') ? 'کد قسمت' : 'کد سیستم';
      const parentIndex = snapshot.headers.indexOf(parentHeader);
      const episodeIndex = snapshot.headers.indexOf(episodeHeader);
      if (parentIndex < 0 || episodeIndex < 0) {
        throw Object.assign(new Error('Series identity columns are unavailable.'), { code: 'COLUMN_UNAVAILABLE' });
      }
      const matches = snapshot.rows.map((row, index) => ({
        row, index,
        record: recordFor(snapshot, row),
        episodeCode: String(row[episodeIndex] ?? '').normalize('NFC').trim(),
      })).filter(({ row, episodeCode }) => {
        const parsed = /^(\d{5})\.(\d{2})\.(\d{2})$/.exec(episodeCode);
        return parsed && parsed[1] === seriesCode &&
          String(row[parentIndex] ?? '').normalize('NFC').trim() === seriesCode &&
          Number(parsed[2]) === season;
      });
      if (!matches.length) {
        throw Object.assign(new Error('Season rows were not found.'), { code: 'ROW_NOT_FOUND' });
      }
      const fingerprint = matches.map(({ episodeCode, record }) => ({
        episodeCode, sourceVersion: versionFor(record),
      })).sort((a, b) => a.episodeCode.localeCompare(b.episodeCode));
      if (versionFor(fingerprint) !== expectedVersion) {
        throw Object.assign(new Error('Season changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      await deleteSheetRows('سریال', matches.map(({ index }) => index + 2));
      return Object.freeze({
        deleted: true,
        deletedRows: matches.length,
        deletedEpisodes: matches.length,
        seriesCode,
        season,
      });
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
        const rowNumber = Number(/!A(\d+):/.exec(response?.data?.updates?.updatedRange || '')?.[1]) ||
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
