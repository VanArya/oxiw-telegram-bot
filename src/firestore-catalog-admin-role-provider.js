'use strict';

const { randomUUID } = require('node:crypto');
const {
  CatalogAdminRoleResolutionError,
  normalizeCatalogAdminRoles,
} = require('./catalog-admin-role-provider');
const {
  validateCatalogAdminRoleAuditEvent,
} = require('./catalog-admin-role-audit');
const {
  IDENTITY_SOURCE,
  isServiceAccountPrincipal,
} = require('./google-cloud-adc-trusted-actor-provider');
const { OWNER_IDENTITY_SOURCE } = require('./firebase-owner-bootstrap-approval-provider');

const DEFAULT_ASSIGNMENTS_COLLECTION = 'catalogAdminRoleAssignments';
const DEFAULT_AUDIT_COLLECTION = 'catalogAdminRoleAuditEvents';
const DEFAULT_CONTROL_COLLECTION = 'catalogAdminControl';
const DEFAULT_CONTROL_DOCUMENT = 'bootstrap';

function isStableSubjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validateBootstrapIdentity(actor, approval) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) ||
      Object.keys(actor).length !== 3 ||
      Object.keys(actor).some((key) => !['actorId', 'actorType', 'identitySource'].includes(key)) ||
      !isServiceAccountPrincipal(actor.actorId) ||
      actor.actorType !== 'service_account' || actor.identitySource !== IDENTITY_SOURCE ||
      !approval || typeof approval !== 'object' || Array.isArray(approval) ||
      Object.keys(approval).length !== 3 ||
      Object.keys(approval).some((key) => !['ownerId', 'ownerIdentitySource', 'approvalReference'].includes(key)) ||
      !isStableSubjectId(approval.ownerId) ||
      approval.ownerIdentitySource !== OWNER_IDENTITY_SOURCE ||
      typeof approval.approvalReference !== 'string' ||
      approval.approvalReference.trim() !== approval.approvalReference ||
      approval.approvalReference.length === 0 || approval.approvalReference.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(approval.approvalReference)) {
    throw new TypeError('Invalid trusted bootstrap identity or approval context.');
  }
}

function createFirestoreCatalogAdminRoleAuditSink({
  firestore,
  collection = DEFAULT_AUDIT_COLLECTION,
} = {}) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof collection !== 'string' || collection.trim() === '') {
    throw new TypeError('Invalid Firestore role audit sink configuration.');
  }

  return Object.freeze({
    async appendInTransaction(transaction, event) {
      if (!transaction || typeof transaction.create !== 'function') {
        throw new TypeError('Invalid Firestore transaction.');
      }
      const safeEvent = validateCatalogAdminRoleAuditEvent(event);
      transaction.create(firestore.collection(collection).doc(safeEvent.eventId), safeEvent);
    },
  });
}

function makeResolutionError(code) {
  return new CatalogAdminRoleResolutionError(code);
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validateAssignmentSnapshot(subjectId, snapshot) {
  if (!snapshot || snapshot.exists !== true) return null;
  const data = snapshot.data();
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.subjectId !== subjectId || typeof data.active !== 'boolean' ||
      !Number.isSafeInteger(data.version) || data.version < 1) {
    throw makeResolutionError('INVALID_ASSIGNMENT');
  }
  const roles = normalizeCatalogAdminRoles(data.roles);
  if (data.active && roles.length === 0) throw makeResolutionError('INVALID_ASSIGNMENT');
  return { data, roles: [...roles] };
}

function chooseOperation(before, afterRoles, afterActive) {
  if (!before) return 'assignment.created';
  if (!before.data.active && afterActive) return 'assignment.reactivated';
  if (before.data.active && !afterActive) return 'assignment.disabled';
  const isSubset = afterRoles.length < before.roles.length &&
    afterRoles.every((role) => before.roles.includes(role));
  return isSubset ? 'role.revoked' : 'roles.changed';
}

