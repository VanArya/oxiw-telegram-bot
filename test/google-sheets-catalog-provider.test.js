'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCatalogSheetAdapter } = require('../src/catalog-sheet-adapter');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const {
  createGoogleSheetsCatalogProvider,
} = require('../src/google-sheets-catalog-provider');
const { categories } = require('./fixtures/catalog-fixtures');
const { createFixtureMetadataProvider } = require('./fixtures/catalog-sheet-source-fixtures');

const spreadsheetIdFixture = 'synthetic-spreadsheet-id';

function mockSheetsClient(valuesBySheet, calls = []) {
  const sheetIds = { 'سینمایی': 101, 'سریال': 202 };
  const titleById = { 101: 'سینمایی', 202: 'سریال' };
  function columnIndex(column) {
    return [...column].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  }
  return {
    spreadsheets: {
      async get(args) {
        calls.push({ spreadsheetGet: args });
        return { data: { sheets: Object.entries(sheetIds).map(([title, sheetId]) => ({ properties: { title, sheetId } })) } };
      },
      async batchUpdate(args) {
        calls.push({ spreadsheetBatchUpdate: args });
        for (const request of args.requestBody.requests || []) {
          const range = request.deleteDimension?.range;
          if (!range) continue;
          const title = titleById[range.sheetId];
          const rows = valuesBySheet[`'${title}'`];
          if (rows) rows.splice(range.startIndex, range.endIndex - range.startIndex);
        }
        return { data: {} };
      },
      values: {
        async get(args) {
          calls.push(args);
          return valuesBySheet[args.range]
            ? { data: { values: valuesBySheet[args.range] } }
            : { data: {} };
        },
        async batchUpdate(args) {
          calls.push({ batchUpdate: args });
          for (const item of args.requestBody.data || []) {
            const match = /!([A-Z]+)([0-9]+)$/.exec(item.range);
            const title = item.range.includes("'سریال'") ? 'سریال' : 'سینمایی';
            const rows = valuesBySheet[`'${title}'`];
            if (!match || !rows) continue;
            const rowNumber = Number(match[2]);
            const column = columnIndex(match[1]);
            rows[rowNumber - 1] ||= [];
            rows[rowNumber - 1][column] = item.values[0][0];
          }
          return { data: {} };
        },
        async append(args) { calls.push({ append: args }); return { data: { updates: { updatedRange: `'سینمایی'!A3:E3` } } }; },
      },
    },
  };
}

const movieValues = [
  ['کد سیستم', 'اسم فیلم', 'کشور سازنده', 'وضعیت انتشار', 'Telegram File ID'],
  ['mock-movie-ir', 'فیلم آزمایشی ایرانی', 'IR', 'published', 'fake-file-movie'],
];
const seriesValues = [
  ['کد سیستم', 'اسم فیلم', 'سال شروع', 'سال پایان', 'کشور سازنده', 'وضعیت انتشار'],
  ['mock-series-us', 'سریال آزمایشی خارجی', '2019', '2021', 'US', 'published'],
];

test('reads headers and rows for both approved sheets using dynamic values.get and append methods', async () => {
  const calls = [];
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient({ "'سینمایی'": movieValues, "'سریال'": seriesValues }, calls),
    spreadsheetId: spreadsheetIdFixture,
  });

  assert.deepEqual(await provider.readSheet('سینمایی'), {
    headers: movieValues[0],
    rows: [movieValues[1]],
  });
  assert.deepEqual(await provider.readSheet('سریال'), {
    headers: seriesValues[0],
    rows: [seriesValues[1]],
  });
  assert.deepEqual(calls.map(({ range }) => range), ["'سینمایی'", "'سریال'"]);
  assert.equal(calls.every((call) => call.spreadsheetId === spreadsheetIdFixture), true);
  assert.deepEqual(Object.keys(provider), ['readSheet', 'updateCatalogRow', 'deleteCatalogRow', 'deleteSeriesWithEpisodes', 'updateSeriesEpisodeRow', 'deleteSeriesEpisodeRow', 'getSheetSchema', 'createCatalogRow', 'createSeriesEpisodeRow']);
});

