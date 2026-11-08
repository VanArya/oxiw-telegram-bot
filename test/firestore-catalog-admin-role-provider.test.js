'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CatalogAdminRoleResolutionError,
} = require('../src/catalog-admin-role-provider');
const {
  createFirestoreCatalogAdminRoleAuditSink,
  createFirestoreCatalogAdminRoleProvider,
} = require('../src/firestore-catalog-admin-role-provider');

const BOOTSTRAP_ACTOR = Object.freeze({
  actorId: 'catalog-bootstrap@oxiw-provisioning.iam.gserviceaccount.com',
  actorType: 'service_account',
  identitySource: 'google_cloud_adc_service_account_impersonation',
});
const BOOTSTRAP_APPROVAL = Object.freeze({
  ownerId: 'catalog-owner', ownerIdentitySource: 'firebase_admin_id_token',
  approvalReference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
});

function bootstrapRequest(targetSubjectId) {
  return { actor: BOOTSTRAP_ACTOR, approval: BOOTSTRAP_APPROVAL, targetSubjectId };
}

function copy(value) {
  return structuredClone(value);
}

function seedControl(firestore, {
  count = 1,
  version = 1,
  state = 'completed',
} = {}) {
  firestore.documents.set('catalogAdminControl/bootstrap', {
    bootstrapState: state,
    version,
    activeAdministratorCount: count,
    completedAt: '2026-10-27T12:00:00.000Z',
    completedBy: 'trusted-operator',
    updatedAt: '2026-10-27T12:00:00.000Z',
    updatedBy: 'trusted-operator',
  });
}

class FakeFirestore {
  constructor() {
    this.documents = new Map();
    this.failReads = false;
    this.readError = new Error('synthetic read failure');
    this.failWrites = false;
    this.transactionCalls = 0;
    this.transactionQueue = Promise.resolve();
  }

  collection(name) {
    return {
      path: name,
      __collection: true,
      doc: (id) => {
      const path = `${name}/${id}`;
      return { path, id, get: async () => this.snapshot(path) };
      },
    };
  }

  snapshot(path) {
    if (this.failReads) throw this.readError;
    const value = this.documents.get(path);
    return { exists: value !== undefined, data: () => copy(value) };
  }

  snapshotCollection(path) {
    if (this.failReads) throw this.readError;
    const prefix = `${path}/`;
    const docs = [...this.documents.entries()]
      .filter(([documentPath]) => documentPath.startsWith(prefix) && !documentPath.slice(prefix.length).includes('/'))
      .map(([documentPath, value]) => ({
        id: documentPath.slice(prefix.length),
        data: () => copy(value),
      }));
    return { docs };
  }

  async runTransaction(callback) {
    const previous = this.transactionQueue;
    let release;
    this.transactionQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    this.transactionCalls += 1;
    const pending = [];
    const transaction = {
      get: async (reference) => reference.__collection
        ? this.snapshotCollection(reference.path)
        : this.snapshot(reference.path),
      create: (reference, value) => {
        if (this.failWrites) throw new Error('synthetic write failure');
        pending.push({ create: true, path: reference.path, value: copy(value) });
      },
      set: (reference, value) => {
        if (this.failWrites) throw new Error('synthetic write failure');
        pending.push({ create: false, path: reference.path, value: copy(value) });
      },
    };
    try {
      const result = await callback(transaction);
      if (pending.some((write) => write.create && this.documents.has(write.path))) {
        throw new Error('synthetic create conflict');
      }
      for (const write of pending) this.documents.set(write.path, write.value);
      return result;
    } finally {
      release();
    }
  }
}

function setup({ auditSink, firestore = new FakeFirestore() } = {}) {
  let eventSequence = 0;
  const sink = auditSink || createFirestoreCatalogAdminRoleAuditSink({
    firestore,
    collection: 'catalogAdminRoleAuditEvents',
  });
  const eventIds = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ];
  const provider = createFirestoreCatalogAdminRoleProvider({
    firestore,
    auditSink: sink,
    assignmentsCollection: 'catalogAdminRoleAssignments',
    clock: () => new Date('2026-10-27T12:00:00.000Z'),
    createEventId: () => eventIds[eventSequence++] || 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  });
  return { firestore, provider };
}

