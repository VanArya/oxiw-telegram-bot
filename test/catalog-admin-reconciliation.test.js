'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createCatalogAdminContentReader } = require('../src/catalog-admin-content-reader');
const { createCatalogAdminApi } = require('../src/catalog-admin-api');
const { createCatalogRoleAuthorizer } = require('../src/catalog-admin-authorization');
const { createInMemoryCatalogAdminRoleProvider } = require('../src/catalog-admin-role-provider');
const { createInMemoryWritableCatalogMetadataProvider } = require('../src/in-memory-writable-catalog-metadata-provider');
const { createFixtureProvider, sheets } = require('./fixtures/catalog-sheet-source-fixtures');

async function withServer(app, run) {
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }
}

function createReaderWithFixture() {
  const source = structuredClone(sheets);
  const movie = source['سینمایی'];
  movie.rows.push([...movie.rows[0]]);
  movie.rows.push(['', 'ردیف ناقص', '2024', 'IR', 'draft', 'private-reconciliation-file-id']);
  movie.rows.push(movie.headers.map(() => ''));

  const writableProvider = createInMemoryWritableCatalogMetadataProvider({
    contentMetadata: [
      {
        contentId: 'movie:fixture-movie-ir',
        approvalStatus: 'approved',
        publicationStatus: 'draft',
        countryIds: ['IR'],
        genreIds: ['drama'],
        categoryIds: ['missing-category'],
      },
      {
        contentId: 'movie:orphaned-metadata',
        approvalStatus: 'pending',
        publicationStatus: 'draft',
        countryIds: ['IR'],
        genreIds: ['drama'],
      },
    ],
    categories: [],
    taxonomies: {
      country: [{ id: 'IR', labelFa: 'ایران', enabled: true }],
      genre: [{ id: 'drama', labelFa: 'درام', enabled: true }],
    },
  });
  const reader = createCatalogAdminContentReader({
    sheetProvider: createFixtureProvider(source),
    writableProvider,
  });
  return { reader, writableProvider };
}

test('read-only reconciliation detects source and metadata drift without exposing private columns', async () => {
  const { reader } = createReaderWithFixture();
  const report = await reader.listReconciliationReport();

  assert.equal(report.mode, 'read-only');
  assert.equal(report.summary.mappedSourceRows, 9);
  assert.equal(report.summary.uniqueSourceRecords, 8);
  assert.equal(report.summary.blankRowsIgnored, 1);
  assert.equal(report.summary.duplicateSourceIds, 1);
  assert.equal(report.summary.invalidSourceRows, 1);
  assert.equal(report.summary.metadataRecords, 2);
  assert.equal(report.summary.matchedMetadata, 1);
  assert.equal(report.summary.missingMetadata, 7);
  assert.equal(report.summary.orphanedMetadata, 1);
  assert.equal(report.summary.taxonomyReferenceIssues, 1);
  assert.equal(report.summary.inconsistentPublication, 0);
  assert.equal(report.summary.totalFindings, 11);

  assert.equal(report.issues.invalidSourceRows[0].sheetName, 'سینمایی');
  assert.equal(report.issues.duplicateSourceIds[0].contentId, 'movie:fixture-movie-ir');
  assert.equal(report.issues.orphanedMetadata[0].contentId, 'movie:orphaned-metadata');
  assert.deepEqual(report.issues.taxonomyReferences[0], {
    contentId: 'movie:fixture-movie-ir',
    taxonomyType: 'category',
    termId: 'missing-category',
    reason: 'missing',
  });
  assert.equal(report.sheets['سینمایی'].blankRowsIgnored, 1);
  assert.equal(report.metadata.validation, 'passed');
  assert.equal(JSON.stringify(report).includes('private-reconciliation-file-id'), false);
  assert.equal(JSON.stringify(report).includes('fake-file-movie'), false);
  assert.equal(JSON.stringify(report).includes('Telegram File ID'), false);
});

test('reconciliation endpoint requires catalog read permission and returns read-only report', async () => {
  const { reader, writableProvider } = createReaderWithFixture();
  const report = await reader.listReconciliationReport();
  const roleProvider = createInMemoryCatalogAdminRoleProvider({
    'fixture-admin': ['administrator'],
    'fixture-observer': ['observer'],
    'fixture-without-role': [],
  });
  const app = createCatalogAdminApi({
    writableProvider,
    contentReader: reader,
    verifyAdminPrincipal: (request) => ({
      authenticated: true,
      subjectId: request.headers['x-fixture-principal'] || 'fixture-admin',
    }),
    roleProvider,
    authorizePermission: createCatalogRoleAuthorizer(),
  });

  await withServer(app, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/v1/admin/catalog/diagnostics/reconciliation`);
    assert.equal(allowed.status, 200);
    const result = await allowed.json();
    assert.equal(result.mode, 'read-only');
    assert.equal(result.summary.totalFindings, report.summary.totalFindings);

    const denied = await fetch(`${baseUrl}/api/v1/admin/catalog/diagnostics/reconciliation`, {
      headers: { 'x-fixture-principal': 'fixture-without-role' },
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'FORBIDDEN');
  });
});
