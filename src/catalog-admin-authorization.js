'use strict';

const PERMISSIONS = Object.freeze({
  READ: 'catalog.admin.read',
  METADATA_WRITE: 'catalog.metadata.write',
  CONTENT_APPROVE: 'catalog.content.approve',
  CONTENT_PUBLISH: 'catalog.content.publish',
  CATEGORIES_MANAGE: 'catalog.categories.manage',
  TAXONOMIES_MANAGE: 'catalog.taxonomies.manage',
});

const ROLES = Object.freeze({
  observer: Object.freeze([PERMISSIONS.READ]),
  editor: Object.freeze([PERMISSIONS.READ, PERMISSIONS.METADATA_WRITE]),
  approver: Object.freeze([PERMISSIONS.READ, PERMISSIONS.CONTENT_APPROVE]),
  publisher: Object.freeze([PERMISSIONS.READ, PERMISSIONS.CONTENT_PUBLISH]),
  taxonomy_manager: Object.freeze([
    PERMISSIONS.READ,
    PERMISSIONS.CATEGORIES_MANAGE,
    PERMISSIONS.TAXONOMIES_MANAGE,
  ]),
  administrator: Object.freeze(Object.values(PERMISSIONS)),
});

const ROLE_NAMES = new Set(Object.keys(ROLES));
const PRINCIPAL_KEYS = new Set(['authenticated', 'subjectId', 'roles']);
const IDENTITY_KEYS = new Set(['authenticated', 'subjectId']);

function isVerifiedCatalogIdentity(identity) {
  return Boolean(identity && typeof identity === 'object' && !Array.isArray(identity) &&
    Object.keys(identity).length === 2 &&
    Object.keys(identity).every((key) => IDENTITY_KEYS.has(key)) &&
    Object.hasOwn(identity, 'authenticated') &&
    Object.hasOwn(identity, 'subjectId') &&
    identity.authenticated === true &&
    typeof identity.subjectId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(identity.subjectId));
}

function normalizeVerifiedCatalogIdentity(identity) {
  if (!isVerifiedCatalogIdentity(identity)) return null;
  return Object.freeze({ authenticated: true, subjectId: identity.subjectId });
}

function isVerifiedCatalogPrincipal(principal) {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal) ||
      Object.keys(principal).some((key) => !PRINCIPAL_KEYS.has(key)) ||
      !Object.hasOwn(principal, 'authenticated') ||
      !Object.hasOwn(principal, 'subjectId') ||
      !Object.hasOwn(principal, 'roles') ||
      principal.authenticated !== true ||
      typeof principal.subjectId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(principal.subjectId) ||
      !Array.isArray(principal.roles)) {
    return false;
  }
  const seen = new Set();
  for (const role of principal.roles) {
    if (typeof role !== 'string' || !ROLE_NAMES.has(role) || seen.has(role)) return false;
    seen.add(role);
  }
  return true;
}

function normalizeVerifiedCatalogPrincipal(principal) {
  if (!isVerifiedCatalogPrincipal(principal)) return null;
  return Object.freeze({
    authenticated: true,
    subjectId: principal.subjectId,
    roles: Object.freeze([...principal.roles]),
  });
}

function createCatalogRoleAuthorizer() {
  return (principal, permission) => {
    if (!isVerifiedCatalogPrincipal(principal) || !Object.values(PERMISSIONS).includes(permission)) {
      return false;
    }
    return principal.roles.some((role) => ROLES[role].includes(permission));
  };
}

module.exports = {
  PERMISSIONS,
  ROLES,
  createCatalogRoleAuthorizer,
  isVerifiedCatalogPrincipal,
  isVerifiedCatalogIdentity,
  normalizeVerifiedCatalogIdentity,
  normalizeVerifiedCatalogPrincipal,
  isKnownCatalogAdminRole: (role) => ROLE_NAMES.has(role),
};
