'use strict';

const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');
const { markCatalogProviderKind } = require('./catalog-provider-kind');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createInMemoryCatalogMetadataProvider({ contentMetadata = {}, categories = [], taxonomies = {} } = {}) {
  if (
    contentMetadata === null || typeof contentMetadata !== 'object' || Array.isArray(contentMetadata) ||
    !Array.isArray(categories) || taxonomies === null || typeof taxonomies !== 'object' || Array.isArray(taxonomies)
  ) {
    throw new TypeError('Invalid in-memory catalog metadata fixture.');
  }

  const metadata = new Map(Object.entries(contentMetadata).map(([id, value]) => [id, clone(value)]));
  const taxonomyTerms = new Map(
    Object.entries(taxonomies).map(([type, terms]) => [type, clone(terms)]),
  );

  const provider = {
    async getContentMetadata(contentId) {
      return clone(metadata.get(contentId) ?? null);
    },
    async listCategories() {
      return clone(categories);
    },
    async listTaxonomyTerms(type) {
      return clone(taxonomyTerms.get(type) ?? []);
    },
  };

  return Object.freeze(markCatalogProviderKind(assertCatalogMetadataProvider(provider), 'in-memory'));
}

module.exports = { createInMemoryCatalogMetadataProvider };
