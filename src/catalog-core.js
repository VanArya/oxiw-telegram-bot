'use strict';

const FILTER_FIELDS = new Set([
  'kind',
  'countryIds',
  'genreIds',
  'releaseYear',
]);
const KINDS = new Set(['movie', 'series']);
const COMPARISON_OPS = new Set(['eq', 'gte', 'lte']);
const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_CHILDREN = 32;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertFilter(expression, depth = 0) {
  if (depth > MAX_FILTER_DEPTH || !isRecord(expression)) {
    throw new TypeError('Filter must be a bounded plain object.');
  }

  const keys = Object.keys(expression);
  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    const children = expression[keys[0]];
    if (!Array.isArray(children) || children.length === 0) {
      throw new TypeError('Boolean filters must contain at least one condition.');
    }
    if (children.length > MAX_FILTER_CHILDREN) {
      throw new TypeError('Boolean filters cannot contain more than 32 conditions.');
    }
    children.forEach((child) => assertFilter(child, depth + 1));
    return;
  }

  if (
    keys.length !== 3 ||
    !keys.includes('field') ||
    !keys.includes('op') ||
    !keys.includes('value')
  ) {
    throw new TypeError('A condition must contain only field, op, and value.');
  }

  const { field, op, value } = expression;
  if (!FILTER_FIELDS.has(field)) {
    throw new TypeError('Unsupported filter field.');
  }

  if (field === 'countryIds' || field === 'genreIds') {
    if (op !== 'contains' || typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Taxonomy filters require contains and a non-empty string.');
    }
    return;
  }

  if (field === 'kind') {
    if (op !== 'eq' || !KINDS.has(value)) {
      throw new TypeError('Invalid kind condition.');
    }
    return;
  }

  if (
    field === 'releaseYear' &&
    COMPARISON_OPS.has(op) &&
    Number.isInteger(value) &&
    value >= 1800 &&
    value <= 3000
  ) {
    return;
  }

  throw new TypeError('Invalid filter operator or value.');
}

function matchesCondition(item, condition) {
  const { field, op, value } = condition;
  const actual = item[field];

  if (op === 'contains') {
    return Array.isArray(actual) && actual.includes(value);
  }
  if (op === 'eq') {
    return actual === value;
  }
  if (op === 'gte') {
    return Number.isInteger(actual) && actual >= value;
  }
  if (op === 'lte') {
    return Number.isInteger(actual) && actual <= value;
  }
  return false;
}

function matchesFilter(item, expression) {
  if (!isRecord(item)) {
    return false;
  }
  if (expression === undefined || expression === null) {
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(expression, 'all')) {
    return expression.all.every((child) => matchesFilter(item, child));
  }
  if (Object.prototype.hasOwnProperty.call(expression, 'any')) {
    return expression.any.some((child) => matchesFilter(item, child));
  }
  return matchesCondition(item, expression);
}

function filterCatalogItems(items, expression) {
  if (!Array.isArray(items)) {
    throw new TypeError('Items must be an array.');
  }
  if (expression !== undefined && expression !== null) {
    assertFilter(expression);
  }

  return items.filter(
    (item) => isPubliclyVisible(item) && matchesFilter(item, expression),
  );
}

function isPubliclyVisible(item) {
  return Boolean(
    item &&
    item.approvalStatus === 'approved' &&
    item.publicationStatus === 'published',
  );
}

function listCategories(categories) {
  if (!Array.isArray(categories)) {
    throw new TypeError('Categories must be an array.');
  }

  return categories
    .filter((category) => category && category.enabled === true)
    .slice()
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.sortOrder) ? left.sortOrder : 0;
      const rightOrder = Number.isFinite(right.sortOrder) ? right.sortOrder : 0;
      return leftOrder - rightOrder || String(left.slug).localeCompare(String(right.slug));
    });
}

function getCategoryItems(items, category) {
  if (!category || category.enabled !== true) {
    return [];
  }
  if (category.filters !== undefined && category.filters !== null) {
    assertFilter(category.filters);
  }
  return filterCatalogItems(items, category.filters);
}

function findPublishedItem(items, id) {
  if (!Array.isArray(items)) {
    throw new TypeError('Items must be an array.');
  }
  return items.find((item) => item && item.id === id && isPubliclyVisible(item)) || null;
}

module.exports = {
  filterCatalogItems,
  findPublishedItem,
  getCategoryItems,
  isPubliclyVisible,
  listCategories,
};
