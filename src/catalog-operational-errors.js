'use strict';

const ERROR_CODES = Object.freeze({
  sheets: Object.freeze([
    'SHEETS_AUTHENTICATION', 'SHEETS_PERMISSION', 'SHEETS_NOT_FOUND',
    'SHEETS_NETWORK', 'SHEETS_UNKNOWN', 'SHEETS_DATA_VALIDATION',
  ]),
  firestore: Object.freeze([
    'FIRESTORE_AUTHENTICATION', 'FIRESTORE_PERMISSION', 'FIRESTORE_NETWORK',
    'FIRESTORE_DATA_VALIDATION', 'FIRESTORE_UNKNOWN',
  ]),
  catalog: Object.freeze(['CATALOG_UNEXPECTED']),
});

const VALID_STAGES = new Set([
  'sheet_read',
  'sheet_response_validation',
  'sheet_snapshot_validation',
  'sheet_row_mapping',
  'sheet_identity_validation',
  'metadata_read',
  'category_read',
  'taxonomy_read',
  'metadata_validation',
  'category_validation',
  'taxonomy_validation',
  'request_handler',
]);

class CatalogDependencyError extends Error {
  constructor({ dependency, stage, errorCode, message }) {
    if (!ERROR_CODES[dependency]?.includes(errorCode) || !VALID_STAGES.has(stage)) {
      throw new TypeError('Invalid catalog dependency error.');
    }
    super(message);
    this.name = 'CatalogDependencyError';
    this.dependency = dependency;
    this.stage = stage;
    this.errorCode = errorCode;
  }
}

function safeStatus(error) {
  const status = error?.response?.status ?? error?.status ?? error?.statusCode;
  return Number.isInteger(status) ? status : undefined;
}

function safeErrorCode(error) {
  const code = error?.code ?? error?.status;
  return typeof code === 'string' || typeof code === 'number' ? String(code).toUpperCase() : '';
}

function isNetworkFailure(error) {
  const code = safeErrorCode(error);
  return [
    'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
    'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UNAVAILABLE',
    'DEADLINE_EXCEEDED', '4', '14',
  ].includes(code);
}

function classifyGoogleApiFailure(dependency, error) {
  if (dependency !== 'sheets' && dependency !== 'firestore') return undefined;
  const status = safeStatus(error);
  const code = safeErrorCode(error);
  if (status === 401 || code === 'UNAUTHENTICATED' || code === '16') {
    return `${dependency.toUpperCase()}_AUTHENTICATION`;
  }
  if (status === 403 || code === 'PERMISSION_DENIED' || code === '7') {
    return `${dependency.toUpperCase()}_PERMISSION`;
  }
  if (dependency === 'sheets' && (status === 404 || code === 'NOT_FOUND' || code === '5')) {
    return 'SHEETS_NOT_FOUND';
  }
  if (dependency === 'firestore' && (status === 404 || code === 'NOT_FOUND' || code === '5')) {
    return 'FIRESTORE_DATA_VALIDATION';
  }
  if ((status === 429 || status >= 500) || isNetworkFailure(error)) {
    return `${dependency.toUpperCase()}_NETWORK`;
  }
  return `${dependency.toUpperCase()}_UNKNOWN`;
}

function createCatalogDependencyError({ dependency, stage, errorCode, message }) {
  return new CatalogDependencyError({ dependency, stage, errorCode, message });
}

function classifyCatalogDependencyError(dependency, stage, error, message) {
  if (error instanceof CatalogDependencyError) return error;
  return createCatalogDependencyError({
    dependency,
    stage,
    errorCode: classifyGoogleApiFailure(dependency, error),
    message,
  });
}

function createCatalogDataValidationError(dependency, stage, message) {
  if (dependency !== 'sheets' && dependency !== 'firestore') {
    throw new TypeError('Invalid catalog data dependency.');
  }
  return createCatalogDependencyError({
    dependency,
    stage,
    errorCode: `${dependency.toUpperCase()}_DATA_VALIDATION`,
    message,
  });
}

module.exports = {
  CatalogDependencyError,
  ERROR_CODES,
  VALID_STAGES,
  classifyCatalogDependencyError,
  classifyGoogleApiFailure,
  createCatalogDataValidationError,
  createCatalogDependencyError,
};
