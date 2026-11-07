'use strict';

const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class FirebaseAdminTargetResolutionError extends Error {
  constructor(code) {
    super('Firebase administrator target could not be resolved.');
    this.name = 'FirebaseAdminTargetResolutionError';
    this.code = code;
  }
}

function isStableSubjectId(value) {
  return typeof value === 'string' && SUBJECT_ID_PATTERN.test(value);
}

function createFirebaseAdminTargetResolver({ auth } = {}) {
  if (!auth || typeof auth.getUserByEmail !== 'function') {
    throw new TypeError('Invalid Firebase Admin target resolver configuration.');
  }

  return Object.freeze(async function resolveTargetSubjectId(email) {
    if (typeof email !== 'string' || email.trim() !== email ||
        email.length === 0 || email.length > 320 || !EMAIL_PATTERN.test(email)) {
      throw new FirebaseAdminTargetResolutionError('TARGET_EMAIL_INVALID');
    }
    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      throw new FirebaseAdminTargetResolutionError('TARGET_LOOKUP_FAILED');
    }
    const uid = user && typeof user === 'object' ? user.uid : undefined;
    if (!isStableSubjectId(uid)) {
      throw new FirebaseAdminTargetResolutionError('TARGET_UID_INVALID');
    }
    return uid;
  });
}

module.exports = {
  FirebaseAdminTargetResolutionError,
  createFirebaseAdminTargetResolver,
  isStableSubjectId,
};
