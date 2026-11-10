'use strict';

const crypto = require('node:crypto');
const { assertVersionedWritableCatalogMetadataProvider } = require('./catalog-writable-metadata-provider');
const { markCatalogProviderKind } = require('./catalog-provider-kind');
const { assertCatalogAuditEventSink } = require('./catalog-audit-event-sink');
const { validateEpisode, validateSeason } = require('./catalog-series-structure-validation');
const { classifyCatalogDependencyError, createCatalogDataValidationError } = require('./catalog-operational-errors');
const {
  CatalogConflictError,
  CatalogInputError,
  CatalogNotFoundError,
  isCanonicalContentId,
  validateApprovalStatus,
  validateCatalogCategory,
  validateCatalogContentMetadata,
  validateCatalogTaxonomyTerm,
  validateExpectedVersion,
  validatePublicationStatus,
} = require('./catalog-metadata-validation');

const COLLECTIONS = Object.freeze({
  contentMetadata: 'catalogContentMetadata',
  categories: 'catalogCategories',
  taxonomies: 'catalogTaxonomies',
});
const TAXONOMY_TYPES = new Set(['country', 'genre']);
const INTERNAL_VERSION = '_version';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeStorageError() {
  return new Error('Unable to access catalog metadata storage.');
}

function validateConfiguration({ firestore, auditEventSink, collections, clock }) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof firestore.runTransaction !== 'function') {
    throw new TypeError('Firestore client must provide collection() and runTransaction().');
  }
  if (!isRecord(collections) ||
      ['contentMetadata', 'categories', 'taxonomies'].some((key) => (
        typeof collections[key] !== 'string' || collections[key].trim() === ''
      ))) {
    throw new TypeError('Invalid catalog metadata collection configuration.');
  }
  assertCatalogAuditEventSink(auditEventSink);
  if (typeof clock !== 'function') throw new TypeError('Catalog provider clock must be a function.');
}

function readSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.exists !== 'boolean') throw new TypeError();
  if (!snapshot.exists) return null;
  if (typeof snapshot.data !== 'function') throw new TypeError();
  const data = snapshot.data();
  if (!isRecord(data) || !Number.isSafeInteger(data[INTERNAL_VERSION]) || data[INTERNAL_VERSION] < 1) {
    throw new TypeError();
  }
  return { data, version: data[INTERNAL_VERSION] };
}

function projectContent(data, contentId) {
  if (data.contentId !== contentId) throw new TypeError();
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
    throw new TypeError();
  }
}

function projectCategory(document, data) {
  if (!document || typeof document.id !== 'string' || data.id !== document.id) throw new TypeError();
  try {
    return validateCatalogCategory(data.id, {
      slug: data.slug,
      localizedTitle: data.localizedTitle,
      enabled: data.enabled,
      ...(data.sortOrder === undefined ? {} : { sortOrder: data.sortOrder }),
      ...(data.mode === undefined ? {} : { mode: data.mode }),
      ...(data.filters === undefined ? {} : { filters: data.filters }),
    });
  } catch {
    throw new TypeError();
  }
}

function projectTaxonomy(type, document, data) {
  if (!document || typeof document.id !== 'string' || data.id !== document.id) throw new TypeError();
  try {
    return validateCatalogTaxonomyTerm(type, data.id, {
      labelFa: data.labelFa,
      enabled: data.enabled,
      ...(data.sortOrder === undefined ? {} : { sortOrder: data.sortOrder }),
    });
  } catch {
    throw new TypeError();
  }
}

