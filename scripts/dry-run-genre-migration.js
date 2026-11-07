'use strict';

const { createOperationalCatalogRuntime } = require('../src/catalog-operational-runtime-factory');
const { runGenreMigrationDryRun } = require('../src/catalog-genre-migration-dry-run');

async function main() {
  const runtime = await createOperationalCatalogRuntime();
  const report = await runGenreMigrationDryRun({
    sheetProvider: runtime.provider,
    metadataProvider: runtime.writableProvider,
    taxonomyProvider: runtime.writableProvider,
  });
  process.stdout.write(\`${JSON.stringify(report, null, 2)}\n\`);
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('Genre migration dry-run failed due to unavailable or invalid read-only dependencies.\n');
    process.exitCode = 1;
  });
}

module.exports = { main };
