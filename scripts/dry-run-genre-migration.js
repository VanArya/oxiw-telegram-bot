'use strict';

const { createOperationalCatalogRuntime } = require('../src/catalog-operational-runtime-factory');
const { runGenreMigrationDryRun } = require('../src/catalog-genre-migration-dry-run');

async function main() {
  const runtime = await createOperationalCatalogRuntime();
  const readOnlyMetadataProvider = Object.freeze({
    listContentMetadataWithVersion: runtime.writableProvider.listContentMetadataWithVersion.bind(runtime.writableProvider),
  });
  const readOnlyTaxonomyProvider = Object.freeze({
    listAllTaxonomyTerms: runtime.writableProvider.listAllTaxonomyTerms.bind(runtime.writableProvider),
  });
  const report = await runGenreMigrationDryRun({
    sheetProvider: runtime.provider,
    metadataProvider: readOnlyMetadataProvider,
    taxonomyProvider: readOnlyTaxonomyProvider,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('Genre migration dry-run failed due to unavailable or invalid read-only dependencies.\n');
    process.exitCode = 1;
  });
}

module.exports = { main };