test('normalizes whitespace and Unicode in live sheet header labels', async () => {
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient({
      "'سینمایی'": [
        ['  کد سیستم  ', ' اسم فیلم ', 'سال'],
        ['normalized-movie', 'عنوان آزمایشی', '2024'],
      ],
    }),
    spreadsheetId: spreadsheetIdFixture,
  });

  assert.deepEqual(await provider.readSheet('سینمایی'), {
    headers: ['کد سیستم', 'اسم فیلم', 'سال'],
    rows: [['normalized-movie', 'عنوان آزمایشی', '2024']],
  });
});

test('empty sheets and responses without values become empty snapshots', async () => {
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient({ "'سینمایی'": [] }),
    spreadsheetId: spreadsheetIdFixture,
  });
  assert.deepEqual(await provider.readSheet('سینمایی'), { headers: [], rows: [] });
  assert.deepEqual(await provider.readSheet('سریال'), { headers: [], rows: [] });
});

test('rejects invalid sheet names before calling the client', async () => {
  let calls = 0;
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: {
      spreadsheets: { values: { async get() { calls += 1; return { data: {} }; }, async batchUpdate() { return { data: {} }; }, async append() { return { data: {} }; } } },
    },
    spreadsheetId: spreadsheetIdFixture,
  });
  await assert.rejects(provider.readSheet('کاربران'), /Unsupported catalog sheet/);
  assert.equal(calls, 0);
});

test('sanitizes client errors and rejects malformed responses without exposing values', async () => {
  const failingProvider = createGoogleSheetsCatalogProvider({
    sheetsClient: {
      spreadsheets: {
        values: {
          async get() {
            const error = new Error('synthetic private credential detail');
            error.response = { status: 401 };
            throw error;
          },
          async batchUpdate() { return { data: {} }; },
          async append() { return { data: {} }; },
        },
      },
    },
    spreadsheetId: spreadsheetIdFixture,
  });
  await assert.rejects(
    failingProvider.readSheet('سینمایی'),
    (error) => error.message === 'Unable to read catalog sheet.' && !error.cause &&
      error.dependency === 'sheets' && error.stage === 'sheet_read' &&
      error.errorCode === 'SHEETS_AUTHENTICATION',
  );

  const malformedProvider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient({ "'سینمایی'": ['not-a-row-array'] }),
    spreadsheetId: spreadsheetIdFixture,
  });
  await assert.rejects(malformedProvider.readSheet('سینمایی'), /Invalid catalog sheet response/);
});

test('updates only explicitly editable catalog cells after checking the source-row version', async () => {
  const values = {
    "'سینمایی'": [
      ['کد سیستم', 'اسم فیلم', 'سال', 'خلاصه داستان', 'Telegram File ID'],
      ['safe-code', 'عنوان قدیمی', '2020', 'خلاصه', 'do-not-touch'],
    ],
  };
  const writes = [];
  const client = {
    spreadsheets: { values: {
      async get({ range }) { return { data: { values: values[range] || [] } }; },
      async append(args) { return { data: { updates: { updatedRange: "'سینمایی'!A3:E3" } } }; },
      async batchUpdate(args) {
        writes.push(args);
        for (const entry of args.requestBody.data) {
          const match = /!([A-Z]+)([0-9]+)$/.exec(entry.range);
          const col = match[1].charCodeAt(0) - 65;
          const row = Number(match[2]) - 1;
          values["'سینمایی'"][row][col] = entry.values[0][0];
        }
        return { data: {} };
      },
    } },
  };
  const provider = createGoogleSheetsCatalogProvider({ sheetsClient: client, spreadsheetId: spreadsheetIdFixture });
  const before = await provider.readSheet('سینمایی');
  const record = Object.fromEntries(before.headers.map((header, index) => [header, before.rows[0][index] ?? '']));
  const version = require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  const result = await provider.updateCatalogRow({
    sheetName: 'سینمایی', systemCode: 'safe-code', expectedVersion: version, fields: { 'اسم فیلم': 'عنوان تازه' },
  });
  assert.equal(values["'سینمایی'"][1][1], 'عنوان تازه');
  assert.equal(values["'سینمایی'"][1][4], 'do-not-touch');
  assert.equal(writes[0].requestBody.valueInputOption, 'RAW');
  assert.equal(result.rowNumber, 2);
  await assert.rejects(provider.updateCatalogRow({
    sheetName: 'سینمایی', systemCode: 'safe-code', expectedVersion: version, fields: { 'اسم فیلم': 'عنوان stale' },
  }), (error) => error.code === 'VERSION_CONFLICT');
});

