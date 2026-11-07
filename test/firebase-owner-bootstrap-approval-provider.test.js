'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FirebaseOwnerApprovalError,
  createFirebaseOwnerBootstrapApprovalProvider,
} = require('../src/firebase-owner-bootstrap-approval-provider');

const OWNER_UID = 'owner-firebase-uid';
const TARGET_UID = 'target-firebase-uid';

function makeProvider(overrides = {}) {
  return createFirebaseOwnerBootstrapApprovalProvider({
    auth: { verifyIdToken: async () => ({ uid: OWNER_UID }) },
    ownerUid: OWNER_UID,
    tokenProvider: async () => 'ephemeral-token',
    resolveTargetSubjectId: async (email) => {
      assert.equal(email, 'neohrju2313@gmail.com');
      return TARGET_UID;
    },
    createApprovalReference: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ...overrides,
  });
}

test('verifies the owner token with revoked-token checking and binds approval to target', async () => {
  const calls = [];
  const provider = makeProvider({
    auth: { verifyIdToken: async (...args) => { calls.push(args); return { uid: OWNER_UID }; } },
  });
  assert.deepEqual(await provider({ targetSubjectId: TARGET_UID }), {
    ownerId: OWNER_UID,
    ownerIdentitySource: 'firebase_admin_id_token',
    approvalReference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.deepEqual(calls, [['ephemeral-token', true]]);
});

test('rejects invalid, revoked, or non-owner tokens without exposing them', async () => {
  for (const auth of [
    { verifyIdToken: async () => { throw new Error('invalid'); } },
    { verifyIdToken: async () => ({ uid: 'another-owner' }) },
  ]) {
    const provider = makeProvider({ auth });
    await assert.rejects(provider({ targetSubjectId: TARGET_UID }), FirebaseOwnerApprovalError);
  }
});

test('rejects a target that does not resolve to the approved account', async () => {
  const provider = makeProvider({ resolveTargetSubjectId: async () => 'different-target' });
  await assert.rejects(provider({ targetSubjectId: TARGET_UID }), (error) =>
    error instanceof FirebaseOwnerApprovalError && error.code === 'TARGET_MISMATCH');
});

test('rejects missing or malformed approval references and never accepts a second approver', async () => {
  const provider = makeProvider({ createApprovalReference: () => 'not-a-uuid' });
  await assert.rejects(provider({ targetSubjectId: TARGET_UID }), (error) =>
    error instanceof FirebaseOwnerApprovalError && error.code === 'APPROVAL_REFERENCE_INVALID');
  const approval = await makeProvider()({ targetSubjectId: TARGET_UID });
  assert.equal(Object.hasOwn(approval, 'approverId'), false);
});
