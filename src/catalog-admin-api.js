'use strict';

const crypto = require('node:crypto');
const express = require('express');
const {
  normalizeVerifiedCatalogPrincipal,
  normalizeVerifiedCatalogIdentity,
  PERMISSIONS,
  ROLES,
} = require('./catalog-admin-authorization');
const { normalizeCatalogAdminRoles } = require('./catalog-admin-role-provider');
const {
  assertVersionedWritableCatalogMetadataProvider,
} = require('./catalog-writable-metadata-provider');
const {
  CatalogConflictError,
  CatalogInputError,
  CatalogNotFoundError,
  TAXONOMY_TYPES,
  isCanonicalContentId,
  validateCatalogCategory,
  validateCatalogContentMetadata,
  validateCatalogTaxonomyTerm,
} = require('./catalog-metadata-validation');

const BASE_PATH = '/api/v1/admin/catalog';

function requestId() {
  return crypto.randomUUID();
}

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message, requestId: requestId() } });
}

function reportRoleResolutionFailure(reporter, category) {
  if (typeof reporter !== 'function') return;
  try {
    // Deliberately omit subject IDs, role values, and raw provider errors.
    reporter(Object.freeze({ category }));
  } catch {
    // Diagnostics must not change the fail-closed HTTP response.
  }
}

function resourceIdentity(type, id) {
  return `${type}:${id}`;
}

function makeEtag(type, id, version) {
  const encodedIdentity = Buffer.from(resourceIdentity(type, id)).toString('base64url');
  return `"catalog-v1.${encodedIdentity}.v${version}"`;
}

function invalidPrecondition(res) {
  return sendError(res, 400, 'INVALID_PRECONDITION', 'پیش‌شرط نسخه معتبر نیست.');
}

function requiredVersion(res) {
  return sendError(res, 428, 'PRECONDITION_REQUIRED', 'برای تغییر رکورد، پیش‌شرط نسخه لازم است.');
}

function readIfMatch(req, res, type, id) {
  const ifMatch = req.get('if-match');
  if (req.get('if-none-match') !== undefined) return invalidPrecondition(res);
  if (ifMatch === undefined) return requiredVersion(res);
  const match = /^"catalog-v1\.([A-Za-z0-9_-]+)\.v([1-9][0-9]*)"$/.exec(ifMatch);
  if (!match) return invalidPrecondition(res);
  const expectedIdentity = Buffer.from(resourceIdentity(type, id)).toString('base64url');
  const version = Number(match[2]);
  if (match[1] !== expectedIdentity || !Number.isSafeInteger(version)) {
    return sendError(res, 412, 'PRECONDITION_FAILED', 'نسخهٔ رکورد تغییر کرده است.');
  }
  return { expectedVersion: version };
}

function readCreatePrecondition(req, res) {
  const ifNoneMatch = req.get('if-none-match');
  if (ifNoneMatch === undefined) {
    if (req.get('if-match') !== undefined) return invalidPrecondition(res);
    return requiredVersion(res);
  }
  if (ifNoneMatch !== '*' || req.get('if-match') !== undefined) return invalidPrecondition(res);
  return { expectedVersion: 0, isCreate: true };
}

function readMutationPrecondition(req, res, type, id) {
  const ifMatch = req.get('if-match');
  const ifNoneMatch = req.get('if-none-match');
  if (ifMatch === undefined && ifNoneMatch === undefined) return requiredVersion(res);
  if (ifNoneMatch === '*') return readCreatePrecondition(req, res);
  if (ifNoneMatch !== undefined) return invalidPrecondition(res);
  return readIfMatch(req, res, type, id);
}

function sendVersioned(res, status, type, id, result, project) {
  res.set('ETag', makeEtag(type, id, result.version));
  return res.status(status).json({ data: project(result.value) });
}

