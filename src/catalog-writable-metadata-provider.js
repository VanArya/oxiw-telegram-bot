'use strict';

const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');

const WRITABLE_METHODS = Object.freeze([
  'upsertContentMetadata',
  'updateApprovalStatus',
  'updatePublicationStatus',
  'upsertCategory',
  'upsertTaxonomyTerm',
  'listAllTaxonomyTerms',
]);

function assertWritableCatalogMetadataProvider(provider) {
  assertCatalogMetadataProvider(provider);
  if (WRITABLE_METHODS.some((method) => typeof provider[method] !== 'function')) {
    throw new TypeError(
      'WritableCatalogMetadataProvider must implement the catalog metadata write methods.',
    );
  }
  return provider;
}

module.exports = { assertWritableCatalogMetadataProvider };
