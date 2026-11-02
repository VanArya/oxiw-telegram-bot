'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const { createFirestoreCatalogAuditEventSink } = require('../src/firestore-catalog-audit-event-sink');
const { scanInvalidMetadataVersions, repairInvalidMetadataVersions } = require('../src/firestore-metadata-version-migration');

class FakeFirestore {
  constructor() { this.documents = new Map(); }
  collection(name) { return new FakeCollection(this, name); }
  snapshot(path) { const value = this.documents.get(path); return { exists: value !== undefined, data: () => structuredClone(value) }; }
  async runTransaction(callback) {
    const staged = [];
    const tx = { get: async (ref) => this.snapshot(ref.path), set: (ref, value) => staged.push([ref.path, structuredClone(value)]), create: (ref, value) => staged.push([ref.path, structuredClone(value)]) };
    const result = await callback(tx);
    for (const [path, value] of staged) this.documents.set(path, value);
    return result;
  }
}
class FakeCollection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return { path: `${this.path}/${id}`, id }; }
  async get() {
    const prefix = `${this.path}/`;
    return { docs: [...this.db.documents.entries()].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(([path]) => ({ id: path.slice(prefix.length), data: () => structuredClone(this.db.documents.get(path)) })) };
  }
}

const contentId = createCatalogContentId('movie', 'migration-fixture');
const validData = { contentId, approvalStatus: 'approved', publicationStatus: 'draft', countryIds: ['IR'], genreIds: ['drama'] };

test('dry-run reports invalid versions without exposing document data or changing storage', async () => {
  const firestore = new FakeFirestore();
  firestore.documents.set(`catalogContentMetadata/${contentId}`, { ...validData, _version: 'legacy-one' });
  firestore.documents.set('catalogContentMetadata/movie:healthy', { ...validData, contentId: 'movie:healthy', _version: 3 });
  const result = await repairInvalidMetadataVersions({ firestore, auditEventSink: createFirestoreCatalogAuditEventSink({ firestore }), dryRun: true });
  assert.deepEqual(result.summary, { total: 2, invalid: 1, versionInvalid: 1, businessDataInvalid: 0, documentInvalid: 0 });
  assert.equal(result.repaired, 0);
  assert.equal(firestore.documents.get(`catalogContentMetadata/${contentId}`)._version, 'legacy-one');
  assert.equal(JSON.stringify(result).includes('approved'), false);
});

test('repair is idempotent, preserves business fields, and audits atomically', async () => {
  const firestore = new FakeFirestore();
  firestore.documents.set(`catalogContentMetadata/${contentId}`, { ...validData, _version: null, customLegacyField: 'preserve' });
  const sink = createFirestoreCatalogAuditEventSink({ firestore });
  const options = { firestore, auditEventSink: sink, actorId: 'migration-operator', dryRun: false, createEventId: () => '11111111-1111-4111-8111-111111111111', clock: () => new Date('2026-11-02T00:00:00.000Z') };
  const first = await repairInvalidMetadataVersions(options);
  assert.equal(first.repaired, 1);
  assert.equal(firestore.documents.get(`catalogContentMetadata/${contentId}`)._version, 1);
  assert.equal(firestore.documents.get(`catalogContentMetadata/${contentId}`).customLegacyField, 'preserve');
  assert.equal(firestore.documents.has('catalogAuditEvents/11111111-1111-4111-8111-111111111111'), true);
  const second = await repairInvalidMetadataVersions(options);
  assert.equal(second.repaired, 0);
  assert.equal([...firestore.documents.keys()].filter((key) => key.startsWith('catalogAuditEvents/')).length, 1);
});

test('business-invalid documents are reported and never repaired', async () => {
  const firestore = new FakeFirestore();
  firestore.documents.set(`catalogContentMetadata/${contentId}`, { ...validData, approvalStatus: 'not-a-status', _version: 0 });
  const result = await repairInvalidMetadataVersions({ firestore, auditEventSink: createFirestoreCatalogAuditEventSink({ firestore }), dryRun: false, actorId: 'migration-operator' });
  assert.equal(result.summary.businessDataInvalid, 1);
  assert.equal(result.repaired, 0);
  assert.equal(firestore.documents.get(`catalogContentMetadata/${contentId}`)._version, 0);
});

test('audit failure rolls back the version repair', async () => {
  const firestore = new FakeFirestore();
  firestore.documents.set(`catalogContentMetadata/${contentId}`, { ...validData, _version: 'broken' });
  await assert.rejects(
    repairInvalidMetadataVersions({
      firestore,
      auditEventSink: { appendInTransaction() { throw new Error('synthetic audit failure'); } },
      actorId: 'migration-operator',
      dryRun: false,
    }),
  );
  assert.equal(firestore.documents.get(`catalogContentMetadata/${contentId}`)._version, 'broken');
});