function validateControlSnapshot(snapshot) {
  if (!snapshot || snapshot.exists !== true) return null;
  const data = snapshot.data();
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.bootstrapState !== 'completed' ||
      !Number.isSafeInteger(data.version) || data.version < 1 ||
      !Number.isSafeInteger(data.activeAdministratorCount) || data.activeAdministratorCount < 1 ||
      !isIsoTimestamp(data.completedAt) ||
      !(isStableSubjectId(data.completedBy) || isServiceAccountPrincipal(data.completedBy)) ||
      !isIsoTimestamp(data.updatedAt) ||
      !(isStableSubjectId(data.updatedBy) || isServiceAccountPrincipal(data.updatedBy))) {
    throw makeResolutionError('ROLE_CONTROL_INVALID');
  }
  return { data };
}

function isActiveAdministrator(assignment) {
  return assignment.data.active && assignment.roles.includes('administrator');
}

function countActiveAdministrators(assignments) {
  return assignments.reduce((count, assignment) => count + (isActiveAdministrator(assignment) ? 1 : 0), 0);
}

function assignmentSnapshotFromQueryDocument(document) {
  if (!document || typeof document.id !== 'string' || typeof document.data !== 'function') {
    throw makeResolutionError('INVALID_ASSIGNMENT');
  }
  return validateAssignmentSnapshot(document.id, { exists: true, data: () => document.data() });
}

function publicAssignment(assignment) {
  return Object.freeze({
    subjectId: assignment.data.subjectId,
    roles: Object.freeze([...assignment.roles]),
    active: assignment.data.active,
    version: assignment.data.version,
    ...(assignment.data.createdAt === undefined ? {} : { createdAt: assignment.data.createdAt }),
    ...(assignment.data.updatedAt === undefined ? {} : { updatedAt: assignment.data.updatedAt }),
  });
}

async function readRoleState(transaction, firestore, assignmentsCollection, controlReference, targetReference) {
  const controlSnapshot = await transaction.get(controlReference);
  const targetSnapshot = await transaction.get(targetReference);
  const collectionSnapshot = await transaction.get(firestore.collection(assignmentsCollection));
  if (!collectionSnapshot || !Array.isArray(collectionSnapshot.docs)) {
    throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
  }
  const assignments = collectionSnapshot.docs.map(assignmentSnapshotFromQueryDocument);
  const control = validateControlSnapshot(controlSnapshot);
  if (!control) {
    if (assignments.length > 0) throw makeResolutionError('ROLE_CONTROL_MISSING');
    return { control: null, assignments, target: null };
  }
  const actualCount = countActiveAdministrators(assignments);
  if (actualCount !== control.data.activeAdministratorCount) {
    throw makeResolutionError('ROLE_CONTROL_INCONSISTENT');
  }
  const target = validateAssignmentSnapshot(
    targetReference.id,
    targetSnapshot,
  );
  return { control, assignments, target, actualCount };
}

