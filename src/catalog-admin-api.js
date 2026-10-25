'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { assertWritableCatalogMetadataProvider } = require('./catalog-writable-metadata-provider');
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

function sendKnownError(res, error) {
  if (error instanceof CatalogInputError) {
    const code = error.code === 'INVALID_CONTENT_ID' ? 'INVALID_CONTENT_ID' : 'INVALID_INPUT';
    return sendError(res, 400, code, 'دادهٔ درخواست معتبر نیست.');
  }
  if (error instanceof CatalogConflictError) {
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

function createCatalogAdminApi({ writableProvider, authorizeAdmin } = {}) {
  const provider = assertWritableCatalogMetadataProvider(writableProvider);
  const app = express();
  app.disable('x-powered-by');

  // Missing authentication is a configuration failure. No route is exposed as
  // writable unless an injected authorizer explicitly returns true.
  app.use((req, res, next) => {
    if (typeof authorizeAdmin !== 'function') {
      return sendError(res, 503, 'ADMIN_AUTH_NOT_CONFIGURED', 'دسترسی مدیریتی پیکربندی نشده است.');
    }
    Promise.resolve()
      .then(() => authorizeAdmin(req))
      .then((authorized) => {
        if (authorized !== true) {
          sendError(res, 403, 'FORBIDDEN', 'اجازهٔ انجام این عملیات را ندارید.');
          return;
        }
        next();
      })
      .catch(() => sendError(res, 500, 'INTERNAL_ERROR', 'در پردازش درخواست خطایی رخ داد.'));
  });

  app.use(express.json({ limit: '32kb', strict: true }));

  app.get(`${BASE_PATH}/items/:contentId/metadata`, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const metadata = await provider.getContentMetadata(req.params.contentId);
    if (!metadata) return sendError(res, 404, 'NOT_FOUND', 'فرادادهٔ محتوا پیدا نشد.');
    return res.json({ data: publicAdminMetadata(req.params.contentId, metadata) });
  }));

  app.put(`${BASE_PATH}/items/:contentId/metadata`, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    const body = validateCatalogContentMetadata(req.params.contentId, req.body);
    if (body.publicationStatus === 'published' && body.approvalStatus !== 'approved') {
      throw new CatalogConflictError('PUBLICATION_REQUIRES_APPROVAL');
    }
    const existed = Boolean(await provider.getContentMetadata(req.params.contentId));
    const saved = await provider.upsertContentMetadata(req.params.contentId, body);
    return res.status(existed ? 200 : 201).json({
      data: publicAdminMetadata(req.params.contentId, saved),
    });
  }));

  app.patch(`${BASE_PATH}/items/:contentId/approval`, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    requireBodyKeys(req.body, ['approvalStatus']);
    const saved = await provider.updateApprovalStatus(req.params.contentId, req.body.approvalStatus);
    return res.json({ data: publicAdminMetadata(req.params.contentId, saved) });
  }));

  app.patch(`${BASE_PATH}/items/:contentId/publication`, asyncRoute(async (req, res) => {
    if (!isCanonicalContentId(req.params.contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
    requireBodyKeys(req.body, ['publicationStatus']);
    const saved = await provider.updatePublicationStatus(req.params.contentId, req.body.publicationStatus);
    return res.json({ data: publicAdminMetadata(req.params.contentId, saved) });
  }));

  app.get(`${BASE_PATH}/categories`, asyncRoute(async (req, res) => {
    const categories = await provider.listCategories();
    if (!Array.isArray(categories)) throw new Error('Invalid category provider response.');
    return res.json({ data: categories.map(publicAdminCategory) });
  }));

  app.get(`${BASE_PATH}/categories/:categoryId`, asyncRoute(async (req, res) => {
    const categories = await provider.listCategories();
    if (!Array.isArray(categories)) throw new Error('Invalid category provider response.');
    const category = categories.find(({ id }) => id === req.params.categoryId);
    if (!category) return sendError(res, 404, 'NOT_FOUND', 'دسته‌بندی پیدا نشد.');
    return res.json({ data: publicAdminCategory(category) });
  }));

  app.put(`${BASE_PATH}/categories/:categoryId`, asyncRoute(async (req, res) => {
    const body = validateCatalogCategory(req.params.categoryId, req.body);
    const existing = (await provider.listCategories()).some(({ id }) => id === req.params.categoryId);
    const saved = await provider.upsertCategory(req.params.categoryId, body);
    return res.status(existing ? 200 : 201).json({ data: publicAdminCategory(saved) });
  }));

  app.get(`${BASE_PATH}/taxonomies/:type`, asyncRoute(async (req, res) => {
    if (!TAXONOMY_TYPES.has(req.params.type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
    const terms = await provider.listAllTaxonomyTerms(req.params.type);
    if (!Array.isArray(terms)) throw new Error('Invalid taxonomy provider response.');
    return res.json({ data: terms.map((term) => publicAdminTaxonomy(req.params.type, term)) });
  }));

  app.get(`${BASE_PATH}/taxonomies/:type/:termId`, asyncRoute(async (req, res) => {
    if (!TAXONOMY_TYPES.has(req.params.type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
    const terms = await provider.listAllTaxonomyTerms(req.params.type);
    if (!Array.isArray(terms)) throw new Error('Invalid taxonomy provider response.');
    const term = terms.find(({ id }) => id === req.params.termId);
    if (!term) return sendError(res, 404, 'NOT_FOUND', 'اصطلاح taxonomy پیدا نشد.');
    return res.json({ data: publicAdminTaxonomy(req.params.type, term) });
  }));

  app.put(`${BASE_PATH}/taxonomies/:type/:termId`, asyncRoute(async (req, res) => {
    if (!TAXONOMY_TYPES.has(req.params.type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
    const body = validateCatalogTaxonomyTerm(req.params.type, req.params.termId, req.body);
    const existing = (await provider.listAllTaxonomyTerms(req.params.type))
      .some(({ id }) => id === req.params.termId);
    const saved = await provider.upsertTaxonomyTerm(req.params.type, req.params.termId, body);
    return res.status(existing ? 200 : 201).json({
      data: publicAdminTaxonomy(req.params.type, saved),
    });
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