test('updates the system code only when the new identity is unique', async () => {
  const values = {
    "'سینمایی'": [
      ['کد سیستم', 'اسم فیلم'],
      ['old-code', 'عنوان اول'],
      ['taken-code', 'عنوان دوم'],
    ],
  };
  const client = { spreadsheets: { values: {
    async get({ range }) { return { data: { values: values[range] || [] } }; },
    async append() { return { data: {} }; },
    async batchUpdate({ requestBody }) {
      for (const entry of requestBody.data) {
        const match = /!([A-Z]+)([0-9]+)$/.exec(entry.range);
        const col = match[1].charCodeAt(0) - 65;
        values["'سینمایی'"][Number(match[2]) - 1][col] = entry.values[0][0];
      }
      return { data: {} };
    },
  } } };
  const provider = createGoogleSheetsCatalogProvider({ sheetsClient: client, spreadsheetId: spreadsheetIdFixture });
  const snapshot = await provider.readSheet('سینمایی');
  const record = Object.fromEntries(snapshot.headers.map((header, i) => [header, snapshot.rows[0][i] ?? '']));
  const version = require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  await assert.rejects(provider.updateCatalogRow({
    sheetName: 'سینمایی', systemCode: 'old-code', expectedVersion: version,
    fields: { 'کد سیستم': 'taken-code' },
  }), (error) => error.code === 'ALREADY_EXISTS');
  const updated = await provider.updateCatalogRow({
    sheetName: 'سینمایی', systemCode: 'old-code', expectedVersion: version,
    fields: { 'کد سیستم': 'new-code' },
  });
  assert.equal(values["'سینمایی'"][1][0], 'new-code');
  assert.match(updated.sourceVersion, /^[A-Za-z0-9_-]{40,64}$/);
});

test('appends a new record using the live sheet header order and RAW values', async () => {
  const values = { "'سینمایی'": [['کد سیستم', 'اسم فیلم', 'Telegram File ID']] };
  let appended;
  const client = { spreadsheets: { values: {
    async get({ range }) { return { data: { values: values[range] || [] } }; },
    async batchUpdate() { return { data: {} }; },
    async append(args) { appended = args; values["'سینمایی'"] .push(args.requestBody.values[0]); return { data: { updates: { updatedRange: "'سینمایی'!A2:C2" } } }; },
  } } };
  const provider = createGoogleSheetsCatalogProvider({ sheetsClient: client, spreadsheetId: spreadsheetIdFixture });
  const created = await provider.createCatalogRow({
    sheetName: 'سینمایی',
    fields: { 'کد سیستم': 'new-movie', 'اسم فیلم': 'فیلم تازه', 'Telegram File ID': 'file-id-123' },
  });
  assert.deepEqual(appended.requestBody.values, [['new-movie', 'فیلم تازه', 'file-id-123']]);
  assert.equal(appended.valueInputOption, 'RAW');
  assert.equal(created.rowNumber, 2);
  assert.equal(created.record['Telegram File ID'], 'file-id-123');
});