function sendKnownError(res, error) {
  if (error instanceof CatalogInputError) {
    if (error.code === 'EXPECTED_VERSION_REQUIRED') {
      return sendError(res, 428, 'PRECONDITION_REQUIRED', 'برای تغییر رکورد، پیش‌شرط نسخه لازم است.');
    }
    const code = error.code === 'INVALID_CONTENT_ID' ? 'INVALID_CONTENT_ID' : 'INVALID_INPUT';
    return sendError(res, 400, code, 'دادهٔ درخواست معتبر نیست.');
  }
  if (error instanceof CatalogConflictError) {
    if (error.code === 'VERSION_CONFLICT') {
      return sendError(res, 412, 'PRECONDITION_FAILED', 'نسخهٔ رکورد تغییر کرده است.');
    }
    if (error.code === 'ALREADY_EXISTS') {
      return sendError(res, 409, 'ALREADY_EXISTS', 'رکورد از قبل وجود دارد.');
    }
    const code = error.code === 'PUBLICATION_REQUIRES_APPROVAL'
      ? 'APPROVAL_REQUIRED'
      : 'CONFLICT';
    const message = code === 'APPROVAL_REQUIRED'
      ? 'پیش از انتشار عمومی، محتوا باید تأیید شده باشد.'
      : 'درخواست با داده‌های موجود سازگار نیست.';
    return sendError(res, 409, code, message);
  }
  if (error instanceof CatalogNotFoundError) {
    return sendError(res, 404, 'NOT_FOUND', 'فرادادهٔ محتوا پیدا نشد.');
  }
  return sendError(res, 500, 'INTERNAL_ERROR', 'در پردازش درخواست خطایی رخ داد.');
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireBodyKeys(body, required, allowed = required) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CatalogInputError();
  const keys = Object.keys(body);
  if (required.some((key) => !Object.hasOwn(body, key)) || keys.some((key) => !allowed.includes(key))) {
    throw new CatalogInputError();
  }
}

function publicAdminMetadata(contentId, value) {
  try {
    return validateCatalogContentMetadata(contentId, value);
  } catch {
    throw new Error('Invalid stored catalog metadata.');
  }
}

function publicAdminCategory(value) {
  try {
    return validateCatalogCategory(value?.id, value);
  } catch {
    throw new Error('Invalid stored catalog category.');
  }
}

function publicAdminTaxonomy(type, value) {
  try {
    return validateCatalogTaxonomyTerm(type, value?.id, value);
  } catch {
    throw new Error('Invalid stored catalog taxonomy.');
  }
}

