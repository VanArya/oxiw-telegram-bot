'use strict';

const { google: defaultGoogle } = require('googleapis');
const {
  applicationDefault,
  getApp,
  getApps,
  initializeApp,
} = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getCatalogFirebaseWebConfig } = require('./catalog-admin-web-config');
const {
  createCatalogRoleAuthorizer,
  createCatalogOwnerAuthorizer,
} = require('./catalog-admin-authorization');
const {
  createFirebaseAdminIdTokenVerifier,
} = require('./firebase-admin-id-token-verifier');
const {
  createFirebaseAdminManagerEmailResolver,
} = require('./firebase-admin-manager-email-resolver');
const {
  createFirebaseAdminTargetResolver,
} = require('./firebase-admin-target-resolver');
const {
  createFirestoreCatalogAdminRoleAuditSink,
  createFirestoreCatalogAdminRoleProvider,
} = require('./firestore-catalog-admin-role-provider');
const {
  createCatalogRuntime,
} = require('./catalog-runtime-factory');

const PROJECT_ID_ENV = 'CATALOG_GCP_PROJECT_ID';
const DATABASE_ID_ENV = 'CATALOG_FIRESTORE_DATABASE_ID';
const DEFAULT_DATABASE_ID = '(default)';
const DIRECT_CATEGORY_WRITES_ENV = 'CATALOG_DIRECT_CATEGORIES_WRITE_ENABLED';
const OWNER_UID_ENV = 'CATALOG_ADMIN_OWNER_UID';
const FIREBASE_APP_NAME = 'oxiw-catalog-core';

class CatalogOperationalRuntimeConfigurationError extends Error {
  constructor() {
    super('Catalog operational runtime configuration is incomplete or invalid.');
    this.name = 'CatalogOperationalRuntimeConfigurationError';
  }
}

function isProjectId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function isDatabaseId(value) {
  return value === DEFAULT_DATABASE_ID ||
    (typeof value === 'string' && /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(value));
}

function readOperationalConfiguration(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CatalogOperationalRuntimeConfigurationError();
  }

  const projectId = env[PROJECT_ID_ENV];
  const databaseId = env[DATABASE_ID_ENV] === undefined
    ? DEFAULT_DATABASE_ID
    : env[DATABASE_ID_ENV];
  const spreadsheetId = env.CATALOG_SPREADSHEET_ID;
  const adcPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  const ownerSubjectId = env[OWNER_UID_ENV];

  if (!isProjectId(projectId) || !isDatabaseId(databaseId) ||
      typeof spreadsheetId !== 'string' || spreadsheetId.trim() === '' ||
      (adcPath !== undefined && (typeof adcPath !== 'string' || adcPath.trim() === '')) ||
      (ownerSubjectId !== undefined &&
        (typeof ownerSubjectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerSubjectId)))) {
    throw new CatalogOperationalRuntimeConfigurationError();
  }

  return Object.freeze({
    projectId,
    databaseId,
    spreadsheetId: spreadsheetId.trim(),
    ownerSubjectId,
    directCategoryWritesEnabled: env[DIRECT_CATEGORY_WRITES_ENV] === 'true',
  });
}

function assertFirebaseAdmin(firebaseAdmin) {
  if (!firebaseAdmin || typeof firebaseAdmin !== 'object' ||
      typeof firebaseAdmin.applicationDefault !== 'function' ||
      typeof firebaseAdmin.initializeApp !== 'function' ||
      typeof firebaseAdmin.getAuth !== 'function' ||
      typeof firebaseAdmin.getFirestore !== 'function') {
    throw new CatalogOperationalRuntimeConfigurationError();
  }
}

function initializeFirebaseAdmin({ firebaseAdmin, projectId, databaseId }) {
  assertFirebaseAdmin(firebaseAdmin);

  let app;
  try {
    const existingApps = typeof firebaseAdmin.getApps === 'function'
      ? firebaseAdmin.getApps()
      : [];
    const existing = Array.isArray(existingApps)
      ? existingApps.find((candidate) => candidate?.name === FIREBASE_APP_NAME)
      : undefined;

    if (existing) {
      if (existing.options?.projectId !== projectId) {
        throw new Error('Firebase app project mismatch.');
      }
      app = typeof firebaseAdmin.getApp === 'function'
        ? firebaseAdmin.getApp(FIREBASE_APP_NAME)
        : existing;
    } else {
      const credential = firebaseAdmin.applicationDefault();
      if (!credential || typeof credential !== 'object') throw new TypeError();
      app = firebaseAdmin.initializeApp({
        credential,
        projectId,
      }, FIREBASE_APP_NAME);
    }

    const auth = firebaseAdmin.getAuth(app);
    const firestore = firebaseAdmin.getFirestore(app, databaseId);
    if (!app || !auth || typeof auth.verifyIdToken !== 'function' ||
        !firestore || typeof firestore.collection !== 'function' ||
        typeof firestore.runTransaction !== 'function') {
      throw new TypeError();
    }
    return Object.freeze({ app, auth, firestore });
  } catch {
    throw new CatalogOperationalRuntimeConfigurationError();
  }
}

