'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCatalogAdminContentReader } = require('../src/catalog-admin-content-reader');
const { createInMemoryWritableCatalogMetadataProvider } = require('../src/in-memory-writable-catalog-metadata-provider');
const { createFixtureProvider, sheets } = require('./fixtures/catalog-sheet-source-fixtures');
const { createCatalogContentId } = require('../src/catalog-content-identity');

function makeReader({ source = sheets, contentMetadata = [], categories = [], sheetProvider } = {}) {
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata,
    categories,
    taxonomies: {
      country: [{ id: 'IR', labelFa: 'ایران', enabled: true }],
      genre: [{ id: 'drama', labelFa: 'درام', enabled: true }],
    },
  });
  return createCatalogAdminContentReader({
    sheetProvider: sheetProvider || createFixtureProvider(source),
    writableProvider,
  });
}

test('admin content reader lists unpublished Sheet rows with metadata status and safe projection', async () => {
  const id = createCatalogContentId('movie', 'fixture-movie-ir');
  const reader = makeReader({
    contentMetadata: [{
      contentId: id,
      approvalStatus: 'approved',
      publicationStatus: 'draft',
      countryIds: ['IR'],
      genreIds: ['drama'],
    }],
  });
  const result = await reader.list(new URLSearchParams('page=1&pageSize=100'));
  assert.equal(result.meta.stats.total, 8);
  assert.equal(result.meta.stats.movies, 6);
  assert.equal(result.meta.stats.series, 2);
  assert.equal(result.meta.stats.missingMetadata, 7);
  const item = result.data.find((entry) => entry.id === id);
  assert.equal(item.approvalStatus, 'approved');
  assert.equal(item.publicationStatus, 'draft');
  assert.equal(item.hasMetadata, true);
  assert.deepEqual(item.countryIds, ['IR']);
  assert.equal(item.systemCode, 'fixture-movie-ir');
  assert.ok(result.data.some((entry) => entry.publicationStatus === 'unknown'));
  assert.equal(JSON.stringify(result).includes('fake-file-movie'), false);
  assert.equal(JSON.stringify(result).includes('Telegram File ID'), false);
  assert.equal(JSON.stringify(item).includes('sourceRecord'), false);
});


test('admin content reader lists registered episodes from the series sheet without exposing Telegram IDs', async () => {
  const source = structuredClone(sheets);
  source['سریال'].headers.push('کد قسمت');
  source['سریال'].rows.forEach((row) => row.push(''));
  const row = Object.fromEntries(source['سریال'].headers.map((header) => [header, '']));
  Object.assign(row, {
    'کد سریال': '70711',
    'کد قسمت': '',
    'اسم فیلم': 'سریال مادر آزمایشی',
    'سال شروع': '2020',
  });
  source['سریال'].rows.push(source['سریال'].headers.map((header) => row[header]));
  const episode = {
    ...row,
    'کد قسمت': '70711.01.13',
    'اسم فیلم': 'قسمت سیزدهم',
    'Telegram File ID': 'private-episode-file-id',
  };
  source['سریال'].rows.push(source['سریال'].headers.map((header) => episode[header]));

  const result = await makeReader({ source }).listSeriesEpisodes();
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].seriesTitle, 'سریال مادر آزمایشی');
  assert.equal(result.episodes[0].episodeCode, '70711.01.13');
  assert.equal(result.episodes[0].episodeTitle, 'قسمت سیزدهم');
  assert.equal(result.episodes[0].hasTelegramFile, true);
  assert.equal(JSON.stringify(result).includes('private-episode-file-id'), false);
});


