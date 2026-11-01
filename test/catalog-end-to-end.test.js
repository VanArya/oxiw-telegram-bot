'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createCatalogAdminApi } = require('../src/catalog-admin-api');
const { createCatalogRoleAuthorizer } = require('../src/catalog-admin-authorization');
const { createInMemoryCatalogAdminRoleProvider } = require('../src/catalog-admin-role-provider');
const { createCatalogApi } = require('../src/catalog-api');
const { createCatalogContentId } = require('../src/catalog-content-identity');
const { createFirestoreCatalogAuditEventSink } = require('../src/firestore-catalog-audit-event-sink');
const { createFirestoreCatalogMetadataProvider } = require('../src/firestore-catalog-metadata-provider');
const {
  createFirestoreWritableCatalogMetadataProvider,
} = require('../src/firestore-writable-catalog-metadata-provider');

const ADMIN_PATH = '/api/v1/admin/catalog';
const roleAuthorizer = createCatalogRoleAuthorizer();

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeFirestore {
  constructor() {
    this.documents = new Map();
    this.transactionQueue = Promise.resolve();
    this.networkCalls = 0;
  }

  collection(path) {
    return new FakeCollection(this, path);
  }

  snapshotDocument(path) {
    const value = this.documents.get(path);
    return { exists: value !== undefined, data: () => clone(value) };
  }

  snapshotCollection(path, predicate = () => true) {
    const prefix = `${path}/`;
    const depth = path.split('/').length + 1;
    return {
      docs: [...this.documents.entries()]
        .filter(([documentPath, value]) => (
          documentPath.startsWith(prefix) &&
          documentPath.split('/').length === depth &&
          predicate(value)
        ))
        .map(([documentPath, value]) => ({
          id: documentPath.slice(prefix.length),
          data: () => clone(value),
        })),
    };
  }

  async runTransaction(callback) {
    const previous = this.transactionQueue;
    let release;
    this.transactionQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const writes = [];
      const transaction = {
        get: async (reference) => reference instanceof FakeQuery
          ? reference.snapshot()
          : this.snapshotDocument(reference.path),
        set: (reference, value) => writes.push({ mode: 'set', path: reference.path, value: clone(value) }),
        create: (reference, value) => writes.push({ mode: 'create', path: reference.path, value: clone(value) }),
      };
      const result = await callback(transaction);
      if (writes.some(({ mode, path }) => mode === 'create' && this.documents.has(path))) {
        throw new Error('fake create conflict');
      }
      for (const write of writes) this.documents.set(write.path, write.value);
      return result;
    } finally {
      release();
    }
  }
}

class FakeCollection {
  constructor(firestore, path) {
    this.firestore = firestore;
    this.path = path;
  }

  doc(id) {
    return new FakeDocument(this.firestore, `${this.path}/${id}`);
  }

  where(field, operator, value) {
    return new FakeQuery(this.firestore, this.path, field, operator, value);
  }

  async get() {
    return this.firestore.snapshotCollection(this.path);
  }
}

class FakeDocument {
  constructor(firestore, path) {
    this.firestore = firestore;
    this.path = path;
    this.id = path.split('/').at(-1);
  }

  collection(name) {
    return new FakeCollection(this.firestore, `${this.path}/${name}`);
  }

  async get() {
    return this.firestore.snapshotDocument(this.path);
  }
}

class FakeQuery {
  constructor(firestore, path, field, operator, value) {
    Object.assign(this, { firestore, path, field, operator, value });
  }

  async snapshot() {
    if (this.operator !== '==' && this.operator !== 'array-contains') {
      throw new Error('unsupported fake query');
    }
    return this.firestore.snapshotCollection(this.path, (record) => (
      this.operator === '=='
        ? record[this.field] === this.value
        : Array.isArray(record[this.field]) && record[this.field].includes(this.value)
    ));
  }

  async get() {
    return this.snapshot();
  }
}

async function withServer(app, run) {
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server.listening) await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function json(response) {
  return { status: response.status, body: await response.json(), etag: response.headers.get('etag') };
}

function createAdmin(writableProvider, roles, subjectId = 'fake-admin') {
  return createCatalogAdminApi({
    writableProvider,
    verifyAdminPrincipal: () => ({ authenticated: true, subjectId }),
    roleProvider: createInMemoryCatalogAdminRoleProvider({ [subjectId]: roles }),
    authorizePermission: roleAuthorizer,
  });
}

function metadataBody(approvalStatus = 'pending', publicationStatus = 'draft', countryIds = ['IR']) {
  return { approvalStatus, publicationStatus, countryIds, genreIds: ['drama'] };
}

