'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { getCategoryItems, listCategories } = require('./catalog-core');
const { createCatalogSheetAdapter } = require('./catalog-sheet-adapter');

const BASE_PATH = '/api/v1/catalog';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const COUNTRY_TERMS = Object.freeze([
  Object.freeze({ id: 'IR', labelFa: 'ایران' }),
  Object.freeze({ id: 'US', labelFa: 'ایالات متحده' }),
]);
const ALLOWED_QUERY_KEYS = new Set([
  'kind', 'countryId', 'genreId', 'q', 'year', 'page', 'pageSize',
]);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestId() {
  return crypto.randomUUID();
}

function sendError(res, error) {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = known ? error.message : 'در پردازش درخواست خطایی رخ داد.';
  return res.status(status).json({
    error: { code, message, requestId: requestId() },
  });
}

function readSingleQuery(query, key) {
  const values = query.getAll(key);
  if (values.length > 1) {
    throw new ApiError(400, 'INVALID_FILTER', `پارامتر ${key} نباید تکرار شود.`);
  }
  return values[0];
}

function positiveInteger(value, key, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, 'INVALID_PAGINATION', `پارامتر ${key} معتبر نیست.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum && parsed > maximum)) {
    throw new ApiError(400, 'INVALID_PAGINATION', `پارامتر ${key} خارج از محدوده است.`);
  }
  return parsed;
}

function parseListQuery(searchParams) {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw new ApiError(400, 'INVALID_FILTER', 'یکی از پارامترهای فیلتر پشتیبانی نمی‌شود.');
    }
  }

  const values = Object.fromEntries(
    [...ALLOWED_QUERY_KEYS].map((key) => [key, readSingleQuery(searchParams, key)]),
  );

  if (values.genreId !== undefined) {
    throw new ApiError(400, 'FILTER_NOT_READY', 'فیلتر ژانر هنوز در نگاشت داده پیاده‌سازی نشده است.');
  }
  if (values.q !== undefined) {
    throw new ApiError(400, 'FILTER_NOT_READY', 'جست‌وجوی عنوان هنوز در قرارداد اجرایی آماده نیست.');
  }

  const filters = [];
  const filtersApplied = {};
  if (values.kind !== undefined) {
    if (!['movie', 'series'].includes(values.kind)) {
      throw new ApiError(400, 'INVALID_FILTER', 'نوع محتوا پشتیبانی نمی‌شود.');
    }
    filters.push({ field: 'kind', op: 'eq', value: values.kind });
    filtersApplied.kind = values.kind;
  }
  if (values.countryId !== undefined) {
    if (!COUNTRY_TERMS.some((term) => term.id === values.countryId)) {
      throw new ApiError(400, 'INVALID_FILTER', 'شناسهٔ کشور در taxonomy پشتیبانی‌شده نیست.');
    }
    filters.push({ field: 'countryIds', op: 'contains', value: values.countryId });
    filtersApplied.countryId = values.countryId;
  }
  if (values.year !== undefined) {
    if (values.kind === 'series') {
      throw new ApiError(400, 'INVALID_FILTER', 'فیلتر year فقط برای فیلم سینمایی پشتیبانی می‌شود.');
    }
    if (!/^\d{4}$/.test(values.year)) {
      throw new ApiError(400, 'INVALID_FILTER', 'سال باید یک عدد چهاررقمی باشد.');
    }
    const year = Number(values.year);
    if (year < 1800 || year > 3000) {
      throw new ApiError(400, 'INVALID_FILTER', 'سال باید بین 1800 و 3000 باشد.');
    }
    filters.push({ field: 'releaseYear', op: 'eq', value: year });
    filtersApplied.year = year;
  }

  return {
    filter: filters.length === 0 ? undefined : { all: filters },
    filtersApplied,
    page: positiveInteger(values.page, 'page', 1),
    pageSize: positiveInteger(values.pageSize, 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function publicCategory(category) {
  getCategoryItems([], category);
  const localizedTitle = {};
  if (category.localizedTitle && typeof category.localizedTitle === 'object') {
    for (const [locale, title] of Object.entries(category.localizedTitle)) {
      if (/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale) && typeof title === 'string') {
        localizedTitle[locale] = title;
      }
    }
  }
  return {
    id: category.id,
    slug: category.slug,
    localizedTitle,
    sortOrder: Number.isFinite(category.sortOrder) ? category.sortOrder : 0,
    filters: publicFilter(category.filters),
  };
}

function publicFilter(filter) {
  if (filter === undefined || filter === null) return undefined;
  if (Object.hasOwn(filter, 'all')) {
    return { all: filter.all.map(publicFilter) };
  }
  if (Object.hasOwn(filter, 'any')) {
    return { any: filter.any.map(publicFilter) };
  }
  return { field: filter.field, op: filter.op, value: filter.value };
}

function createCatalogApi({ provider, categories = [] }) {
  const adapter = createCatalogSheetAdapter(provider);
  const app = express();
  app.disable('x-powered-by');

  app.get(`${BASE_PATH}/items`, async (req, res) => {
    try {
      const parsed = parseListQuery(new URL(req.originalUrl, 'http://localhost').searchParams);
      const items = await adapter.listItems(parsed.filter);
      const start = (parsed.page - 1) * parsed.pageSize;
      if (!Number.isSafeInteger(start)) {
        throw new ApiError(400, 'INVALID_PAGINATION', 'محدودهٔ صفحه‌بندی معتبر نیست.');
      }
      return res.json({
        data: items.slice(start, start + parsed.pageSize),
        meta: {
          page: parsed.page,
          pageSize: parsed.pageSize,
          total: items.length,
          filtersApplied: parsed.filtersApplied,
        },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(`${BASE_PATH}/items/:id`, async (req, res) => {
    try {
      const items = await adapter.listItems();
      const item = items.find((candidate) => candidate.id === req.params.id);
      if (!item) throw new ApiError(404, 'NOT_FOUND', 'محتوا پیدا نشد.');
      return res.json({ data: item });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(`${BASE_PATH}/categories`, (req, res) => {
    try {
      const active = listCategories(categories).map(publicCategory);
      return res.json({ data: active });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get(`${BASE_PATH}/taxonomies`, (req, res) => {
    return res.json({
      data: { country: COUNTRY_TERMS.map((term) => ({ ...term })) },
      meta: { availableTypes: ['country'] },
    });
  });

  app.use((req, res) => {
    return sendError(res, new ApiError(404, 'NOT_FOUND', 'مسیر درخواست پیدا نشد.'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return sendError(res, error);
  });

  return app;
}

module.exports = { createCatalogApi };
