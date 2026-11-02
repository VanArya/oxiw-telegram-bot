'use strict';

const crypto = require('node:crypto');
const { validateCatalogAuditEvent } = require('./catalog-audit-event-sink');
const { validateCatalogContentMetadata } = require('./catalog-metadata-validation');

const DEFAULT_CONTENT_COLLECTION = 'catalogContentMetadata';
const INTERNAL_VERSION = '_version';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function classifyDocument(document, data) {
  if (!document || typeof document.id !== 'string' || !isRecord(data)) return 'document_invalid';
  if (validVersion(data[INTERNAL_VERSION])) return null;
  try {
    validateCatalogContentMetadata(document.id, {
      contentId: data.contentId,
      approvalStatus: data.approvalStatus,
      publicationStatus: data.publicationStatus,
      ...(data.countryIds === undefined ? {} : { countryIds: data.countryIds }),
      ...(data.genreIds === undefined ? {} : { genreIds: data.genreIds }),
    });
  } catch {
    return 'business_data_invalid';
  }
  return 'version_invalid';
}

function assertDependencies({ firestore, auditEventSink, collection }) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof firestore.runTransaction !== 'function' ||
      !auditEventSink || typeof auditEventSink.appendInTransaction !== 'function' ||
      typeof collection !== 'string' || collection.trim() === '') {
    throw new TypeError('Invalid metadata version migration dependencies.');
  }
}

function summaryFor(documents) {
  const summary = { total: documents.length, invalid: 0, versionInvalid: 0, businessDataInvalid: 0, documentInvalid: 0 };
  for (const item of documents) {
    if (!item.issue) continue;
    summary.invalid += 1;
    if (item.issue === 'version_invalid') summary.versionInvalid += 1;
    else if (item.issue === 'business_data_invalid') summary.businessDataInvalid += 1;
    else summary.documentInvalid += 1;
  }
  return Object.freeze(summary);
}

async function scanInvalidMetadataVersions({ firestore, collection = DEFAULT_CONTENT_COLLECTION } = {}) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof collection !== 'string' || collection.trim() === '') {
    throw new TypeError('Invalid metadata version scan configuration.');
  }
  const snapshot = await firestore.collection(collection).get();
  if (!snapshot || !Array.isArray(snapshot.docs)) throw new TypeError('Invalid metadata collection response.');
  const documents = snapshot.docs.map((document) => {
    let data;
    try { data = document.data(); } catch { data = null; }
    return Object.freeze({
      id: typeof document?.id === 'string' ? document.id : null,
      issue: classifyDocument(document, data),
      currentVersion: validVersion(data?.[INTERNAL_VERSION]) ? data[INTERNAL_VERSION] : null,
    });
  });
  return Object.freeze({ summary: summaryFor(documents), documents: Object.freeze(documents) });
}

async function repairInvalidMetadataVersions({
  firestore,
  auditEventSink,
  collection = DEFAULT_CONTENT_COLLECTION,
  actorId,
  dryRun = true,
  createEventId = crypto.randomUUID,
  clock = () => new Date(),
} = {}) {
  assertDependencies({ firestore, auditEventSink, collection });
  if (typeof dryRun !== 'boolean' || typeof createEventId !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Invalid metadata version migration options.');
  }
  const scan = await scanInvalidMetadataVersions({ firestore, collection });
  if (dryRun) return Object.freeze({ dryRun: true, summary: scan.summary, repaired: 0, skipped: scan.summary.businessDataInvalid + scan.summary.documentInvalid });
  if (typeof actorId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actorId)) {
    throw new TypeError('A trusted migration actorId is required for writes.');
  }
  let repaired = 0;
  let skipped = 0;
  for (const candidate of scan.documents.filter((item) => item.issue === 'version_invalid')) {
    const reference = firestore.collection(collection).doc(candidate.id);
    const result = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const data = snapshot?.exists === true && typeof snapshot.data === 'function' ? snapshot.data() : null;
      const issue = classifyDocument({ id: candidate.id }, data);
      if (issue !== 'version_invalid') return false;
      const occurredAt = clock();
      if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) throw new TypeError('Invalid migration clock.');
      const event = validateCatalogAuditEvent({
        eventId: createEventId(), operation: 'metadata.updated', entityType: 'content', entityId: candidate.id,
        occurredAt: occurredAt.toISOString(), outcome: 'committed', previousVersion: 0, version: 1,
        changedFields: [], actorId,
      });
      transaction.set(reference, { ...data, [INTERNAL_VERSION]: 1 });
      await auditEventSink.appendInTransaction(transaction, event);
      return true;
    });
    if (result) repaired += 1;
    else skipped += 1;
  }
  return Object.freeze({ dryRun: false, summary: scan.summary, repaired, skipped });
}

module.exports = {
  DEFAULT_CONTENT_COLLECTION,
  INTERNAL_VERSION,
  scanInvalidMetadataVersions,
  repairInvalidMetadataVersions,
};