test('integrates sheet identity, shared Firestore metadata, admin authorization, audit, and public catalog', async () => {
  const movieId = createCatalogContentId('movie', 'e2e-movie-1');
  const seriesId = createCatalogContentId('series', 'e2e-series-1');
  const firestore = new FakeFirestore();
  const auditEventSink = createFirestoreCatalogAuditEventSink({ firestore });
  const writableProvider = createFirestoreWritableCatalogMetadataProvider({ firestore, auditEventSink });
  const metadataProvider = createFirestoreCatalogMetadataProvider({ firestore });
  const sheets = {
    async readSheet(sheetName) {
      if (sheetName === 'سینمایی') {
        return {
          headers: ['کد سیستم', 'اسم فیلم', 'Telegram File ID'],
          rows: [['e2e-movie-1', 'فیلم ساختگی', 'synthetic-private-file-id']],
        };
      }
      if (sheetName === 'سریال') {
        return {
          headers: ['کد سیستم', 'اسم فیلم', 'Telegram File ID'],
          rows: [['e2e-series-1', 'سریال ساختگی', 'synthetic-private-series-file-id']],
        };
      }
      throw new Error('unexpected fake sheet');
    },
  };
  const publicApi = createCatalogApi({ provider: sheets, metadataProvider });
  const editorApi = createAdmin(writableProvider, ['editor'], 'verified-editor');
  const approverApi = createAdmin(writableProvider, ['approver'], 'verified-approver');
  const publisherApi = createAdmin(writableProvider, ['publisher'], 'verified-publisher');
  const taxonomyApi = createAdmin(writableProvider, ['taxonomy_manager'], 'verified-taxonomy-manager');
  const observerApi = createAdmin(writableProvider, ['observer'], 'verified-observer');

  await withServer(taxonomyApi, async (baseUrl) => {
    for (const [type, id, labelFa, enabled] of [
      ['country', 'IR', 'ایران', true],
      ['country', 'US', 'ایالات متحده', false],
      ['genre', 'drama', 'درام', true],
    ]) {
      const result = await json(await fetch(`${baseUrl}${ADMIN_PATH}/taxonomies/${type}/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify({ labelFa, enabled }),
      }));
      assert.equal(result.status, 201);
    }

    for (const [id, slug, title, kind] of [
      ['iranian-movies', 'iranian-movies', 'فیلم سینمایی ایرانی', 'movie'],
      ['iranian-series', 'iranian-series', 'سریال ایرانی', 'series'],
    ]) {
      const category = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify({
          slug,
          localizedTitle: { fa: title },
          enabled: true,
          sortOrder: 1,
          filters: { all: [
            { field: 'kind', op: 'eq', value: kind },
            { field: 'countryIds', op: 'contains', value: 'IR' },
          ] },
        }),
      }));
      assert.equal(category.status, 201);
    }
  });

  await withServer(publicApi, async (baseUrl) => {
    const all = await json(await fetch(`${baseUrl}/api/v1/catalog/items`));
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.data, []);
  });

  await withServer(editorApi, async (baseUrl) => {
    const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(movieId)}/metadata`;
    const invalid = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({ ...metadataBody(), countryIds: ['Iran'] }),
    }));
    assert.equal(invalid.status, 400);
    assert.equal(await writableProvider.getContentMetadata(movieId), null);

    const invalidStatus = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify(metadataBody('approved', 'draft')),
    }));
    assert.equal(invalidStatus.status, 403);

    const created = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify(metadataBody()),
    }));
    assert.equal(created.status, 201);

    const updated = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': created.etag },
      body: JSON.stringify(metadataBody('pending', 'draft', ['IR'])),
    }));
    assert.equal(updated.status, 200);
    const stale = await json(await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': created.etag },
      body: JSON.stringify(metadataBody()),
    }));
    assert.equal(stale.status, 412);
    assert.deepEqual(await metadataProvider.getContentMetadata(movieId), updated.body.data);

    const series = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(seriesId)}/metadata`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify(metadataBody()),
      },
    ));
    assert.equal(series.status, 201);
  });

  await withServer(observerApi, async (baseUrl) => {
    const read = await json(await fetch(`${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(movieId)}/metadata`));
    assert.equal(read.status, 200);
    const denied = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(movieId)}/approval`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': read.etag },
        body: JSON.stringify({ approvalStatus: 'approved' }),
      },
    ));
    assert.equal(denied.status, 403);
  });

  const unauthenticatedApi = createCatalogAdminApi({
    writableProvider,
    verifyAdminPrincipal: () => ({ authenticated: false, subjectId: 'fake-user' }),
    roleProvider: createInMemoryCatalogAdminRoleProvider({ 'fake-user': ['administrator'] }),
    authorizePermission: roleAuthorizer,
  });
  await withServer(unauthenticatedApi, async (baseUrl) => {
    const denied = await json(await fetch(`${baseUrl}${ADMIN_PATH}/categories`));
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, 'UNAUTHENTICATED');
  });

  await withServer(approverApi, async (baseUrl) => {
    for (const id of [movieId, seriesId]) {
      const url = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(id)}`;
      const current = await json(await fetch(`${url}/metadata`));
      const deniedPublish = await json(await fetch(`${url}/publication`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': current.etag },
        body: JSON.stringify({ publicationStatus: 'published' }),
      }));
      assert.equal(deniedPublish.status, 403);
    }

    const movieUrl = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(movieId)}`;
    const current = await json(await fetch(`${movieUrl}/metadata`));
    const concurrent = await Promise.all([
      fetch(`${movieUrl}/approval`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': current.etag },
        body: JSON.stringify({ approvalStatus: 'approved' }),
      }),
      fetch(`${movieUrl}/approval`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': current.etag },
        body: JSON.stringify({ approvalStatus: 'rejected' }),
      }),
    ]);
    assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 412]);

    const seriesUrl = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(seriesId)}`;
    const seriesCurrent = await json(await fetch(`${seriesUrl}/metadata`));
    const approvedSeries = await json(await fetch(`${seriesUrl}/approval`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': seriesCurrent.etag },
      body: JSON.stringify({ approvalStatus: 'approved' }),
    }));
    assert.equal(approvedSeries.status, 200);
    assert.equal(approvedSeries.body.data.publicationStatus, 'draft');
  });

  await withServer(publisherApi, async (baseUrl) => {
    const movieUrl = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(movieId)}`;
    let current = await json(await fetch(`${movieUrl}/metadata`));
    if (current.body.data.approvalStatus !== 'approved') {
      const corrected = await withServer(approverApi, async (approverBase) => json(await fetch(
        `${approverBase}${ADMIN_PATH}/items/${encodeURIComponent(movieId)}/approval`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'if-match': current.etag },
          body: JSON.stringify({ approvalStatus: 'approved' }),
        },
      )));
      assert.equal(corrected.status, 200);
      current = await json(await fetch(`${movieUrl}/metadata`));
    }
    const publishedMovie = await json(await fetch(`${movieUrl}/publication`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': current.etag },
      body: JSON.stringify({ publicationStatus: 'published' }),
    }));
    assert.equal(publishedMovie.status, 200);

    const seriesUrl = `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(seriesId)}`;
    const seriesCurrent = await json(await fetch(`${seriesUrl}/metadata`));
    const publishedSeries = await json(await fetch(`${seriesUrl}/publication`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': seriesCurrent.etag },
      body: JSON.stringify({ publicationStatus: 'published' }),
    }));
    assert.equal(publishedSeries.status, 200);
  });

  await withServer(publicApi, async (baseUrl) => {
    const all = await json(await fetch(`${baseUrl}/api/v1/catalog/items`));
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.data.map(({ id }) => id).sort(), [movieId, seriesId].sort());
    assert.equal(JSON.stringify(all.body).includes('synthetic-private-file-id'), false);
    assert.equal(JSON.stringify(all.body).includes('synthetic-private-series-file-id'), false);
    for (const internalField of ['sourceRecord', 'telegramFileId', 'approvalStatus', 'publicationStatus', '_version']) {
      assert.equal(JSON.stringify(all.body).includes(internalField), false);
    }

    const movieCategory = await json(await fetch(`${baseUrl}/api/v1/catalog/items?category=iranian-movies`));
    assert.deepEqual(movieCategory.body.data.map(({ id }) => id), [movieId]);
    const seriesCategory = await json(await fetch(`${baseUrl}/api/v1/catalog/items?category=iranian-series`));
    assert.deepEqual(seriesCategory.body.data.map(({ id }) => id), [seriesId]);
    const categories = await json(await fetch(`${baseUrl}/api/v1/catalog/categories`));
    assert.deepEqual(categories.body.data.map(({ slug }) => slug).sort(), ['iranian-movies', 'iranian-series']);
    const taxonomies = await json(await fetch(`${baseUrl}/api/v1/catalog/taxonomies`));
    assert.deepEqual(taxonomies.body.data.country.map(({ id }) => id), ['IR']);
    assert.deepEqual(taxonomies.body.data.genre.map(({ id }) => id), ['drama']);
  });

  const auditEvents = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, event]) => event);
  assert.ok(auditEvents.some(({ operation, actorId }) => (
    operation === 'approval.approved' && actorId === 'verified-approver'
  )));
  assert.ok(auditEvents.some(({ operation, actorId }) => (
    operation === 'publication.published' && actorId === 'verified-publisher'
  )));
  assert.ok(auditEvents.every((event) => (
    !Object.hasOwn(event, 'telegramFileId') && !Object.hasOwn(event, 'token')
  )));
  assert.equal(firestore.networkCalls, 0);

  const failingAuditSink = { async appendInTransaction() { throw new Error('synthetic-private-audit-failure'); } };
  const failingWriter = createFirestoreWritableCatalogMetadataProvider({
    firestore,
    auditEventSink: failingAuditSink,
  });
  const failingApi = createAdmin(failingWriter, ['editor'], 'verified-editor');
  const failedId = createCatalogContentId('movie', 'audit-rollback-fixture');
  const auditCount = auditEvents.length;
  await withServer(failingApi, async (baseUrl) => {
    const result = await json(await fetch(
      `${baseUrl}${ADMIN_PATH}/items/${encodeURIComponent(failedId)}/metadata`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify(metadataBody()),
      },
    ));
    assert.equal(result.status, 500);
    assert.equal(JSON.stringify(result.body).includes('synthetic-private-audit-failure'), false);
  });
  assert.equal(await metadataProvider.getContentMetadata(failedId), null);
  assert.equal([...firestore.documents.keys()].filter((path) => path.startsWith('catalogAuditEvents/')).length, auditCount);
});
