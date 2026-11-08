'use strict';

const { validateCatalogAuditEvent } = require('./catalog-audit-event-sink');

const DEFAULT_COLLECTION = 'catalogAuditEvents';
const MAX_PAGE_SIZE = 100;

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new TypeError();
  return parsed;
}

function projectEvent(document) {
  if (!document || typeof document.id !== 'string' || typeof document.data !== 'function') {
    throw new TypeError();
  }
  const stored = document.data();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new TypeError();
  const event = validateCatalogAuditEvent({
    eventId: stored.eventId,
    operation: stored.operation,
    entityType: stored.entityType,
    entityId: stored.entityId,
    occurredAt: stored.occurredAt,
    outcome: stored.outcome,
    previousVersion: stored.previousVersion,
    version: stored.version,
    changedFields: stored.changedFields,
    ...(stored.actorId === undefined ? {} : { actorId: stored.actorId }),
  });
  if (event.eventId !== document.id) throw new TypeError();
  return Object.freeze({
    eventId: event.eventId,
    operation: event.operation,
    entityType: event.entityType,
    entityId: event.entityId,
    occurredAt: event.occurredAt,
    outcome: event.outcome,
    previousVersion: event.previousVersion,
    version: event.version,
    changedFields: Object.freeze([...event.changedFields]),
    ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
  });
}

function createFirestoreCatalogAuditReader({ firestore, collection = DEFAULT_COLLECTION } = {}) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof collection !== 'string' || collection.trim() === '') {
    throw new TypeError('Invalid Firestore audit reader configuration.');
  }

  return Object.freeze({
    async list({ page: pageValue, pageSize: pageSizeValue } = {}) {
      let page;
      let pageSize;
      try {
        page = positiveInteger(pageValue, 1);
        pageSize = positiveInteger(pageSizeValue, 20, MAX_PAGE_SIZE);
      } catch {
        const error = new TypeError('Invalid audit pagination.');
        error.code = 'INVALID_PAGINATION';
        throw error;
      }
      const offset = (page - 1) * pageSize;
      if (!Number.isSafeInteger(offset)) {
        const error = new TypeError('Invalid audit pagination.');
        error.code = 'INVALID_PAGINATION';
        throw error;
      }
      try {
        // eventId is the Firestore document ID (the sink writes doc(eventId)).
        // Firestore's implicit __name__ tie-breaker therefore provides the same
        // deterministic secondary order without requiring a composite index.
        const query = firestore.collection(collection)
          .orderBy('occurredAt', 'desc')
          .offset(offset)
          .limit(pageSize + 1);
        const snapshot = await query.get();
        if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
        const projected = snapshot.docs.map(projectEvent);
        const hasMore = projected.length > pageSize;
        return Object.freeze({
          data: Object.freeze(projected.slice(0, pageSize)),
          meta: Object.freeze({ page, pageSize, hasMore }),
        });
      } catch (error) {
        if (error?.code === 'INVALID_PAGINATION') throw error;
        const unavailable = new Error('Catalog audit history is unavailable.', { cause: error });
        unavailable.code = 'AUDIT_HISTORY_UNAVAILABLE';
        throw unavailable;
      }
    },
  });
}

module.exports = { createFirestoreCatalogAuditReader };