test('Firestore resolver returns only allowlisted roles for active assignments', async () => {
  const { firestore, provider } = setup();
  firestore.documents.set('catalogAdminRoleAssignments/active-user', {
    subjectId: 'active-user', roles: ['observer', 'editor'], active: true, version: 1,
  });
  firestore.documents.set('catalogAdminRoleAssignments/disabled-user', {
    subjectId: 'disabled-user', roles: ['administrator'], active: false, version: 2,
  });
  firestore.documents.set('catalogAdminRoleAssignments/administrator-user', {
    subjectId: 'administrator-user', roles: ['administrator'], active: true, version: 1,
  });
  seedControl(firestore, { count: 1 });
  assert.deepEqual(await provider.resolveRoles('active-user'), ['observer', 'editor']);
  assert.deepEqual(await provider.resolveRoles('disabled-user'), []);
  assert.deepEqual(await provider.resolveRoles('missing-user'), []);
});

test('Firestore role provider lists and reads safe manager assignments', async () => {
  const { firestore, provider } = setup();
  seedControl(firestore, { count: 1 });
  firestore.documents.set('catalogAdminRoleAssignments/active-admin', {
    subjectId: 'active-admin', roles: ['administrator'], active: true, version: 2,
    createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z',
  });
  firestore.documents.set('catalogAdminRoleAssignments/disabled-admin', {
    subjectId: 'disabled-admin', roles: ['administrator'], active: false, version: 2,
  });
  assert.deepEqual(await provider.getAssignment('active-admin'), {
    subjectId: 'active-admin', roles: ['administrator'], active: true, version: 2,
    createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z',
  });
  assert.deepEqual(await provider.listAssignments({ activeOnly: true }), [{
    subjectId: 'active-admin', roles: ['administrator'], active: true, version: 2,
    createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z',
  }]);
});

test('Firestore resolver fails closed on invalid subjects, malformed assignments, and read errors', async () => {
  const { firestore, provider } = setup();
  await assert.rejects(provider.resolveRoles('bad subject'), (error) => (
    error instanceof CatalogAdminRoleResolutionError && error.code === 'INVALID_SUBJECT'
  ));
  for (const [subjectId, assignment] of [
    ['unknown-role', { subjectId: 'unknown-role', roles: ['root'], active: true, version: 1 }],
    ['duplicate-role', { subjectId: 'duplicate-role', roles: ['editor', 'editor'], active: true, version: 1 }],
    ['empty-active', { subjectId: 'empty-active', roles: [], active: true, version: 1 }],
    ['bad-version', { subjectId: 'bad-version', roles: ['observer'], active: true, version: 0 }],
    ['wrong-subject', { subjectId: 'another-user', roles: ['observer'], active: true, version: 1 }],
  ]) {
    firestore.documents.set(`catalogAdminRoleAssignments/${subjectId}`, assignment);
    await assert.rejects(provider.resolveRoles(subjectId), (error) => (
      error instanceof CatalogAdminRoleResolutionError && error.code === 'INVALID_ASSIGNMENT'
    ));
  }
  firestore.failReads = true;
  await assert.rejects(provider.resolveRoles('valid-user'), (error) => (
    error instanceof CatalogAdminRoleResolutionError && error.code === 'ROLE_SOURCE_UNAVAILABLE'
  ));
  firestore.readError = Object.assign(new Error('synthetic permission denial'), { code: 7 });
  await assert.rejects(provider.resolveRoles('valid-user'), (error) => (
    error instanceof CatalogAdminRoleResolutionError && error.code === 'ROLE_SOURCE_UNAVAILABLE'
  ));
});