/**
 * Build the operational composition from explicit environment configuration.
 * This function never runs at module import time; callers must invoke it
 * explicitly through the separate Catalog entrypoint.
 */
async function createOperationalCatalogRuntime({
  env = process.env,
  google = defaultGoogle,
  firebaseAdmin = {
    applicationDefault,
    initializeApp,
    getApp,
    getApps,
    getAuth,
    getFirestore,
  },
  readinessCheck,
  authorizeOwner,
  targetResolver,
} = {}) {
  const configuration = readOperationalConfiguration(env);
  if (!google || typeof google !== 'object') {
    throw new CatalogOperationalRuntimeConfigurationError();
  }

  const firebase = initializeFirebaseAdmin({
    firebaseAdmin,
    projectId: configuration.projectId,
    databaseId: configuration.databaseId,
  });
  const operationalTargetResolver = targetResolver === undefined
    ? createFirebaseAdminTargetResolver({ auth: firebase.auth })
    : targetResolver;
  const operationalAuthorizeOwner = authorizeOwner === undefined
    ? (configuration.ownerSubjectId === undefined
      ? undefined
      : createCatalogOwnerAuthorizer({ ownerSubjectId: configuration.ownerSubjectId }))
    : authorizeOwner;

  let roleProvider;
  try {
    const roleAuditSink = createFirestoreCatalogAdminRoleAuditSink({
      firestore: firebase.firestore,
    });
    roleProvider = createFirestoreCatalogAdminRoleProvider({
      firestore: firebase.firestore,
      auditSink: roleAuditSink,
    });
  } catch {
    throw new CatalogOperationalRuntimeConfigurationError();
  }

  let runtime;
  let runtimeForReadiness;
  const operationalReadiness = readinessCheck || (async () => Object.freeze({
    // Client construction and ADC acquisition happen before this callback. This
    // is an initialization check, not a live permission probe.
    sheetSource: Boolean(runtimeForReadiness?.provider),
    metadataStore: Boolean(runtimeForReadiness?.metadataProvider),
    writableStore: Boolean(runtimeForReadiness?.writableProvider),
    auditSink: Boolean(runtimeForReadiness?.auditEventSink),
  }));
  try {
    runtime = await createCatalogRuntime({
      env: {
        CATALOG_SPREADSHEET_ID: configuration.spreadsheetId,
      },
      google,
      firestore: firebase.firestore,
      verifyAdminPrincipal: createFirebaseAdminIdTokenVerifier({ auth: firebase.auth }),
      roleProvider,
      authorizePermission: createCatalogRoleAuthorizer(),
      ...(operationalAuthorizeOwner === undefined ? {} : { authorizeOwner: operationalAuthorizeOwner }),
      targetResolver: operationalTargetResolver,
      resolveManagerEmail: createFirebaseAdminManagerEmailResolver({ auth: firebase.auth }),
      readinessCheck: operationalReadiness,
      getAdminWebConfig: () => getCatalogFirebaseWebConfig({
        env,
        runtimeProjectId: configuration.projectId,
      }),
      directCategoryWritesEnabled: configuration.directCategoryWritesEnabled,
    });
  } catch {
    throw new CatalogOperationalRuntimeConfigurationError();
  }

  runtimeForReadiness = runtime;
  return Object.freeze({
    ...runtime,
    runtimeMode: 'operational',
    firebaseApp: firebase.app,
    projectId: configuration.projectId,
    databaseId: configuration.databaseId,
    targetResolver: operationalTargetResolver,
    authorizeOwner: operationalAuthorizeOwner,
    readinessCheck: operationalReadiness,
  });
}

module.exports = {
  CatalogOperationalRuntimeConfigurationError,
  DATABASE_ID_ENV,
  DEFAULT_DATABASE_ID,
  FIREBASE_APP_NAME,
  PROJECT_ID_ENV,
  DIRECT_CATEGORY_WRITES_ENV,
  OWNER_UID_ENV,
  createOperationalCatalogRuntime,
  isDatabaseId,
  isProjectId,
  readOperationalConfiguration,
};
