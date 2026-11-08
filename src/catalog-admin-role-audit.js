'use strict';

const { isKnownCatalogAdminRole } = require('./catalog-admin-authorization');

const ROLE_AUDIT_EVENT_V1_KEYS = new Set([
  'eventId', 'operation', 'occurredAt', 'outcome', 'actorId', 'targetSubjectId',
  'rolesBefore', 'rolesAfter', 'activeBefore', 'activeAfter', 'previousVersion', 'version',
]);
const ROLE_AUDIT_EVENT_V2_KEYS = new Set([
  ...ROLE_AUDIT_EVENT_V1_KEYS,
  'schemaVersion', 'actorType', 'identitySource', 'ownerId', 'approverId', 'approvalReference',
]);
const ROLE_AUDIT_EVENT_V3_KEYS = new Set([
  ...ROLE_AUDIT_EVENT_V1_KEYS,
  'schemaVersion', 'actorType', 'identitySource', 'ownerId',
]);
const ROLE_AUDIT_EVENT_V4_KEYS = new Set([
  ...ROLE_AUDIT_EVENT_V1_KEYS,
  'schemaVersion', 'actorType', 'identitySource', 'ownerId',
  'ownerIdentitySource', 'approvalReference',
]);
const ROLE_AUDIT_OPERATIONS = new Set([
  'assignment.created',
  'roles.changed',
  'role.revoked',
  'assignment.disabled',
  'assignment.reactivated',
  'bootstrap.completed',
]);

function isStableSubjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isServiceAccountPrincipal(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(value);
}

function hasValidIdentityAndApproval(event) {
  return event.schemaVersion === 2 && event.operation === 'bootstrap.completed' &&
    event.actorType === 'service_account' &&
    event.identitySource === 'google_cloud_adc_service_account_impersonation' &&
    isServiceAccountPrincipal(event.actorId) &&
    isStableSubjectId(event.ownerId) &&
    isStableSubjectId(event.approverId) &&
    event.ownerId !== event.approverId &&
    typeof event.approvalReference === 'string' &&
    event.approvalReference.trim() === event.approvalReference &&
    event.approvalReference.length > 0 && event.approvalReference.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(event.approvalReference);
}

function hasValidFirebaseOwnerIdentity(event) {
  return event.schemaVersion === 3 && event.operation === 'bootstrap.completed' &&
    event.actorType === 'firebase_user' &&
    event.identitySource === 'firebase_admin_id_token' &&
    isStableSubjectId(event.actorId) && isStableSubjectId(event.ownerId) &&
    event.actorId === event.ownerId;
}

function hasValidSingleOwnerIdentity(event) {
  return event.schemaVersion === 4 && event.operation === 'bootstrap.completed' &&
    event.actorType === 'service_account' &&
    event.identitySource === 'google_cloud_adc_service_account_impersonation' &&
    isServiceAccountPrincipal(event.actorId) &&
    isStableSubjectId(event.ownerId) &&
    event.ownerIdentitySource === 'firebase_admin_id_token' &&
    typeof event.approvalReference === 'string' &&
    event.approvalReference.trim() === event.approvalReference &&
    event.approvalReference.length > 0 && event.approvalReference.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(event.approvalReference);
}

function isRoleList(value) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  for (const role of value) {
    if (typeof role !== 'string' || !isKnownCatalogAdminRole(role) || seen.has(role)) return false;
    seen.add(role);
  }
  return true;
}

function sameRoles(left, right) {
  return left.length === right.length && left.every((role) => right.includes(role));
}

function isStrictSubset(subset, superset) {
  return subset.length < superset.length && subset.every((role) => superset.includes(role));
}