test('creates an episode using the existing series and episode columns without adding a parent-code column', async () => {
  const headers = [
    'اسم فیلم', 'نوع', 'سازنده', 'ژانر', 'کد سریال', 'کد قسمت',
    'سال شروع', 'سال پایان', 'تعداد فصل و قسمت', 'بازیگران',
    'خلاصه داستان', 'امتیاز', 'زبان', 'پیشنهادی', 'لینک تریلر',
    'پوستر فیلم', 'شناسه URL', 'Telegram File ID',
  ];
  const values = {
    "'سریال'": [
      headers,
      ['سریال مادر', 'سریال', 'ایران', 'درام', '70711', '', '2020', 'در حال پخش', '۱ فصل', '', '', '', '', '', '', '', '', ''],
    ],
  };
  let appended;
  const client = { spreadsheets: { values: {
    async get({ range }) { return { data: { values: values[range] || [] } }; },
    async batchUpdate() { return { data: {} }; },
    async append(args) {
      appended = args;
      values["'سریال'"].push(args.requestBody.values[0]);
      return { data: { updates: { updatedRange: "'سریال'!A3:R3" } } };
    },
  } } };
  const provider = createGoogleSheetsCatalogProvider({ sheetsClient: client, spreadsheetId: spreadsheetIdFixture });
  const fields = {
    'اسم فیلم': 'فصل 1 قسمت 13',
    'نوع': 'قسمت',
    'سازنده': 'ایران',
    'کد سریال': '70711',
    'کد قسمت': '70711.01.13',
    'Telegram File ID': 'synthetic-telegram-file-id',
  };

  const created = await provider.createSeriesEpisodeRow({
    seriesCode: '70711', episodeCode: '70711.01.13', fields,
  });
  assert.equal(created.rowNumber, 3);
  assert.equal(created.record['کد سریال'], '70711');
  assert.equal(created.record['کد قسمت'], '70711.01.13');
  assert.deepEqual(appended.requestBody.values[0], headers.map((header) => fields[header] || ''));
  assert.equal(appended.range, "'سریال'!A:ZZZ");
  assert.equal(appended.valueInputOption, 'RAW');

  await assert.rejects(
    provider.createSeriesEpisodeRow({ seriesCode: '70711', episodeCode: '70711.01.13', fields }),
    (error) => error.code === 'ALREADY_EXISTS',
  );
});


test('deletes a movie row physically after checking the row version', async () => {
  const values = [movieValues[0], ['delete-me', 'فیلم برای حذف', 'IR', 'draft', 'file-delete']];
  const source = { "'سینمایی'": values };
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient(source),
    spreadsheetId: spreadsheetIdFixture,
  });
  const record = Object.fromEntries(movieValues[0].map((header, index) => [header, values[1][index]]));
  const version = require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  const deleted = await provider.deleteCatalogRow({
    sheetName: 'سینمایی', systemCode: 'delete-me', expectedVersion: version,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.deletedRows, 1);
  assert.equal(source["'سینمایی'"].length, 1);
  await assert.rejects(
    provider.deleteCatalogRow({ sheetName: 'سینمایی', systemCode: 'delete-me', expectedVersion: version }),
    (error) => error.code === 'ROW_NOT_FOUND',
  );
});

test('deletes a series together with all its linked episode rows', async () => {
  const headers = ['اسم فیلم', 'نوع', 'سازنده', 'کد سریال', 'کد قسمت', 'Telegram File ID'];
  const rows = [
    headers,
    ['سریال اول', 'سریال', 'ایران', '70711', '', ''],
    ['قسمت یک', 'قسمت', 'ایران', '70711', '70711.01.01', 'file-a'],
    ['سریال دوم', 'سریال', 'آمریکا', '80808', '', ''],
    ['قسمت یک', 'قسمت', 'آمریکا', '80808', '80808.01.01', 'file-b'],
    ['قسمت دو', 'قسمت', 'آمریکا', '80808', '80808.01.02', 'file-c'],
  ];
  const source = { "'سریال'": rows };
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient(source),
    spreadsheetId: spreadsheetIdFixture,
  });
  const record = Object.fromEntries(headers.map((header, index) => [header, rows[1][index]]));
  const version = require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  const deleted = await provider.deleteSeriesWithEpisodes({ seriesCode: '70711', expectedVersion: version });
  assert.equal(deleted.deletedRows, 2);
  assert.equal(deleted.deletedEpisodes, 1);
  assert.deepEqual(source["'سریال'"].slice(1).map((row) => row[3]), ['80808', '80808', '80808']);
  assert.deepEqual(source["'سریال'"].slice(1).map((row) => row[4]), ['', '80808.01.01', '80808.01.02']);
});

