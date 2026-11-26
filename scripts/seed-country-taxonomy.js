'use strict';

const { createOperationalCatalogRuntime } = require('../src/catalog-operational-runtime-factory');
const {
  COUNTRY_CATEGORIES,
  COUNTRY_TERMS,
  applyCountryTaxonomySeed,
  planCountryTaxonomySeed,
} = require('../src/catalog-country-taxonomy-seed');

async function main(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply');
  if (argv.some((arg) => arg !== '--apply')) throw new Error('Only --apply is supported.');
  if (apply && env.CATALOG_CONFIRM_COUNTRY_TAXONOMY_APPLY !== 'YES') {
    throw new Error('Set CATALOG_CONFIRM_COUNTRY_TAXONOMY_APPLY=YES to authorize Production writes.');
  }

  const runtime = await createOperationalCatalogRuntime({ env });
  const [existingTerms, existingCategories] = await Promise.all([
    runtime.writableProvider.listAllTaxonomyTerms('country'),
    runtime.writableProvider.listCategories(),
  ]);
  const plan = planCountryTaxonomySeed(existingTerms, existingCategories);
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    requestedCountryTerms: COUNTRY_TERMS.length,
    requestedCategories: COUNTRY_CATEGORIES.length,
    existingCountryTerms: existingTerms.length,
    existingCategories: existingCategories.length,
    createTerms: plan.createTerms,
    updateTerms: plan.updateTerms.map(({ id, previous, value }) => ({
      id, previousLabelFa: previous.labelFa, labelFa: value.labelFa,
      previousEnabled: previous.enabled, enabled: value.enabled,
    })),
    alreadyPresentTerms: plan.alreadyPresentTerms,
    createCategories: plan.createCategories.map(({ id, slug, localizedTitle }) => ({
      id, slug, localizedTitle,
    })),
    updateCategories: plan.updateCategories.map(({ id, previous, value }) => ({
      id, slug: value.slug, previousMode: previous.mode || 'dynamic',
      titleFa: value.localizedTitle.fa, filters: value.filters,
    })),
    alreadyPresentCategories: plan.alreadyPresentCategories,
    conflicts: plan.conflicts,
  };

  if (!apply) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\\n');
    return report;
  }
  if (plan.conflicts.length) throw new Error('Country taxonomy seed blocked by ID, label, or category conflicts.');

  const result = await applyCountryTaxonomySeed({ writableProvider: runtime.writableProvider });
  report.createdTerms = result.createdTerms;
  report.updatedTerms = result.updatedTerms;
  report.createdCategories = result.createdCategories;
  report.updatedCategories = result.updatedCategories;
  report.blocked = result.blocked;
  process.stdout.write(JSON.stringify(report, null, 2) + '\\n');
  return report;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write((error?.message || 'Country taxonomy seed failed.') + '\\n');
  process.exitCode = 1;
});

module.exports = { main };
