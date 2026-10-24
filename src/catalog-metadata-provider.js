'use strict';

const REQUIRED_METHODS = Object.freeze([
  'getContentMetadata',
  'listCategories',
  'listTaxonomyTerms',
]);

function assertCatalogMetadataProvider(provider) {
  if (!provider || REQUIRED_METHODS.some((method) => typeof provider[method] !== 'function')) {
    throw new TypeError(
      'CatalogMetadataProvider must implement getContentMetadata, listCategories, and listTaxonomyTerms.',
    );
  }
  return provider;
}

module.exports = { assertCatalogMetadataProvider };