test('admin reader uses the populated legacy code column when کد سریال is blank', async () => {
  const source = structuredClone(sheets);
  source['سریال'].headers.push('کد سیستم', 'کد قسمت');
  source['سریال'].rows.forEach((row) => row.push('', ''));
  const headers = source['سریال'].headers;
  const fallbackParent = Object.fromEntries(headers.map((header) => [header, '']));
  Object.assign(fallbackParent, {
    'کد سریال': '',
    'کد سیستم': '70711',
    'کد قسمت': '',
    'اسم فیلم': 'سریال بازیابی‌شده',
  });
  source['سریال'].rows.push(headers.map((header) => fallbackParent[header]));

  const reader = makeReader({ source });
  const listed = await reader.list(new URLSearchParams('kind=series&pageSize=100'));
  const recovered = listed.data.find((item) => item.id === 'series:70711');
  assert.ok(recovered);
  assert.equal(recovered.systemCode, '70711');

  const sourceRecord = await reader.getItemSource('series:70711');
  assert.ok(sourceRecord);
  assert.equal(sourceRecord.record['کد سیستم'], '70711');
  assert.equal(sourceRecord.sourceRowNumber, source['سریال'].rows.length + 1);
});

test('source diagnostics report only safe identity candidates and never expose file IDs', async () => {
  const source = structuredClone(sheets);
  const headers = source['سریال'].headers;
  const invalid = Object.fromEntries(headers.map((header) => [header, '']));
  Object.assign(invalid, {
    'کد سریال': '',
    'اسم فیلم': 'ردیف بدون شناسه',
    'Telegram File ID': 'never-return-this-file-id',
  });
  source['سریال'].rows.push(headers.map((header) => invalid[header]));
  const reader = makeReader({ source });
  const report = await reader.listSourceDiagnostics();
  const row = report.data.find((entry) => entry.sheetName === 'سریال');
  assert.ok(row);
  assert.equal(row.titlePresent, true);
  assert.deepEqual(row.codeCandidates, {});
  assert.equal(JSON.stringify(report).includes('never-return-this-file-id'), false);
  assert.equal(report.meta.total, 1);
});

test('admin reader tolerates whitespace and duplicate aliases in required sheet headings', async () => {
  const source = structuredClone(sheets);
  source['سریال'].headers.push(' کد سریال ', ' اسم فیلم ');
  source['سریال'].rows.forEach((row) => row.push('', ''));

  const result = await makeReader({ source }).list(new URLSearchParams('kind=series&pageSize=100'));
  assert.equal(result.meta.stats.series, 2);
  assert.ok(result.data.some((item) => item.id === 'series:fixture-series-ir'));
  assert.equal(result.data.find((item) => item.id === 'series:fixture-series-ir').systemCode, 'fixture-series-ir');
});

test('protected source reader returns every sheet column while normal list projection keeps file IDs private', async () => {
  const reader = makeReader();
  const source = await reader.getItemSource(createCatalogContentId('movie', 'fixture-movie-ir'));
  assert.deepEqual(source.headers, sheets['سینمایی'].headers);
  assert.equal(source.record['Telegram File ID'], 'fake-file-movie');
  assert.equal(source.record['اسم فیلم'], 'فیلم ایرانی ساختگی');
  const list = await reader.list(new URLSearchParams('pageSize=100'));
  assert.equal(JSON.stringify(list).includes('fake-file-movie'), false);
});

test('source reader exposes dropdown options from existing catalog column values', async () => {
  const source = structuredClone(sheets);
  source['سینمایی'].headers.push('ژانر', 'زبان', 'پیشنهادی');
  source['سینمایی'].rows.forEach((row, index) => row.push(index % 2 ? 'اکشن، درام' : 'درام، کمدی', 'فارسی', index % 2 ? 'خیر' : 'بله'));
  source['سریال'].headers.push('ژانر', 'زبان', 'پیشنهادی');
  source['سریال'].rows.forEach((row) => row.push('درام، جنایی', 'انگلیسی', 'بله'));
  const reader = makeReader({ source });
  const item = await reader.getItemSource(createCatalogContentId('movie', 'fixture-movie-ir'));
  assert.deepEqual(item.fieldOptions['نوع'], ['سینمایی', 'سریال']);
  assert.deepEqual([...item.fieldOptions['ژانر']].sort(), ['اکشن', 'درام', 'جنایی', 'کمدی'].sort());
  assert.deepEqual([...item.fieldOptions['زبان']].sort(), ['انگلیسی', 'فارسی'].sort());
  assert.deepEqual([...item.fieldOptions['پیشنهادی']].sort(), ['بله', 'خیر'].sort());
});

