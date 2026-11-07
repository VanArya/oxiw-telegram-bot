'use strict';

const { randomUUID } = require('node:crypto');

const OWNER_IDENTITY_SOURCE = 'firebase_admin_id_token';
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FirebaseOwnerApprovalError extends Error {
  constructor(code) {
    super('Firebase owner approval could not be verified.');
    this.name = 'FirebaseOwnerApprovalError';
    this.code = code;
  }
}

function isStableSubjectId(value) {
  return typeof value === 'string' && SUBJECT_ID_PATTERN.test(value);
}

function createFirebaseOwnerBootstrapApprovalProvider({
  auth,
  ownerUid,
  tokenProvider,
  resolveTargetSubjectId,
  targetEmail = 'neohrju2313@gmail.com',
  createApprovalReference = randomUUID,
} = {}) {
  if (!auth || typeof auth.verifyIdToken !== 'function' ||
      !isStableSubjectId(ownerUid) || typeof tokenProvider !== 'function' ||
      typeof resolveTargetSubjectId !== 'function' ||
      typeof targetEmail !== 'string' || targetEmail.trim() !== targetEmail ||
      targetEmail.length === 0 || targetEmail.length > 320 ||
      typeof createApprovalReference !== 'function') {
    throw new TypeError('Invalid Firebase owner bootstrap approval configuration.');
  }

  return Object.freeze(async function trustedApprovalProvider({ targetSubjectId } = {}) {
    if (!isStableSubjectId(targetSubjectId)) {
      throw new FirebaseOwnerApprovalError('TARGET_INVALID');
    }

    let token;
    try {
      token = await tokenProvider({ targetSubjectId });
      if (typeof token !== 'string' || token.length === 0) {
        throw new FirebaseOwnerApprovalError('OWNER_TOKEN_UNAVAILABLE');
      }
      const decoded = await auth.verifyIdToken(token, true);
      const verifiedOwnerUid = decoded && typeof decoded === 'object' ? decoded.uid : undefined;
      if (verifiedOwnerUid !== ownerUid) {
        throw new FirebaseOwnerApprovalError('OWNER_NOT_ALLOWED');
      }
    } catch (error) {
      if (error instanceof FirebaseOwnerApprovalError) throw error;
      throw new FirebaseOwnerApprovalError('OWNER_TOKEN_INVALID');
    } finally {
      // The provider never persists, logs, or returns the ephemeral token.
      token = undefined;
    }

    let resolvedTarget;
    try {
      resolvedTarget = await resolveTargetSubjectId(targetEmail);
    } catch {
      throw new FirebaseOwnerApprovalError('TARGET_LOOKUP_FAILED');
    }
    if (!isStableSubjectId(resolvedTarget) || resolvedTarget !== targetSubjectId) {
      throw new FirebaseOwnerApprovalError('TARGET_MISMATCH');
    }

    const approvalReference = createApprovalReference();
    if (typeof approvalReference !== 'string' || !UUID_PATTERN.test(approvalReference)) {
      throw new FirebaseOwnerApprovalError('APPROVAL_REFERENCE_INVALID');
    }
    return Object.freeze({
      ownerId: ownerUid,
      ownerIdentitySource: OWNER_IDENTITY_SOURCE,
      approvalReference,
    });
  });
}

module.exports = {
  FirebaseOwnerApprovalError,
  OWNER_IDENTITY_SOURCE,
  createFirebaseOwnerBootstrapApprovalProvider,
  isStableSubjectId,
};
