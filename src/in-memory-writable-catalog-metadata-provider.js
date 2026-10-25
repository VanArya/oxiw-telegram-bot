'use strict';

const { assertWritableCatalogMetadataProvider } = require('./catalog-writable-metadata-provider');
const {
  CatalogConflictError,
  CatalogNotFoundError,
  validateApprovalStatus,
  validateCatalogCategory,
  validateCatalogContentMetadata,
  validateCatalogTaxonomyTerm,
  validatePublicationStatus,
} = require('./catalog-metadata-validation');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertTaxonomyReferences(metadata, taxonomyTerms) {
  for (const [field, type] of [['countryIds', 'country'], ['genreIds', 'genre']]) {
    const ids = metadata[field] || [];
    const active = new Set(
      [...taxonomyTerms.get(type).values()]
        .filter((term) => term.enabled)
        .map((term) => term.id),
    );
    if (ids.some((id) => !active.has(id))) {
      throw new CatalogConflictError('TAXONOMY_REFERENCE_INVALID');
    }
  }
}

function createInMemoryWritableCatalogMetadataProvider({
  contentMetadata = [],
  categories = [],
  taxonomies = {},
} = {}) {
  if (!Array.isArray(contentMetadata) || !Array.isArray(categories) ||
    taxonomies === null || typeof taxonomies !== 'object' || Array.isArray(taxonomies) ||
    Object.keys(taxonomies).some((type) => !['country', 'genre'].includes(type))) {
    throw new TypeError('Invalid in-memory catalog metadata seed.');
  }

  const metadata = new Map();
  const categoryStore = new Map();
  const taxonomyTerms = new Map([['country', new Map()], ['genre', new Map()]]);

  for (const item of contentMetadata) {
    if (!item || typeof item.contentId !== 'string' || metadata.has(item.contentId)) {
      throw new CatalogConflictError('DUPLICATE_CONTENT_METADATA');
    }
    const record = validateCatalogContentMetadata(item.contentId, item);
    metadata.set(record.contentId, record);
  }

  for (const item of categories) {
    if (!item || typeof item.id !== 'string' || categoryStore.has(item.id)) {
      throw new CatalogConflictError('DUPLICATE_CATEGORY_ID');
    }
    categoryStore.set(item.id, validateCatalogCategory(item.id, item));
  }
  const seededSlugs = [...categoryStore.values()].map(({ slug }) => slug);
  if (new Set(seededSlugs).size !== seededSlugs.length) {
    throw new CatalogConflictError('DUPLICATE_CATEGORY_SLUG');
  }

  for (const type of ['country', 'genre']) {
    const terms = taxonomies[type] ?? [];
    if (!Array.isArray(terms)) throw new TypeError('Invalid in-memory taxonomy seed.');
    for (const item of terms) {
      if (!item || typeof item.id !== 'string' || taxonomyTerms.get(type).has(item.id)) {
        throw new CatalogConflictError('DUPLICATE_TAXONOMY_ID');
      }
      taxonomyTerms.get(type).set(item.id, validateCatalogTaxonomyTerm(type, item.id, item));
    }
  }

  for (const record of metadata.values()) assertTaxonomyReferences(record, taxonomyTerms);

  function assertUniqueCategorySlug(category) {
    for (const existing of categoryStore.values()) {
      if (existing.id !== category.id && existing.slug === category.slug) {
        throw new CatalogConflictError('DUPLICATE_CATEGORY_SLUG');
      }
    }
  }

  const provider = {
    async getContentMetadata(contentId) {
      return clone(metadata.get(contentId) ?? null);
    },
    async listCategories() {
      return clone([...categoryStore.values()]);
    },
    async listTaxonomyTerms(type) {
      if (!taxonomyTerms.has(type)) return [];
      return clone([...taxonomyTerms.get(type).values()].filter((term) => term.enabled));
    },
    async listAllTaxonomyTerms(type) {
      if (!taxonomyTerms.has(type)) return [];
      return clone([...taxonomyTerms.get(type).values()]);
    },
    async upsertContentMetadata(contentId, value) {
      const record = validateCatalogContentMetadata(contentId, value);
      if (record.publicationStatus === 'published' && record.approvalStatus !== 'approved') {
        throw new CatalogConflictError('PUBLICATION_REQUIRES_APPROVAL');
      }
      assertTaxonomyReferences(record, taxonomyTerms);
      metadata.set(contentId, record);
      return clone(record);
    },
    async updateApprovalStatus(contentId, approvalStatus) {
      const current = metadata.get(contentId);
      if (!current) throw new CatalogNotFoundError('CONTENT_METADATA_NOT_FOUND');
      const status = validateApprovalStatus(approvalStatus);
      const updated = { ...current, approvalStatus: status };
      metadata.set(contentId, updated);
      return clone(updated);
    },
    async updatePublicationStatus(contentId, publicationStatus) {
      const current = metadata.get(contentId);
      if (!current) throw new CatalogNotFoundError('CONTENT_METADATA_NOT_FOUND');
      const status = validatePublicationStatus(publicationStatus, current.approvalStatus);
      const updated = { ...current, publicationStatus: status };
      metadata.set(contentId, updated);
      return clone(updated);
    },
    async upsertCategory(categoryId, value) {
      const category = validateCatalogCategory(categoryId, value);
      assertUniqueCategorySlug(category);
      categoryStore.set(categoryId, category);
      return clone(category);
    },
    async upsertTaxonomyTerm(type, termId, value) {
      if (!taxonomyTerms.has(type)) {
        validateCatalogTaxonomyTerm(type, termId, value);
      }
      const term = validateCatalogTaxonomyTerm(type, termId, value);
      const current = taxonomyTerms.get(type).get(termId);
      if (current?.enabled && !term.enabled) {
        const referenced = [...metadata.values()].some((record) => (
          (type === 'country' ? record.countryIds : record.genreIds)?.includes(termId)
        ));
        if (referenced) throw new CatalogConflictError('TAXONOMY_TERM_IN_USE');
      }
      taxonomyTerms.get(type).set(termId, term);
      return clone(term);
    },
  };

  return Object.freeze(assertWritableCatalogMetadataProvider(provider));
}

module.exports = { createInMemoryWritableCatalogMetadataProvider };
