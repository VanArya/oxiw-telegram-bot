'use strict';

const FIREBASE_WEB_ENV = Object.freeze({
  apiKey: 'CATALOG_FIREBASE_WEB_API_KEY',
  authDomain: 'CATALOG_FIREBASE_WEB_AUTH_DOMAIN',
  projectId: 'CATALOG_FIREBASE_WEB_PROJECT_ID',
  messagingSenderId: 'CATALOG_FIREBASE_WEB_MESSAGING_SENDER_ID',
  appId: 'CATALOG_FIREBASE_WEB_APP_ID',
});

class CatalogAdminWebConfigError extends Error {
  constructor(missingVariables = []) {
    super('Admin web Firebase configuration is incomplete or invalid.');
    this.name = 'CatalogAdminWebConfigError';
    this.missingVariables = Object.freeze([...missingVariables]);
  }
}

function getCatalogFirebaseWebConfig({ env = process.env, runtimeProjectId } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CatalogAdminWebConfigError(Object.values(FIREBASE_WEB_ENV));
  }
  const missing = Object.values(FIREBASE_WEB_ENV).filter((name) => (
    typeof env[name] !== 'string' || env[name].trim() === '' || /[\r\n]/.test(env[name])
  ));
  if (missing.length > 0) throw new CatalogAdminWebConfigError(missing);

  const config = Object.fromEntries(Object.entries(FIREBASE_WEB_ENV).map(([key, name]) => [
    key,
    env[name].trim(),
  ]));
  if (config.projectId !== runtimeProjectId) {
    throw new CatalogAdminWebConfigError([FIREBASE_WEB_ENV.projectId]);
  }
  let authDomainValid = false;
  try {
    const authDomain = new URL(`https://${config.authDomain}`);
    authDomainValid = authDomain.hostname === config.authDomain && authDomain.pathname === '/' &&
      !authDomain.username && !authDomain.password;
  } catch { /* invalid host remains fail-closed */ }
  if (!authDomainValid || !/^[A-Za-z0-9_-]{1,256}$/.test(config.apiKey) ||
      !/^\d+$/.test(config.messagingSenderId) ||
      !/^[A-Za-z0-9:_-]+$/.test(config.appId)) {
    throw new CatalogAdminWebConfigError();
  }
  return Object.freeze(config);
}

module.exports = {
  CatalogAdminWebConfigError,
  FIREBASE_WEB_ENV,
  getCatalogFirebaseWebConfig,
};
