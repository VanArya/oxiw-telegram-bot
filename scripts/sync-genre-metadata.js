'use strict';

const { createOperationalCatalogRuntime } = require('../src/catalog-operational-runtime-factory');
const { runGenreMigrationDryRun } = require('../src/catalog-genre-migration-dry-run');

async function main(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply');
  if (argv.some((arg) => arg !== '--apply')) throw new Error('Only --apply is supported.');
  if (apply && env.CATALOG_CONFIRM_GENRE_METADATA_APPLY !== 'YES') {
    throw new Error('Set CATALOG_CONFIRM_GENRE_METADATA_APPLY=YES to authorize Production writes.');
  }

  const runtime = await createOperationalCatalogRuntime({ env });
  const report = await runGenreMigrationDryRun({
    sheetProvider: runtime.provider,
    metadataProvider: {
      listContentMetadataWithVersion: runtime.writableProvider.listContentMetadataWithVersion.bind(runtime.writableProvider),
    },
    taxonomyProvider: {
      listAllTaxonomyTerms: runtime.writableProvider.listAllTaxonomyTerms.bind(runtime.writableProvider),
    },
  });
  const candidates = report['migration-preview'].assignments.filter((item) =>
    item.status === 'create_metadata' && item.proposedMetadata);
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    scannedTitles: report.summary.totalTitles,
    metadataMissing: report.summary.metadataMissing,
    createCandidates: candidates.length,
    needsReview: report.summary.needsReview,
    metadataConflicts: report.summary.metadataConflicts,
    skippedExistingMetadata: report.summary.totalTitles - report.summary.metadataMissing,
  };
  if (!apply) {
    process.stdout.write(JSON.stringify({ summary, candidates }, null, 2) + '\n');
    return { summary, candidates };
  }

  // Create-only policy: existing metadata documents are never updated here.
  // expectedVersion: 0 makes a concurrent/existing document a conflict, not an overwrite.
  const created = [];
  const failures = [];
  for (const candidate of candidates) {
    try {
      await runtime.writableProvider.upsertContentMetadata(
        candidate.contentId,
        candidate.proposedMetadata,
        { expectedVersion: 0, actorId: 'genre-metadata-sync' },
      );
      created.push(candidate.contentId);
    } catch (error) {
      failures.push({
        contentId: candidate.contentId,
        code: typeof error?.code === 'string' ? error.code : 'WRITE_FAILED',
      });
    }
  }
  const result = { summary, createdCount: created.length, created, failures };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (failures.length) process.exitCode = 2;
  return result;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write((error?.message || 'Genre metadata sync failed.') + '\n');
  process.exitCode = 1;
});

module.exports = { main };