test('Firebase owner bootstrap is atomic, one-time, and writes schema v3 audit', async () => {
  const { firestore, provider } = setup();
  const result = await provider.bootstrapFirstAdministrator({ subjectId: 'KJN9jIBKCEUqzfRN3lTktcv3Z9b2' });
  assert.equal(result.version, 1);
  assert.deepEqual(await provider.resolveRoles('KJN9jIBKCEUqzfRN3lTktcv3Z9b2'), ['administrator']);
  const event = firestore.documents.get(`catalogAdminRoleAuditEvents/${result.eventId}`);
  assert.equal(event.schemaVersion, 3);
  assert.equal(event.actorType, 'firebase_user');
  assert.equal(event.identitySource, 'firebase_admin_id_token');
  assert.equal(event.actorId, 'KJN9jIBKCEUqzfRN3lTktcv3Z9b2');
  assert.equal(event.ownerId, event.actorId);
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
  await assert.rejects(
    provider.bootstrapFirstAdministrator({ subjectId: 'another-user' }),
    { code: 'BOOTSTRAP_ALREADY_COMPLETED' },
  );
  assert.equal(firestore.documents.has('catalogAdminRoleAssignments/another-user'), false);
  const invalid = setup();
  await assert.rejects(invalid.provider.bootstrapFirstAdministrator({ subjectId: 'bad subject' }), TypeError);
  assert.equal(invalid.firestore.transactionCalls, 0);
});

test('role assignment creation and changes write assignment plus role audit in one transaction', async () => {
  const { firestore, provider } = setup();
  const bootstrap = await provider.bootstrapAdministrator(bootstrapRequest('bootstrap-admin'));
  assert.equal(bootstrap.version, 1);
  const created = await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'managed-user', roles: ['observer'], expectedVersion: 0,
  });
  assert.equal(created.version, 1);
  assert.deepEqual(firestore.documents.get('catalogAdminRoleAssignments/managed-user'), {
    subjectId: 'managed-user', roles: ['observer'], active: true, version: 1,
    createdAt: '2026-10-27T12:00:00.000Z', createdBy: 'trusted-operator',
    updatedAt: '2026-10-27T12:00:00.000Z', updatedBy: 'trusted-operator',
  });
  assert.equal(firestore.documents.get(`catalogAdminRoleAuditEvents/${created.eventId}`).operation,
    'assignment.created');

  const changed = await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'managed-user', roles: ['editor'], expectedVersion: 1,
  });
  assert.equal(changed.version, 2);
  assert.deepEqual(await provider.resolveRoles('managed-user'), ['editor']);
  const audit = firestore.documents.get(`catalogAdminRoleAuditEvents/${changed.eventId}`);
  assert.equal(audit.operation, 'roles.changed');
  assert.deepEqual(audit.rolesBefore, ['observer']);
  assert.deepEqual(audit.rolesAfter, ['editor']);
  assert.equal(firestore.transactionCalls, 4);
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
});

test('stale versions, invalid actor/roles, and disabled assignment creation are rejected', async () => {
  const { firestore, provider } = setup();
  await provider.bootstrapAdministrator(bootstrapRequest('bootstrap-admin'));
  firestore.documents.set('catalogAdminRoleAssignments/managed-user', {
    subjectId: 'managed-user', roles: ['observer'], active: true, version: 2,
  });
  await assert.rejects(provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'managed-user', roles: ['editor'], expectedVersion: 1,
  }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(provider.changeAssignment({
    actorId: 'bad actor', targetSubjectId: 'managed-user', roles: ['editor'], expectedVersion: 2,
  }), TypeError);
  await assert.rejects(provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'managed-user', roles: ['unknown'], expectedVersion: 2,
  }), CatalogAdminRoleResolutionError);
  await assert.rejects(provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'new-user', roles: ['observer'], active: false, expectedVersion: 0,
  }), TypeError);
  assert.deepEqual(firestore.documents.get('catalogAdminRoleAssignments/managed-user'), {
    subjectId: 'managed-user', roles: ['observer'], active: true, version: 2,
  });
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
});

