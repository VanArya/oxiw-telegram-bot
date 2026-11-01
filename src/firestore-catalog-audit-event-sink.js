'use strict';

const { validateCatalogAuditEvent } = require('./catalog-audit-event-sink');

const DEFAULT_COLLECTION = 'catalogAuditEvents';

function createFirestoreCatalogAuditEventSink({ firestore, collection = DEFAULT_COLLECTION } = {}) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof collection !== 'string' || collection.trim() === '') {
    throw new TypeError('Invalid Firestore audit sink configuration.');
  }

  return Object.freeze({
    async appendInTransaction(transaction, event) {
      if (!transaction || typeof transaction.create !== 'function') {
        throw new TypeError('Invalid Firestore transaction.');
      }
      const safeEvent = validateCatalogAuditEvent(event);
      const reference = firestore.collection(collection).doc(safeEvent.eventId);
      transaction.create(reference, safeEvent);
    },
  });
}

module.exports = { createFirestoreCatalogAuditEventSink };
