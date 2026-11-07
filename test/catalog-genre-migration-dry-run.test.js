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