test('revocation and soft disable are audited and resolve to no access', async () => {
  const { firestore, provider } = setup();
  await provider.bootstrapAdministrator(bootstrapRequest('bootstrap-admin'));
  firestore.documents.set('catalogAdminRoleAssignments/managed-user', {
    subjectId: 'managed-user', roles: ['administrator', 'observer'], active: true, version: 1,
  });
  seedControl(firestore, { count: 2, version: 1 });
  const revoked = await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'managed-user', roles: ['observer'], expectedVersion: 1,
  });
  assert.equal(firestore.documents.get(`catalogAdminRoleAuditEvents/${revoked.eventId}`).operation,
    'role.revoked');
  const disabled = await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'managed-user', roles: ['observer'], active: false,
    expectedVersion: 2,
  });
  assert.equal(firestore.documents.get(`catalogAdminRoleAuditEvents/${disabled.eventId}`).operation,
    'assignment.disabled');
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
  assert.deepEqual(await provider.resolveRoles('managed-user'), []);
  const reactivated = await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'managed-user', roles: ['observer'], active: true,
    expectedVersion: 3,
  });
  assert.equal(reactivated.version, 4);
  assert.equal(firestore.documents.get(`catalogAdminRoleAuditEvents/${reactivated.eventId}`).operation,
    'assignment.reactivated');
  assert.equal(firestore.documents.get('catalogAdminRoleAssignments/managed-user').active, true);
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
  assert.deepEqual(await provider.resolveRoles('managed-user'), ['observer']);
});

test('assignment write or audit failure rolls back both writes', async () => {
  const { firestore, provider } = setup({
    auditSink: {
      async appendInTransaction(transaction) {
        transaction.create({ path: 'catalogAdminRoleAuditEvents/fake' }, { eventId: 'fake' });
        throw new Error('synthetic audit failure');
      },
    },
  });
  await assert.rejects(provider.bootstrapAdministrator(bootstrapRequest('managed-user')), CatalogAdminRoleResolutionError);
  assert.equal(firestore.documents.size, 0);

  const writeFailure = setup();
  writeFailure.firestore.failWrites = true;
  await assert.rejects(writeFailure.provider.bootstrapAdministrator(bootstrapRequest('managed-user')), CatalogAdminRoleResolutionError);
  assert.equal(writeFailure.firestore.documents.size, 0);
});

