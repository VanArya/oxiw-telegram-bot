'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FirebaseAdminTargetResolutionError,
  createFirebaseAdminTargetResolver,
} = require('../src/firebase-admin-target-resolver');

test('resolves the target UID through Firebase Admin getUserByEmail', async () => {
  const calls = [];
  const resolver = createFirebaseAdminTargetResolver({
    auth: { async getUserByEmail(email) { calls.push(email); return { uid: 'target-firebase-uid' }; } },
  });
  assert.equal(await resolver('target@example.com'), 'target-firebase-uid');
  assert.deepEqual(calls, ['target@example.com']);
});

test('fails closed when the target account does not exist or lookup fails', async () => {
  for (const auth of [
    { async getUserByEmail() { throw new Error('not found'); } },
    { async getUserByEmail() { throw new Error('service unavailable'); } },
  ]) {
    const resolver = createFirebaseAdminTargetResolver({ auth });
    await assert.rejects(resolver('target@example.com'), (error) =>
      error instanceof FirebaseAdminTargetResolutionError && error.code === 'TARGET_LOOKUP_FAILED');
  }
});

test('rejects a missing or invalid Firebase UID without logging account data', async () => {
  for (const uid of [undefined, '', 'bad uid', 'x'.repeat(129)]) {
    const resolver = createFirebaseAdminTargetResolver({
      auth: { async getUserByEmail() { return { uid }; } },
    });
    await assert.rejects(resolver('target@example.com'), (error) =>
      error instanceof FirebaseAdminTargetResolutionError && error.code === 'TARGET_UID_INVALID');
  }
});

test('rejects missing or malformed email input before Firebase lookup', async () => {
  let calls = 0;
  const resolver = createFirebaseAdminTargetResolver({
    auth: { async getUserByEmail() { calls += 1; return { uid: 'target-uid' }; } },
  });
  for (const email of [undefined, '', ' bad@example.com', 'bad', 'x'.repeat(321)]) {
    await assert.rejects(resolver(email), (error) =>
      error instanceof FirebaseAdminTargetResolutionError && error.code === 'TARGET_EMAIL_INVALID');
  }
  assert.equal(calls, 0);
});
