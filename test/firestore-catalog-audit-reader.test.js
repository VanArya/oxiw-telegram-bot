'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFirestoreCatalogAuditReader } = require('../src/firestore-catalog-audit-reader');

function event(eventId, occurredAt, extra = {}) {
  return {
    eventId,
    operation: 'metadata.updated',
    entityType: 'content',
    entityId: 'movie:101',
    occurredAt,
    outcome: 'committed',
    previousVersion: 1,
    version: 2,
    changedFields: ['approvalStatus'],
    actorId: 'verified-admin',
    rawPayload: 'must-not-be-projected',
    ...extra,
  };
}

class FakeQuery {
  constructor(documents) { this.documents = documents; this.skip = 0; this.take = Infinity; this.orderings = []; }
  orderBy(field, direction) { this.orderings.push([field, direction]); return this; }
  offset(value) { this.skip = value; return this; }
  limit(value) { this.take = value; return this; }
  async get() {
    return { docs: [...this.documents]
      .sort((left, right) => right.data().occurredAt.localeCompare(left.data().occurredAt) || right.id.localeCompare(left.id))
      .slice(this.skip, this.skip + this.take) };
  }
}

function createFirestore(documents) {
  const queries = [];
  return {
    queries,
    collection: () => {
      const query = new FakeQuery(documents);
      queries.push(query);
      return query;
    },
  };
}

test('lists paginated catalog audit events with an explicit safe projection', async () => {
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ];
  const docs = [
    { id: ids[0], data: () => event(ids[0], '2026-10-01T00:00:00.000Z') },
    { id: ids[1], data: () => event(ids[1], '2026-10-02T00:00:00.000Z') },
    { id: ids[2], data: () => event(ids[2], '2026-10-03T00:00:00.000Z') },
  ];
  const firestore = createFirestore(docs);
  const reader = createFirestoreCatalogAuditReader({ firestore });
  const first = await reader.list({ page: '1', pageSize: '2' });
  assert.deepEqual(firestore.queries[0].orderings, [['occurredAt', 'desc']]);
  assert.deepEqual(first.data.map(({ eventId }) => eventId), [ids[2], ids[1]]);
  assert.equal(first.meta.hasMore, true);
  assert.equal(Object.hasOwn(first.data[0], 'rawPayload'), false);
  const second = await reader.list({ page: '2', pageSize: '2' });
  assert.deepEqual(second.data.map(({ eventId }) => eventId), [ids[0]]);
  assert.equal(second.meta.hasMore, false);
});

test('rejects invalid pagination and malformed stored audit events', async () => {
  const reader = createFirestoreCatalogAuditReader({
    firestore: createFirestore([{ id: 'bad', data: () => event('other-id', 'bad-date') }]),
  });
  await assert.rejects(reader.list({ page: '0' }), { code: 'INVALID_PAGINATION' });
  await assert.rejects(reader.list(), /history is unavailable/);
});


test('preserves the Firestore failure as an internal cause without exposing its message', async () => {
  const firestoreFailure = Object.assign(new Error('private Firestore details'), {
    code: 9,
    status: 400,
  });
  const firestore = {
    collection() {
      return {
        orderBy() { return this; },
        offset() { return this; },
        limit() { return this; },
        async get() { throw firestoreFailure; },
      };
    },
  };
  const reader = createFirestoreCatalogAuditReader({ firestore });
  await assert.rejects(reader.list(), (error) => {
    assert.equal(error.code, 'AUDIT_HISTORY_UNAVAILABLE');
    assert.equal(error.cause, firestoreFailure);
    assert.doesNotMatch(error.message, /private Firestore details/);
    return true;
  });
});