test('bootstrap is one-time, creates marker/count/assignment/audit atomically, and rejects invalid control state', async () => {
  const { firestore, provider } = setup();
  const first = await provider.bootstrapAdministrator(bootstrapRequest('first-admin'));
  const bootstrapAudit = firestore.documents.get(`catalogAdminRoleAuditEvents/${first.eventId}`);
  assert.equal(bootstrapAudit.operation, 'bootstrap.completed');
  assert.equal(bootstrapAudit.schemaVersion, 4);
  assert.equal(bootstrapAudit.actorId, BOOTSTRAP_ACTOR.actorId);
  assert.equal(bootstrapAudit.actorType, 'service_account');
  assert.equal(bootstrapAudit.identitySource, BOOTSTRAP_ACTOR.identitySource);
  assert.equal(bootstrapAudit.ownerId, BOOTSTRAP_APPROVAL.ownerId);
  assert.equal(bootstrapAudit.ownerIdentitySource, BOOTSTRAP_APPROVAL.ownerIdentitySource);
  assert.equal(bootstrapAudit.approvalReference, BOOTSTRAP_APPROVAL.approvalReference);
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
  await assert.rejects(provider.bootstrapAdministrator(bootstrapRequest('second-admin')), { code: 'BOOTSTRAP_ALREADY_COMPLETED' });
  assert.equal(firestore.documents.has('catalogAdminRoleAssignments/second-admin'), false);

  const invalidApproval = setup();
  await assert.rejects(invalidApproval.provider.bootstrapAdministrator({
    ...bootstrapRequest('first-admin'),
    approval: { ...BOOTSTRAP_APPROVAL, ownerIdentitySource: 'environment' },
  }), TypeError);
  assert.equal(invalidApproval.firestore.transactionCalls, 0);
  assert.equal(invalidApproval.firestore.documents.size, 0);

  const invalid = setup();
  seedControl(invalid.firestore, { count: 0 });
  await assert.rejects(invalid.provider.bootstrapAdministrator(bootstrapRequest('first-admin')), { code: 'ROLE_CONTROL_INVALID' });

  const legacy = setup();
  legacy.firestore.documents.set('catalogAdminRoleAssignments/legacy-admin', {
    subjectId: 'legacy-admin', roles: ['administrator'], active: true, version: 1,
  });
  await assert.rejects(legacy.provider.bootstrapAdministrator(bootstrapRequest('first-admin')), { code: 'ROLE_CONTROL_MISSING' });
  await assert.rejects(legacy.provider.resolveRoles('legacy-admin'), { code: 'ROLE_CONTROL_MISSING' });

  const inconsistent = setup();
  inconsistent.firestore.documents.set('catalogAdminRoleAssignments/legacy-admin', {
    subjectId: 'legacy-admin', roles: ['administrator'], active: true, version: 1,
  });
  seedControl(inconsistent.firestore, { count: 2 });
  await assert.rejects(inconsistent.provider.resolveRoles('legacy-admin'), { code: 'ROLE_CONTROL_INCONSISTENT' });
  await assert.rejects(inconsistent.provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'new-user', roles: ['observer'], expectedVersion: 0,
  }), { code: 'ROLE_CONTROL_INCONSISTENT' });
});

test('last active administrator cannot be removed, while a second administrator can be removed', async () => {
  const { firestore, provider } = setup();
  await provider.bootstrapAdministrator(bootstrapRequest('first-admin'));
  const second = await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'second-admin', roles: ['administrator'], expectedVersion: 0,
  });
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 2);
  await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'second-admin', roles: ['administrator'], active: false,
    expectedVersion: second.version,
  });
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
  await assert.rejects(provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'first-admin', roles: ['administrator'], active: false,
    expectedVersion: 1,
  }), { code: 'LAST_ADMINISTRATOR' });
  assert.equal(firestore.documents.get('catalogAdminRoleAssignments/first-admin').active, true);
});

test('serialized concurrent last-administrator removals allow neither operation to remove the last one', async () => {
  const { firestore, provider } = setup();
  await provider.bootstrapAdministrator(bootstrapRequest('first-admin'));
  const second = await provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'second-admin', roles: ['administrator'], expectedVersion: 0,
  });
  const attempts = await Promise.allSettled([
    provider.changeAssignment({
      actorId: 'trusted-operator', targetSubjectId: 'first-admin', roles: ['administrator'], active: false,
      expectedVersion: 1,
    }),
    provider.changeAssignment({
      actorId: 'trusted-operator', targetSubjectId: 'second-admin', roles: ['administrator'], active: false,
      expectedVersion: second.version,
    }),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
});

test('audit failure during an existing assignment change rolls back assignment and administrator count', async () => {
  const auditSink = {
    async appendInTransaction() {
      throw new Error('synthetic audit failure');
    },
  };
  const { firestore, provider } = setup({ auditSink });
  firestore.documents.set('catalogAdminRoleAssignments/first-admin', {
    subjectId: 'first-admin', roles: ['administrator'], active: true, version: 1,
  });
  seedControl(firestore, { count: 1 });
  await assert.rejects(provider.changeAssignment({
    actorId: 'trusted-operator', targetSubjectId: 'new-user', roles: ['observer'], expectedVersion: 0,
  }), CatalogAdminRoleResolutionError);
  assert.equal(firestore.documents.has('catalogAdminRoleAssignments/new-user'), false);
  assert.equal(firestore.documents.get('catalogAdminControl/bootstrap').activeAdministratorCount, 1);
});