test('reader creates new movie and series rows using each sheet schema', async () => {
  const source = structuredClone(sheets);
  const hash = (record) => require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('base64url');
  const provider = {
    async readSheet(name) { return { headers: [...source[name].headers], rows: source[name].rows.map((row) => [...row]) }; },
    async getSheetSchema(name) { return [...source[name].headers]; },
    async createCatalogRow({ sheetName, fields }) {
      const record = Object.fromEntries(source[sheetName].headers.map((header) => [header, fields[header] ?? '']));
      source[sheetName].rows.push(source[sheetName].headers.map((header) => record[header]));
      return { record, rowNumber: source[sheetName].rows.length + 1, sourceVersion: hash(record) };
    },
    async updateCatalogRow({ sheetName, systemCode, expectedVersion, fields }) {
      const codeHeader = sheetName === 'سریال' ? 'کد سریال' : 'کد سیستم';
      const codeIndex = source[sheetName].headers.indexOf(codeHeader);
      const rowIndex = source[sheetName].rows.findIndex((row) => row[codeIndex] === systemCode);
      const record = Object.fromEntries(source[sheetName].headers.map((header, index) => [header, source[sheetName].rows[rowIndex][index] ?? '']));
      assert.equal(hash(record), expectedVersion);
      for (const [header, value] of Object.entries(fields)) record[header] = value;
      source[sheetName].rows[rowIndex] = source[sheetName].headers.map((header) => record[header]);
      return { rowNumber: rowIndex + 2, sourceVersion: hash(record) };
    },
  };
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata: [{
      contentId: 'movie:created-movie', approvalStatus: 'approved', publicationStatus: 'draft',
      countryIds: ['IR'], genreIds: ['drama'],
    }],
    categories: [], taxonomies: { country: [{ id: 'IR', labelFa: 'ایران', enabled: true }], genre: [{ id: 'drama', labelFa: 'درام', enabled: true }] },
  });
  const reader = createCatalogAdminContentReader({ sheetProvider: provider, writableProvider });
  const movie = await reader.createItemSource('movie', {
    'کد سیستم': 'created-movie', 'اسم فیلم': 'فیلم تازه', 'سال': '2025', 'Telegram File ID': 'new-file',
  });
  assert.equal(movie.id, 'movie:created-movie');
  assert.equal(movie.record['Telegram File ID'], 'new-file');
  const series = await reader.createItemSource('series', {
    'کد سریال': 'created-series', 'اسم فیلم': 'سریال تازه', 'سال شروع': '2023',
    'سال پایان': 'در حال پخش', 'تعداد فصل و قسمت': '۱ فصل، ۸ قسمت',
  });
  assert.equal(series.id, 'series:created-series');
  assert.equal(series.systemCode, 'created-series');
  assert.equal(series.record['سال پایان'], 'در حال پخش');
  const updatedSeries = await reader.updateItemSource(series.id, {
    sourceVersion: series.sourceVersion, fields: { 'کد سریال': 'created-series-renamed', 'اسم فیلم': 'عنوان سریال ویرایش‌شده' },
  });
  assert.equal(updatedSeries.id, 'series:created-series-renamed');
  assert.equal(updatedSeries.systemCode, 'created-series-renamed');
  assert.equal(updatedSeries.record['کد سریال'], 'created-series-renamed');
  const updated = await reader.updateItemSource(movie.id, {
    sourceVersion: movie.sourceVersion, fields: { 'Telegram File ID': 'updated-file', 'اسم فیلم': 'عنوان ویرایش‌شده' },
  });
  assert.equal(updated.record['Telegram File ID'], 'updated-file');
  assert.equal(updated.record['اسم فیلم'], 'عنوان ویرایش‌شده');
  const renamed = await reader.updateItemSource(movie.id, {
    sourceVersion: updated.sourceVersion, fields: { 'کد سیستم': 'created-movie-renamed' },
  });
  assert.equal(renamed.id, 'movie:created-movie-renamed');
  assert.equal(await writableProvider.getContentMetadata('movie:created-movie'), null);
  assert.deepEqual(await writableProvider.getContentMetadata(renamed.id), {
    contentId: renamed.id, approvalStatus: 'approved', publicationStatus: 'draft',
    countryIds: ['IR'], genreIds: ['drama'],
  });
});

