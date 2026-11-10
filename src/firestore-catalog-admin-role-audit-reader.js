'use strict';

const { validateCatalogAdminRoleAuditEvent } = require('./catalog-admin-role-audit');

const DEFAULT_COLLECTION = 'catalogAdminRoleAuditEvents';
const MAX_PAGE_SIZE = 100;

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new TypeError();
  return parsed;
}

function projectEvent(document) {
  if (!document || typeof document.id !== 'string' || typeof document.data !== 'function') throw new TypeError();
  const event = validateCatalogAdminRoleAuditEvent(document.data());
  if (event.eventId !== document.id) throw new TypeError();
  return event;
}

function createFirestoreCatalogAdminRoleAuditReader({ firestore, collection = DEFAULT_COLLECTION } = {}) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof collection !== 'string' || collection.trim() === '') {
    throw new TypeError('Invalid Firestore role audit reader configuration.');
  }

  return Object.freeze({
    async list({ page: pageValue, pageSize: pageSizeValue } = {}) {
      let page;
      let pageSize;
      try {
        page = positiveInteger(pageValue, 1, 10000);
        pageSize = positiveInteger(pageSizeValue, 20, MAX_PAGE_SIZE);
      } catch {
        const error = new TypeError('Invalid role audit pagination.');
        error.code = 'INVALID_PAGINATION';
        throw error;
      }
      const offset = (page - 1) * pageSize;
      if (!Number.isSafeInteger(offset)) {
        const error = new TypeError('Invalid role audit pagination.');
        error.code = 'INVALID_PAGINATION';
        throw error;
      }
      try {
        const snapshot = await firestore.collection(collection)
          .orderBy('occurredAt', 'desc')
          .offset(offset)
          .limit(pageSize + 1)
          .get();
        if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError();
        const events = snapshot.docs.map(projectEvent);
        return Object.freeze({
          data: Object.freeze(events.slice(0, pageSize)),
          meta: Object.freeze({ page, pageSize, hasMore: events.length > pageSize }),
        });
      } catch (error) {
        if (error?.code === 'INVALID_PAGINATION') throw error;
        const unavailable = new Error('Administrator role audit history is unavailable.', { cause: error });
        unavailable.code = 'ROLE_AUDIT_HISTORY_UNAVAILABLE';
        throw unavailable;
      }
    },
  });
}

module.exports = { createFirestoreCatalogAdminRoleAuditReader };
