'use strict';

const { getCategoryItems } = require('./catalog-core');
const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');
const { createCatalogContentId } = require('./catalog-content-identity');

const COLLECTIONS = Object.freeze({
  contentMetadata: 'catalogContentMetadata',
  categories: 'catalogCategories',
  taxonomies: 'catalogTaxonomies',
});
const CONTENT_KINDS = new Set(['movie', 'series']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'unknown']);
const PUBLICATION_STATUSES = new Set(['draft', 'published', 'archived', 'unknown']);
const TAXONOMY_TYPES = new Set(['country', 'genre']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalContentId(contentId) {
  if (typeof contentId !== 'string') return false;
  const separator = contentId.indexOf(':');
  if (separator < 1) return false;
  const kind = contentId.slice(0, separator);
  const encodedCode = contentId.slice(separator + 1);
  if (!CONTENT_KINDS.has(kind) || encodedCode.length === 0) return false;
  try {
    return createCatalogContentId(kind, decodeURIComponent(encodedCode)) === contentId;
  } catch {
    return false;
  }
}

function validIdList(value, type) {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
    const id = value[index];
    const valid = typeof id === 'string' &&
      (type === 'country' ? /^[A-Z]{2}$/.test(id) : ID_PATTERN.test(id)) &&
      !ids.has(id);
    if (!valid) return false;
    ids.add(id);
  }
  return true;
}

function projectContentMetadata(data, contentId) {
  if (
    !isRecord(data) ||
    data.contentId !== contentId ||
    !APPROVAL_STATUSES.has(data.approvalStatus) ||
    !PUBLICATION_STATUSES.has(data.publicationStatus) ||
    !validIdList(data.countryIds, 'country') ||
    !validIdList(data.genreIds, 'genre')
  ) return null;

  const metadata = {
    contentId,
    approvalStatus: data.approvalStatus,
    publicationStatus: data.publicationStatus,
  };
  if (data.countryIds !== undefined) metadata.countryIds = [...data.countryIds];
  if (data.genreIds !== undefined) metadata.genreIds = [...data.genreIds];
  return metadata;
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
          if (
            !isRecord(data) ||
            typeof document.id !== 'string' ||
            data.id !== document.id ||
            !ID_PATTERN.test(data.id) ||
            typeof data.slug !== 'string' || !SLUG_PATTERN.test(data.slug) ||
            typeof data.enabled !== 'boolean' ||
            !isRecord(data.localizedTitle) ||
            Object.keys(data.localizedTitle).length === 0 ||
            Object.entries(data.localizedTitle).some(([locale, title]) => (
              !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale) ||
              typeof title !== 'string' || title.trim() === ''
            )) ||
            (data.sortOrder !== undefined && !Number.isFinite(data.sortOrder))
          ) throw new TypeError();

          const category = {
            id: data.id,
            slug: data.slug,
            localizedTitle: { ...data.localizedTitle },
            enabled: data.enabled,
            sortOrder: data.sortOrder,
          };
          if (data.filters !== undefined) category.filters = data.filters;
          if (category.enabled) getCategoryItems([], category);
          return category;
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
          const validTypeId = type === 'country'
            ? typeof data?.id === 'string' && /^[A-Z]{2}$/.test(data.id)
            : typeof data?.id === 'string' && ID_PATTERN.test(data.id);
          if (
            !isRecord(data) ||
            typeof document.id !== 'string' ||
            data.id !== document.id ||
            !validTypeId ||
            typeof data.labelFa !== 'string' || data.labelFa.trim() === '' ||
            typeof data.enabled !== 'boolean'
          ) throw new TypeError();
          return { id: data.id, labelFa: data.labelFa, enabled: data.enabled };
        }).filter((term) => term.enabled);
      } catch {
        throw safeReadError();
      }
    },
  };

  return Object.freeze(assertCatalogMetadataProvider(provider));
}

module.exports = { createFirestoreCatalogMetadataProvider };
