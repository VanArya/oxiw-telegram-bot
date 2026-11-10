'use strict';

const EVENT_KEYS = new Set([
  'eventId', 'operation', 'entityType', 'entityId', 'occurredAt', 'outcome',
  'previousVersion', 'version', 'changedFields', 'actorId',
]);
const OPERATIONS = new Set([
  'metadata.created', 'metadata.updated',
  'approval.pending', 'approval.approved', 'approval.rejected', 'approval.unknown',
  'content.disabled', 'content.restored', 'content.deleted',
  'publication.draft', 'publication.published', 'publication.archived', 'publication.unknown',
  'category.created', 'category.updated', 'category.deleted',
  'taxonomy.created', 'taxonomy.updated', 'taxonomy.deleted',
]);
const ENTITY_TYPES = new Set(['content', 'category', 'taxonomy']);
const CHANGED_FIELDS = new Set([
  'contentId', 'approvalStatus', 'publicationStatus', 'countryIds', 'genreIds', 'categoryIds',
  'lifecycleStatus', 'disabledAt', 'disabledBy',
  'slug', 'localizedTitle', 'filters', 'enabled', 'sortOrder', 'mode', 'labelFa', 'deleted',
]);

function assertCatalogAuditEventSink(sink) {
  if (!sink || typeof sink.appendInTransaction !== 'function') {
    throw new TypeError('CatalogAuditEventSink must implement appendInTransaction().');
  }
  return sink;
}

function validateCatalogAuditEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      Object.keys(event).some((key) => !EVENT_KEYS.has(key)) ||
      typeof event.eventId !== 'string' || !/^[0-9a-f-]{36}$/.test(event.eventId) ||
      !OPERATIONS.has(event.operation) || !ENTITY_TYPES.has(event.entityType) ||
      typeof event.entityId !== 'string' || event.entityId.length === 0 ||
      typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt)) ||
      event.outcome !== 'committed' || !Number.isSafeInteger(event.previousVersion) ||
      event.previousVersion < 0 || !Number.isSafeInteger(event.version) ||
      event.version !== event.previousVersion + 1 || !Array.isArray(event.changedFields) ||
      event.changedFields.some((field) => !CHANGED_FIELDS.has(field)) ||
      (event.actorId !== undefined &&
        (typeof event.actorId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.actorId)))) {
    throw new TypeError('Invalid catalog audit event.');
  }
  return Object.freeze({
    ...event,
    changedFields: Object.freeze([...new Set(event.changedFields)]),
  });
}

module.exports = { assertCatalogAuditEventSink, validateCatalogAuditEvent };
