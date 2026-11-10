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
  return {
    spreadsheets: {
      values: {
        async get(args) {
          calls.push(args);
          return valuesBySheet[args.range]
            ? { data: { values: valuesBySheet[args.range] } }
            : { data: {} };
        },
        async batchUpdate(args) { calls.push({ batchUpdate: args }); return { data: {} }; },
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
  assert.deepEqual(Object.keys(provider), ['readSheet', 'updateCatalogRow', 'getSheetSchema', 'createCatalogRow']);
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
