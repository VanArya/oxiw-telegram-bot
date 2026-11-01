'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TIMEOUT_MS,
  probeFirestoreReadOnly,
} = require('../scripts/probe-firestore-readonly');

const TARGET = Object.freeze({
  CATALOG_GCP_PROJECT_ID: 'oxiw-catalog-test-123',
  CATALOG_FIRESTORE_DATABASE_ID: '(default)',
});

function fakeFirestoreClass({ collections = [], error, hang = false } = {}) {
  const state = { options: null, listCalls: 0, terminateCalls: 0, writeCalls: 0 };
  class FakeFirestore {
    constructor(options) {
      state.options = options;
    }

    async listCollections() {
      state.listCalls += 1;
      if (hang) return new Promise(() => {});
      if (error) throw error;
      return collections;
    }

    collection() { state.writeCalls += 1; throw new Error('unexpected operation'); }
    runTransaction() { state.writeCalls += 1; throw new Error('unexpected operation'); }

    async terminate() {
      state.terminateCalls += 1;
    }
  }
  return { FakeFirestore, state };
}

test('uses explicit project and database and performs only listCollections', async () => {
  const { FakeFirestore, state } = fakeFirestoreClass({ collections: [{ id: 'catalogCategories' }] });
  const result = await probeFirestoreReadOnly({ env: TARGET, FirestoreClass: FakeFirestore });
  assert.deepEqual(result, { category: 'SUCCESS', collectionCount: 1 });
  assert.deepEqual(state.options, {
    projectId: TARGET.CATALOG_GCP_PROJECT_ID,
    databaseId: TARGET.CATALOG_FIRESTORE_DATABASE_ID,
  });
  assert.equal(state.listCalls, 1);
  assert.equal(state.writeCalls, 0);
  assert.equal(state.terminateCalls, 1);
});

test('rejects missing or invalid target settings before constructing the SDK client', async () => {
  const { FakeFirestore, state } = fakeFirestoreClass();
  for (const env of [
    {},
    { ...TARGET, CATALOG_GCP_PROJECT_ID: '' },
    { ...TARGET, CATALOG_GCP_PROJECT_ID: 'Uppercase-Invalid' },
    { ...TARGET, CATALOG_FIRESTORE_DATABASE_ID: '' },
    { ...TARGET, CATALOG_FIRESTORE_DATABASE_ID: 'invalid database' },
  ]) {
    const result = await probeFirestoreReadOnly({ env, FirestoreClass: FakeFirestore });
    assert.deepEqual(result, { category: 'INCOMPLETE_CONFIGURATION' });
  }
  assert.equal(state.options, null);
  assert.equal(state.listCalls, 0);
});

test('classifies authentication, permission, network, and unknown errors without exposing raw details', async () => {
  const cases = [
    [{ code: 16, message: 'private credential detail' }, 'AUTHENTICATION_FAILED'],
    [{ code: 7, message: 'private document detail' }, 'PERMISSION_DENIED'],
    [{ code: 14, message: 'private endpoint detail' }, 'NETWORK_OR_TIMEOUT'],
    [{ code: 'ETIMEDOUT', message: 'private host detail' }, 'NETWORK_OR_TIMEOUT'],
    [{ message: 'private unknown detail' }, 'UNKNOWN_ERROR'],
  ];
  for (const [error, category] of cases) {
    const { FakeFirestore, state } = fakeFirestoreClass({ error });
    const result = await probeFirestoreReadOnly({ env: TARGET, FirestoreClass: FakeFirestore });
    assert.deepEqual(result, { category });
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(state.terminateCalls, 1);
  }
});

test('enforces the read timeout and terminates the client', async () => {
  const { FakeFirestore, state } = fakeFirestoreClass({ hang: true });
  const result = await probeFirestoreReadOnly({
    env: TARGET,
    FirestoreClass: FakeFirestore,
    timeoutMs: 5,
  });
  assert.deepEqual(result, { category: 'NETWORK_OR_TIMEOUT' });
  assert.equal(state.listCalls, 1);
  assert.equal(state.writeCalls, 0);
  assert.equal(state.terminateCalls, 1);
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);
});

test('terminates the client after an invalid SDK shape without leaking details', async () => {
  const state = { terminateCalls: 0 };
  class InvalidFirestore {
    constructor() {}
    async terminate() { state.terminateCalls += 1; }
  }
  const result = await probeFirestoreReadOnly({ env: TARGET, FirestoreClass: InvalidFirestore });
  assert.deepEqual(result, { category: 'UNKNOWN_ERROR' });
  assert.equal(state.terminateCalls, 1);
});
