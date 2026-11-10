'use strict';

const crypto = require('node:crypto');
const {
  CatalogConflictError,
  CatalogNotFoundError,
  validateExpectedVersion,
} = require('./catalog-metadata-validation');
const { assertCatalogAuditEventSink } = require('./catalog-audit-event-sink');
const { CatalogSeriesStructureInputError, episodeDocumentId, seasonDocumentId,
  validateEpisode, validateSeason, validateSeriesId } = require('./catalog-series-structure-validation');

const DEFAULT_COLLECTION = 'catalogSeriesStructures';
const INTERNAL_VERSION = '_version';
const MAX_ATOMIC_CASCADE_ITEMS = 240;

function safeStorageError() {
  return new Error('Unable to access series structure storage.');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotValue(snapshot) {
  if (!snapshot || typeof snapshot.exists !== 'boolean') throw new TypeError();
  if (!snapshot.exists) return null;
  if (typeof snapshot.data !== 'function') throw new TypeError();
  const data = snapshot.data();
  if (!isRecord(data) || !Number.isSafeInteger(data[INTERNAL_VERSION]) || data[INTERNAL_VERSION] < 1) {
    throw new TypeError();
  }
  return { data, version: data[INTERNAL_VERSION] };
}

function changedFields(previous, next, fields) {
  if (!previous) return fields;
  return fields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
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
    actorId: options.actorId,
  };
}

function projectSeason(documentId, data) {
  if (documentId !== seasonDocumentId(data.seasonNumber)) throw new TypeError();
  const value = validateSeason({
    seasonNumber: data.seasonNumber,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.description === undefined ? {} : { description: data.description }),
    lifecycleStatus: data.lifecycleStatus,
  });
  return {
    ...value,
    ...(data.disabledAt === undefined ? {} : { disabledAt: data.disabledAt }),
    ...(data.disabledBy === undefined ? {} : { disabledBy: data.disabledBy }),
    ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
    ...(data.updatedAt === undefined ? {} : { updatedAt: data.updatedAt }),
  };
}

function projectEpisode(documentId, data) {
  if (documentId !== episodeDocumentId(data.episodeNumber)) throw new TypeError();
  const value = validateEpisode({
    episodeNumber: data.episodeNumber,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.description === undefined ? {} : { description: data.description }),
    ...(data.releaseDate === undefined ? {} : { releaseDate: data.releaseDate }),
    lifecycleStatus: data.lifecycleStatus,
    downloadLinks: data.downloadLinks,
  });
  return {
    ...value,
    ...(data.disabledAt === undefined ? {} : { disabledAt: data.disabledAt }),
    ...(data.disabledBy === undefined ? {} : { disabledBy: data.disabledBy }),
    ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
    ...(data.updatedAt === undefined ? {} : { updatedAt: data.updatedAt }),
  };
}

