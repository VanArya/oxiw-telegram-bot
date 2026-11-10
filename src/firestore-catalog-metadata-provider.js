'use strict';

const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');
const { markCatalogProviderKind } = require('./catalog-provider-kind');
const {
  classifyCatalogDependencyError,
  createCatalogDataValidationError,
} = require('./catalog-operational-errors');
const {
  isCanonicalContentId,
  validateCatalogCategory,
  validateCatalogContentMetadata,
  validateCatalogTaxonomyTerm,
} = require('./catalog-metadata-validation');

const COLLECTIONS = Object.freeze({
  contentMetadata: 'catalogContentMetadata',
  categories: 'catalogCategories',
  taxonomies: 'catalogTaxonomies',
});
const TAXONOMY_TYPES = new Set(['country', 'genre']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectContentMetadata(data, contentId) {
  if (!isRecord(data) || data.contentId !== contentId) return null;
  try {
    return validateCatalogContentMetadata(contentId, {
      contentId: data.contentId,
      approvalStatus: data.approvalStatus,
      publicationStatus: data.publicationStatus,
      ...(data.countryIds === undefined ? {} : { countryIds: data.countryIds }),
      ...(data.genreIds === undefined ? {} : { genreIds: data.genreIds }),
      ...(data.categoryIds === undefined ? {} : { categoryIds: data.categoryIds }),
      ...(data.lifecycleStatus === undefined ? {} : { lifecycleStatus: data.lifecycleStatus }),
      ...(data.disabledAt === undefined ? {} : { disabledAt: data.disabledAt }),
      ...(data.disabledBy === undefined ? {} : { disabledBy: data.disabledBy }),
    });
  } catch {
    return null;
  }
}

function readDocumentData(document) {
  if (!document || typeof document.data !== 'function') {
    throw new TypeError('Invalid Firestore document response.');
  }
  return document.data();
}

function createFirestoreCatalogMetadataProvider({ firestore, collections = COLLECTIONS } = {}) {
  if (!firestore || typeof firestore.collection !== 'function') {
    throw new TypeError('Firestore client must provide collection().');
  }
  if (
    !isRecord(collections) ||
    ['contentMetadata', 'categories', 'taxonomies'].some(
      (key) => typeof collections[key] !== 'string' || collections[key].trim() === '',
    )
  ) {
    throw new TypeError('Invalid catalog metadata collection configuration.');
  }

  const provider = {
    async getContentMetadata(contentId) {
      if (!isCanonicalContentId(contentId)) return null;
      let snapshot;
      try {
        snapshot = await firestore.collection(collections.contentMetadata).doc(contentId).get();
      } catch (error) {
        throw classifyCatalogDependencyError(
          'firestore', 'metadata_read', error, 'Unable to read catalog metadata.',
        );
      }
      if (!snapshot || typeof snapshot.exists !== 'boolean') {
        throw createCatalogDataValidationError(
          'firestore', 'metadata_validation', 'Unable to read catalog metadata.',
        );
      }
      if (!snapshot.exists) return null;
      try {
        return projectContentMetadata(readDocumentData(snapshot), contentId);
      } catch {
        throw createCatalogDataValidationError(
          'firestore', 'metadata_validation', 'Unable to read catalog metadata.',
        );
      }
    },

    async listCategories() {
      let snapshot;
      try {
        snapshot = await firestore.collection(collections.categories).get();
      } catch (error) {
        throw classifyCatalogDependencyError(
          'firestore', 'category_read', error, 'Unable to read catalog metadata.',
        );
      }
      try {
        if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();

        const categories = snapshot.docs.map((document) => {
          const data = readDocumentData(document);
          if (!isRecord(data) || typeof document.id !== 'string' || data.id !== document.id) {
            throw new TypeError();
          }
          return validateCatalogCategory(data.id, {
            slug: data.slug,
            localizedTitle: data.localizedTitle,
            enabled: data.enabled,
            ...(data.sortOrder === undefined ? {} : { sortOrder: data.sortOrder }),
            ...(data.mode === undefined ? {} : { mode: data.mode }),
            ...(data.filters === undefined ? {} : { filters: data.filters }),
          });
        }).filter((category) => category.enabled);
        const slugs = categories.map(({ slug }) => slug);
        if (new Set(slugs).size !== slugs.length) throw new TypeError();
        return categories;
      } catch {
        throw createCatalogDataValidationError(
          'firestore', 'category_validation', 'Unable to read catalog metadata.',
        );
      }
    },

    async listTaxonomyTerms(type) {
      if (!TAXONOMY_TYPES.has(type)) return [];
      let snapshot;
      try {
        snapshot = await firestore
          .collection(collections.taxonomies)
          .doc(type)
          .collection('terms')
          .get();
      } catch (error) {
        throw classifyCatalogDependencyError(
          'firestore', 'taxonomy_read', error, 'Unable to read catalog metadata.',
        );
      }
      try {
        if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();

        return snapshot.docs.map((document) => {
          const data = readDocumentData(document);
          if (!isRecord(data) || typeof document.id !== 'string' || data.id !== document.id) {
            throw new TypeError();
          }
          return validateCatalogTaxonomyTerm(type, data.id, {
            labelFa: data.labelFa,
            enabled: data.enabled,
            ...(data.sortOrder === undefined ? {} : { sortOrder: data.sortOrder }),
          });
        }).filter((term) => term.enabled);
      } catch {
        throw createCatalogDataValidationError(
          'firestore', 'taxonomy_validation', 'Unable to read catalog metadata.',
        );
      }
    },
  };

  return Object.freeze(markCatalogProviderKind(assertCatalogMetadataProvider(provider), 'firestore-read'));
}

module.exports = { createFirestoreCatalogMetadataProvider };
