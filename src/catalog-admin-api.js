'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { getCategoryItems } = require('./catalog-core');
const { FirebaseAdminTokenVerificationError } = require('./firebase-admin-id-token-verifier');
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
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      : ['CATEGORY_IN_USE', 'CATEGORY_REFERENCE_INVALID', 'TAXONOMY_REFERENCE_INVALID'].includes(error.code)
        ? error.code
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

function isStableSubjectId(value) {
  return typeof value === 'string' && SUBJECT_ID_PATTERN.test(value);
}

function publicManagerAssignment(value, email) {
  if (!value || typeof value !== 'object' || !isStableSubjectId(value.subjectId) ||
      !Array.isArray(value.roles) || typeof value.active !== 'boolean' ||
      !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new CatalogInputError();
  }
  if (email !== undefined &&
      (typeof email !== 'string' || email.length === 0 || email.length > 320)) {
    throw new CatalogInputError();
  }
  return {
    subjectId: value.subjectId,
    roles: [...normalizeCatalogAdminRoles(value.roles)],
    active: value.active,
    version: value.version,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    ...(email === undefined ? {} : { email }),
  };
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
    const { directCategoryIds, computedCategoryIds, ...stored } = value || {};
    const metadata = validateCatalogContentMetadata(contentId, stored);
    if (Array.isArray(directCategoryIds)) metadata.directCategoryIds = [...directCategoryIds];
    if (Array.isArray(computedCategoryIds)) metadata.computedCategoryIds = [...computedCategoryIds];
    return metadata;
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
  authorizeOwner,
  targetResolver,
  resolveManagerEmail,
  directCategoryWritesEnabled = false,
} = {}) {
  const provider = assertVersionedWritableCatalogMetadataProvider(writableProvider);
  const app = express();
  app.disable('x-powered-by');
  const parseJson = express.json({ limit: '32kb', strict: true });
  if (typeof directCategoryWritesEnabled !== 'boolean') throw new TypeError('Invalid direct category write flag.');

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
      .catch((error) => {
        if (error instanceof FirebaseAdminTokenVerificationError) {
          return sendError(res, 401, 'UNAUTHENTICATED', 'هویت معتبر نیست.');
        }
        return sendError(res, 503, 'AUTHENTICATION_UNAVAILABLE', 'بررسی هویت در دسترس نیست.');
      });
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

  function requireOwner(req, res, next) {
    if (typeof authorizeOwner !== 'function') {
      return sendError(res, 503, 'OWNER_AUTH_NOT_CONFIGURED', 'دسترسی مالک پیکربندی نشده است.');
    }
    Promise.resolve()
      .then(() => authorizeOwner(res.locals.catalogAdminPrincipal))
      .then((allowed) => {
        if (allowed !== true) {
          sendError(res, 403, 'OWNER_REQUIRED', 'این عملیات فقط برای مالک مجاز است.');
          return;
        }
        next();
      })
      .catch(() => sendError(res, 503, 'OWNER_AUTH_UNAVAILABLE', 'بررسی مالک در دسترس نیست.'));
  }

  async function readManagerAssignment(subjectId) {
    if (typeof roleProvider?.getAssignment === 'function') {
      return roleProvider.getAssignment(subjectId);
    }
    if (typeof roleProvider?.listAssignments !== 'function') return null;
    const assignments = await roleProvider.listAssignments({ activeOnly: false });
    return Array.isArray(assignments)
      ? assignments.find((assignment) => assignment?.subjectId === subjectId) || null
      : null;
  }

  function handleManagerError(error, res) {
    if (error?.code === 'VERSION_CONFLICT') {
      return sendError(res, 412, 'PRECONDITION_FAILED', 'نسخهٔ رکورد تغییر کرده است.');
    }
    if (error?.code === 'LAST_ADMINISTRATOR') {
      return sendError(res, 409, 'LAST_ADMINISTRATOR', 'این تغییر آخرین مدیر فعال را حذف می‌کند و مجاز نیست.');
    }
    if (error?.code === 'NO_CHANGE') {
      return sendError(res, 409, 'NO_CHANGE', 'نقش‌های انتخاب‌شده با وضعیت فعلی تفاوتی ندارند.');
    }
    if (error?.code === 'OWNER_ADMIN_REQUIRED') {
      return sendError(res, 409, 'OWNER_ADMIN_REQUIRED', 'نقش مدیر سامانه برای حساب مالک قابل لغو نیست.');
    }
    if (error?.code === 'ALREADY_EXISTS') {
      return sendError(res, 409, 'ALREADY_EXISTS', 'مدیر از قبل وجود دارد.');
    }
    if (error?.code === 'ROLE_CONTROL_MISSING' || error?.code === 'ROLE_CONTROL_INCONSISTENT' ||
        error?.code === 'ROLE_CONTROL_INVALID' || error?.code === 'ROLE_SOURCE_UNAVAILABLE') {
      return sendError(res, 503, 'ROLE_SOURCE_UNAVAILABLE', 'منبع نقش‌ها در دسترس نیست.');
    }
    if (error?.code === 'MANAGER_EMAIL_LOOKUP_FAILED' || error?.code === 'MANAGER_EMAIL_UNAVAILABLE') {
      return sendError(res, 503, 'MANAGER_EMAIL_UNAVAILABLE', 'ایمیل مدیر در دسترس نیست.');
    }
    if (error instanceof CatalogInputError || error?.code === 'INVALID_SUBJECT' ||
        error?.code === 'INVALID_ASSIGNMENT') {
      return sendError(res, 400, 'INVALID_INPUT', 'دادهٔ مدیر معتبر نیست.');
    }
    return sendError(res, 500, 'INTERNAL_ERROR', 'عملیات مدیریت مدیران انجام نشد.');
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

  app.get(`${BASE_PATH}/managers`, requireOwner, asyncRoute(async (req, res) => {
    if (typeof roleProvider?.listAssignments !== 'function') {
      return sendError(res, 503, 'ADMIN_ROLE_MANAGEMENT_NOT_CONFIGURED', 'مدیریت مدیران پیکربندی نشده است.');
    }
    try {
      const assignments = await roleProvider.listAssignments({ activeOnly: true });
      if (!Array.isArray(assignments)) throw new Error();
      if (typeof resolveManagerEmail !== 'function') {
        return res.json({ data: assignments.map(publicManagerAssignment) });
      }
      const resolved = await Promise.all(assignments.map(async (assignment) => ({
        assignment,
        email: await resolveManagerEmail(assignment.subjectId),
      })));
      return res.json({ data: resolved.map(({ assignment, email }) =>
        publicManagerAssignment(assignment, email)) });
    } catch (error) {
      return handleManagerError(error, res);
    }
  }));

  app.post(`${BASE_PATH}/managers`, requireOwner, parseJson, asyncRoute(async (req, res) => {
    try {
      requireBodyKeys(req.body, ['email'], ['email', 'roles']);
      if (typeof req.body.email !== 'string' || !EMAIL_PATTERN.test(req.body.email) ||
          req.body.email.length > 320) throw new CatalogInputError();
      if (typeof targetResolver !== 'function' || typeof roleProvider?.changeAssignment !== 'function') {
        return sendError(res, 503, 'ADMIN_ROLE_MANAGEMENT_NOT_CONFIGURED', 'مدیریت مدیران پیکربندی نشده است.');
      }
      const targetSubjectId = await targetResolver(req.body.email);
      if (!isStableSubjectId(targetSubjectId)) throw new CatalogInputError();
      const current = await readManagerAssignment(targetSubjectId);
      if (current?.active === true) {
        return sendError(res, 409, 'ALREADY_EXISTS', 'مدیر از قبل فعال است.');
      }
      const reactivating = current?.active === false;
      const roles = reactivating ? current.roles : normalizeCatalogAdminRoles(req.body.roles);
      if (roles.length === 0) throw new CatalogInputError();
      const result = await roleProvider.changeAssignment({
        actorId: res.locals.catalogAdminPrincipal.subjectId,
        targetSubjectId,
        roles,
        active: true,
        expectedVersion: current?.version ?? 0,
      });
      return res.status(reactivating ? 200 : 201).json({ data: {
        subjectId: targetSubjectId,
        roles: [...roles],
        active: true,
        version: result.version,
        eventId: result.eventId,
      } });
    } catch (error) {
      return handleManagerError(error, res);
    }
  }));

  app.patch(`${BASE_PATH}/managers/:subjectId`, requireOwner, parseJson, asyncRoute(async (req, res) => {
    if (!isStableSubjectId(req.params.subjectId)) {
      return sendError(res, 400, 'INVALID_INPUT', 'شناسهٔ مدیر معتبر نیست.');
    }
    const precondition = readIfMatch(req, res, 'manager', req.params.subjectId);
    if (!precondition || res.headersSent) return;
    try {
      requireBodyKeys(req.body, ['roles']);
      const roles = normalizeCatalogAdminRoles(req.body.roles);
      if (roles.length === 0) throw new CatalogInputError();
      if (typeof roleProvider?.changeAssignment !== 'function') {
        return sendError(res, 503, 'ADMIN_ROLE_MANAGEMENT_NOT_CONFIGURED', 'مدیریت مدیران پیکربندی نشده است.');
      }
      const current = await readManagerAssignment(req.params.subjectId);
      if (!current || current.active !== true) {
        return sendError(res, 404, 'NOT_FOUND', 'مدیر فعال پیدا نشد.');
      }
      if (req.params.subjectId === res.locals.catalogAdminPrincipal.subjectId &&
          !roles.includes('administrator')) {
        return sendError(res, 409, 'OWNER_ADMIN_REQUIRED', 'نقش مدیر سامانه برای حساب مالک قابل لغو نیست.');
      }
      if (current.roles.length === roles.length && roles.every((role) => current.roles.includes(role))) {
        return sendError(res, 409, 'NO_CHANGE', 'نقش‌های انتخاب‌شده با وضعیت فعلی تفاوتی ندارند.');
      }
      const result = await roleProvider.changeAssignment({
        actorId: res.locals.catalogAdminPrincipal.subjectId,
        targetSubjectId: req.params.subjectId,
        roles: [...roles],
        active: true,
        expectedVersion: precondition.expectedVersion,
      });
      res.set('ETag', makeEtag('manager', req.params.subjectId, result.version));
      return res.json({ data: {
        subjectId: req.params.subjectId,
        roles: [...roles],
        active: true,
        version: result.version,
        eventId: result.eventId,
      } });
    } catch (error) {
      return handleManagerError(error, res);
    }
  }));

  app.delete(`${BASE_PATH}/managers/:subjectId`, requireOwner, asyncRoute(async (req, res) => {
    if (!isStableSubjectId(req.params.subjectId)) return sendError(res, 400, 'INVALID_INPUT', 'شناسهٔ مدیر معتبر نیست.');
    const precondition = readIfMatch(req, res, 'manager', req.params.subjectId);
    if (!precondition || res.headersSent) return;
    if (typeof roleProvider?.changeAssignment !== 'function') {
      return sendError(res, 503, 'ADMIN_ROLE_MANAGEMENT_NOT_CONFIGURED', 'مدیریت مدیران پیکربندی نشده است.');
    }
    try {
      const current = await readManagerAssignment(req.params.subjectId);
      if (!current || current.active !== true) return sendError(res, 404, 'NOT_FOUND', 'مدیر پیدا نشد.');
      if (req.params.subjectId === res.locals.catalogAdminPrincipal.subjectId) {
        return sendError(res, 409, 'OWNER_ADMIN_REQUIRED', 'حساب مالک از این مسیر قابل غیرفعال‌سازی نیست.');
      }
      const result = await roleProvider.changeAssignment({
        actorId: res.locals.catalogAdminPrincipal.subjectId,
        targetSubjectId: req.params.subjectId,
        roles: current.roles,
        active: false,
        expectedVersion: precondition.expectedVersion,
      });
      res.set('ETag', makeEtag('manager', req.params.subjectId, result.version));
      return res.json({ data: {
        subjectId: req.params.subjectId,
        roles: [...current.roles],
        active: false,
        version: result.version,
        eventId: result.eventId,
      } });
    } catch (error) {
      return handleManagerError(error, res);
    }
  }));

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
      const diagnosticRequestId = requestId();
      const diagnostic = {
        event: 'catalog_admin_items_read_failed',
        requestId: diagnosticRequestId,
        errorName: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'UnknownError',
        dependency: typeof error?.dependency === 'string' ? error.dependency : undefined,
        stage: typeof error?.stage === 'string' ? error.stage : undefined,
        errorCode: typeof error?.errorCode === 'string' ? error.errorCode : undefined,
        validationIssue: ['snapshot_shape', 'document_id_invalid', 'document_data_unavailable',
          'document_data_unreadable', 'document_data_not_object', 'version_invalid',
          'content_id_mismatch', 'metadata_fields_invalid'].includes(error?.validationIssue)
          ? error.validationIssue : undefined,
        status: Number.isInteger(error?.status) ? error.status : undefined,
        code: typeof error?.code === 'string' || typeof error?.code === 'number'
          ? String(error.code).slice(0, 40)
          : undefined,
      };
      // Log only bounded diagnostic metadata; never log messages, tokens, headers,
      // spreadsheet contents, user identifiers, or raw provider errors.
      console.error('[catalog-admin-diagnostic]', JSON.stringify(diagnostic));
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'فهرست محتوا در دسترس نیست.',
          requestId: diagnosticRequestId,
        },
      });
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
      const diagnosticRequestId = requestId();
      const cause = error?.cause;
      const diagnostic = {
        event: 'catalog_admin_audit_read_failed',
        requestId: diagnosticRequestId,
        errorName: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'UnknownError',
        errorCode: typeof cause?.code === 'string' || typeof cause?.code === 'number'
          ? String(cause.code).slice(0, 40)
          : (typeof error?.code === 'string' ? error.code.slice(0, 40) : undefined),
        errorStatus: Number.isInteger(cause?.status) ? cause.status : undefined,
      };
      // Keep diagnostics bounded; never log raw messages, request headers, tokens, or user data.
      console.error('[catalog-admin-diagnostic]', JSON.stringify(diagnostic));
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'تاریخچهٔ مدیریتی در دسترس نیست.',
          requestId: diagnosticRequestId,
        },
      });
    }
  }));

  app.get(`${BASE_PATH}/items/:contentId/metadata`, requirePermission(PERMISSIONS.READ), asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const metadata = await provider.getContentMetadataWithVersion(req.params.contentId);
    if (!metadata) return sendError(res, 404, 'NOT_FOUND', 'فرادادهٔ محتوا پیدا نشد.');
    let value = metadata.value;
    if (typeof contentReader?.getItem === 'function' && typeof provider.listCategories === 'function') {
      const item = await contentReader.getItem(req.params.contentId);
      if (item) {
        const categories = await provider.listCategories();
        const computedCategoryIds = categories
          .filter((category) => category.enabled && category.mode !== 'manual' &&
            getCategoryItems([item], category).length > 0)
          .map((category) => category.id);
        value = { ...value, directCategoryIds: value.categoryIds || [], computedCategoryIds };
      }
    }
    return sendVersioned(res, 200, 'content', req.params.contentId, { ...metadata, value },
      (result) => publicAdminMetadata(req.params.contentId, result));
  }));

  app.put(`${BASE_PATH}/items/:contentId/metadata`, requirePermission(PERMISSIONS.METADATA_WRITE), parseJson, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const precondition = readMutationPrecondition(req, res, 'content', req.params.contentId);
    if (!precondition || res.headersSent) return;
    if (!directCategoryWritesEnabled && Object.hasOwn(req.body || {}, 'categoryIds')) {
      return sendError(res, 409, 'FEATURE_DISABLED', 'تخصیص مستقیم دسته‌بندی هنوز فعال نیست.');
    }
    let current = null;
    if (!precondition.isCreate) {
      current = await provider.getContentMetadataWithVersion(req.params.contentId);
      if (!current) return sendError(res, 404, 'NOT_FOUND', 'فرادادهٔ محتوا پیدا نشد.');
      if (current.version !== precondition.expectedVersion) {
        return sendError(res, 412, 'PRECONDITION_FAILED', 'نسخهٔ رکورد تغییر کرده است.');
      }
    }
    const requestBody = current && !Object.hasOwn(req.body || {}, 'categoryIds')
      ? { ...req.body, categoryIds: current.value.categoryIds || [] }
      : req.body;
    const body = validateCatalogContentMetadata(req.params.contentId, requestBody);
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
    if (!directCategoryWritesEnabled && Object.hasOwn(req.body || {}, 'mode') && req.body.mode !== 'dynamic') {
      return sendError(res, 409, 'FEATURE_DISABLED', 'حالت‌های جدید دسته‌بندی هنوز فعال نیستند.');
    }
    if (!directCategoryWritesEnabled && !precondition.isCreate) {
      const current = await provider.getCategoryWithVersion(req.params.categoryId);
      if (current?.value?.mode && current.value.mode !== 'dynamic') {
        return sendError(res, 409, 'FEATURE_DISABLED', 'ویرایش این حالت دسته‌بندی هنوز فعال نیست.');
      }
    }
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
