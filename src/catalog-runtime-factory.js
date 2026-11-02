'use strict';

const { createCatalogHttpService } = require('./catalog-http-service');
const { createFirestoreCatalogAuditEventSink } = require('./firestore-catalog-audit-event-sink');
const { createFirestoreCatalogAuditReader } = require('./firestore-catalog-audit-reader');
const { createFirestoreCatalogMetadataProvider } = require('./firestore-catalog-metadata-provider');
const { createFirestoreWritableCatalogMetadataProvider } = require('./firestore-writable-catalog-metadata-provider');
const { createGoogleSheetsCatalogProvider } = require('./google-sheets-catalog-provider');
const { assertCatalogAdminRoleProvider } = require('./catalog-admin-role-provider');
const { repairInvalidMetadataVersions } = require('./firestore-metadata-version-migration');

const GOOGLE_SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SPREADSHEET_ID_ENV = 'CATALOG_SPREADSHEET_ID';

class CatalogRuntimeConfigurationError extends Error {
  constructor() {
    super('Catalog runtime configuration is incomplete or invalid.');
    this.name = 'CatalogRuntimeConfigurationError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireEnvironment(env) {
  if (!isRecord(env) || typeof env[SPREADSHEET_ID_ENV] !== 'string' ||
      env[SPREADSHEET_ID_ENV].trim() === '') {
    throw new CatalogRuntimeConfigurationError();
  }
  return env[SPREADSHEET_ID_ENV].trim();
}

function requireDependencies({ google, firestore, verifyAdminPrincipal, roleProvider, authorizePermission,
  readinessCheck, categories, collections, auditCollection, clock }) {
  if (!google || typeof google.auth?.GoogleAuth !== 'function' ||
      typeof google.sheets !== 'function' ||
      !firestore || typeof firestore.collection !== 'function' ||
      typeof firestore.runTransaction !== 'function' ||
      typeof verifyAdminPrincipal !== 'function' ||
      typeof roleProvider?.resolveRoles !== 'function' ||
      typeof authorizePermission !== 'function' ||
      typeof readinessCheck !== 'function' ||
      (categories !== undefined && !Array.isArray(categories)) ||
      (collections !== undefined && !isRecord(collections)) ||
      (auditCollection !== undefined && typeof auditCollection !== 'string') ||
      (clock !== undefined && typeof clock !== 'function')) {
    throw new CatalogRuntimeConfigurationError();
  }
}

/**
 * Compose the existing providers and HTTP app from explicit dependencies.
 * This deliberately returns an injected runtime, never an operational attestation:
 * the caller still owns Firestore client creation and verifier provenance.
 */
async function createCatalogRuntime({
  env,
  google,
  firestore,
  verifyAdminPrincipal,
  roleProvider,
  reportRoleResolutionFailure,
  authorizePermission,
  readinessCheck,
  categories,
  collections,
  auditCollection,
  clock,
  getAdminWebConfig,
  bootstrapSecret,
  bootstrapOwnerSubjectId,
} = {}) {
  const spreadsheetId = requireEnvironment(env);
  requireDependencies({
    google, firestore, verifyAdminPrincipal, roleProvider, authorizePermission, readinessCheck,
    categories, collections, auditCollection, clock,
  });

  let sheetsClient;
  try {
    const auth = new google.auth.GoogleAuth({ scopes: [GOOGLE_SHEETS_READONLY_SCOPE] });
    const authClient = await auth.getClient();
    if (!authClient) throw new TypeError();
    sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  } catch {
    throw new CatalogRuntimeConfigurationError();
  }

  let provider;
  let metadataProvider;
  let auditEventSink;
  let auditReader;
  let writableProvider;
  try {
    assertCatalogAdminRoleProvider(roleProvider);
    provider = createGoogleSheetsCatalogProvider({ sheetsClient, spreadsheetId });
    metadataProvider = createFirestoreCatalogMetadataProvider({ firestore, collections });
    auditEventSink = createFirestoreCatalogAuditEventSink({
      firestore,
      ...(auditCollection === undefined ? {} : { collection: auditCollection }),
    });
    auditReader = createFirestoreCatalogAuditReader({
      firestore,
      ...(auditCollection === undefined ? {} : { collection: auditCollection }),
    });
    writableProvider = createFirestoreWritableCatalogMetadataProvider({
      firestore,
      auditEventSink,
      ...(collections === undefined ? {} : { collections }),
      ...(clock === undefined ? {} : { clock }),
    });
  } catch {
    throw new CatalogRuntimeConfigurationError();
  }

  let app;
  try {
    app = createCatalogHttpService({
      provider,
      metadataProvider,
      writableProvider,
      auditReader,
      verifyAdminPrincipal,
      roleProvider,
      reportRoleResolutionFailure,
      authorizePermission,
      readinessCheck,
      ...(categories === undefined ? {} : { categories }),
      ...(getAdminWebConfig === undefined ? {} : { getAdminWebConfig }),
      bootstrapSecret,
      bootstrapOwnerSubjectId,
      metadataVersionMigration: (options) => repairInvalidMetadataVersions({
        firestore, auditEventSink, actorId: options.actorId, dryRun: options.dryRun,
      }),
    });
  } catch {
    throw new CatalogRuntimeConfigurationError();
  }

  return Object.freeze({
    runtimeMode: 'injected',
    provider,
    metadataProvider,
    writableProvider,
    auditEventSink,
    auditReader,
    verifyAdminPrincipal,
    roleProvider,
    reportRoleResolutionFailure,
    authorizePermission,
    readinessCheck,
    app,
  });
}

module.exports = {
  CatalogRuntimeConfigurationError,
  GOOGLE_SHEETS_READONLY_SCOPE,
  SPREADSHEET_ID_ENV,
  createCatalogRuntime,
};