test('admin content reader searches title or system code and applies filters before pagination', async () => {
  const reader = makeReader();
  const byTitle = await reader.list(new URLSearchParams('q=%D8%B3%D8%B1%DB%8C%D8%A7%D9%84&kind=series'));
  assert.equal(byTitle.meta.total, 2);
  const byCode = await reader.list(new URLSearchParams('q=fixture-movie-draft&approvalStatus=unknown'));
  assert.equal(byCode.meta.total, 1);
  assert.equal(byCode.data[0].systemCode, 'fixture-movie-draft');
  const page = await reader.list(new URLSearchParams('page=2&pageSize=3'));
  assert.equal(page.meta.page, 2);
  assert.equal(page.data.length, 3);
});

test('admin content reader combines taxonomy and category filters before pagination', async () => {
  const movieId = createCatalogContentId('movie', 'fixture-movie-ir');
  const reader = makeReader({
    contentMetadata: [{
      contentId: movieId, approvalStatus: 'approved', publicationStatus: 'draft',
      countryIds: ['IR'], genreIds: ['drama'],
    }],
  });
  const country = await reader.list(new URLSearchParams('countryId=IR&pageSize=100'));
  assert.equal(country.meta.total, 1);
  assert.equal(country.data[0].id, movieId);
  const genre = await reader.list(new URLSearchParams('genreId=drama&pageSize=100'));
  assert.equal(genre.meta.total, 1);
  await assert.rejects(reader.list(new URLSearchParams('countryId=US')), {
    name: 'CatalogAdminListInputError',
  });
});


test('admin content reader filters dynamic, manual, and hybrid category membership', async () => {
  const id = createCatalogContentId('movie', 'fixture-movie-ir');
  const reader = makeReader({
    contentMetadata: [{
      contentId: id, approvalStatus: 'pending', publicationStatus: 'draft',
      countryIds: ['IR'], genreIds: ['drama'], categoryIds: ['manual-pick'],
    }],
    categories: [
      { id: 'dynamic-iran', slug: 'dynamic-iran', localizedTitle: { fa: 'ایرانی پویا' },
        enabled: true, mode: 'dynamic',
        filters: { all: [{ field: 'countryIds', op: 'contains', value: 'IR' }] } },
      { id: 'manual-pick', slug: 'manual-pick', localizedTitle: { fa: 'انتخاب دستی' },
        enabled: true, mode: 'manual' },
      { id: 'hybrid-pick', slug: 'hybrid-pick', localizedTitle: { fa: 'ترکیبی' },
        enabled: true, mode: 'hybrid',
        filters: { all: [{ field: 'genreIds', op: 'contains', value: 'drama' }] } },
    ],
  });
  for (const categoryId of ['dynamic-iran', 'manual-pick', 'hybrid-pick']) {
    const result = await reader.list(new URLSearchParams(`categoryId=${categoryId}&pageSize=100`));
    assert.equal(result.meta.total, 1, categoryId);
    assert.equal(result.data[0].id, id);
  }
});

test('admin content reader rejects invalid query and ambiguous source identities', async () => {
  const reader = makeReader();
  await assert.rejects(reader.list(new URLSearchParams('pageSize=101')),
    { name: 'CatalogAdminListInputError' });

  const duplicateSource = structuredClone(sheets);
  duplicateSource['سینمایی'].rows.push([...duplicateSource['سینمایی'].rows[0]]);
  const duplicateReader = makeReader({ source: duplicateSource });
  await assert.rejects(duplicateReader.list(new URLSearchParams()), TypeError);
});

test('admin content reader preserves a Firestore metadata validation diagnostic stage and code', async () => {
  const writableProvider = {
    getContentMetadataWithVersion: async () => null,
    listContentMetadataWithVersion: async () => {
      const error = new Error('safe validation failure');
      error.dependency = 'firestore';
      error.stage = 'metadata_validation';
      error.errorCode = 'FIRESTORE_DATA_VALIDATION';
      throw error;
    },
  };
  const reader = createCatalogAdminContentReader({
    sheetProvider: createFixtureProvider(sheets),
    writableProvider,
  });
  await assert.rejects(
    reader.list(new URLSearchParams()),
    (error) => error.name === 'CatalogAdminListStageError' &&
      error.dependency === 'firestore' &&
      error.stage === 'metadata_validation' &&
      error.errorCode === 'FIRESTORE_DATA_VALIDATION',
  );
});