function changedFields(previous, next, keys) {
  if (!previous) return keys;
  return keys.filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

function eventFor({ operation, entityType, entityId, options, previousVersion, version, fields, clock }) {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError();
  return {
    eventId: crypto.randomUUID(),
    operation,
    entityType,
    entityId,
    occurredAt: now.toISOString(),
    outcome: 'committed',
    previousVersion,
    version,
    changedFields: fields,
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
  };
}

function createFirestoreWritableCatalogMetadataProvider({
  firestore,
  auditEventSink,
  collections = COLLECTIONS,
  clock = () => new Date(),
} = {}) {
  validateConfiguration({ firestore, auditEventSink, collections, clock });

  function contentRef(contentId) {
    return firestore.collection(collections.contentMetadata).doc(contentId);
  }

  function categoryRef(categoryId) {
    return firestore.collection(collections.categories).doc(categoryId);
  }

  function taxonomyRef(type, termId) {
    return firestore.collection(collections.taxonomies)
      .doc(type).collection('terms').doc(termId);
  }

  async function readVersioned(reference, project) {
    try {
      const stored = readSnapshot(await reference.get());
      if (!stored) return null;
      return { value: project(stored.data), version: stored.version };
    } catch {
      throw safeStorageError();
    }
  }

  async function readCollection(collectionName, project, { enabledOnly = false } = {}) {
    try {
      const snapshot = await firestore.collection(collectionName).get();
      if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
      const values = snapshot.docs.map((document) => {
        const stored = readSnapshot({ exists: true, data: () => document.data() });
        return { value: project(document, stored.data), version: stored.version };
      });
      const result = enabledOnly ? values.filter(({ value }) => value.enabled) : values;
      if (collectionName === collections.categories) {
        const slugs = result.map(({ value }) => value.slug);
        if (new Set(slugs).size !== slugs.length) throw new TypeError();
      }
      return result;
    } catch {
      throw safeStorageError();
    }
  }

  async function readTaxonomy(type, { enabledOnly = false } = {}) {
    if (!TAXONOMY_TYPES.has(type)) return [];
    try {
      const snapshot = await firestore.collection(collections.taxonomies)
        .doc(type).collection('terms').get();
      if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
      const values = snapshot.docs.map((document) => {
        const stored = readSnapshot({ exists: true, data: () => document.data() });
        return { value: projectTaxonomy(type, document, stored.data), version: stored.version };
      });
      return (enabledOnly ? values.filter(({ value }) => value.enabled) : values);
    } catch {
      throw safeStorageError();
    }
  }

  async function assertActiveTaxonomyReferences(transaction, metadata) {
    for (const [field, type] of [['countryIds', 'country'], ['genreIds', 'genre']]) {
      for (const id of metadata[field] || []) {
        const snapshot = await transaction.get(taxonomyRef(type, id));
        const stored = readSnapshot(snapshot);
        if (!stored || !projectTaxonomy(type, { id }, stored.data).enabled) {
          throw new CatalogConflictError('TAXONOMY_REFERENCE_INVALID');
        }
      }
    }
  }

  async function assertActiveCategoryReferences(transaction, metadata) {
    for (const id of metadata.categoryIds || []) {
      const snapshot = await transaction.get(categoryRef(id));
      const stored = readSnapshot(snapshot);
      if (!stored || !projectCategory({ id }, stored.data).enabled) {
        throw new CatalogConflictError('CATEGORY_REFERENCE_INVALID');
      }
    }
  }

  async function transactWrite({
    reference,
    options,
    projectExisting,
    value,
    valueFor,
    entityType,
    entityId,
    operationFor,
    fieldNames,
    beforeWrite,
  }) {
    const writeOptions = validateExpectedVersion(options);
    try {
      return await firestore.runTransaction(async (transaction) => {
        const stored = readSnapshot(await transaction.get(reference));
        const expected = writeOptions.expectedVersion;
        if (expected === 0 && stored !== null) throw new CatalogConflictError('ALREADY_EXISTS');
        if (expected > 0 && (!stored || stored.version !== expected)) {
          throw new CatalogConflictError('VERSION_CONFLICT');
        }
        const previous = stored ? projectExisting(stored.data) : null;
        const nextVersion = (stored?.version ?? 0) + 1;
        const nextValue = valueFor ? valueFor(previous) : value;
        if (beforeWrite) await beforeWrite(transaction, previous, nextValue);
        const data = { ...nextValue, [INTERNAL_VERSION]: nextVersion };
        transaction.set(reference, data);
        const event = eventFor({
          operation: operationFor(previous, nextValue),
          entityType,
          entityId,
          options: writeOptions,
          previousVersion: stored?.version ?? 0,
          version: nextVersion,
          fields: changedFields(previous, nextValue, fieldNames),
          clock,
        });
        await auditEventSink.appendInTransaction(transaction, event);
        return { value: nextValue, version: nextVersion };
      });
    } catch (error) {
      if (error instanceof CatalogConflictError || error instanceof CatalogInputError) throw error;
      throw safeStorageError();
    }
  }

  async function deleteVersionedRecord({ reference, projectExisting, entityType, entityId, options, referenceCheck }) {
    const writeOptions = validateExpectedVersion(options);
    try {
      return await firestore.runTransaction(async (transaction) => {
        const stored = readSnapshot(await transaction.get(reference));
        if (!stored) throw new CatalogNotFoundError('NOT_FOUND');
        if (stored.version !== writeOptions.expectedVersion) throw new CatalogConflictError('VERSION_CONFLICT');
        const previous = projectExisting(stored.data);
        if (referenceCheck) await referenceCheck(transaction);
        transaction.delete(reference);
        const version = stored.version + 1;
        const event = eventFor({
          operation: `${entityType}.deleted`, entityType, entityId,
          options: writeOptions, previousVersion: stored.version, version,
          fields: ['deleted'], clock,
        });
        await auditEventSink.appendInTransaction(transaction, event);
        return { value: previous, version };
      });
    } catch (error) {
      if (error instanceof CatalogConflictError || error instanceof CatalogInputError ||
          error instanceof CatalogNotFoundError) throw error;
      throw safeStorageError();
    }
  }

  const provider = {
    async getContentMetadata(contentId) {
      if (!isCanonicalContentId(contentId)) return null;
      const record = await provider.getContentMetadataWithVersion(contentId);
      return record?.value ?? null;
    },
    async getContentMetadataWithVersion(contentId) {
      if (!isCanonicalContentId(contentId)) return null;
      return readVersioned(contentRef(contentId), (data) => projectContent(data, contentId));
    },
    async listContentMetadataWithVersion() {
      let snapshot;
      try {
        snapshot = await firestore.collection(collections.contentMetadata).get();
      } catch (error) {
        throw classifyCatalogDependencyError(
          'firestore', 'metadata_read', error, 'Unable to read catalog metadata.',
        );
      }
      const failValidation = (validationIssue) => {
        const error = createCatalogDataValidationError(
          'firestore', 'metadata_validation', 'Unable to read catalog metadata.',
        );
        error.validationIssue = validationIssue;
        throw error;
      };
      if (!snapshot || !Array.isArray(snapshot.docs)) failValidation('snapshot_shape');
      const results = [];
      for (const document of snapshot.docs) {
        if (!document || typeof document.id !== 'string' ||
            !isCanonicalContentId(document.id)) failValidation('document_id_invalid');
        let raw;
        try {
          if (typeof document.data !== 'function') failValidation('document_data_unavailable');
          raw = document.data();
        } catch (error) {
          if (error?.validationIssue) throw error;
          failValidation('document_data_unreadable');
        }
        if (!isRecord(raw)) failValidation('document_data_not_object');
        if (!Number.isSafeInteger(raw[INTERNAL_VERSION]) || raw[INTERNAL_VERSION] < 1) {
          failValidation('version_invalid');
        }
        if (raw.contentId !== document.id) failValidation('content_id_mismatch');
        let value;
        try {
          value = projectContent(raw, document.id);
        } catch {
          failValidation('metadata_fields_invalid');
        }
        results.push(Object.freeze({ value, version: raw[INTERNAL_VERSION] }));
      }
      return results;
    },
    async listCategories() {
      const entries = await readCollection(
        collections.categories,
        (document, data) => projectCategory(document, data),
      );
      return entries.map(({ value }) => value);
    },
    async listTaxonomyTerms(type) {
      return (await readTaxonomy(type, { enabledOnly: true })).map(({ value }) => value);
    },
    async listAllTaxonomyTerms(type) {
      return (await readTaxonomy(type)).map(({ value }) => value);
    },
    async getCategoryWithVersion(categoryId) {
      if (typeof categoryId !== 'string') return null;
      return readVersioned(categoryRef(categoryId), (data) => projectCategory({ id: categoryId }, data));
    },
    async getTaxonomyTermWithVersion(type, termId) {
      if (!TAXONOMY_TYPES.has(type) || typeof termId !== 'string') return null;
      return readVersioned(taxonomyRef(type, termId), (data) => projectTaxonomy(type, { id: termId }, data));
    },
    async moveContentMetadata(oldContentId, newContentId, options = {}) {
      if (!isCanonicalContentId(oldContentId) || !isCanonicalContentId(newContentId) ||
          oldContentId === newContentId) throw new CatalogInputError('INVALID_CONTENT_ID');
      try {
        return await firestore.runTransaction(async (transaction) => {
          const oldReference = contentRef(oldContentId);
          const newReference = contentRef(newContentId);
          const oldStored = readSnapshot(await transaction.get(oldReference));
          const newStored = readSnapshot(await transaction.get(newReference));
          if (!oldStored) return null;
          if (newStored) throw new CatalogConflictError('ALREADY_EXISTS');
          const previous = projectContent(oldStored.data, oldContentId);
          const nextVersion = oldStored.version + 1;
          const nextValue = validateCatalogContentMetadata(newContentId, {
            ...previous, contentId: newContentId,
          });
          transaction.set(newReference, { ...nextValue, [INTERNAL_VERSION]: nextVersion });
          transaction.delete(oldReference);
          const event = eventFor({
            operation: 'metadata.updated', entityType: 'content', entityId: oldContentId,
            options, previousVersion: oldStored.version, version: nextVersion,
            fields: ['contentId'], clock,
          });
          await auditEventSink.appendInTransaction(transaction, event);
          return { value: nextValue, version: nextVersion };
        });
      } catch (error) {
        if (error instanceof CatalogConflictError || error instanceof CatalogInputError) throw error;
        throw safeStorageError();
      }
    },
    async upsertContentMetadata(contentId, value, options) {
      const metadata = validateCatalogContentMetadata(contentId, value);
      if (metadata.publicationStatus === 'published' && metadata.approvalStatus !== 'approved') {
        throw new CatalogConflictError('PUBLICATION_REQUIRES_APPROVAL');
      }
      return (await transactWrite({
        reference: contentRef(contentId),
        options,
        projectExisting: (data) => projectContent(data, contentId),
        value: metadata,
        entityType: 'content',
        entityId: contentId,
        operationFor: (previous) => previous ? 'metadata.updated' : 'metadata.created',
        fieldNames: ['approvalStatus', 'publicationStatus', 'countryIds', 'genreIds', 'categoryIds', 'lifecycleStatus', 'disabledAt', 'disabledBy'],
        valueFor: (previous) => previous ? {
          ...metadata,
          ...(metadata.categoryIds === undefined && previous.categoryIds !== undefined ? { categoryIds: previous.categoryIds } : {}),
          ...(metadata.lifecycleStatus === undefined && previous.lifecycleStatus !== undefined
            ? { lifecycleStatus: previous.lifecycleStatus, ...(previous.disabledAt ? { disabledAt: previous.disabledAt, disabledBy: previous.disabledBy } : {}) }
            : {}),
          ...(metadata.lifecycleStatus === 'active' && previous.lifecycleStatus === 'disabled'
            ? { lifecycleStatus: 'disabled', disabledAt: previous.disabledAt, disabledBy: previous.disabledBy }
            : {}),
        } : metadata,
        beforeWrite: async (transaction, _previous, nextValue) => {
          await assertActiveTaxonomyReferences(transaction, nextValue);
          await assertActiveCategoryReferences(transaction, nextValue);
        },
      }));
    },
    async updateContentLifecycleStatus(contentId, lifecycleStatus, options) {
      if (!isCanonicalContentId(contentId) || !['active', 'disabled'].includes(lifecycleStatus)) {
        throw new CatalogInputError('INVALID_CONTENT_LIFECYCLE');
      }
      const writeOptions = validateExpectedVersion(options);
      const timestamp = clock();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) throw new CatalogInputError();
      const disabledFields = lifecycleStatus === 'disabled'
        ? { disabledAt: timestamp.toISOString(), ...(writeOptions.actorId ? { disabledBy: writeOptions.actorId } : {}) }
        : {};
      if (lifecycleStatus === 'disabled' && !writeOptions.actorId) throw new CatalogInputError();
      return transactWrite({
        reference: contentRef(contentId),
        options: writeOptions,
        projectExisting: (data) => projectContent(data, contentId),
        entityType: 'content',
        entityId: contentId,
        operationFor: (_previous, next) => next.lifecycleStatus === 'disabled' ? 'content.disabled' : 'content.restored',
        fieldNames: ['lifecycleStatus', 'disabledAt', 'disabledBy'],
        valueFor: (previous) => {
          const value = {
            ...(previous || {
              contentId,
              approvalStatus: 'unknown',
              publicationStatus: 'unknown',
              countryIds: [],
              genreIds: [],
            }),
            lifecycleStatus,
            ...disabledFields,
          };
          if (lifecycleStatus === 'active') {
            delete value.disabledAt;
            delete value.disabledBy;
          }
          return value;
        },
      });
    },
    async deleteContentMetadata(contentId, options) {
      if (!isCanonicalContentId(contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
      return deleteVersionedRecord({
        reference: contentRef(contentId),
        options,
        projectExisting: (data) => projectContent(data, contentId),
        entityType: 'content',
        entityId: contentId,
        referenceCheck: contentId.startsWith('series:') ? async (transaction) => {
          const seasonsCollection = firestore.collection('catalogSeriesStructures')
            .doc(contentId).collection('seasons');
          const seasonsSnapshot = await transaction.get(seasonsCollection);
          if (!seasonsSnapshot || !Array.isArray(seasonsSnapshot.docs)) throw new TypeError();
          const seasonEntries = [];
          const episodeEntries = [];
          for (const seasonDocument of seasonsSnapshot.docs) {
            const seasonData = seasonDocument.data();
            const seasonNumber = Number(String(seasonDocument.id).replace(/^season-/, ''));
            if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 1 ||
                !Number.isSafeInteger(seasonData?._version) || seasonData._version < 1) throw new TypeError();
            const season = validateSeason({
              seasonNumber,
              ...(seasonData.title === undefined ? {} : { title: seasonData.title }),
              ...(seasonData.description === undefined ? {} : { description: seasonData.description }),
              lifecycleStatus: seasonData.lifecycleStatus,
            });
            const episodesCollection = seasonsCollection.doc(seasonDocument.id).collection('episodes');
            const episodesSnapshot = await transaction.get(episodesCollection);
            if (!episodesSnapshot || !Array.isArray(episodesSnapshot.docs)) throw new TypeError();
            seasonEntries.push({ document: seasonDocument, season, version: seasonData._version });
            for (const episodeDocument of episodesSnapshot.docs) {
              const episodeData = episodeDocument.data();
              const episodeNumber = Number(String(episodeDocument.id).replace(/^episode-/, ''));
              if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1 ||
                  !Number.isSafeInteger(episodeData?._version) || episodeData._version < 1) throw new TypeError();
              const episode = validateEpisode({
                episodeNumber,
                ...(episodeData.title === undefined ? {} : { title: episodeData.title }),
                ...(episodeData.description === undefined ? {} : { description: episodeData.description }),
                ...(episodeData.releaseDate === undefined ? {} : { releaseDate: episodeData.releaseDate }),
                lifecycleStatus: episodeData.lifecycleStatus,
                downloadLinks: episodeData.downloadLinks,
              });
              episodeEntries.push({
                document: episodeDocument,
                episode,
                seasonNumber,
                version: episodeData._version,
              });
            }
          }
          if (seasonEntries.length + episodeEntries.length > 240) {
            throw new CatalogConflictError('CASCADE_LIMIT_EXCEEDED');
          }
          for (const entry of episodeEntries) {
            transaction.delete(entry.document.ref || seasonsCollection.doc(seasonDocumentId(entry.seasonNumber))
              .collection('episodes').doc(episodeDocumentId(entry.episode.episodeNumber)));
            await auditEventSink.appendInTransaction(transaction, eventFor({
              operation: 'episode.deleted',
              entityType: 'episode',
              entityId: `${contentId}:season:${entry.seasonNumber}:episode:${entry.episode.episodeNumber}`,
              options,
              previousVersion: entry.version,
              version: entry.version + 1,
              fields: ['deleted'],
              clock,
            }));
          }
          for (const entry of seasonEntries) {
            transaction.delete(entry.document.ref || seasonsCollection.doc(seasonDocumentId(entry.season.seasonNumber)));
            await auditEventSink.appendInTransaction(transaction, eventFor({
              operation: 'season.deleted',
              entityType: 'season',
              entityId: `${contentId}:season:${entry.season.seasonNumber}`,
              options,
              previousVersion: entry.version,
              version: entry.version + 1,
              fields: ['deleted'],
              clock,
            }));
          }
        } : undefined,
      });
    },
    async updateApprovalStatus(contentId, approvalStatus, options) {
      validateExpectedVersion(options);
      const current = await provider.getContentMetadataWithVersion(contentId);
      if (!current) throw new CatalogNotFoundError('CONTENT_METADATA_NOT_FOUND');
      const value = { ...current.value, approvalStatus: validateApprovalStatus(approvalStatus) };
      return (await transactWrite({
        reference: contentRef(contentId),
        options,
        projectExisting: (data) => projectContent(data, contentId),
        value,
        entityType: 'content',
        entityId: contentId,
        operationFor: (_previous, next) => `approval.${next.approvalStatus}`,
        fieldNames: ['approvalStatus'],
      }));
    },
    async updatePublicationStatus(contentId, publicationStatus, options) {
      validateExpectedVersion(options);
      const current = await provider.getContentMetadataWithVersion(contentId);
      if (!current) throw new CatalogNotFoundError('CONTENT_METADATA_NOT_FOUND');
      const value = {
        ...current.value,
        publicationStatus: validatePublicationStatus(publicationStatus, current.value.approvalStatus),
      };
      return (await transactWrite({
        reference: contentRef(contentId),
        options,
        projectExisting: (data) => projectContent(data, contentId),
        value,
        entityType: 'content',
        entityId: contentId,
        operationFor: (_previous, next) => `publication.${next.publicationStatus}`,
        fieldNames: ['publicationStatus'],
      }));
    },
    async upsertCategory(categoryId, value, options) {
      const category = validateCatalogCategory(categoryId, value);
      return (await transactWrite({
        reference: categoryRef(categoryId),
        options,
        projectExisting: (data) => projectCategory({ id: categoryId }, data),
        value: category,
        entityType: 'category',
        entityId: categoryId,
        operationFor: (previous) => previous ? 'category.updated' : 'category.created',
        fieldNames: ['slug', 'localizedTitle', 'filters', 'enabled', 'sortOrder', 'mode'],
        beforeWrite: async (transaction, previous) => {
          const snapshot = await transaction.get(
            firestore.collection(collections.categories).where('slug', '==', category.slug),
          );
          if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
          const conflicting = snapshot.docs.some((document) => document.id !== categoryId);
          if (conflicting) throw new CatalogConflictError('DUPLICATE_CATEGORY_SLUG');
          if (previous?.enabled && !category.enabled) {
            const references = await transaction.get(
              firestore.collection(collections.contentMetadata).where('categoryIds', 'array-contains', categoryId),
            );
            if (!references || !Array.isArray(references.docs)) throw new TypeError();
            if (references.docs.length > 0) throw new CatalogConflictError('CATEGORY_IN_USE');
          }
          return previous;
        },
      }));
    },
    async upsertTaxonomyTerm(type, termId, value, options) {
      const term = validateCatalogTaxonomyTerm(type, termId, value);
      return (await transactWrite({
        reference: taxonomyRef(type, termId),
        options,
        projectExisting: (data) => projectTaxonomy(type, { id: termId }, data),
        value: term,
        entityType: 'taxonomy',
        entityId: `${type}:${termId}`,
        operationFor: (previous) => previous ? 'taxonomy.updated' : 'taxonomy.created',
        fieldNames: ['labelFa', 'enabled', 'sortOrder'],
        beforeWrite: async (transaction, previous) => {
          if (previous?.enabled && !term.enabled) {
            const field = type === 'country' ? 'countryIds' : 'genreIds';
            const snapshot = await transaction.get(
              firestore.collection(collections.contentMetadata).where(field, 'array-contains', termId),
            );
            if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
            if (snapshot.docs.length > 0) throw new CatalogConflictError('TAXONOMY_TERM_IN_USE');
          }
        },
      }));
    },
    async deleteCategory(categoryId, options) {
      if (typeof categoryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(categoryId)) throw new CatalogInputError('INVALID_CATEGORY_ID');
      return deleteVersionedRecord({
        reference: categoryRef(categoryId),
        options,
        projectExisting: (data) => projectCategory({ id: categoryId }, data),
        entityType: 'category',
        entityId: categoryId,
        referenceCheck: async (transaction) => {
          const references = await transaction.get(
            firestore.collection(collections.contentMetadata).where('categoryIds', 'array-contains', categoryId),
          );
          if (!references || !Array.isArray(references.docs)) throw new TypeError();
          if (references.docs.length > 0) throw new CatalogConflictError('CATEGORY_IN_USE');
        },
      });
    },
    async deleteTaxonomyTerm(type, termId, options) {
      if (!TAXONOMY_TYPES.has(type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
      const validId = type === 'country'
        ? typeof termId === 'string' && /^[A-Z]{2}$/.test(termId)
        : typeof termId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(termId);
      if (!validId) throw new CatalogInputError('INVALID_TAXONOMY_ID');
      return deleteVersionedRecord({
        reference: taxonomyRef(type, termId),
        options,
        projectExisting: (data) => projectTaxonomy(type, { id: termId }, data),
        entityType: 'taxonomy',
        entityId: `${type}:${termId}`,
        referenceCheck: async (transaction) => {
          const field = type === 'country' ? 'countryIds' : 'genreIds';
          const references = await transaction.get(
            firestore.collection(collections.contentMetadata).where(field, 'array-contains', termId),
          );
          if (!references || !Array.isArray(references.docs)) throw new TypeError();
          if (references.docs.length > 0) throw new CatalogConflictError('TAXONOMY_TERM_IN_USE');
        },
      });
    },
  };

  return Object.freeze(markCatalogProviderKind(
    assertVersionedWritableCatalogMetadataProvider(provider),
    'firestore-write',
  ));
}

module.exports = { createFirestoreWritableCatalogMetadataProvider };