function createCatalogAdminApi({
  writableProvider,
  contentReader,
  auditReader,
  verifyAdminPrincipal,
  roleProvider,
  reportRoleResolutionFailure: reportRoleFailure,
  authorizePermission,
} = {}) {
  const provider = assertVersionedWritableCatalogMetadataProvider(writableProvider);
  const app = express();
  app.disable('x-powered-by');
  const parseJson = express.json({ limit: '32kb', strict: true });

  // The host supplies a trusted verifier. Request fields and ordinary headers
  // are never used to construct the principal in this module.
  app.use((req, res, next) => {
    if (typeof verifyAdminPrincipal !== 'function' ||
        typeof roleProvider?.resolveRoles !== 'function' ||
        typeof authorizePermission !== 'function') {
      return sendError(res, 503, 'ADMIN_AUTH_NOT_CONFIGURED', 'دسترسی مدیریتی پیکربندی نشده است.');
    }
    Promise.resolve()
      .then(() => verifyAdminPrincipal(req))
      .then((candidate) => {
        const identity = normalizeVerifiedCatalogIdentity(candidate);
        if (!identity) {
          sendError(res, 401, 'UNAUTHENTICATED', 'هویت معتبر نیست.');
          return null;
        }
        return identity;
      })
      .then(async (identity) => {
        if (!identity) return;
        let roleValues;
        try {
          roleValues = await roleProvider.resolveRoles(identity.subjectId);
        } catch {
          reportRoleResolutionFailure(reportRoleFailure, 'provider_error');
          sendError(res, 503, 'ROLE_RESOLUTION_UNAVAILABLE', 'بررسی مجوز در دسترس نیست.');
          return;
        }
        let roles;
        try {
          roles = normalizeCatalogAdminRoles(roleValues);
        } catch {
          reportRoleResolutionFailure(reportRoleFailure, 'invalid_assignment');
          sendError(res, 503, 'ROLE_RESOLUTION_UNAVAILABLE', 'بررسی مجوز در دسترس نیست.');
          return;
        }
        const principal = normalizeVerifiedCatalogPrincipal({ ...identity, roles });
        if (!principal) {
          sendError(res, 503, 'ROLE_RESOLUTION_UNAVAILABLE', 'بررسی مجوز در دسترس نیست.');
          return;
        }
        res.locals.catalogAdminPrincipal = principal;
        next();
      })
      .catch(() => sendError(res, 503, 'AUTHENTICATION_UNAVAILABLE', 'بررسی هویت در دسترس نیست.'));
  });

  function requirePermission(permission) {
    return (req, res, next) => {
      Promise.resolve()
        .then(() => authorizePermission(res.locals.catalogAdminPrincipal, permission))
        .then((allowed) => {
          if (allowed !== true) {
            sendError(res, 403, 'FORBIDDEN', 'اجازهٔ انجام این عملیات را ندارید.');
            return;
          }
          next();
        })
        .catch(() => sendError(res, 503, 'AUTHORIZATION_UNAVAILABLE', 'بررسی مجوز در دسترس نیست.'));
    };
  }

  async function requirePermissionForCurrentRequest(res, permission) {
    try {
      const allowed = await authorizePermission(res.locals.catalogAdminPrincipal, permission);
      if (allowed === true) return true;
      sendError(res, 403, 'FORBIDDEN', 'اجازهٔ انجام این عملیات را ندارید.');
      return false;
    } catch {
      sendError(res, 503, 'AUTHORIZATION_UNAVAILABLE', 'بررسی مجوز در دسترس نیست.');
      return false;
    }
  }

  app.get(`${BASE_PATH}/me`, requirePermission(PERMISSIONS.READ), (req, res) => {
    const principal = res.locals.catalogAdminPrincipal;
    const permissions = [...new Set(principal.roles.flatMap((role) => ROLES[role] || []))];
    return res.json({ data: {
      subjectId: principal.subjectId,
      roles: [...principal.roles],
      permissions,
    } });
  });

  app.get(`${BASE_PATH}/items`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    if (!contentReader || typeof contentReader.list !== 'function') {
      return sendError(res, 503, 'ADMIN_CONTENT_READ_NOT_CONFIGURED', 'فهرست مدیریتی محتوا پیکربندی نشده است.');
    }
    try {
      return res.json(await contentReader.list(new URL(req.originalUrl, 'http://localhost').searchParams));
    } catch (error) {
      if (error?.name === 'CatalogAdminListInputError') {
        return sendError(res, 400, 'INVALID_FILTER', 'فیلتر یا صفحه‌بندی معتبر نیست.');
      }
      return sendError(res, 500, 'INTERNAL_ERROR', 'فهرست محتوا در دسترس نیست.');
    }
  }));

  app.get(`${BASE_PATH}/audit`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    if (!auditReader || typeof auditReader.list !== 'function') {
      return sendError(res, 503, 'ADMIN_AUDIT_READ_NOT_CONFIGURED', 'تاریخچهٔ مدیریتی پیکربندی نشده است.');
    }
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    for (const key of query.keys()) {
      if (!['page', 'pageSize'].includes(key) || query.getAll(key).length !== 1) {
        return sendError(res, 400, 'INVALID_PAGINATION', 'صفحه‌بندی معتبر نیست.');
      }
    }
    try {
      return res.json(await auditReader.list({
        page: query.get('page') ?? undefined,
        pageSize: query.get('pageSize') ?? undefined,
      }));
    } catch (error) {
      if (error?.code === 'INVALID_PAGINATION') {
        return sendError(res, 400, 'INVALID_PAGINATION', 'صفحه‌بندی معتبر نیست.');
      }
      return sendError(res, 500, 'INTERNAL_ERROR', 'تاریخچهٔ مدیریتی در دسترس نیست.');
    }
  }));

  app.get(`${BASE_PATH}/items/:contentId/metadata`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const metadata = await provider.getContentMetadataWithVersion(req.params.contentId);
    if (!metadata) return sendError(res, 404, 'NOT_FOUND', 'فرادادهٔ محتوا پیدا نشد.');
    return sendVersioned(res, 200, 'content', req.params.contentId, metadata,
      (value) => publicAdminMetadata(req.params.contentId, value));
  }));

  app.put(`${BASE_PATH}/items/:contentId/metadata`, requirePermission(PERMISSIONS.METADATA_WRITE), parseJson, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const precondition = readMutationPrecondition(req, res, 'content', req.params.contentId);
    if (!precondition || res.headersSent) return;
    const body = validateCatalogContentMetadata(req.params.contentId, req.body);
    let current = null;
    if (!precondition.isCreate) {
      current = await provider.getContentMetadataWithVersion(req.params.contentId);
      if (!current) return sendError(res, 404, 'NOT_FOUND', 'فرادادهٔ محتوا پیدا نشد.');
      if (current.version !== precondition.expectedVersion) {
        return sendError(res, 412, 'PRECONDITION_FAILED', 'نسخهٔ رکورد تغییر کرده است.');
      }
    }
    const approvalChanged = current
      ? body.approvalStatus !== current.value.approvalStatus
      : body.approvalStatus !== 'pending';
    const publicationChanged = current
      ? body.publicationStatus !== current.value.publicationStatus
      : body.publicationStatus !== 'draft';
    if (approvalChanged && !await requirePermissionForCurrentRequest(res, PERMISSIONS.CONTENT_APPROVE)) return;
    if (publicationChanged && !await requirePermissionForCurrentRequest(res, PERMISSIONS.CONTENT_PUBLISH)) return;
    if (body.publicationStatus === 'published' && body.approvalStatus !== 'approved') {
      throw new CatalogConflictError('PUBLICATION_REQUIRES_APPROVAL');
    }
    const saved = await provider.upsertContentMetadata(req.params.contentId, body, {
      expectedVersion: precondition.expectedVersion,
      actorId: res.locals.catalogAdminPrincipal.subjectId,
    });
    return sendVersioned(res, precondition.isCreate ? 201 : 200, 'content', req.params.contentId,
      saved, (value) => publicAdminMetadata(req.params.contentId, value));
  }));

  app.patch(`${BASE_PATH}/items/:contentId/approval`, requirePermission(PERMISSIONS.CONTENT_APPROVE), parseJson, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const precondition = readIfMatch(req, res, 'content', req.params.contentId);
    if (!precondition || res.headersSent) return;
    requireBodyKeys(req.body, ['approvalStatus']);
    const saved = await provider.updateApprovalStatus(req.params.contentId, req.body.approvalStatus, {
      ...precondition,
      actorId: res.locals.catalogAdminPrincipal.subjectId,
    });
    return sendVersioned(res, 200, 'content', req.params.contentId, saved,
      (value) => publicAdminMetadata(req.params.contentId, value));
  }));

  app.patch(`${BASE_PATH}/items/:contentId/publication`, requirePermission(PERMISSIONS.CONTENT_PUBLISH), parseJson, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const precondition = readIfMatch(req, res, 'content', req.params.contentId);
    if (!precondition || res.headersSent) return;
    requireBodyKeys(req.body, ['publicationStatus']);
    const saved = await provider.updatePublicationStatus(req.params.contentId, req.body.publicationStatus, {
      ...precondition,
      actorId: res.locals.catalogAdminPrincipal.subjectId,
    });
    return sendVersioned(res, 200, 'content', req.params.contentId, saved,
      (value) => publicAdminMetadata(req.params.contentId, value));
  }));

  app.get(`${BASE_PATH}/categories`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    const categories = await provider.listCategories();
    if (!Array.isArray(categories)) throw new Error('Invalid category provider response.');
    return res.json({ data: categories.map(publicAdminCategory) });
  }));

  app.get(`${BASE_PATH}/categories/:categoryId`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    const category = await provider.getCategoryWithVersion(req.params.categoryId);
    if (!category) return sendError(res, 404, 'NOT_FOUND', 'دسته‌بندی پیدا نشد.');
    return sendVersioned(res, 200, 'category', req.params.categoryId, category, publicAdminCategory);
  }));

  app.put(`${BASE_PATH}/categories/:categoryId`, requirePermission(PERMISSIONS.CATEGORIES_MANAGE), parseJson, asyncRoute(async (req, res) => {
    const precondition = readMutationPrecondition(req, res, 'category', req.params.categoryId);
    if (!precondition || res.headersSent) return;
    const body = validateCatalogCategory(req.params.categoryId, req.body);
    const saved = await provider.upsertCategory(req.params.categoryId, body, {
      expectedVersion: precondition.expectedVersion,
      actorId: res.locals.catalogAdminPrincipal.subjectId,
    });
    return sendVersioned(res, precondition.isCreate ? 201 : 200, 'category', req.params.categoryId,
      saved, publicAdminCategory);
  }));

  app.get(`${BASE_PATH}/taxonomies/:type`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    if (!TAXONOMY_TYPES.has(req.params.type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
    const terms = await provider.listAllTaxonomyTerms(req.params.type);
    if (!Array.isArray(terms)) throw new Error('Invalid taxonomy provider response.');
    return res.json({ data: terms.map((term) => publicAdminTaxonomy(req.params.type, term)) });
  }));

  app.get(`${BASE_PATH}/taxonomies/:type/:termId`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    if (!TAXONOMY_TYPES.has(req.params.type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
    const term = await provider.getTaxonomyTermWithVersion(req.params.type, req.params.termId);
    if (!term) return sendError(res, 404, 'NOT_FOUND', 'اصطلاح taxonomy پیدا نشد.');
    return sendVersioned(res, 200, `taxonomy-${req.params.type}`, req.params.termId, term,
      (value) => publicAdminTaxonomy(req.params.type, value));
  }));

  app.put(`${BASE_PATH}/taxonomies/:type/:termId`, requirePermission(PERMISSIONS.TAXONOMIES_MANAGE), parseJson, asyncRoute(async (req, res) => {
    if (!TAXONOMY_TYPES.has(req.params.type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
    const precondition = readMutationPrecondition(req, res, `taxonomy-${req.params.type}`, req.params.termId);
    if (!precondition || res.headersSent) return;
    const body = validateCatalogTaxonomyTerm(req.params.type, req.params.termId, req.body);
    const saved = await provider.upsertTaxonomyTerm(req.params.type, req.params.termId, body, {
      expectedVersion: precondition.expectedVersion,
      actorId: res.locals.catalogAdminPrincipal.subjectId,
    });
    return sendVersioned(res, precondition.isCreate ? 201 : 200,
      `taxonomy-${req.params.type}`, req.params.termId, saved,
      (value) => publicAdminTaxonomy(req.params.type, value));
  }));

  app.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'مسیر درخواست پیدا نشد.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400) {
      return sendError(res, 400, 'INVALID_JSON', 'بدنهٔ JSON معتبر نیست.');
    }
    if (error && error.status === 413) {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'اندازهٔ درخواست بیش از حد مجاز است.');
    }
    return sendKnownError(res, error);
  });

  return app;
}

module.exports = { createCatalogAdminApi };