test('admin content reader skips invalid source rows and reports safe row diagnostics', async () => {
  const source = structuredClone(sheets);
  const invalidRow = [...source['سینمایی'].rows[0]];
  const titleIndex = source['سینمایی'].headers.indexOf('اسم فیلم');
  invalidRow[titleIndex] = '';
  source['سینمایی'].rows.splice(1, 0, invalidRow);
  const diagnostics = [];
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata: [], categories: [],
    taxonomies: { country: [], genre: [] },
  });
  const reader = createCatalogAdminContentReader({
    sheetProvider: createFixtureProvider(source),
    writableProvider,
    onInvalidSourceRow: (diagnostic) => diagnostics.push(diagnostic),
  });

  const result = await reader.list(new URLSearchParams('pageSize=100'));
  assert.equal(result.meta.stats.total, 8);
  // Existing fixture-count regression is covered by the preceding test; assert exclusion directly.
  assert.equal(result.meta.invalidSourceRows, 1);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    sheetName: 'سینمایی',
    rowNumber: 3,
    stage: 'sheet_row_mapping',
    validationIssue: 'required_field_invalid',
    fieldName: 'اسم فیلم',
  });
  assert.equal(JSON.stringify(diagnostics).includes('fixture-movie-ir'), false);
});

test('admin content reader still rejects duplicate identities rather than silently skipping them', async () => {
  const duplicateSource = structuredClone(sheets);
  duplicateSource['سینمایی'].rows.push([...duplicateSource['سینمایی'].rows[0]]);
  const reader = makeReader({ source: duplicateSource });
  await assert.rejects(reader.list(new URLSearchParams()), (error) =>
    error.name === 'CatalogAdminListStageError' && error.stage === 'sheet_identity_validation');
});


test('admin content reader groups episodes into seasons and supplies a stable season version', async () => {
  const source = structuredClone(sheets);
  source['سریال'].headers.push('کد قسمت');
  source['سریال'].rows.forEach((row) => row.push(''));
  const headers = source['سریال'].headers;
  const parent = Object.fromEntries(headers.map((header) => [header, '']));
  Object.assign(parent, { 'کد سریال': '70711', 'اسم فیلم': 'سریال فصل‌بندی‌شده' });
  source['سریال'].rows.push(headers.map((header) => parent[header]));
  for (const episodeCode of ['70711.01.01', '70711.01.02', '70711.02.01']) {
    const episode = {
      ...parent,
      'کد قسمت': episodeCode,
      'اسم فیلم': `قسمت ${episodeCode.slice(-2)}`,
      'Telegram File ID': `private-${episodeCode}`,
    };
    source['سریال'].rows.push(headers.map((header) => episode[header]));
  }
  const reader = makeReader({ source });
  const result = await reader.listSeriesSeasons();
  assert.equal(result.seasons.length, 2);
  assert.deepEqual(result.seasons.map(({ season, episodeCount }) => ({ season, episodeCount })), [
    { season: 1, episodeCount: 2 },
    { season: 2, episodeCount: 1 },
  ]);
  assert.equal(result.seasons[0].seriesTitle, 'سریال فصل‌بندی‌شده');
  assert.match(result.seasons[0].sourceVersion, /^[A-Za-z0-9_-]{40,64}$/);
  assert.equal(JSON.stringify(result).includes('private-70711'), false);
});

