'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { createCatalogApi } = require('./catalog-api');
const { createCatalogAdminApi } = require('./catalog-admin-api');
const { createCatalogAdminContentReader } = require('./catalog-admin-content-reader');
const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');
const {
  assertVersionedWritableCatalogMetadataProvider,
} = require('./catalog-writable-metadata-provider');

const DEFAULT_PORT = 8080;
const PUBLIC_CATALOG_PATH = '/api/v1/catalog';
const ADMIN_CATALOG_PATH = '/api/v1/admin/catalog';
const ADMIN_WEB_STATIC_FILES = new Set(['/app.js', '/auth-session-coordinator.js', '/styles.css']);
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
  authorizeOwner,
  targetResolver,
  resolveManagerEmail,
  readinessCheck,
  logger,
  getAdminWebConfig,
  auditReader,
  directCategoryWritesEnabled = false,
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

  const publicApi = createCatalogApi({ provider, categories, metadataProvider, logger });
  const adminContentReader = createCatalogAdminContentReader({
    sheetProvider: provider,
    writableProvider,
    onInvalidSourceRow(diagnostic) {
      // Only bounded, non-content metadata is logged. Never include row values,
      // system codes, file IDs, or raw validation messages.
      console.error('[catalog-admin-diagnostic]', JSON.stringify({
        event: 'catalog_admin_source_row_skipped',
        sheetName: diagnostic.sheetName,
        rowNumber: diagnostic.rowNumber,
        stage: diagnostic.stage,
        validationIssue: diagnostic.validationIssue,
        ...(diagnostic.fieldName ? { fieldName: diagnostic.fieldName } : {}),
      }));
    },
  });
  // Missing verifier/policy is intentionally allowed here because the existing
  // admin API fails closed with 503. It never derives a principal from the request.
  const adminApi = createCatalogAdminApi({
    writableProvider,
    contentReader: adminContentReader,
    auditReader,
    verifyAdminPrincipal,
    roleProvider,
    reportRoleResolutionFailure,
    authorizePermission,
    authorizeOwner,
    targetResolver,
    resolveManagerEmail,
    directCategoryWritesEnabled,
  });

  const app = express();
  app.disable('x-powered-by');
  // Keep the opener relationship available for Firebase's cross-origin auth popup.
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
  });

  const adminWebRoot = path.resolve(__dirname, '..', 'admin-web');
  const sendAdminIndex = (req, res) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(path.join(adminWebRoot, 'index.html'));
  };
  app.get('/admin/config.json', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof getAdminWebConfig !== 'function') {
      return res.status(503).json({
        error: {
          code: 'ADMIN_WEB_CONFIG_UNAVAILABLE',
          message: 'پیکربندی Firebase پنل تنظیم نشده است.',
          missing: [],
        },
      });
    }
    try {
      const candidate = getAdminWebConfig();
      const configKeys = ['apiKey', 'authDomain', 'projectId', 'messagingSenderId', 'appId'];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
          configKeys.some((key) => typeof candidate[key] !== 'string' || candidate[key].trim() === '')) {
        throw new TypeError();
      }
      const config = Object.fromEntries(configKeys.map((key) => [key, candidate[key]]));
      return res.status(200).json({ data: config });
    } catch (error) {
      const missing = Array.isArray(error?.missingVariables)
        ? error.missingVariables.filter((name) => typeof name === 'string')
        : [];
      return res.status(503).json({
        error: {
          code: 'ADMIN_WEB_CONFIG_UNAVAILABLE',
          message: 'پیکربندی Firebase پنل ناقص است یا با پروژهٔ سرویس مطابقت ندارد.',
          missing,
        },
      });
    }
  });
  app.get('/admin', (req, res) => {
    if (req.path === '/admin/') return sendAdminIndex(req, res);
    return res.redirect(308, '/admin/');
  });
  const adminStatic = express.static(adminWebRoot, {
    dotfiles: 'deny',
    index: false,
    fallthrough: true,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-cache');
    },
  });
  app.use('/admin', (req, res, next) => {
    if (req.path.split('/').some((part) => part.startsWith('.'))) {
      return res.status(404).end();
    }
    if (ADMIN_WEB_STATIC_FILES.has(req.path)) {
      return adminStatic(req, res, next);
    }
    if (!path.extname(req.path)) {
      return next();
    }
    return res.status(404).end();
  });
  app.get('/admin/*', (req, res, next) => {
    if (path.extname(req.path)) return next();
    return sendAdminIndex(req, res);
  });

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
