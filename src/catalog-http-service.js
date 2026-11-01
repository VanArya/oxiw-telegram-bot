'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createCatalogApi } = require('./catalog-api');
const { createCatalogAdminApi } = require('./catalog-admin-api');
const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');
const {
  assertVersionedWritableCatalogMetadataProvider,
} = require('./catalog-writable-metadata-provider');

const DEFAULT_PORT = 8080;
const PUBLIC_CATALOG_PATH = '/api/v1/catalog';
const ADMIN_CATALOG_PATH = '/api/v1/admin/catalog';
const REQUIRED_READINESS_CHECKS = Object.freeze([
  'sheetSource',
  'metadataStore',
  'writableStore',
  'auditSink',
]);

function requestId() {
  return crypto.randomUUID();
}

function sendError(res, status, code, message) {
  return res.status(status).json({
    error: { code, message, requestId: requestId() },
  });
}

function parseCatalogPort(value = process.env.PORT) {
  if (value === undefined) return DEFAULT_PORT;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('PORT must be an integer from 1 through 65535.');
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new TypeError('PORT must be an integer from 1 through 65535.');
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('PORT must be an integer from 1 through 65535.');
  }
  return port;
}

function isUnderPath(pathname, basePath) {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function createCatalogHttpService({
  provider,
  categories = [],
  metadataProvider,
  writableProvider,
  verifyAdminPrincipal,
  roleProvider,
  reportRoleResolutionFailure,
  authorizePermission,
  readinessCheck,
} = {}) {
  if (!provider || typeof provider.readSheet !== 'function') {
    throw new TypeError('Catalog HTTP service requires an injected readSheet provider.');
  }
  if (!Array.isArray(categories)) {
    throw new TypeError('Catalog HTTP service categories must be an array.');
  }
  assertCatalogMetadataProvider(metadataProvider);
  if (!writableProvider) {
    throw new TypeError('Catalog HTTP service requires a VersionedWritableCatalogMetadataProvider.');
  }
  assertVersionedWritableCatalogMetadataProvider(writableProvider);
  if (typeof readinessCheck !== 'function') {
    throw new TypeError('Catalog HTTP service requires an injected readiness check.');
  }

  const publicApi = createCatalogApi({ provider, categories, metadataProvider });
  // Missing verifier/policy is intentionally allowed here because the existing
  // admin API fails closed with 503. It never derives a principal from the request.
  const adminApi = createCatalogAdminApi({
    writableProvider,
    verifyAdminPrincipal,
    roleProvider,
    reportRoleResolutionFailure,
    authorizePermission,
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/health/live', (req, res) => res.status(200).json({ status: 'live' }));

  app.get('/health/ready', async (req, res) => {
    try {
      const checks = await readinessCheck();
      const checksReady = checks && typeof checks === 'object' && !Array.isArray(checks) &&
        REQUIRED_READINESS_CHECKS.every((key) => checks[key] === true);
      const authorizationConfigured = typeof verifyAdminPrincipal === 'function' &&
        typeof roleProvider?.resolveRoles === 'function' &&
        typeof authorizePermission === 'function';
      if (!checksReady || !authorizationConfigured) {
        return res.status(503).json({ status: 'not_ready' });
      }
      return res.status(200).json({ status: 'ready' });
    } catch {
      return res.status(503).json({ status: 'not_ready' });
    }
  });

  // The child apps retain their existing routes, 404 behavior, and error
  // projections. Dispatch without a mount prefix so their original paths remain intact.
  app.use((req, res, next) => {
    if (isUnderPath(req.path, PUBLIC_CATALOG_PATH)) return publicApi(req, res, next);
    if (isUnderPath(req.path, ADMIN_CATALOG_PATH)) return adminApi(req, res, next);
    return next();
  });

  app.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'مسیر درخواست پیدا نشد.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return sendError(res, 500, 'INTERNAL_ERROR', 'در پردازش درخواست خطایی رخ داد.');
  });

  return app;
}

module.exports = {
  ADMIN_CATALOG_PATH,
  DEFAULT_PORT,
  PUBLIC_CATALOG_PATH,
  REQUIRED_READINESS_CHECKS,
  createCatalogHttpService,
  parseCatalogPort,
};