function matchesOperationTransition(event) {
  switch (event.operation) {
    case 'assignment.created':
      return event.previousVersion === 0 && event.version === 1 &&
        event.activeBefore === false && event.activeAfter === true &&
        event.rolesBefore.length === 0 && event.rolesAfter.length > 0;
    case 'roles.changed':
      return event.activeBefore === true && event.activeAfter === true &&
        event.rolesBefore.length > 0 && event.rolesAfter.length > 0 &&
        !sameRoles(event.rolesBefore, event.rolesAfter);
    case 'role.revoked':
      return event.activeBefore === true && event.activeAfter === true &&
        event.rolesBefore.length > 0 && isStrictSubset(event.rolesAfter, event.rolesBefore);
    case 'assignment.disabled':
      return event.activeBefore === true && event.activeAfter === false &&
        event.rolesBefore.length > 0 && sameRoles(event.rolesBefore, event.rolesAfter);
    case 'assignment.reactivated':
      return event.activeBefore === false && event.activeAfter === true &&
        event.rolesBefore.length > 0 && sameRoles(event.rolesBefore, event.rolesAfter);
    case 'bootstrap.completed':
      return event.previousVersion === 0 && event.version === 1 &&
        event.activeBefore === false && event.activeAfter === true &&
        event.rolesBefore.length === 0 && event.rolesAfter.length === 1 &&
        event.rolesAfter[0] === 'administrator';
    default:
      return false;
  }
}

function validateCatalogAdminRoleAuditEvent(event) {
  const schemaVersion = event && typeof event === 'object' && !Array.isArray(event)
    ? (event.schemaVersion === undefined ? 1 : event.schemaVersion)
    : undefined;
  const expectedKeys = schemaVersion === 1 ? ROLE_AUDIT_EVENT_V1_KEYS :
    schemaVersion === 2 ? ROLE_AUDIT_EVENT_V2_KEYS :
      schemaVersion === 3 ? ROLE_AUDIT_EVENT_V3_KEYS :
        schemaVersion === 4 ? ROLE_AUDIT_EVENT_V4_KEYS : new Set();
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      Object.keys(event).some((key) => !expectedKeys.has(key)) ||
      Object.keys(event).length !== expectedKeys.size ||
      typeof event.eventId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.eventId) ||
      !ROLE_AUDIT_OPERATIONS.has(event.operation) ||
      typeof event.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      new Date(event.occurredAt).toISOString() !== event.occurredAt ||
      event.outcome !== 'committed' ||
      !(schemaVersion === 1 ? isStableSubjectId(event.actorId) :
        schemaVersion === 2 ? hasValidIdentityAndApproval(event) :
          schemaVersion === 3 ? hasValidFirebaseOwnerIdentity(event) :
            hasValidSingleOwnerIdentity(event)) ||
      !isStableSubjectId(event.targetSubjectId) ||
      !isRoleList(event.rolesBefore) || !isRoleList(event.rolesAfter) ||
      typeof event.activeBefore !== 'boolean' || typeof event.activeAfter !== 'boolean' ||
      !Number.isSafeInteger(event.previousVersion) || event.previousVersion < 0 ||
      !Number.isSafeInteger(event.version) || event.version !== event.previousVersion + 1 ||
      !matchesOperationTransition(event)) {
    throw new TypeError('Invalid catalog administrator role audit event.');
  }

  return Object.freeze({
    ...event,
    rolesBefore: Object.freeze([...event.rolesBefore]),
    rolesAfter: Object.freeze([...event.rolesAfter]),
  });
}

function assertCatalogAdminRoleAuditSink(sink) {
  if (!sink || typeof sink.appendInTransaction !== 'function') {
    throw new TypeError('CatalogAdminRoleAuditSink must implement appendInTransaction().');
  }
  return sink;
}

module.exports = {
  ROLE_AUDIT_OPERATIONS,
  ROLE_AUDIT_EVENT_V1_KEYS,
  ROLE_AUDIT_EVENT_V2_KEYS,
  ROLE_AUDIT_EVENT_V3_KEYS,
  ROLE_AUDIT_EVENT_V4_KEYS,
  assertCatalogAdminRoleAuditSink,
  validateCatalogAdminRoleAuditEvent,
};
