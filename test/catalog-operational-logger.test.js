'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyGoogleApiFailure,
  createCatalogDataValidationError,
} = require('../src/catalog-operational-errors');
const {
  createCatalogOperationalLogger,
} = require('../src/catalog-operational-logger');

test('classifies Sheets and Firestore failures using status and code only', () => {
  const cases = [
    ['sheets', { response: { status: 401 }, message: 'secret token' }, 'SHEETS_AUTHENTICATION'],
    ['sheets', { status: 403, message: 'private API response' }, 'SHEETS_PERMISSION'],
    ['sheets', { response: { status: 404 } }, 'SHEETS_NOT_FOUND'],
    ['sheets', { code: 'ETIMEDOUT', message: 'secret header' }, 'SHEETS_NETWORK'],
    ['sheets', { message: 'raw unknown provider message' }, 'SHEETS_UNKNOWN'],
    ['firestore', { code: 16, message: 'private credential detail' }, 'FIRESTORE_AUTHENTICATION'],
    ['firestore', { code: 7, message: 'private document data' }, 'FIRESTORE_PERMISSION'],
    ['firestore', { code: 14, message: 'private endpoint' }, 'FIRESTORE_NETWORK'],
    ['firestore', { message: 'raw unknown firestore message' }, 'FIRESTORE_UNKNOWN'],
  ];
  for (const [dependency, error, expected] of cases) {
    assert.equal(classifyGoogleApiFailure(dependency, error), expected);
  }
  const invalidData = createCatalogDataValidationError(
    'firestore', 'taxonomy_validation', 'safe provider message',
  );
  assert.equal(invalidData.errorCode, 'FIRESTORE_DATA_VALIDATION');
  assert.equal(Object.hasOwn(invalidData, 'cause'), false);
});

test('emits only fixed JSON fields and tolerates a failing stderr writer', () => {
  const lines = [];
  const logger = createCatalogOperationalLogger({ write: (line) => lines.push(line) });
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(logger.logFailure({
    requestId,
    dependency: 'sheets',
    stage: 'sheet_read',
    errorCode: 'SHEETS_AUTHENTICATION',
    query: 'private-query-value',
    token: 'private-token',
    message: 'private provider message',
  }), true);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'catalog_request_failed',
    requestId,
    route: '/api/v1/catalog/items',
    dependency: 'sheets',
    stage: 'sheet_read',
    errorCode: 'SHEETS_AUTHENTICATION',
  });
  assert.equal(lines[0].includes('private'), false);
  assert.equal(lines[0].includes('query'), false);

  const failingLogger = createCatalogOperationalLogger({ write() { throw new Error('writer failed'); } });
  assert.equal(failingLogger.logFailure({
    requestId,
    dependency: 'sheets',
    stage: 'sheet_read',
    errorCode: 'SHEETS_AUTHENTICATION',
  }), false);
  assert.equal(logger.logFailure({
    requestId: 'invalid', dependency: 'sheets', stage: 'sheet_read',
    errorCode: 'SHEETS_AUTHENTICATION',
  }), false);
});