function createFirestoreCatalogAdminRoleProvider({
  firestore,
  auditSink,
  assignmentsCollection = DEFAULT_ASSIGNMENTS_COLLECTION,
  controlCollection = DEFAULT_CONTROL_COLLECTION,
  controlDocument = DEFAULT_CONTROL_DOCUMENT,
  clock = () => new Date(),
  createEventId = randomUUID,
} = {}) {
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof firestore.runTransaction !== 'function' ||
      typeof assignmentsCollection !== 'string' || assignmentsCollection.trim() === '' ||
      typeof controlCollection !== 'string' || controlCollection.trim() === '' ||
      typeof controlDocument !== 'string' || controlDocument.trim() === '' ||
      !auditSink || typeof auditSink.appendInTransaction !== 'function' ||
      typeof clock !== 'function' || typeof createEventId !== 'function') {
    throw new TypeError('Invalid Firestore catalog administrator role provider configuration.');
  }

  const assignmentReference = (subjectId) => firestore.collection(assignmentsCollection).doc(subjectId);
  const controlReference = () => firestore.collection(controlCollection).doc(controlDocument);

  async function resolveRoleState(subjectId) {
    return firestore.runTransaction(async (transaction) => {
      const state = await readRoleState(
        transaction,
        firestore,
        assignmentsCollection,
        controlReference(),
        assignmentReference(subjectId),
      );
      return state;
    });
  }

  return Object.freeze({
    async getAssignment(subjectId) {
      if (!isStableSubjectId(subjectId)) throw makeResolutionError('INVALID_SUBJECT');
      try {
        const state = await resolveRoleState(subjectId);
        return state.target ? publicAssignment(state.target) : null;
      } catch (error) {
        if (error instanceof CatalogAdminRoleResolutionError) throw error;
        throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
      }
    },

    async listAssignments({ activeOnly = false } = {}) {
      if (typeof activeOnly !== 'boolean') throw new TypeError('Invalid assignment list options.');
      try {
        return firestore.runTransaction(async (transaction) => {
          const controlSnapshot = await transaction.get(controlReference());
          const collectionSnapshot = await transaction.get(firestore.collection(assignmentsCollection));
          if (!collectionSnapshot || !Array.isArray(collectionSnapshot.docs)) {
            throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
          }
          const assignments = collectionSnapshot.docs.map(assignmentSnapshotFromQueryDocument);
          const control = validateControlSnapshot(controlSnapshot);
          if (!control && assignments.length > 0) throw makeResolutionError('ROLE_CONTROL_MISSING');
          if (control && countActiveAdministrators(assignments) !== control.data.activeAdministratorCount) {
            throw makeResolutionError('ROLE_CONTROL_INCONSISTENT');
          }
          return assignments
            .filter((assignment) => !activeOnly || assignment.data.active)
            .map(publicAssignment);
        });
      } catch (error) {
        if (error instanceof CatalogAdminRoleResolutionError) throw error;
        throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
      }
    },

    async resolveRoles(subjectId) {
      if (!isStableSubjectId(subjectId)) throw makeResolutionError('INVALID_SUBJECT');
      try {
        const state = await resolveRoleState(subjectId);
        const assignment = state.target;
        return assignment?.data.active ? [...assignment.roles] : [];
      } catch (error) {
        if (error instanceof CatalogAdminRoleResolutionError) throw error;
        throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
      }
    },

    // The caller must supply an actor from verified ADC impersonation and an
    // approval from a separately trusted provider. This adapter validates shape,
    // not the provenance of either injected dependency.
    async bootstrapFirstAdministrator({ subjectId } = {}) {
      if (!isStableSubjectId(subjectId)) {
        throw new TypeError('Invalid Firebase owner subject.');
      }
      const occurredAt = clock();
      const occurredAtIso = occurredAt instanceof Date ? occurredAt.toISOString() : '';
      if (!isIsoTimestamp(occurredAtIso)) throw new TypeError('Invalid role bootstrap clock.');

      try {
        return await firestore.runTransaction(async (transaction) => {
          const state = await readRoleState(
            transaction,
            firestore,
            assignmentsCollection,
            controlReference(),
            assignmentReference(subjectId),
          );
          if (state.control || state.assignments.length > 0) {
            throw makeResolutionError(state.control ? 'BOOTSTRAP_ALREADY_COMPLETED' : 'ROLE_CONTROL_MISSING');
          }
          const event = validateCatalogAdminRoleAuditEvent({
            schemaVersion: 3,
            eventId: createEventId(),
            operation: 'bootstrap.completed',
            occurredAt: occurredAtIso,
            outcome: 'committed',
            actorId: subjectId,
            actorType: 'firebase_user',
            identitySource: 'firebase_admin_id_token',
            ownerId: subjectId,
            targetSubjectId: subjectId,
            rolesBefore: [],
            rolesAfter: ['administrator'],
            activeBefore: false,
            activeAfter: true,
            previousVersion: 0,
            version: 1,
          });
          transaction.create(assignmentReference(subjectId), {
            subjectId,
            roles: ['administrator'],
            active: true,
            version: 1,
            createdAt: occurredAtIso,
            createdBy: subjectId,
            updatedAt: occurredAtIso,
            updatedBy: subjectId,
          });
          transaction.create(controlReference(), {
            bootstrapState: 'completed',
            version: 1,
            activeAdministratorCount: 1,
            completedAt: occurredAtIso,
            completedBy: subjectId,
            actorType: 'firebase_user',
            identitySource: 'firebase_admin_id_token',
            ownerId: subjectId,
            updatedAt: occurredAtIso,
            updatedBy: subjectId,
          });
          await auditSink.appendInTransaction(transaction, event);
          return Object.freeze({ version: 1, eventId: event.eventId });
        });
      } catch (error) {
        if (error instanceof CatalogAdminRoleResolutionError) throw error;
        // Log only safe error metadata; never log request bodies, credentials, or raw messages.
        console.error('[catalog-admin-bootstrap] Firestore bootstrap failed', {
          errorName: typeof error?.name === 'string' ? error.name : 'UnknownError',
          errorCode: typeof error?.code === 'string' || typeof error?.code === 'number'
            ? String(error.code).slice(0, 64)
            : undefined,
          errorStatus: typeof error?.status === 'string' || typeof error?.status === 'number'
            ? String(error.status).slice(0, 32)
            : undefined,
        });
        if (error instanceof TypeError) throw error;
        throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
      }
    },

    async bootstrapAdministrator({ actor, approval, targetSubjectId } = {}) {
      validateBootstrapIdentity(actor, approval);
      const { actorId } = actor;
      if (!isStableSubjectId(targetSubjectId)) {
        throw new TypeError('Invalid catalog administrator bootstrap request.');
      }
      const occurredAt = clock();
      const occurredAtIso = occurredAt instanceof Date ? occurredAt.toISOString() : '';
      if (!isIsoTimestamp(occurredAtIso)) throw new TypeError('Invalid role bootstrap clock.');

      try {
        return await firestore.runTransaction(async (transaction) => {
          const state = await readRoleState(
            transaction,
            firestore,
            assignmentsCollection,
            controlReference(),
            assignmentReference(targetSubjectId),
          );
          if (state.control || state.assignments.length > 0) {
            throw makeResolutionError(state.control ? 'BOOTSTRAP_ALREADY_COMPLETED' : 'ROLE_CONTROL_MISSING');
          }
          const assignmentReferenceForTarget = assignmentReference(targetSubjectId);
          const event = validateCatalogAdminRoleAuditEvent({
            schemaVersion: 4,
            eventId: createEventId(),
            operation: 'bootstrap.completed',
            occurredAt: occurredAtIso,
            outcome: 'committed',
            actorId,
            actorType: actor.actorType,
            identitySource: actor.identitySource,
            ownerId: approval.ownerId,
            ownerIdentitySource: approval.ownerIdentitySource,
            approvalReference: approval.approvalReference,
            targetSubjectId,
            rolesBefore: [],
            rolesAfter: ['administrator'],
            activeBefore: false,
            activeAfter: true,
            previousVersion: 0,
            version: 1,
          });
          transaction.create(assignmentReferenceForTarget, {
            subjectId: targetSubjectId,
            roles: ['administrator'],
            active: true,
            version: 1,
            createdAt: occurredAtIso,
            createdBy: actorId,
            updatedAt: occurredAtIso,
            updatedBy: actorId,
          });
          transaction.create(controlReference(), {
            bootstrapState: 'completed',
            version: 1,
            activeAdministratorCount: 1,
            completedAt: occurredAtIso,
            completedBy: actorId,
            actorType: actor.actorType,
            identitySource: actor.identitySource,
            ownerId: approval.ownerId,
            ownerIdentitySource: approval.ownerIdentitySource,
            approvalReference: approval.approvalReference,
            updatedAt: occurredAtIso,
            updatedBy: actorId,
          });
          await auditSink.appendInTransaction(transaction, event);
          return Object.freeze({ version: 1, eventId: event.eventId });
        });
      } catch (error) {
        if (error instanceof CatalogAdminRoleResolutionError || error instanceof TypeError) throw error;
        throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
      }
    },

    // Trusted provisioning code must supply actorId from an authenticated operator/workload.
    // This method is intentionally not wired to an HTTP route or runtime by this adapter.
    async changeAssignment({ actorId, targetSubjectId, roles, active = true, expectedVersion } = {}) {
      if (!isStableSubjectId(actorId) || !isStableSubjectId(targetSubjectId) ||
          typeof active !== 'boolean' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new TypeError('Invalid catalog administrator role change request.');
      }
      const nextRoles = [...normalizeCatalogAdminRoles(roles)];
      if (active && nextRoles.length === 0) {
        throw new TypeError('An active role assignment must contain at least one role.');
      }
      const occurredAt = clock();
      const occurredAtIso = occurredAt instanceof Date ? occurredAt.toISOString() : '';
      if (!Number.isFinite(Date.parse(occurredAtIso))) throw new TypeError('Invalid role change clock.');

      try {
        return await firestore.runTransaction(async (transaction) => {
          const reference = assignmentReference(targetSubjectId);
          const state = await readRoleState(
            transaction,
            firestore,
            assignmentsCollection,
            controlReference(),
            reference,
          );
          if (!state.control) throw makeResolutionError('ROLE_CONTROL_MISSING');
          const before = state.target;
          const actualVersion = before?.data.version ?? 0;
          if (actualVersion !== expectedVersion) {
            const error = new Error('Catalog administrator role assignment version conflict.');
            error.code = 'VERSION_CONFLICT';
            throw error;
          }
          if (!before && !active) throw new TypeError('Cannot create a disabled role assignment.');
          if (before && !before.data.active && !active) {
            throw new TypeError('Role assignment is already disabled.');
          }
          if (before && !active && (nextRoles.length !== before.roles.length ||
              !nextRoles.every((role) => before.roles.includes(role)))) {
            throw new TypeError('Disabling an assignment must preserve its roles.');
          }
          if (before && active && !before.data.active &&
              (nextRoles.length !== before.roles.length ||
               !nextRoles.every((role) => before.roles.includes(role)))) {
            throw new TypeError('Reactivating an assignment must preserve its existing roles.');
          }
          if (before && active && before.data.active && nextRoles.length === before.roles.length &&
              nextRoles.every((role) => before.roles.includes(role))) {
            throw new TypeError('Role assignment change has no effect.');
          }

          const beforeIsAdministrator = before ? isActiveAdministrator(before) : false;
          const afterIsAdministrator = active && nextRoles.includes('administrator');
          const nextAdministratorCount = state.actualCount - (beforeIsAdministrator ? 1 : 0) +
            (afterIsAdministrator ? 1 : 0);
          if (nextAdministratorCount < 1) {
            throw makeResolutionError('LAST_ADMINISTRATOR');
          }

          const nextVersion = actualVersion + 1;
          const eventInput = {
            eventId: createEventId(),
            operation: chooseOperation(before, nextRoles, active),
            occurredAt: occurredAtIso,
            outcome: 'committed',
            actorId,
            targetSubjectId,
            rolesBefore: before?.roles ?? [],
            rolesAfter: nextRoles,
            activeBefore: before?.data.active ?? false,
            activeAfter: active,
            previousVersion: actualVersion,
            version: nextVersion,
          };
          const event = validateCatalogAdminRoleAuditEvent(eventInput);
          const assignment = {
            ...(before?.data ?? {}),
            subjectId: targetSubjectId,
            roles: nextRoles,
            active,
            version: nextVersion,
            ...(before ? {} : { createdAt: occurredAtIso, createdBy: actorId }),
            updatedAt: occurredAtIso,
            updatedBy: actorId,
          };
          if (before) transaction.set(reference, assignment);
          else transaction.create(reference, assignment);
          transaction.set(controlReference(), {
            ...state.control.data,
            version: state.control.data.version + 1,
            activeAdministratorCount: nextAdministratorCount,
            updatedAt: occurredAtIso,
            updatedBy: actorId,
          });
          await auditSink.appendInTransaction(transaction, event);
          return Object.freeze({ version: nextVersion, eventId: event.eventId });
        });
      } catch (error) {
        if (error instanceof CatalogAdminRoleResolutionError ||
            error?.code === 'VERSION_CONFLICT' || error instanceof TypeError) throw error;
        throw makeResolutionError('ROLE_SOURCE_UNAVAILABLE');
      }
    },
  });
}

module.exports = {
  DEFAULT_ASSIGNMENTS_COLLECTION,
  DEFAULT_AUDIT_COLLECTION,
  DEFAULT_CONTROL_COLLECTION,
  DEFAULT_CONTROL_DOCUMENT,
  createFirestoreCatalogAdminRoleAuditSink,
  createFirestoreCatalogAdminRoleProvider,
};
