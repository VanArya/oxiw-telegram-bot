'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FirebaseAdminManagerEmailResolutionError,
  createFirebaseAdminManagerEmailResolver,
} = require('../src/firebase-admin-manager-email-resolver');

test('manager email resolver uses Firebase Admin getUser and returns only email', async () => {
  const calls = [];
  const resolver = createFirebaseAdminManagerEmailResolver({
    auth: { async getUser(uid) { calls.push(uid); return { uid, email: 'manager@example.com', displayName: 'private' }; } },
  });
  assert.equal(await resolver('manager-1'), 'manager@example.com');
  assert.deepEqual(calls, ['manager-1']);
});

test('manager email resolver fails closed for missing users, invalid subjects, or unusable email', async () => {
  const missing = createFirebaseAdminManagerEmailResolver({ auth: { async getUser() { throw new Error('hidden'); } } });
  await assert.rejects(missing('manager-1'), (error) =>
    error instanceof FirebaseAdminManagerEmailResolutionError && error.code === 'MANAGER_EMAIL_LOOKUP_FAILED');

  const invalidSubject = createFirebaseAdminManagerEmailResolver({ auth: { async getUser() { throw new Error(); } } });
  await assert.rejects(invalidSubject('bad subject'), (error) =>
    error instanceof FirebaseAdminManagerEmailResolutionError && error.code === 'MANAGER_SUBJECT_INVALID');

  const noEmail = createFirebaseAdminManagerEmailResolver({ auth: { async getUser() { return { uid: 'manager-1' }; } } });
  await assert.rejects(noEmail('manager-1'), (error) =>
    error instanceof FirebaseAdminManagerEmailResolutionError && error.code === 'MANAGER_EMAIL_UNAVAILABLE');
});
