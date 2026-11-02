'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertCatalogAdminRoleAuditSink,
  validateCatalogAdminRoleAuditEvent,
} = require('../src/catalog-admin-role-audit');

function validEvent(overrides = {}) {
  return {
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operation: 'roles.changed',
    occurredAt: '2026-10-26T12:00:00.000Z',
    outcome: 'committed',
    actorId: 'trusted-operator',
    targetSubjectId: 'target-admin',
    rolesBefore: ['observer'],
    rolesAfter: ['editor'],
    activeBefore: true,
    activeAfter: true,
    previousVersion: 1,
    version: 2,
    ...overrides,
  };
}

function createFakeTransactionStore({ failWrite = false, failAudit = false } = {}) {
  const assignments = new Map([['target-admin', {
    roles: ['observer'], active: true, version: 1,
  }]]);
  const events = new Map();
  let transactionContext;

  return {
    assignments,
    events,
    get transactionContext() { return transactionContext; },
    async runTransaction(work) {
      const pendingAssignments = new Map(assignments);
      const pendingEvents = new Map(events);
      const context = {
        setAssignment(subjectId, value) {
          if (failWrite) throw new Error('fake assignment write failed');
          pendingAssignments.set(subjectId, value);
        },
        appendAudit(event) {
          if (failAudit) throw new Error('fake audit append failed');
          pendingEvents.set(event.eventId, event);
        },
      };
      transactionContext = context;
      const result = await work(context);
      assignments.clear();
      for (const [key, value] of pendingAssignments) assignments.set(key, value);
      events.clear();
      for (const [key, value] of pendingEvents) events.set(key, value);
      return result;
    },
  };
}

async function fakeRoleMutation(store, auditSink, event) {
  const validated = validateCatalogAdminRoleAuditEvent(event);
  return store.runTransaction(async (transaction) => {
    transaction.setAssignment(event.targetSubjectId, {
      roles: [...validated.rolesAfter],
      active: validated.activeAfter,
      version: validated.version,
    });
    await auditSink.appendInTransaction(transaction, validated);
    return { committed: true, version: validated.version };
  });
}

test('accepts a valid role assignment lifecycle event with trusted actor and target IDs', () => {
  const event = validateCatalogAdminRoleAuditEvent(validEvent());
  assert.equal(event.operation, 'roles.changed');
  assert.equal(event.outcome, 'committed');
  assert.deepEqual(event.rolesBefore, ['observer']);
  assert.deepEqual(event.rolesAfter, ['editor']);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.rolesAfter), true);
});

test('accepts version 2 bootstrap audit with service-account identity and separate approvals', () => {
  const event = validateCatalogAdminRoleAuditEvent({
    ...validEvent({
      operation: 'bootstrap.completed',
      actorId: 'catalog-bootstrap@oxiw-provisioning.iam.gserviceaccount.com',
      targetSubjectId: 'first-admin',
      rolesBefore: [],
      rolesAfter: ['administrator'],
      activeBefore: false,
      activeAfter: true,
      previousVersion: 0,
      version: 1,
    }),
    schemaVersion: 2,
    actorType: 'service_account',
    identitySource: 'google_cloud_adc_service_account_impersonation',
    ownerId: 'catalog-owner',
    approverId: 'second-approver',
    approvalReference: 'CHG-2026-1042',
  });
  assert.equal(event.schemaVersion, 2);
  assert.equal(event.actorType, 'service_account');
  assert.equal(event.identitySource, 'google_cloud_adc_service_account_impersonation');
  assert.equal(event.ownerId, 'catalog-owner');
  assert.equal(event.approverId, 'second-approver');
  assert.equal(event.approvalReference, 'CHG-2026-1042');
});

test('accepts Firebase owner bootstrap schema v3 and rejects mismatched owner identity', () => {
  const event = validateCatalogAdminRoleAuditEvent({
    ...validEvent({
      operation: 'bootstrap.completed',
      actorId: 'firebase-owner',
      targetSubjectId: 'firebase-owner',
      rolesBefore: [], rolesAfter: ['administrator'],
      activeBefore: false, activeAfter: true,
      previousVersion: 0, version: 1,
    }),
    schemaVersion: 3,
    actorType: 'firebase_user',
    identitySource: 'firebase_admin_id_token',
    ownerId: 'firebase-owner',
  });
  assert.equal(event.schemaVersion, 3);
  assert.throws(() => validateCatalogAdminRoleAuditEvent({
    ...event, ownerId: 'different-owner',
  }), TypeError);
  assert.throws(() => validateCatalogAdminRoleAuditEvent({
    ...event, actorType: 'service_account',
  }), TypeError);
});

test('rejects untrusted or incomplete version 2 identity and approval fields', () => {
  const v2 = {
    ...validEvent({
      operation: 'bootstrap.completed',
      actorId: 'catalog-bootstrap@oxiw-provisioning.iam.gserviceaccount.com',
      targetSubjectId: 'first-admin',
      rolesBefore: [], rolesAfter: ['administrator'],
      activeBefore: false, activeAfter: true,
      previousVersion: 0, version: 1,
    }),
    schemaVersion: 2,
    actorType: 'service_account',
    identitySource: 'google_cloud_adc_service_account_impersonation',
    ownerId: 'catalog-owner',
    approverId: 'second-approver',
    approvalReference: 'CHG-2026-1042',
  };
  for (const invalid of [
    { ...v2, schemaVersion: 3 },
    { ...v2, operation: 'roles.changed' },
    { ...v2, actorType: 'human' },
    { ...v2, identitySource: 'environment' },
    { ...v2, actorId: 'claimed-actor' },
    { ...v2, approverId: 'catalog-owner' },
    { ...v2, approvalReference: '' },
    (() => { const { approvalReference, ...missing } = v2; return missing; })(),
  ]) {
    assert.throws(() => validateCatalogAdminRoleAuditEvent(invalid), TypeError);
  }
  // Schema v1 records remain accepted without new identity and approval fields.
  assert.equal(validateCatalogAdminRoleAuditEvent(validEvent()).actorId, 'trusted-operator');
});

