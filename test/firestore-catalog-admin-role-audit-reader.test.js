'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFirestoreCatalogAdminRoleAuditReader } = require('../src/firestore-catalog-admin-role-audit-reader');

const event = Object.freeze({
  eventId: '12345678-1234-4234-8234-123456789012',
  operation: 'assignment.created',
  occurredAt: '2026-11-10T12:00:00.000Z',
  outcome: 'committed',
  actorId: 'owner-user',
  targetSubjectId: 'manager-user',
  rolesBefore: [],
  rolesAfter: ['editor'],
  activeBefore: false,
  activeAfter: true,
  previousVersion: 0,
  version: 1,
});

function makeFirestore(documents = [event]) {
  return {
    collection(name) {
      assert.equal(name, 'catalogAdminRoleAuditEvents');
      return {
        orderBy(field, direction) {
          assert.equal(field, 'occurredAt');
          assert.equal(direction, 'desc');
          return {
            offset(offset) {
              return {
                limit(limit) {
                  return {
                    async get() {
                      const sorted = [...documents].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
                      return { docs: sorted.slice(offset, offset + limit).map((value) => ({
                        id: value.eventId,
                        data: () => structuredClone(value),
                      })) };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

test('reads and validates role audit events with bounded pagination', async () => {
  const reader = createFirestoreCatalogAdminRoleAuditReader({ firestore: makeFirestore() });
  const result = await reader.list({ page: '1', pageSize: '20' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].operation, 'assignment.created');
  assert.equal(result.data[0].targetSubjectId, 'manager-user');
  assert.deepEqual(result.meta, { page: 1, pageSize: 20, hasMore: false });
});

test('rejects invalid role audit pagination and malformed event records', async () => {
  const reader = createFirestoreCatalogAdminRoleAuditReader({ firestore: makeFirestore() });
  await assert.rejects(reader.list({ page: '0' }), (error) => error.code === 'INVALID_PAGINATION');
  const malformed = createFirestoreCatalogAdminRoleAuditReader({
    firestore: makeFirestore([{ ...event, rolesAfter: ['unknown-role'] }]),
  });
  await assert.rejects(malformed.list(), (error) => error.code === 'ROLE_AUDIT_HISTORY_UNAVAILABLE');
});
