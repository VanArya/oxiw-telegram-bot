'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getCatalogFirebaseWebConfig } = require('../src/catalog-admin-web-config');

const env = Object.freeze({
  CATALOG_FIREBASE_WEB_API_KEY: 'public-api-key',
  CATALOG_FIREBASE_WEB_AUTH_DOMAIN: 'catalog.example.firebaseapp.com',
  CATALOG_FIREBASE_WEB_PROJECT_ID: 'catalog-project-123',
  CATALOG_FIREBASE_WEB_MESSAGING_SENDER_ID: '1234567890',
  CATALOG_FIREBASE_WEB_APP_ID: '1:1234567890:web:abc123',
});

test('exposes only complete public Firebase web settings when the project matches runtime', () => {
  assert.deepEqual(getCatalogFirebaseWebConfig({ env, runtimeProjectId: 'catalog-project-123' }), {
    apiKey: 'public-api-key',
    authDomain: 'catalog.example.firebaseapp.com',
    projectId: 'catalog-project-123',
    messagingSenderId: '1234567890',
    appId: '1:1234567890:web:abc123',
  });
});

test('fails closed for missing or mismatched Firebase web configuration', () => {
  assert.throws(
    () => getCatalogFirebaseWebConfig({ env: {}, runtimeProjectId: 'catalog-project-123' }),
    (error) => error.name === 'CatalogAdminWebConfigError' && error.missingVariables.length === 5,
  );
  assert.throws(
    () => getCatalogFirebaseWebConfig({ env, runtimeProjectId: 'other-project-123' }),
    (error) => error.name === 'CatalogAdminWebConfigError' &&
      error.missingVariables.includes('CATALOG_FIREBASE_WEB_PROJECT_ID'),
  );
});
