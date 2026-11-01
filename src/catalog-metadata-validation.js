'use strict';

const { filterCatalogItems } = require('./catalog-core');
const { createCatalogContentId } = require('./catalog-content-identity');

const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'unknown']);
const PUBLICATION_STATUSES = new Set(['draft', 'published', 'archived', 'unknown']);
const TAXONOMY_TYPES = new Set(['country', 'genre']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class CatalogInputError extends Error {
  constructor(code = 'INVALID_INPUT') {
    super('Invalid catalog input.');
    this.name = 'CatalogInputError';
    this.code = code;
  }
}

class CatalogConflictError extends Error {
  constructor(code = 'CONFLICT') {
    super('Catalog update conflicts with existing data.');
    this.name = 'CatalogConflictError';
    this.code = code;
  }
}

class CatalogNotFoundError extends Error {
  constructor(code = 'NOT_FOUND') {
    super('Catalog record was not found.');
    this.name = 'CatalogNotFoundError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CatalogInputError();
  }
}

function isCanonicalContentId(contentId) {
  if (typeof contentId !== 'string') return false;
  const separator = contentId.indexOf(':');
  if (separator < 1) return false;
  const kind = contentId.slice(0, separator);
  const encodedSystemCode = contentId.slice(separator + 1);
  if (!['movie', 'series'].includes(kind) || encodedSystemCode.length === 0) return false;
  try {
    return createCatalogContentId(kind, decodeURIComponent(encodedSystemCode)) === contentId;
  } catch {
    return false;
  }
}

function validateIdList(value, type) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new CatalogInputError();
  const seen = new Set();
  const ids = [];
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    const valid = Object.hasOwn(value, index) && typeof id === 'string' &&
      (type === 'country' ? /^[A-Z]{2}$/.test(id) : ID_PATTERN.test(id)) &&
      !seen.has(id);
    if (!valid) throw new CatalogInputError();
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function validateCatalogContentMetadata(contentId, value) {
  if (!isCanonicalContentId(contentId)) throw new CatalogInputError('INVALID_CONTENT_ID');
  assertAllowedKeys(value, new Set([
    'contentId', 'approvalStatus', 'publicationStatus', 'countryIds', 'genreIds',
  ]));
  if (
    (Object.hasOwn(value, 'contentId') && value.contentId !== contentId) ||
    !APPROVAL_STATUSES.has(value.approvalStatus) ||
    !PUBLICATION_STATUSES.has(value.publicationStatus)
  ) throw new CatalogInputError();

  const metadata = {
    contentId,
    approvalStatus: value.approvalStatus,
    publicationStatus: value.publicationStatus,
  };
  const countryIds = validateIdList(value.countryIds, 'country');
  const genreIds = validateIdList(value.genreIds, 'genre');
  if (countryIds !== undefined) metadata.countryIds = countryIds;
  if (genreIds !== undefined) metadata.genreIds = genreIds;
  return metadata;
}

function validateApprovalStatus(value) {
  if (!APPROVAL_STATUSES.has(value)) throw new CatalogInputError();
  return value;
}

function validatePublicationStatus(value, approvalStatus) {
  if (!PUBLICATION_STATUSES.has(value)) throw new CatalogInputError();
  if (value === 'published' && approvalStatus !== 'approved') {
    throw new CatalogConflictError('PUBLICATION_REQUIRES_APPROVAL');
  }
  return value;
}

function validateExpectedVersion(options) {
  if (!isRecord(options) || !Object.hasOwn(options, 'expectedVersion') ||
      Object.keys(options).some((key) => !['expectedVersion', 'actorId'].includes(key)) ||
      !Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 0 ||
      (options.actorId !== undefined &&
        (typeof options.actorId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options.actorId)))) {
    throw new CatalogInputError('EXPECTED_VERSION_REQUIRED');
  }
  return options;
}

function validateCatalogCategory(categoryId, value) {
  if (typeof categoryId !== 'string' || !ID_PATTERN.test(categoryId)) {
    throw new CatalogInputError('INVALID_CATEGORY_ID');
  }
  assertAllowedKeys(value, new Set([
    'id', 'slug', 'localizedTitle', 'filters', 'enabled', 'sortOrder',
  ]));
  if (
    (Object.hasOwn(value, 'id') && value.id !== categoryId) ||
    typeof value.slug !== 'string' || !SLUG_PATTERN.test(value.slug) ||
    !isRecord(value.localizedTitle) || Object.keys(value.localizedTitle).length === 0 ||
    Object.entries(value.localizedTitle).some(([locale, title]) => (
      !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale) ||
      typeof title !== 'string' || title.trim() === ''
    )) ||
    typeof value.enabled !== 'boolean' ||
    (value.sortOrder !== undefined && !Number.isFinite(value.sortOrder))
  ) throw new CatalogInputError();

  const category = {
    id: categoryId,
    slug: value.slug,
    localizedTitle: { ...value.localizedTitle },
    enabled: value.enabled,
  };
  if (value.sortOrder !== undefined) category.sortOrder = value.sortOrder;
  if (value.filters !== undefined) {
    try {
      filterCatalogItems([], value.filters);
    } catch {
      throw new CatalogInputError();
    }
    category.filters = structuredClone(value.filters);
  }
  return category;
}

function validateCatalogTaxonomyTerm(type, termId, value) {
  if (!TAXONOMY_TYPES.has(type)) throw new CatalogInputError('INVALID_TAXONOMY_TYPE');
  const validId = type === 'country'
    ? typeof termId === 'string' && /^[A-Z]{2}$/.test(termId)
    : typeof termId === 'string' && ID_PATTERN.test(termId);
  if (!validId) throw new CatalogInputError('INVALID_TAXONOMY_ID');
  assertAllowedKeys(value, new Set(['id', 'labelFa', 'enabled', 'sortOrder']));
  if (
    (Object.hasOwn(value, 'id') && value.id !== termId) ||
    typeof value.labelFa !== 'string' || value.labelFa.trim() === '' ||
    typeof value.enabled !== 'boolean' ||
    (value.sortOrder !== undefined && !Number.isFinite(value.sortOrder))
  ) throw new CatalogInputError();

  const term = { id: termId, labelFa: value.labelFa, enabled: value.enabled };
  if (value.sortOrder !== undefined) term.sortOrder = value.sortOrder;
  return term;
}

module.exports = {
  CatalogConflictError,
  CatalogInputError,
  CatalogNotFoundError,
  APPROVAL_STATUSES,
  PUBLICATION_STATUSES,
  TAXONOMY_TYPES,
  validateApprovalStatus,
  validateCatalogCategory,
  isCanonicalContentId,
  validateCatalogContentMetadata,
  validateCatalogTaxonomyTerm,
  validatePublicationStatus,
  validateExpectedVersion,
};
