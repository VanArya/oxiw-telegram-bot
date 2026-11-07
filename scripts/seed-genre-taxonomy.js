'use strict';

const { createOperationalCatalogRuntime } = require('../src/catalog-operational-runtime-factory');
const { GENRE_TERMS, planGenreTaxonomySeed, applyGenreTaxonomySeed } = require('../src/catalog-genre-taxonomy-seed');

async function main(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply');
  if (argv.some((arg) => arg !== '--apply')) throw new Error('Only --apply is supported.');
  if (apply && env.CATALOG_CONFIRM_GENRE_TAXONOMY_APPLY !== 'YES') {
    throw new Error('Set CATALOG_CONFIRM_GENRE_TAXONOMY_APPLY=YES to authorize Production writes.');
  }
  const runtime = await createOperationalCatalogRuntime({ env });
  const existing = await runtime.writableProvider.listAllTaxonomyTerms('genre');
  const plan = planGenreTaxonomySeed(existing);
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    requestedTerms: GENRE_TERMS.length,
    existingTerms: existing.length,
    create: plan.create,
    alreadyPresent: plan.alreadyPresent,
    conflicts: plan.conflicts,
  };
  if (!apply) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report;
  }
  if (plan.conflicts.length) throw new Error('Taxonomy seed blocked by ID or label conflicts.');
  const result = await applyGenreTaxonomySeed({ writableProvider: runtime.writableProvider });
  report.created = result.created;
  report.blocked = result.blocked;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write((error?.message || 'Genre taxonomy seed failed.') + '\n');
  process.exitCode = 1;
});

module.exports = { main };
