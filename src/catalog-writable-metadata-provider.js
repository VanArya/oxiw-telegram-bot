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

const VERSIONED_METHODS = Object.freeze([
  'getContentMetadataWithVersion',
  'getCategoryWithVersion',
  'getTaxonomyTermWithVersion',
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

function assertVersionedWritableCatalogMetadataProvider(provider) {
  assertWritableCatalogMetadataProvider(provider);
  if (VERSIONED_METHODS.some((method) => typeof provider[method] !== 'function')) {
    throw new TypeError(
      'VersionedWritableCatalogMetadataProvider must expose versioned record reads.',
    );
  }
  return provider;
}

module.exports = {
  assertWritableCatalogMetadataProvider,
  assertVersionedWritableCatalogMetadataProvider,
};