function createFirestoreCatalogSeriesStructureProvider({
  firestore,
  auditEventSink,
  collection = DEFAULT_COLLECTION,
  clock = () => new Date(),
} = {}) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof firestore.runTransaction !== 'function' ||
      typeof collection !== 'string' || collection.trim() === '' ||
      typeof clock !== 'function') {
    throw new TypeError('Invalid series structure provider configuration.');
  }
  assertCatalogAuditEventSink(auditEventSink);

  function seriesRef(seriesId) {
    return firestore.collection(collection).doc(validateSeriesId(seriesId));
  }
  function seasonsRef(seriesId) {
    return seriesRef(seriesId).collection('seasons');
  }
  function seasonRef(seriesId, seasonNumber) {
    return seasonsRef(seriesId).doc(seasonDocumentId(seasonNumber));
  }
  function episodesRef(seriesId, seasonNumber) {
    return seasonRef(seriesId, seasonNumber).collection('episodes');
  }
  function episodeRef(seriesId, seasonNumber, episodeNumber) {
    return episodesRef(seriesId, seasonNumber).doc(episodeDocumentId(episodeNumber));
  }

  async function readVersioned(reference, project) {
    const stored = snapshotValue(await reference.get());
    return stored ? { value: project(reference.path.split('/').at(-1), stored.data), version: stored.version } : null;
  }

  async function writeRecord({ reference, options, validator, input, entityType, entityId, operationFor, fields }) {
    const writeOptions = validateExpectedVersion(options);
    if (!writeOptions.actorId) throw new CatalogSeriesStructureInputError('ACTOR_REQUIRED');
    const timestamp = clock();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) throw new TypeError();
    return firestore.runTransaction(async (transaction) => {
      const stored = snapshotValue(await transaction.get(reference));
      if (writeOptions.expectedVersion === 0 && stored) throw new CatalogConflictError('ALREADY_EXISTS');
      if (writeOptions.expectedVersion > 0 && (!stored || stored.version !== writeOptions.expectedVersion)) {
        throw new CatalogConflictError('VERSION_CONFLICT');
      }
      const previous = stored ? validator(reference.path.split('/').at(-1), stored.data) : null;
      const next = validator(reference.path.split('/').at(-1), input);
      const version = (stored?.version ?? 0) + 1;
      const now = timestamp.toISOString();
      const data = {
        ...next,
        createdAt: stored?.data.createdAt || now,
        updatedAt: now,
        [INTERNAL_VERSION]: version,
      };
      if (next.lifecycleStatus === 'disabled') {
        data.disabledAt = previous?.disabledAt || now;
        data.disabledBy = previous?.disabledBy || writeOptions.actorId;
      } else {
        delete data.disabledAt;
        delete data.disabledBy;
      }
      transaction.set(reference, data);
      await auditEventSink.appendInTransaction(transaction, eventFor({
        operation: operationFor(previous, next),
        entityType,
        entityId,
        options: writeOptions,
        previousVersion: stored?.version ?? 0,
        version,
        fields: changedFields(previous, next, fields),
        clock,
      }));
      return { value: validator(reference.path.split('/').at(-1), data), version };
    }).catch((error) => {
      if (error instanceof CatalogConflictError || error instanceof CatalogSeriesStructureInputError) throw error;
      throw safeStorageError();
    });
  }

  async function deleteRecord({ reference, options, project, entityType, entityId }) {
    const writeOptions = validateExpectedVersion(options);
    if (!writeOptions.actorId) throw new CatalogSeriesStructureInputError('ACTOR_REQUIRED');
    return firestore.runTransaction(async (transaction) => {
      const stored = snapshotValue(await transaction.get(reference));
      if (!stored) throw new CatalogNotFoundError('NOT_FOUND');
      if (stored.version !== writeOptions.expectedVersion) throw new CatalogConflictError('VERSION_CONFLICT');
      const previous = project(reference.path.split('/').at(-1), stored.data);
      transaction.delete(reference);
      await auditEventSink.appendInTransaction(transaction, eventFor({
        operation: `${entityType}.deleted`,
        entityType,
        entityId,
        options: writeOptions,
        previousVersion: stored.version,
        version: stored.version + 1,
        fields: ['deleted'],
        clock,
      }));
      return { value: previous, version: stored.version + 1 };
    });
  }

  const provider = {
    async listSeasons(seriesId, { includeDisabled = false } = {}) {
      const snapshot = await seasonsRef(seriesId).get();
      if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
      return snapshot.docs.map((doc) => {
        const stored = snapshotValue({ exists: true, data: () => doc.data() });
        return { value: projectSeason(doc.id, stored.data), version: stored.version };
      }).filter(({ value }) => includeDisabled || value.lifecycleStatus === 'active')
        .sort((left, right) => left.value.seasonNumber - right.value.seasonNumber);
    },
    async getSeasonWithVersion(seriesId, seasonNumber) {
      if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 1) return null;
      return readVersioned(seasonRef(seriesId, seasonNumber), projectSeason);
    },
    async createSeason(seriesId, value, options) {
      const season = validateSeason(value);
      return writeRecord({
        reference: seasonRef(seriesId, season.seasonNumber),
        options,
        validator: (_id, data) => projectSeason(seasonDocumentId(data.seasonNumber), data),
        input: season,
        entityType: 'season',
        entityId: `${seriesId}:season:${season.seasonNumber}`,
        operationFor: () => 'season.created',
        fields: ['seasonNumber', 'title', 'description', 'lifecycleStatus'],
      });
    },
    async updateSeason(seriesId, seasonNumber, value, options) {
      const season = validateSeason({ ...value, seasonNumber });
      return writeRecord({
        reference: seasonRef(seriesId, seasonNumber),
        options,
        validator: projectSeason,
        input: season,
        entityType: 'season',
        entityId: `${seriesId}:season:${seasonNumber}`,
        operationFor: (previous, next) => previous?.lifecycleStatus !== next.lifecycleStatus
          ? (next.lifecycleStatus === 'disabled' ? 'season.disabled' : 'season.restored')
          : 'season.updated',
        fields: ['seasonNumber', 'title', 'description', 'lifecycleStatus'],
      });
    },
    async setSeasonLifecycleStatus(seriesId, seasonNumber, lifecycleStatus, options) {
      const current = await provider.getSeasonWithVersion(seriesId, seasonNumber);
      if (!current) throw new CatalogNotFoundError('SEASON_NOT_FOUND');
      const { disabledAt, disabledBy, createdAt, updatedAt, ...editable } = current.value;
      return provider.updateSeason(seriesId, seasonNumber, {
        ...editable,
        lifecycleStatus,
      }, options);
    },
    async deleteSeason(seriesId, seasonNumber, options) {
      const writeOptions = validateExpectedVersion(options);
      if (!writeOptions.actorId) throw new CatalogSeriesStructureInputError('ACTOR_REQUIRED');
      const reference = seasonRef(seriesId, seasonNumber);
      return firestore.runTransaction(async (transaction) => {
        const seasonStored = snapshotValue(await transaction.get(reference));
        if (!seasonStored) throw new CatalogNotFoundError('SEASON_NOT_FOUND');
        if (seasonStored.version !== writeOptions.expectedVersion) throw new CatalogConflictError('VERSION_CONFLICT');
        const episodeSnapshot = await transaction.get(episodesRef(seriesId, seasonNumber));
        if (!episodeSnapshot || !Array.isArray(episodeSnapshot.docs)) throw new TypeError();
        if (episodeSnapshot.docs.length > MAX_ATOMIC_CASCADE_ITEMS) {
          throw new CatalogConflictError('CASCADE_LIMIT_EXCEEDED');
        }
        for (const episode of episodeSnapshot.docs) {
          const stored = snapshotValue({ exists: true, data: () => episode.data() });
          const value = projectEpisode(episode.id, stored.data);
          transaction.delete(episodeRef(seriesId, seasonNumber, value.episodeNumber));
          await auditEventSink.appendInTransaction(transaction, eventFor({
            operation: 'episode.deleted',
            entityType: 'episode',
            entityId: `${seriesId}:season:${seasonNumber}:episode:${value.episodeNumber}`,
            options: writeOptions,
            previousVersion: stored.version,
            version: stored.version + 1,
            fields: ['deleted'],
            clock,
          }));
        }
        transaction.delete(reference);
        await auditEventSink.appendInTransaction(transaction, eventFor({
          operation: 'season.deleted',
          entityType: 'season',
          entityId: `${seriesId}:season:${seasonNumber}`,
          options: writeOptions,
          previousVersion: seasonStored.version,
          version: seasonStored.version + 1,
          fields: ['deleted'],
          clock,
        }));
        return { deletedEpisodes: episodeSnapshot.docs.length };
      });
    },
    async listEpisodes(seriesId, seasonNumber, { includeDisabled = false } = {}) {
      const season = await provider.getSeasonWithVersion(seriesId, seasonNumber);
      if (!season) throw new CatalogNotFoundError('SEASON_NOT_FOUND');
      if (!includeDisabled && season.value.lifecycleStatus !== 'active') return [];
      const snapshot = await episodesRef(seriesId, seasonNumber).get();
      if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
      return snapshot.docs.map((doc) => {
        const stored = snapshotValue({ exists: true, data: doc.data });
        return { value: projectEpisode(doc.id, stored.data), version: stored.version };
      }).filter(({ value }) => includeDisabled || value.lifecycleStatus === 'active')
        .sort((left, right) => left.value.episodeNumber - right.value.episodeNumber);
    },
    async getEpisodeWithVersion(seriesId, seasonNumber, episodeNumber) {
      if (![seasonNumber, episodeNumber].every((number) => Number.isSafeInteger(number) && number >= 1)) return null;
      return readVersioned(episodeRef(seriesId, seasonNumber, episodeNumber), projectEpisode);
    },
    async createEpisode(seriesId, seasonNumber, value, options) {
      const episode = validateEpisode(value);
      return firestore.runTransaction(async (transaction) => {
        const seasonStored = snapshotValue(await transaction.get(seasonRef(seriesId, seasonNumber)));
        if (!seasonStored) throw new CatalogNotFoundError('SEASON_NOT_FOUND');
        const reference = episodeRef(seriesId, seasonNumber, episode.episodeNumber);
        const existing = snapshotValue(await transaction.get(reference));
        if (existing) throw new CatalogConflictError('ALREADY_EXISTS');
        const writeOptions = validateExpectedVersion(options);
        if (writeOptions.expectedVersion !== 0) throw new CatalogConflictError('ALREADY_EXISTS');
        if (!writeOptions.actorId) throw new CatalogSeriesStructureInputError('ACTOR_REQUIRED');
        const now = clock();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError();
        const data = { ...episode, createdAt: now.toISOString(), updatedAt: now.toISOString(), [INTERNAL_VERSION]: 1 };
        if (episode.lifecycleStatus === 'disabled') {
          data.disabledAt = now.toISOString();
          data.disabledBy = writeOptions.actorId;
        }
        transaction.set(reference, data);
        await auditEventSink.appendInTransaction(transaction, eventFor({
          operation: 'episode.created',
          entityType: 'episode',
          entityId: `${seriesId}:season:${seasonNumber}:episode:${episode.episodeNumber}`,
          options: writeOptions,
          previousVersion: 0,
          version: 1,
          fields: ['episodeNumber', 'title', 'description', 'releaseDate', 'lifecycleStatus', 'downloadLinks'],
          clock,
        }));
        return { value: projectEpisode(episodeDocumentId(episode.episodeNumber), data), version: 1 };
      });
    },
    async updateEpisode(seriesId, seasonNumber, episodeNumber, value, options) {
      const episode = validateEpisode({ ...value, episodeNumber });
      return writeRecord({
        reference: episodeRef(seriesId, seasonNumber, episodeNumber),
        options,
        validator: projectEpisode,
        input: episode,
        entityType: 'episode',
        entityId: `${seriesId}:season:${seasonNumber}:episode:${episodeNumber}`,
        operationFor: (previous, next) => previous?.lifecycleStatus !== next.lifecycleStatus
          ? (next.lifecycleStatus === 'disabled' ? 'episode.disabled' : 'episode.restored')
          : 'episode.updated',
        fields: ['episodeNumber', 'title', 'description', 'releaseDate', 'lifecycleStatus', 'downloadLinks'],
      });
    },
    async setEpisodeLifecycleStatus(seriesId, seasonNumber, episodeNumber, lifecycleStatus, options) {
      if (!['active', 'disabled'].includes(lifecycleStatus)) throw new CatalogSeriesStructureInputError('INVALID_LIFECYCLE_STATUS');
      const current = await provider.getEpisodeWithVersion(seriesId, seasonNumber, episodeNumber);
      if (!current) throw new CatalogNotFoundError('EPISODE_NOT_FOUND');
      const { disabledAt, disabledBy, createdAt, updatedAt, ...editable } = current.value;
      return provider.updateEpisode(seriesId, seasonNumber, episodeNumber, {
        ...editable,
        lifecycleStatus,
      }, options);
    },
    async deleteEpisode(seriesId, seasonNumber, episodeNumber, options) {
      return deleteRecord({
        reference: episodeRef(seriesId, seasonNumber, episodeNumber),
        options,
        project: projectEpisode,
        entityType: 'episode',
        entityId: `${seriesId}:season:${seasonNumber}:episode:${episodeNumber}`,
      });
    },
    async listStructure(seriesId, { includeDisabled = false, parentLifecycleStatus = 'active' } = {}) {
      validateSeriesId(seriesId);
      if (!includeDisabled && parentLifecycleStatus !== 'active') return [];
      const seasons = await provider.listSeasons(seriesId, { includeDisabled });
      const result = [];
      for (const entry of seasons) {
        const episodes = await provider.listEpisodes(seriesId, entry.value.seasonNumber, { includeDisabled });
        result.push({
          ...entry,
          episodes: episodes.filter(({ value }) => (
            includeDisabled || (entry.value.lifecycleStatus === 'active' && value.lifecycleStatus === 'active')
          )),
        });
      }
      return result;
    },
    async deleteSeriesStructure(seriesId, options) {
      const writeOptions = validateExpectedVersion(options);
      if (!writeOptions.actorId) throw new CatalogSeriesStructureInputError('ACTOR_REQUIRED');
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(seasonsRef(seriesId));
        if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
        const seasonRecords = snapshot.docs.map((doc) => ({
          doc,
          stored: snapshotValue({ exists: true, data: doc.data }),
          value: projectSeason(doc.id, doc.data()),
        }));
        const episodeRecords = [];
        for (const season of seasonRecords) {
          const episodes = await transaction.get(episodesRef(seriesId, season.value.seasonNumber));
          if (!episodes || !Array.isArray(episodes.docs)) throw new TypeError();
          for (const episode of episodes.docs) {
            const stored = snapshotValue({ exists: true, data: episode.data });
            episodeRecords.push({
              seasonNumber: season.value.seasonNumber,
              episode,
              stored,
              value: projectEpisode(episode.id, stored.data),
            });
          }
        }
        const total = seasonRecords.length + episodeRecords.length;
        if (total > MAX_ATOMIC_CASCADE_ITEMS) throw new CatalogConflictError('CASCADE_LIMIT_EXCEEDED');
        for (const entry of episodeRecords) {
          transaction.delete(episodeRef(seriesId, entry.seasonNumber, entry.value.episodeNumber));
          await auditEventSink.appendInTransaction(transaction, eventFor({
            operation: 'episode.deleted', entityType: 'episode',
            entityId: `${seriesId}:season:${entry.seasonNumber}:episode:${entry.value.episodeNumber}`,
            options: writeOptions, previousVersion: entry.stored.version, version: entry.stored.version + 1,
            fields: ['deleted'], clock,
          }));
        }
        for (const entry of seasonRecords) {
          transaction.delete(seasonRef(seriesId, entry.value.seasonNumber));
          await auditEventSink.appendInTransaction(transaction, eventFor({
            operation: 'season.deleted', entityType: 'season',
            entityId: `${seriesId}:season:${entry.value.seasonNumber}`,
            options: writeOptions, previousVersion: entry.stored.version, version: entry.stored.version + 1,
            fields: ['deleted'], clock,
          }));
        }
        return { deletedSeasons: seasonRecords.length, deletedEpisodes: episodeRecords.length };
      });
    },
  };

  return Object.freeze(provider);
}

module.exports = { createFirestoreCatalogSeriesStructureProvider, MAX_ATOMIC_CASCADE_ITEMS };
