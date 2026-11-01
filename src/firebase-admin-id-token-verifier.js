'use strict';

const { getAuth } = require('firebase-admin/auth');

const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

class FirebaseAdminTokenVerificationError extends Error {
  constructor(code = 'INVALID_TOKEN') {
    super('Firebase ID token could not be verified.');
    this.name = 'FirebaseAdminTokenVerificationError';
    this.code = code;
  }
}

function extractBearerToken(request) {
  if (!request || typeof request !== 'object') return null;
  let authorization;
  try {
    authorization = typeof request.get === 'function'
      ? request.get('authorization')
      : request.headers?.authorization;
  } catch {
    return null;
  }
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

function assertAuthClient(auth) {
  if (!auth || typeof auth.verifyIdToken !== 'function') {
    throw new TypeError('Firebase Admin Auth client must implement verifyIdToken().');
  }
  return auth;
}

function createFirebaseAdminIdTokenVerifier({ auth } = {}) {
  assertAuthClient(auth);

  return Object.freeze(async function verifyAdminPrincipal(request) {
    const token = extractBearerToken(request);
    if (!token) throw new FirebaseAdminTokenVerificationError('MISSING_TOKEN');

    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(token, true);
    } catch {
      throw new FirebaseAdminTokenVerificationError('INVALID_TOKEN');
    }

    const subjectId = decodedToken && typeof decodedToken === 'object'
      ? decodedToken.uid
      : undefined;
    if (typeof subjectId !== 'string' || !SUBJECT_ID_PATTERN.test(subjectId)) {
      throw new FirebaseAdminTokenVerificationError('INVALID_TOKEN');
    }

    return Object.freeze({ authenticated: true, subjectId });
  });
}

// The caller remains responsible for Firebase Admin app initialization and credentials.
// This helper only obtains the Auth service from the supplied app and never initializes one.
function createFirebaseAdminIdTokenVerifierFromApp({ app } = {}) {
  if (!app || typeof app !== 'object') {
    throw new TypeError('A Firebase Admin app is required.');
  }
  return createFirebaseAdminIdTokenVerifier({
    auth: getAuth(app),
  });
}

module.exports = {
  FirebaseAdminTokenVerificationError,
  SUBJECT_ID_PATTERN,
  createFirebaseAdminIdTokenVerifier,
  createFirebaseAdminIdTokenVerifierFromApp,
  extractBearerToken,
};
