'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const { runGenreMigrationDryRun, normalizeGenreLabel } = require('../src/catalog-genre-migration-dry-run');

function sheetProvider() {
  return {
    async readSheet(name) {
      return name === 'سینمایی'
        ? { headers: ['کد سیستم', 'اسم فیلم', 'سال', 'ژانر'], rows: [
          ['one', 'یک', '2020', 'درام،  کمدی'],
          ['two', 'دو', '2021', 'درام\u200c'],
        ] }
        : { headers: ['کد سیستم', 'اسم فیلم', 'سال شروع', 'سال پایان', 'ژانر'], rows: [
          ['three', 'سه', '2020', '2021', 'معمایی'],
        ] };
    },
  };
}

test('genre dry-run reports normalization, mappings, and never writes', async () => {
  const calls = [];
  const metadata = {
    async listContentMetadataWithVersion() {
      calls.push('metadata-read');
      return [
        { value: { contentId: createCatalogContentId('movie', 'one'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: ['drama'] } },
        { value: { contentId: createCatalogContentId('movie', 'two'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: [] } },
        { value: { contentId: createCatalogContentId('series', 'three'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: ['drama'] } },
      ];
    },
  };
  const taxonomy = { async listAllTaxonomyTerms(type) {
    calls.push('taxonomy-' + type);
    return [{ id: 'drama', labelFa: 'درام', enabled: true }, { id: 'comedy', labelFa: 'کمدی', enabled: true }];
  } };
  const report = await runGenreMigrationDryRun({ sheetProvider: sheetProvider(), metadataProvider: metadata, taxonomyProvider: taxonomy });
  assert.equal(normalizeGenreLabel(' درام\u200c  '), 'درام');
  assert.equal(report.summary.totalTitles, 3);
  assert.equal(report.summary.rawGenreValues, 4);
  assert.equal(report.summary.uniqueRawGenres, 4);
  assert.equal(report.summary.uniqueNormalizedGenres, 3);
  assert.equal(report.summary.transferableAssignments, 3);
  assert.equal(report.summary.metadataConflicts, 1);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(report['migration-preview'].assignments.find((item) => item.contentId.endsWith(':three')).reason, 'GENRE_TERM_UNMAPPED');
  assert.deepEqual(calls, ['metadata-read', 'taxonomy-genre']);
});

test('genre dry-run rejects incomplete dependencies', async () => {
  await assert.rejects(runGenreMigrationDryRun(), TypeError);
});

test('ambiguous normalized taxonomy labels are never auto-mapped', async () => {
  const metadata = {
    async listContentMetadataWithVersion() {
      return [
        { value: { contentId: createCatalogContentId('movie', 'one'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: [] } },
        { value: { contentId: createCatalogContentId('movie', 'two'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: [] } },
        { value: { contentId: createCatalogContentId('series', 'three'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: [] } },
      ];
    },
  };
  const taxonomy = {
    async listAllTaxonomyTerms() {
      return [
        { id: 'drama', labelFa: 'درام', enabled: true },
        { id: 'drama-alt', labelFa: 'درام\u200c', enabled: true },
        { id: 'comedy', labelFa: 'کمدی', enabled: true },
        { id: 'mystery', labelFa: 'معمایی', enabled: true },
      ];
    },
  };
  const report = await runGenreMigrationDryRun({
    sheetProvider: sheetProvider(), metadataProvider: metadata, taxonomyProvider: taxonomy,
  });
  const first = report['migration-preview'].assignments.find((item) => item.contentId.endsWith(':one'));
  assert.equal(first.status, 'needs_review');
  assert.equal(first.reason, 'GENRE_TERM_AMBIGUOUS');
  assert.deepEqual(first.ambiguousGenres, ['درام']);
  assert.equal(report['normalization-report'].duplicateTaxonomyLabels.length, 1);
});


test('duplicate source content IDs are marked for manual review', async () => {
  const duplicateSheetProvider = {
    async readSheet(name) {
      return name === 'سینمایی'
        ? { headers: ['کد سیستم', 'اسم فیلم', 'سال', 'ژانر'], rows: [
          ['duplicate', 'عنوان اول', '2020', 'درام'],
          ['duplicate', 'عنوان دوم', '2021', 'کمدی'],
        ] }
        : { headers: ['کد سیستم', 'اسم فیلم', 'سال شروع', 'سال پایان', 'ژانر'], rows: [] };
    },
  };
  const metadataProvider = {
    async listContentMetadataWithVersion() {
      return [{ value: {
        contentId: createCatalogContentId('movie', 'duplicate'),
        approvalStatus: 'approved', publicationStatus: 'draft', genreIds: [],
      } }];
    },
  };
  const taxonomyProvider = {
    async listAllTaxonomyTerms() {
      return [
        { id: 'drama', labelFa: 'درام', enabled: true },
        { id: 'comedy', labelFa: 'کمدی', enabled: true },
      ];
    },
  };
  const report = await runGenreMigrationDryRun({
    sheetProvider: duplicateSheetProvider,
    metadataProvider,
    taxonomyProvider,
  });
  const item = report['migration-preview'].assignments.find((entry) => entry.contentId.endsWith(':duplicate'));
  assert.equal(item.status, 'needs_review');
  assert.equal(item.reason, 'CONTENT_ID_DUPLICATE');
  assert.equal(report.summary.duplicateContentIds, 1);
});

test('missing or empty source genre data never proposes clearing existing metadata', async () => {
  const incompleteSheetProvider = {
    async readSheet(name) {
      return name === 'سینمایی'
        ? { headers: ['کد سیستم', 'اسم فیلم', 'سال'], rows: [['movie-empty', 'فیلم بدون ژانر', '2020']] }
        : { headers: ['کد سیستم', 'اسم فیلم', 'سال شروع', 'سال پایان', 'ژانر'], rows: [
          ['series-empty', 'سریال بدون ژانر', '2020', '2021', ''],
        ] };
    },
  };
  const metadataProvider = {
    async listContentMetadataWithVersion() {
      return [
        { value: { contentId: createCatalogContentId('movie', 'movie-empty'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: ['drama'] } },
        { value: { contentId: createCatalogContentId('series', 'series-empty'), approvalStatus: 'approved', publicationStatus: 'draft', genreIds: ['comedy'] } },
      ];
    },
  };
  const taxonomyProvider = {
    async listAllTaxonomyTerms() {
      return [
        { id: 'drama', labelFa: 'درام', enabled: true },
        { id: 'comedy', labelFa: 'کمدی', enabled: true },
      ];
    },
  };
  const report = await runGenreMigrationDryRun({
    sheetProvider: incompleteSheetProvider,
    metadataProvider,
    taxonomyProvider,
  });
  const movie = report['migration-preview'].assignments.find((entry) => entry.contentId.endsWith(':movie-empty'));
  const series = report['migration-preview'].assignments.find((entry) => entry.contentId.endsWith(':series-empty'));
  assert.equal(movie.reason, 'GENRE_COLUMN_MISSING');
  assert.equal(series.reason, 'GENRE_SOURCE_EMPTY');
  assert.equal(report.summary.transferableAssignments, 0);
});


test('missing metadata produces safe create candidates when every source genre is mapped', async () => {
  const metadataProvider = { async listContentMetadataWithVersion() { return []; } };
  const taxonomyProvider = {
    async listAllTaxonomyTerms() {
      return [
        { id: 'drama', labelFa: 'درام', enabled: true },
        { id: 'comedy', labelFa: 'کمدی', enabled: true },
        { id: 'mystery', labelFa: 'معمایی', enabled: true },
      ];
    },
  };
  const report = await runGenreMigrationDryRun({
    sheetProvider: sheetProvider(), metadataProvider, taxonomyProvider,
  });
  assert.equal(report.summary.metadataMissing, 3);
  assert.equal(report.summary.metadataCreateCandidates, 3);
  assert.equal(report.summary.needsReview, 0);
  const item = report['migration-preview'].assignments.find((entry) => entry.contentId.endsWith(':one'));
  assert.equal(item.status, 'create_metadata');
  assert.deepEqual(item.proposedMetadata, {
    approvalStatus: 'pending',
    publicationStatus: 'draft',
    countryIds: [],
    genreIds: ['drama', 'comedy'],
  });
});

test('unmapped genres are discovered even when every content metadata document is missing', async () => {
  const metadataProvider = { async listContentMetadataWithVersion() { return []; } };
  const taxonomyProvider = {
    async listAllTaxonomyTerms() {
      return [{ id: 'drama', labelFa: 'درام', enabled: true }];
    },
  };
  const report = await runGenreMigrationDryRun({
    sheetProvider: sheetProvider(), metadataProvider, taxonomyProvider,
  });
  const labels = report['migration-preview'].newGenres.map((item) => item.label);
  assert.deepEqual(labels.sort(), ['کمدی', 'معمایی'].sort());
  assert.equal(report.summary.metadataCreateCandidates, 1);
  assert.equal(report.summary.needsReview, 2);
  const candidate = report['migration-preview'].assignments.find((entry) => entry.contentId.endsWith(':two'));
  assert.equal(candidate.status, 'create_metadata');
});