test('admin content reader forwards a versioned season deletion to the source provider', async () => {
  const source = structuredClone(sheets);
  source['سریال'].headers.push('کد قسمت');
  source['سریال'].rows.forEach((row) => row.push(''));
  const headers = source['سریال'].headers;
  const parent = Object.fromEntries(headers.map((header) => [header, '']));
  Object.assign(parent, { 'کد سریال': '70711', 'اسم فیلم': 'سریال آزمایشی' });
  source['سریال'].rows.push(headers.map((header) => parent[header]));
  const episode = { ...parent, 'کد قسمت': '70711.03.01', 'اسم فیلم': 'قسمت اول', 'Telegram File ID': 'private-file' };
  source['سریال'].rows.push(headers.map((header) => episode[header]));
  let received;
  const sheetProvider = {
    async readSheet(name) {
      return { headers: [...source[name].headers], rows: source[name].rows.map((row) => [...row]) };
    },
    async deleteSeriesSeasonRows(options) {
      received = options;
      return { deleted: true, deletedRows: 1, deletedEpisodes: 1 };
    },
  };
  const reader = makeReader({ source, sheetProvider });
  const season = (await reader.listSeriesSeasons()).seasons[0];
  const deleted = await reader.deleteSeriesSeason('70711', 3, { sourceVersion: season.sourceVersion });
  assert.equal(received.seriesCode, '70711');
  assert.equal(received.season, 3);
  assert.equal(received.expectedVersion, season.sourceVersion);
  assert.equal(deleted.deletedEpisodes, 1);
});