test('updates only editable episode columns using source-version protection', async () => {
  const headers = ['اسم فیلم', 'نوع', 'سازنده', 'کد سریال', 'کد قسمت', 'Telegram File ID'];
  const rows = [
    headers,
    ['قسمت قدیم', 'قسمت', 'ایران', '70711', '70711.01.01', 'file-old'],
  ];
  const source = { "'سریال'": rows };
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient(source),
    spreadsheetId: spreadsheetIdFixture,
  });
  const record = Object.fromEntries(headers.map((header, index) => [header, rows[1][index]]));
  const version = require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  const updated = await provider.updateSeriesEpisodeRow({
    episodeCode: '70711.01.01',
    expectedVersion: version,
    fields: { 'اسم فیلم': 'قسمت جدید', 'سازنده': 'آمریکا', 'Telegram File ID': 'file-new' },
  });
  assert.equal(updated.record['اسم فیلم'], 'قسمت جدید');
  assert.equal(updated.record['سازنده'], 'آمریکا');
  assert.equal(updated.record['Telegram File ID'], 'file-new');
  assert.equal(updated.record['کد سریال'], '70711');
  assert.equal(updated.record['کد قسمت'], '70711.01.01');
  assert.deepEqual(rows[1], ['قسمت جدید', 'قسمت', 'آمریکا', '70711', '70711.01.01', 'file-new']);
  await assert.rejects(
    provider.updateSeriesEpisodeRow({
      episodeCode: '70711.01.01',
      expectedVersion: version,
      fields: { 'کد قسمت': '70711.01.02' },
    }),
    (error) => error.code === 'COLUMN_UNAVAILABLE',
  );
});

test('deletes one episode row without deleting its parent series', async () => {
  const headers = ['اسم فیلم', 'نوع', 'سازنده', 'کد سریال', 'کد قسمت', 'Telegram File ID'];
  const rows = [
    headers,
    ['سریال اول', 'سریال', 'ایران', '70711', '', ''],
    ['قسمت یک', 'قسمت', 'ایران', '70711', '70711.01.01', 'file-a'],
  ];
  const source = { "'سریال'": rows };
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient(source),
    spreadsheetId: spreadsheetIdFixture,
  });
  const record = Object.fromEntries(headers.map((header, index) => [header, rows[2][index]]));
  const version = require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  const result = await provider.deleteSeriesEpisodeRow({ episodeCode: '70711.01.01', expectedVersion: version });
  assert.equal(result.deleted, true);
  assert.deepEqual(source["'سریال'"].slice(1), [rows[1]]);
});


test('legacy rows remain mappable without country and internal Telegram IDs stay private', async () => {
  const legacyValues = [
    ['کد سیستم', 'اسم فیلم', 'وضعیت انتشار', 'Telegram File ID'],
    ['legacy-movie', 'فیلم قدیمی ساختگی', 'published', 'synthetic-file-id'],
  ];
  const provider = createGoogleSheetsCatalogProvider({
    sheetsClient: mockSheetsClient({
      "'سینمایی'": legacyValues,
      "'سریال'": [['کد سیستم', 'اسم فیلم']],
    }),
    spreadsheetId: spreadsheetIdFixture,
  });
  const adapter = createCatalogSheetAdapter(provider, {
    metadataProvider: createFixtureMetadataProvider({
      [createCatalogContentId('movie', 'legacy-movie')]: {
        approvalStatus: 'approved', publicationStatus: 'published',
      },
    }),
  });
  const items = await adapter.listItems();
  assert.deepEqual(items, [{ id: 'movie:legacy-movie', kind: 'movie', title: 'فیلم قدیمی ساختگی' }]);
  assert.equal(JSON.stringify(items).includes('synthetic-file-id'), false);
  assert.deepEqual(await adapter.listCategoryItems(
    categories.find((category) => category.slug === 'iranian-movies'),
  ), []);
});

test('provider rejects missing client or Spreadsheet ID at construction', () => {
  assert.throws(
    () => createGoogleSheetsCatalogProvider({ sheetsClient: {}, spreadsheetId: spreadsheetIdFixture }),
    /Sheets values client with read, append, and batch-update access/,
  );
  assert.throws(
    () => createGoogleSheetsCatalogProvider({
      sheetsClient: mockSheetsClient({}),
      spreadsheetId: ' ',
    }),
    /Spreadsheet ID is required/,
  );
});
