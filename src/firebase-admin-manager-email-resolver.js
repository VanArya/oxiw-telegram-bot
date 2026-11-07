'use strict';

const { isStableSubjectId } = require('./firebase-admin-target-resolver');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class FirebaseAdminManagerEmailResolutionError extends Error {
  constructor(code = 'MANAGER_EMAIL_LOOKUP_FAILED') {
    super('Firebase administrator email could not be resolved.');
    this.name = 'FirebaseAdminManagerEmailResolutionError';
    this.code = code;
  }
}

function createFirebaseAdminManagerEmailResolver({ auth } = {}) {
  if (!auth || typeof auth.getUser !== 'function') {
    throw new TypeError('Invalid Firebase Admin manager email resolver configuration.');
  }

  return Object.freeze(async function resolveManagerEmail(subjectId) {
    if (!isStableSubjectId(subjectId)) {
      throw new FirebaseAdminManagerEmailResolutionError('MANAGER_SUBJECT_INVALID');
    }
    let user;
    try {
      user = await auth.getUser(subjectId);
    } catch {
      throw new FirebaseAdminManagerEmailResolutionError();
    }
    const email = user && typeof user === 'object' ? user.email : undefined;
    if (typeof email !== 'string' || email.length === 0 || email.length > 320 ||
        !EMAIL_PATTERN.test(email)) {
      throw new FirebaseAdminManagerEmailResolutionError('MANAGER_EMAIL_UNAVAILABLE');
    }
    return email;
  });
}

module.exports = {
  FirebaseAdminManagerEmailResolutionError,
  createFirebaseAdminManagerEmailResolver,
};