test('deletes a series, its episode rows, and its Firestore metadata as one managed operation', async () => {
  const source = structuredClone(sheets);
  source['سریال'].headers.push('کد قسمت');
  source['سریال'].rows.forEach((row) => row.push(''));
  const headers = source['سریال'].headers;
  const parent = Object.fromEntries(headers.map((header) => [header, '']));
  Object.assign(parent, {
    'کد سریال': '70711',
    'اسم فیلم': 'سریال آزمایشی برای حذف',
    'سال شروع': '2022',
    'کشور سازنده': 'IR',
    'وضعیت انتشار': 'published',
  });
  const episode = {
    ...parent,
    'اسم فیلم': 'قسمت اول',
    'کد قسمت': '70711.01.01',
    'Telegram File ID': 'private-episode-file',
  };
  source['سریال'].rows.push(headers.map((header) => parent[header]));
  source['سریال'].rows.push(headers.map((header) => episode[header]));

  const contentId = createCatalogContentId('series', '70711');
  const metadata = {
    contentId,
    approvalStatus: 'pending',
    publicationStatus: 'draft',
    countryIds: [],
    genreIds: [],
  };
  const sheetProvider = {
    async readSheet(name) {
      return { headers: [...source[name].headers], rows: source[name].rows.map((row) => [...row]) };
    },
    async getSheetSchema(name) { return [...source[name].headers]; },
    async deleteSeriesWithEpisodes({ seriesCode, expectedVersion }) {
      assert.equal(seriesCode, '70711');
      const parentRecord = Object.fromEntries(headers.map((header, index) => [header, source['سریال'].rows[2][index] ?? '']));
      const currentVersion = require('node:crypto').createHash('sha256').update(JSON.stringify(parentRecord)).digest('base64url');
      assert.equal(expectedVersion, currentVersion);
      const before = source['سریال'].rows.length;
      source['سریال'].rows = source['سریال'].rows.filter((row) => String(row[headers.indexOf('کد سریال')] ?? '') !== '70711');
      return { deleted: true, deletedRows: before - source['سریال'].rows.length, deletedEpisodes: 1 };
    },
  };
  const reader = makeReader({ source, sheetProvider, contentMetadata: [metadata] });
  const current = await reader.getItemSource(contentId);
  assert.equal(current.record['اسم فیلم'], 'سریال آزمایشی برای حذف');
  assert.equal(current.sourceRowNumber, 4);
  assert.equal(current.sourceVersion.length, 43);

  const deleted = await reader.deleteItemSource(contentId, {
    sourceVersion: current.sourceVersion,
    actorId: 'admin-delete-test',
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.deletedEpisodes, 1);
  assert.equal(await reader.getItem(contentId), null);
  const providerMetadata = await reader.list(new URLSearchParams('kind=series&pageSize=100'));
  assert.equal(providerMetadata.data.some((item) => item.id === contentId), false);
});

test('admin reader skips dotted episode records from standalone catalog listing', async () => {
  const source = structuredClone(sheets);
  source['سریال'].headers.push('کد سریال مادر', 'لینک تلگرام', 'عنوان قسمت');
  source['سریال'].rows.push(['70711.01.01', 'قسمت اول', '', '', '', '', '', '', '70711', 'https://t.me/example/1', 'قسمت اول']);
  const reader = makeReader({ source });
  const result = await reader.list(new URLSearchParams('kind=series&pageSize=100'));
  assert.equal(result.meta.stats.series, 2);
  // Assert episode exclusion without coupling to the fixture's overall count.
  assert.equal(result.data.some((item) => item.systemCode === '70711.01.01'), false);
});


test('admin projection uses the live سازنده column and exposes its fixed dropdown options', async () => {
  const source = structuredClone(sheets);
  source['سینمایی'].headers.push('سازنده');
  source['سینمایی'].rows.forEach((row, index) => row.push(index === 0 ? 'آمریکا' : 'ایران'));
  source['سریال'].headers.push('سازنده');
  source['سریال'].rows.forEach((row) => row.push('ایران'));
  const reader = makeReader({
    source,
    contentMetadata: [{
      contentId: createCatalogContentId('movie', 'fixture-movie-ir'),
      approvalStatus: 'approved',
      publicationStatus: 'draft',
      countryIds: ['IR'],
      genreIds: ['drama'],
    }],
  });

  const result = await reader.list(new URLSearchParams('pageSize=100'));
  const item = result.data.find((entry) => entry.id === 'movie:fixture-movie-ir');
  assert.equal(item.producerCountry, 'آمریکا');
  assert.deepEqual(item.countryIds, ['US']);
  assert.ok(item.sourceAvailableFields.includes('producerCountry'));

  const sourceItem = await reader.getItemSource(item.id);
  assert.deepEqual(sourceItem.fieldOptions['سازنده'], [
    'ایران', 'آمریکا', 'کره جنوبی', 'ژاپن', 'هند', 'مصر', 'اسپانیا',
  ]);
});

test('creating a record on a schema with سازنده requires an approved producer country', async () => {
  const headers = ['اسم فیلم', 'نوع', 'سازنده', 'ژانر', 'کد سیستم', 'سال',
    'بازیگران', 'خلاصه داستان', 'امتیاز', 'زبان', 'پیشنهادی',
    'لینک تریلر', 'پوستر فیلم', 'شناسه URL', 'Telegram File ID'];
  const snapshots = {
    'سینمایی': { headers, rows: [] },
    'سریال': { headers: ['اسم فیلم', 'نوع', 'سازنده', 'ژانر', 'کد سریال', 'کد قسمت',
      'سال شروع', 'سال پایان', 'تعداد فصل و قسمت', 'بازیگران', 'خلاصه داستان',
      'امتیاز', 'زبان', 'پیشنهادی', 'لینک تریلر', 'پوستر فیلم', 'شناسه URL', 'Telegram File ID'], rows: [] },
  };
  const provider = {
    async readSheet(name) { return { headers: [...snapshots[name].headers], rows: snapshots[name].rows.map((row) => [...row]) }; },
    async getSheetSchema(name) { return [...snapshots[name].headers]; },
    async createCatalogRow({ sheetName, fields }) {
      const record = Object.fromEntries(snapshots[sheetName].headers.map((header) => [header, fields[header] ?? '']));
      snapshots[sheetName].rows.push(snapshots[sheetName].headers.map((header) => record[header]));
      return { record, rowNumber: snapshots[sheetName].rows.length + 1, sourceVersion: 'v'.repeat(43) };
    },
  };
  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata: [], categories: [],
    taxonomies: { country: [], genre: [] },
  });
  const reader = createCatalogAdminContentReader({ sheetProvider: provider, writableProvider });

  await assert.rejects(reader.createItemSource('movie', {
    'کد سیستم': 'new-movie', 'اسم فیلم': 'فیلم جدید',
  }), { code: 'INVALID_INPUT' });

  const created = await reader.createItemSource('movie', {
    'کد سیستم': 'new-movie', 'اسم فیلم': 'فیلم جدید', 'سازنده': 'اسپانیا',
  });
  assert.equal(created.record['سازنده'], 'اسپانیا');
  assert.equal(created.id, 'movie:new-movie');
});