test('accepts create, revoke, disable, and one-time administrator bootstrap transitions', () => {
  assert.equal(validateCatalogAdminRoleAuditEvent(validEvent({
    operation: 'assignment.created',
    rolesBefore: [], rolesAfter: ['observer'],
    activeBefore: false, activeAfter: true,
    previousVersion: 0, version: 1,
  })).operation, 'assignment.created');
  assert.equal(validateCatalogAdminRoleAuditEvent(validEvent({
    operation: 'role.revoked',
    rolesBefore: ['observer', 'editor'], rolesAfter: ['observer'],
  })).operation, 'role.revoked');
  assert.equal(validateCatalogAdminRoleAuditEvent(validEvent({
    operation: 'assignment.disabled',
    rolesBefore: ['observer'], rolesAfter: ['observer'],
    activeBefore: true, activeAfter: false,
  })).operation, 'assignment.disabled');
  assert.equal(validateCatalogAdminRoleAuditEvent(validEvent({
    operation: 'bootstrap.completed',
    rolesBefore: [], rolesAfter: ['administrator'],
    activeBefore: false, activeAfter: true,
    previousVersion: 0, version: 1,
  })).operation, 'bootstrap.completed');
});

test('rejects invalid actor or target identifiers, unknown roles, bad transitions, and incomplete events', () => {
  for (const event of [
    validEvent({ actorId: '' }),
    validEvent({ actorId: 'bad actor' }),
    validEvent({ targetSubjectId: '' }),
    validEvent({ rolesAfter: ['superuser'] }),
    validEvent({ rolesAfter: ['editor', 'editor'] }),
    validEvent({ outcome: 'failed' }),
    validEvent({ version: 3 }),
    validEvent({ operation: 'bootstrap.completed', rolesAfter: ['editor'] }),
    (() => { const { targetSubjectId, ...incomplete } = validEvent(); return incomplete; })(),
  ]) {
    assert.throws(() => validateCatalogAdminRoleAuditEvent(event), TypeError);
  }
});

test('rejects request-controlled identity, role, token, and secret fields', () => {
  for (const extra of [
    { principal: { subjectId: 'client-actor' } },
    { requestedBy: 'client-actor' },
    { requestedRoles: ['administrator'] },
    { token: 'synthetic-token' },
    { secret: 'synthetic-secret' },
    { request: { headers: { authorization: 'synthetic-token' } } },
  ]) {
    assert.throws(() => validateCatalogAdminRoleAuditEvent({ ...validEvent(), ...extra }), TypeError);
  }
});

test('role audit sink accepts only the append-in-transaction contract', () => {
  const sink = { async appendInTransaction() {} };
  assert.equal(assertCatalogAdminRoleAuditSink(sink), sink);
  for (const invalid of [undefined, {}, { append() {} }]) {
    assert.throws(() => assertCatalogAdminRoleAuditSink(invalid), TypeError);
  }
});

test('passes the exact assignment transaction context to the role audit sink', async () => {
  const store = createFakeTransactionStore();
  const received = [];
  const sink = {
    async appendInTransaction(transaction, event) {
      received.push(transaction);
      transaction.appendAudit(event);
    },
  };
  const result = await fakeRoleMutation(store, sink, validEvent());
  assert.equal(result.committed, true);
  assert.equal(received[0], store.transactionContext);
  assert.equal(store.assignments.get('target-admin').version, 2);
  assert.equal(store.events.size, 1);
});

test('fake transaction rolls back assignment and audit together if either write fails', async () => {
  for (const options of [{ failWrite: true }, { failAudit: true }]) {
    const store = createFakeTransactionStore(options);
    const sink = {
      async appendInTransaction(transaction, event) {
        transaction.appendAudit(event);
      },
    };
    await assert.rejects(fakeRoleMutation(store, sink, validEvent()));
    assert.deepEqual(store.assignments.get('target-admin'), {
      roles: ['observer'], active: true, version: 1,
    });
    assert.equal(store.events.size, 0);
  }
});

test('does not report audit success when assignment mutation fails', async () => {
  const store = createFakeTransactionStore({ failWrite: true });
  let auditCalls = 0;
  const sink = {
    async appendInTransaction(transaction, event) {
      auditCalls += 1;
      transaction.appendAudit(event);
    },
  };
  await assert.rejects(fakeRoleMutation(store, sink, validEvent()));
  assert.equal(auditCalls, 0);
  assert.equal(store.events.size, 0);
});

test('existing catalog audit event contract remains separate and unchanged', () => {
  const { validateCatalogAuditEvent } = require('../src/catalog-audit-event-sink');
  const catalogEvent = {
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operation: 'metadata.created',
    entityType: 'content',
    entityId: 'movie-YWJj',
    occurredAt: '2026-10-26T12:00:00.000Z',
    outcome: 'committed',
    previousVersion: 0,
    version: 1,
    changedFields: ['approvalStatus', 'publicationStatus'],
    actorId: 'trusted-operator',
  };
  assert.equal(validateCatalogAuditEvent(catalogEvent).operation, 'metadata.created');
  assert.throws(() => validateCatalogAuditEvent({
    ...catalogEvent, operation: 'roles.changed', entityType: 'admin_role_assignment',
  }), TypeError);
});
