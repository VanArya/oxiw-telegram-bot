'use strict';

const { assertWritableCatalogMetadataProvider } = require('./catalog-writable-metadata-provider');
const { markCatalogProviderKind } = require('./catalog-provider-kind');
const {
  CatalogConflictError,
  CatalogNotFoundError,
  validateApprovalStatus,
  validateCatalogCategory,
  validateCatalogContentMetadata,
  validateCatalogTaxonomyTerm,
  validateExpectedVersion,
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
  const metadataVersions = new Map();
  const categoryStore = new Map();
  const categoryVersions = new Map();
  const taxonomyTerms = new Map([['country', new Map()], ['genre', new Map()]]);
  const taxonomyVersions = new Map([['country', new Map()], ['genre', new Map()]]);

  function checkExpectedVersion(versions, id, options) {
    const { expectedVersion } = validateExpectedVersion(options);
    const currentVersion = versions.get(id) ?? 0;
    if (expectedVersion === 0 && currentVersion > 0) throw new CatalogConflictError('ALREADY_EXISTS');
    if (expectedVersion > 0 && expectedVersion !== currentVersion) {
      throw new CatalogConflictError('VERSION_CONFLICT');
    }
    return currentVersion + 1;
  }

  for (const item of contentMetadata) {
    if (!item || typeof item.contentId !== 'string' || metadata.has(item.contentId)) {
      throw new CatalogConflictError('DUPLICATE_CONTENT_METADATA');
    }
    const record = validateCatalogContentMetadata(item.contentId, item);
    metadata.set(record.contentId, record);
    metadataVersions.set(record.contentId, 1);
  }

  for (const item of categories) {
    if (!item || typeof item.id !== 'string' || categoryStore.has(item.id)) {
      throw new CatalogConflictError('DUPLICATE_CATEGORY_ID');
    }
    categoryStore.set(item.id, validateCatalogCategory(item.id, item));
    categoryVersions.set(item.id, 1);
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
      taxonomyVersions.get(type).set(item.id, 1);
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
    async getContentMetadataWithVersion(contentId) {
      const value = metadata.get(contentId);
      if (!value) return null;
      return { value: clone(value), version: metadataVersions.get(contentId) };
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
    async getCategoryWithVersion(categoryId) {
      const value = categoryStore.get(categoryId);
      if (!value) return null;
      return { value: clone(value), version: categoryVersions.get(categoryId) };
    },
    async getTaxonomyTermWithVersion(type, termId) {
      const value = taxonomyTerms.get(type)?.get(termId);
      if (!value) return null;
      return { value: clone(value), version: taxonomyVersions.get(type).get(termId) };
    },
    async moveContentMetadata(oldContentId, newContentId) {
      if (typeof oldContentId !== 'string' || typeof newContentId !== 'string' ||
          !oldContentId || !newContentId || oldContentId === newContentId) {
        throw new CatalogConflictError('INVALID_CONTENT_ID');
      }
      const current = metadata.get(oldContentId);
      if (!current) return null;
      if (metadata.has(newContentId)) throw new CatalogConflictError('ALREADY_EXISTS');
      const version = (metadataVersions.get(oldContentId) ?? 0) + 1;
      const moved = validateCatalogContentMetadata(newContentId, { ...current, contentId: newContentId });
      metadata.delete(oldContentId);
      metadataVersions.delete(oldContentId);
      metadata.set(newContentId, moved);
      metadataVersions.set(newContentId, version);
      return { value: clone(moved), version };
    },
    async upsertContentMetadata(contentId, value, options) {
      const record = validateCatalogContentMetadata(contentId, value);
      if (record.publicationStatus === 'published' && record.approvalStatus !== 'approved') {
        throw new CatalogConflictError('PUBLICATION_REQUIRES_APPROVAL');
      }
      assertTaxonomyReferences(record, taxonomyTerms);
      const version = checkExpectedVersion(metadataVersions, contentId, options);
      metadata.set(contentId, record);
      metadataVersions.set(contentId, version);
      return { value: clone(record), version };
    },
    async updateContentLifecycleStatus(contentId, lifecycleStatus, options) {
      if (typeof contentId !== 'string' || !['active', 'disabled'].includes(lifecycleStatus)) {
        throw new CatalogConflictError('INVALID_CONTENT_LIFECYCLE');
      }
      const version = checkExpectedVersion(metadataVersions, contentId, options);
      const current = metadata.get(contentId) || {
        contentId,
        approvalStatus: 'unknown',
        publicationStatus: 'unknown',
        countryIds: [],
        genreIds: [],
        lifecycleStatus: 'active',
      };
      const updated = lifecycleStatus === 'disabled'
        ? { ...current, lifecycleStatus, disabledAt: new Date().toISOString(), disabledBy: options.actorId }
        : { ...current, lifecycleStatus, disabledAt: undefined, disabledBy: undefined };
      if (lifecycleStatus === 'disabled' && !options.actorId) throw new CatalogConflictError('INVALID_ACTOR');
      if (lifecycleStatus === 'active') {
        delete updated.disabledAt;
        delete updated.disabledBy;
      }
      metadata.set(contentId, updated);
      metadataVersions.set(contentId, version);
      return { value: clone(updated), version };
    },
    async updateApprovalStatus(contentId, approvalStatus, options) {
      const current = metadata.get(contentId);
      if (!current) throw new CatalogNotFoundError('CONTENT_METADATA_NOT_FOUND');
      const status = validateApprovalStatus(approvalStatus);
      const version = checkExpectedVersion(metadataVersions, contentId, options);
      const updated = { ...current, approvalStatus: status };
      metadata.set(contentId, updated);
      metadataVersions.set(contentId, version);
      return { value: clone(updated), version };
    },
    async updatePublicationStatus(contentId, publicationStatus, options) {
      const current = metadata.get(contentId);
      if (!current) throw new CatalogNotFoundError('CONTENT_METADATA_NOT_FOUND');
      const status = validatePublicationStatus(publicationStatus, current.approvalStatus);
      const version = checkExpectedVersion(metadataVersions, contentId, options);
      const updated = { ...current, publicationStatus: status };
      metadata.set(contentId, updated);
      metadataVersions.set(contentId, version);
      return { value: clone(updated), version };
    },
    async upsertCategory(categoryId, value, options) {
      const category = validateCatalogCategory(categoryId, value);
      assertUniqueCategorySlug(category);
      const version = checkExpectedVersion(categoryVersions, categoryId, options);
      categoryStore.set(categoryId, category);
      categoryVersions.set(categoryId, version);
      return { value: clone(category), version };
    },
    async upsertTaxonomyTerm(type, termId, value, options) {
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
      const version = checkExpectedVersion(taxonomyVersions.get(type), termId, options);
      taxonomyTerms.get(type).set(termId, term);
      taxonomyVersions.get(type).set(termId, version);
      return { value: clone(term), version };
    },
  };

  return Object.freeze(markCatalogProviderKind(assertWritableCatalogMetadataProvider(provider), 'in-memory'));
}

module.exports = { createInMemoryWritableCatalogMetadataProvider };
