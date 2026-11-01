'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FirebaseAdminTokenVerificationError,
  createFirebaseAdminIdTokenVerifier,
  extractBearerToken,
} = require('../src/firebase-admin-id-token-verifier');

function makeRequest(authorization, extra = {}) {
  return {
    headers: { ...(authorization === undefined ? {} : { authorization }), ...extra },
  };
}

test('extracts only a bearer token from the authorization header', () => {
  assert.equal(extractBearerToken(makeRequest('Bearer synthetic-token')), 'synthetic-token');
  assert.equal(extractBearerToken(makeRequest('bearer\tsynthetic-token')), 'synthetic-token');
  for (const authorization of [
    undefined,
    '',
    'Basic synthetic-token',
    'Bearer',
    'Bearer token with spaces',
    'Bearer token\nforged-header',
  ]) {
    assert.equal(extractBearerToken(makeRequest(authorization)), null);
  }
});

test('verifies the Firebase token and returns only the trusted UID as subjectId', async () => {
  const calls = [];
  const verifier = createFirebaseAdminIdTokenVerifier({
    auth: {
      async verifyIdToken(token, checkRevoked) {
        calls.push({ token, checkRevoked });
        return { uid: 'firebase-user-123', email: 'ignored@example.invalid', role: 'ignored' };
      },
    },
  });
  const result = await verifier(makeRequest('Bearer signed-token', { subjectId: 'request-user' }));
  assert.deepEqual(result, { authenticated: true, subjectId: 'firebase-user-123' });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(calls, [{ token: 'signed-token', checkRevoked: true }]);
});

test('rejects missing or malformed authorization and never accepts request-controlled identity', async () => {
  let calls = 0;
  const verifier = createFirebaseAdminIdTokenVerifier({
    auth: { async verifyIdToken() { calls += 1; return { uid: 'trusted-user' }; } },
  });
  for (const request of [
    makeRequest(undefined, { subjectId: 'client-user', actorId: 'client-actor' }),
    makeRequest('Basic client-user', { subjectId: 'trusted-user' }),
    { body: { subjectId: 'trusted-user' }, query: { actorId: 'trusted-user' } },
  ]) {
    await assert.rejects(verifier(request), (error) => (
      error instanceof FirebaseAdminTokenVerificationError && error.code === 'MISSING_TOKEN'
    ));
  }
  assert.equal(calls, 0);
});

test('fails closed for invalid, expired, revoked, and verifier-error tokens without leaking details', async () => {
  for (const failure of [
    new Error('expired token private detail'),
    Object.assign(new Error('revoked token private detail'), { code: 'auth/id-token-revoked' }),
    new Error('invalid signature private detail'),
  ]) {
    const verifier = createFirebaseAdminIdTokenVerifier({
      auth: { async verifyIdToken() { throw failure; } },
    });
    await assert.rejects(verifier(makeRequest('Bearer token')), (error) => (
      error instanceof FirebaseAdminTokenVerificationError &&
      error.code === 'INVALID_TOKEN' &&
      !error.message.includes('private detail')
    ));
  }
});

test('rejects incomplete or incompatible decoded Firebase identities', async () => {
  for (const decodedToken of [
    undefined,
    {},
    { sub: 'only-sub-no-uid' },
    { uid: '' },
    { uid: 'firebase/user' },
    { uid: 'firebase.user' },
    { uid: 'x'.repeat(129) },
  ]) {
    const verifier = createFirebaseAdminIdTokenVerifier({
      auth: { async verifyIdToken() { return decodedToken; } },
    });
    await assert.rejects(verifier(makeRequest('Bearer signed-token')), (error) => (
      error instanceof FirebaseAdminTokenVerificationError && error.code === 'INVALID_TOKEN'
    ));
  }
});

test('invalid verifier configuration fails before request processing', () => {
  assert.throws(() => createFirebaseAdminIdTokenVerifier(), /verifyIdToken/);
});
