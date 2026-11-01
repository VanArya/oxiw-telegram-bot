'use strict';

const { isKnownCatalogAdminRole } = require('./catalog-admin-authorization');

class CatalogAdminRoleResolutionError extends Error {
  constructor(code) {
    super('Catalog administrator roles could not be resolved.');
    this.name = 'CatalogAdminRoleResolutionError';
    this.code = code;
  }
}

function assertCatalogAdminRoleProvider(provider) {
  if (!provider || typeof provider.resolveRoles !== 'function') {
    throw new TypeError('CatalogAdminRoleProvider must implement resolveRoles(subjectId).');
  }
  return provider;
}

function normalizeCatalogAdminRoles(value) {
  if (!Array.isArray(value)) {
    throw new CatalogAdminRoleResolutionError('INVALID_ASSIGNMENT');
  }
  const seen = new Set();
  for (const role of value) {
    if (typeof role !== 'string' || !isKnownCatalogAdminRole(role) || seen.has(role)) {
      throw new CatalogAdminRoleResolutionError('INVALID_ASSIGNMENT');
    }
    seen.add(role);
  }
  return Object.freeze([...value]);
}

// Explicit fixture provider. Never selected implicitly by an HTTP service or runtime.
function createInMemoryCatalogAdminRoleProvider(assignments = {}) {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    throw new TypeError('Role assignments must be an object keyed by principal ID.');
  }
  const stored = new Map(Object.entries(assignments).map(([subjectId, roles]) => [
    subjectId,
    Array.isArray(roles) ? [...roles] : roles,
  ]));

  return Object.freeze({
    async resolveRoles(subjectId) {
      if (typeof subjectId !== 'string' || subjectId.trim() === '') {
        throw new CatalogAdminRoleResolutionError('INVALID_SUBJECT');
      }
      const roles = stored.get(subjectId);
      return Array.isArray(roles) ? [...roles] : (roles === undefined ? [] : roles);
    },
  });
}

module.exports = {
  CatalogAdminRoleResolutionError,
  assertCatalogAdminRoleProvider,
  createInMemoryCatalogAdminRoleProvider,
  normalizeCatalogAdminRoles,
};
