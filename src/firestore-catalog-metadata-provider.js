'use strict';

const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');
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

function safeReadError() {
  return new Error('Unable to read catalog metadata.');
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
      try {
        const snapshot = await firestore.collection(collections.contentMetadata).doc(contentId).get();
        if (!snapshot || snapshot.exists !== true) return null;
        return projectContentMetadata(readDocumentData(snapshot), contentId);
      } catch {
        throw safeReadError();
      }
    },

    async listCategories() {
      try {
        const snapshot = await firestore.collection(collections.categories).get();
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
            ...(data.filters === undefined ? {} : { filters: data.filters }),
          });
        }).filter((category) => category.enabled);
        const slugs = categories.map(({ slug }) => slug);
        if (new Set(slugs).size !== slugs.length) throw new TypeError();
        return categories;
      } catch {
        throw safeReadError();
      }
    },

    async listTaxonomyTerms(type) {
      if (!TAXONOMY_TYPES.has(type)) return [];
      try {
        const snapshot = await firestore
          .collection(collections.taxonomies)
          .doc(type)
          .collection('terms')
          .get();
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
        throw safeReadError();
      }
    },
  };

  return Object.freeze(assertCatalogMetadataProvider(provider));
}

module.exports = { createFirestoreCatalogMetadataProvider };
