'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCatalogContentId } = require('../src/catalog-content-identity');
const { createFirestoreCatalogAuditEventSink } = require('../src/firestore-catalog-audit-event-sink');
const {
  createFirestoreWritableCatalogMetadataProvider,
} = require('../src/firestore-writable-catalog-metadata-provider');
const { CatalogConflictError, CatalogInputError } = require('../src/catalog-metadata-validation');

function copy(value) {
  return structuredClone(value);
}

class FakeFirestore {
  constructor() {
    this.documents = new Map();
    this.failReads = false;
    this.failWrites = false;
    this.externalCalls = 0;
    this.transactionQueue = Promise.resolve();
  }

  seed(path, value) {
    this.documents.set(path, copy(value));
  }

  collection(path) {
    return new FakeCollection(this, path);
  }

  async runTransaction(callback) {
    const previousTransaction = this.transactionQueue;
    let releaseTransaction;
    this.transactionQueue = new Promise((resolve) => { releaseTransaction = resolve; });
    await previousTransaction;
    try {
      const staged = [];
      const transaction = {
        get: async (reference) => {
          if (this.failReads) throw new Error('synthetic-private-read-error');
          if (reference instanceof FakeQuery) return reference.getSnapshot();
          return this.snapshotDocument(reference.path);
        },
        set: (reference, value) => {
          if (this.failWrites) throw new Error('synthetic-private-write-error');
          staged.push({ mode: 'set', path: reference.path, value: copy(value) });
        },
        create: (reference, value) => {
          if (this.failWrites) throw new Error('synthetic-private-write-error');
          staged.push({ mode: 'create', path: reference.path, value: copy(value) });
        },
        delete: (reference) => {
          if (this.failWrites) throw new Error('synthetic-private-write-error');
          staged.push({ mode: 'delete', path: reference.path });
        },
      };
      const result = await callback(transaction);
      if (staged.some(({ mode, path }) => mode === 'create' && this.documents.has(path))) {
        throw new Error('synthetic-private-create-conflict');
      }
      for (const write of staged) {
        if (write.mode === 'delete') this.documents.delete(write.path);
        else this.documents.set(write.path, write.value);
      }
      return result;
    } finally {
      releaseTransaction();
    }
  }

  snapshotDocument(path) {
    if (this.failReads) throw new Error('synthetic-private-read-error');
    const data = this.documents.get(path);
    return { exists: data !== undefined, data: () => copy(data) };
  }

  snapshotCollection(path, predicate = () => true) {
    if (this.failReads) throw new Error('synthetic-private-read-error');
    const prefix = `${path}/`;
    const expectedDepth = path.split('/').length + 1;
    const docs = [...this.documents.entries()]
      .filter(([documentPath, value]) => (
        documentPath.startsWith(prefix) && documentPath.split('/').length === expectedDepth && predicate(value)
      ))
      .map(([documentPath, value]) => ({
        id: documentPath.slice(prefix.length),
        data: () => copy(value),
      }));
    return { docs };
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
    this.firestore = firestore;
    this.path = path;
    this.field = field;
    this.operator = operator;
    this.value = value;
  }

  async getSnapshot() {
    if (this.operator !== '==' && this.operator !== 'array-contains') throw new Error('unsupported mock query');
    return this.firestore.snapshotCollection(this.path, (record) => (
      this.operator === '=='
        ? record[this.field] === this.value
        : Array.isArray(record[this.field]) && record[this.field].includes(this.value)
    ));
  }

  async get() {
    return this.getSnapshot();
  }
}

function setup({ sink, clock } = {}) {
  const firestore = new FakeFirestore();
  firestore.seed('catalogTaxonomies/country/terms/IR', {
    id: 'IR', labelFa: 'ایران', enabled: true, _version: 1,
  });
  firestore.seed('catalogTaxonomies/country/terms/US', {
    id: 'US', labelFa: 'آمریکا', enabled: true, _version: 1,
  });
  firestore.seed('catalogTaxonomies/genre/terms/drama', {
    id: 'drama', labelFa: 'درام', enabled: true, _version: 1,
  });
  const auditEventSink = sink || createFirestoreCatalogAuditEventSink({ firestore });
  const provider = createFirestoreWritableCatalogMetadataProvider({
    firestore,
    auditEventSink,
    ...(clock ? { clock } : {}),
  });
  return { firestore, provider };
}

const contentId = createCatalogContentId('movie', 'writable-fixture-1');
const metadata = {
  approvalStatus: 'approved',
  publicationStatus: 'draft',
  countryIds: ['IR'],
  genreIds: ['drama'],
};

test('creates and retrieves versioned metadata, with atomic audit records and safe projection', async () => {
  const { firestore, provider } = setup({ clock: () => new Date('2026-10-25T00:00:00.000Z') });
  const created = await provider.upsertContentMetadata(contentId, metadata, {
    expectedVersion: 0,
    actorId: 'admin-test-1',
  });
  assert.deepEqual(created, { value: { contentId, ...metadata }, version: 1 });

  const firstRead = await provider.getContentMetadataWithVersion(contentId);
  assert.deepEqual(firstRead, { value: { contentId, ...metadata }, version: 1 });
  assert.deepEqual(await provider.getContentMetadata(contentId), { contentId, ...metadata });
  assert.equal('_version' in (await provider.getContentMetadata(contentId)), false);

  const changed = await provider.upsertContentMetadata(contentId, {
    ...metadata,
    countryIds: ['US'],
  }, { expectedVersion: 1, actorId: 'admin-test-1' });
  assert.deepEqual(changed.value.countryIds, ['US']);
  assert.equal(changed.version, 2);
  assert.equal((await provider.getContentMetadataWithVersion(contentId)).version, 2);

  await assert.rejects(
    provider.upsertContentMetadata(contentId, metadata, { expectedVersion: 1 }),
    (error) => error instanceof CatalogConflictError,
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, { ...metadata, countryIds: ['IR'] }, { expectedVersion: 0 }),
    (error) => error instanceof CatalogConflictError,
  );
  assert.deepEqual((await provider.getContentMetadata(contentId)).countryIds, ['US']);
  const auditEvents = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, event]) => event);
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[0].operation, 'metadata.created');
  assert.deepEqual(auditEvents[1].changedFields, ['countryIds']);
  assert.equal(auditEvents[1].outcome, 'committed');
  assert.equal(auditEvents[0].actorId, 'admin-test-1');
  assert.equal(Object.hasOwn(auditEvents[0], 'countryIds'), false);
  assert.equal(JSON.stringify(auditEvents).includes('Telegram'), false);
});

test('lists versioned metadata for the authenticated admin catalog reader', async () => {
  const { provider } = setup();
  await provider.upsertContentMetadata(contentId, metadata, { expectedVersion: 0 });
  const listed = await provider.listContentMetadataWithVersion();
  assert.deepEqual(listed, [{ value: { contentId, ...metadata }, version: 1 }]);
  assert.equal(JSON.stringify(listed).includes('_version'), false);
});

test('moves content metadata transactionally when the system code identity changes', async () => {
  const { firestore, provider } = setup();
  const nextId = createCatalogContentId('movie', 'writable-fixture-renamed');
  await provider.upsertContentMetadata(contentId, {
    ...metadata, approvalStatus: 'approved', publicationStatus: 'draft',
  }, { expectedVersion: 0, actorId: 'admin-test-1' });
  const moved = await provider.moveContentMetadata(contentId, nextId, { actorId: 'admin-test-1' });
  assert.equal(moved.value.contentId, nextId);
  assert.equal(moved.value.approvalStatus, 'approved');
  assert.deepEqual(moved.value.countryIds, ['IR']);
  assert.equal(await provider.getContentMetadataWithVersion(contentId), null);
  assert.deepEqual((await provider.getContentMetadataWithVersion(nextId)).value, moved.value);
  const events = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, event]) => event);
  assert.equal(events.at(-1).operation, 'metadata.updated');
  assert.deepEqual(events.at(-1).changedFields, ['contentId']);
});

test('metadata collection read failures expose only safe Firestore classification', async () => {
  const { firestore, provider } = setup();
  firestore.failReads = true;
  await assert.rejects(
    provider.listContentMetadataWithVersion(),
    (error) => error.dependency === 'firestore' &&
      error.stage === 'metadata_read' &&
      error.errorCode === 'FIRESTORE_UNKNOWN' &&
      error.message === 'Unable to read catalog metadata.' &&
      !error.message.includes('synthetic-private-read-error'),
  );
});

test('invalid stored metadata documents are classified separately from Firestore read failures', async () => {
  const { firestore, provider } = setup();
  firestore.seed(`catalogContentMetadata/${contentId}`, {
    contentId,
    approvalStatus: 'approved',
    publicationStatus: 'draft',
    // Deliberately omit the required internal version.
  });
  await assert.rejects(
    provider.listContentMetadataWithVersion(),
    (error) => error.dependency === 'firestore' &&
      error.stage === 'metadata_validation' &&
      error.errorCode === 'FIRESTORE_DATA_VALIDATION',
  );
});

test('content disable and restore are versioned and audited transactionally', async () => {
  const { firestore, provider } = setup({
    clock: () => new Date('2026-11-10T12:00:00.000Z'),
  });
  const disabled = await provider.updateContentLifecycleStatus(contentId, 'disabled', {
    expectedVersion: 0,
    actorId: 'admin-test-1',
  });
  assert.equal(disabled.version, 1);
  assert.equal(disabled.value.lifecycleStatus, 'disabled');
  assert.equal(disabled.value.disabledAt, '2026-11-10T12:00:00.000Z');
  assert.equal(disabled.value.disabledBy, 'admin-test-1');

  const restored = await provider.updateContentLifecycleStatus(contentId, 'active', {
    expectedVersion: 1,
    actorId: 'admin-test-1',
  });
  assert.equal(restored.version, 2);
  assert.equal(restored.value.lifecycleStatus, 'active');
  assert.equal(Object.hasOwn(restored.value, 'disabledAt'), false);
  assert.equal(Object.hasOwn(restored.value, 'disabledBy'), false);

  const events = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, event]) => event);
  assert.deepEqual(events.map((event) => event.operation), ['content.disabled', 'content.restored']);
  assert.deepEqual(events.map((event) => event.changedFields), [
    ['lifecycleStatus', 'disabledAt', 'disabledBy'],
    ['lifecycleStatus', 'disabledAt', 'disabledBy'],
  ]);
  assert.deepEqual(events.map((event) => event.actorId), ['admin-test-1', 'admin-test-1']);
});

test('permanent metadata deletion removes the record but retains the content audit event', async () => {
  const { firestore, provider } = setup();
  await provider.upsertContentMetadata(contentId, metadata, {
    expectedVersion: 0,
    actorId: 'admin-test-1',
  });
  await provider.updateContentLifecycleStatus(contentId, 'disabled', {
    expectedVersion: 1,
    actorId: 'admin-test-1',
  });

  const deleted = await provider.deleteContentMetadata(contentId, {
    expectedVersion: 2,
    actorId: 'admin-test-1',
  });
  assert.equal(deleted.version, 3);
  assert.equal(deleted.value.lifecycleStatus, 'disabled');
  assert.equal(await provider.getContentMetadata(contentId), null);
  const events = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, value]) => value);
  assert.equal(events.at(-1).operation, 'content.deleted');
  assert.deepEqual(events.at(-1).changedFields, ['deleted']);
  assert.equal(events.at(-1).actorId, 'admin-test-1');
});

test('approval and publication remain independent and publication requires approval', async () => {
  const { firestore, provider } = setup();
  const pending = { ...metadata, approvalStatus: 'pending' };
  await provider.upsertContentMetadata(contentId, pending, { expectedVersion: 0 });
  await assert.rejects(
    provider.updatePublicationStatus(contentId, 'published', { expectedVersion: 1 }),
    (error) => error instanceof CatalogConflictError,
  );
  assert.equal((await provider.getContentMetadataWithVersion(contentId)).version, 1);

  await provider.updateApprovalStatus(contentId, 'approved', { expectedVersion: 1 });
  const approved = await provider.getContentMetadataWithVersion(contentId);
  assert.equal(approved.value.approvalStatus, 'approved');
  assert.equal(approved.value.publicationStatus, 'draft');
  assert.equal(approved.version, 2);
  await provider.updatePublicationStatus(contentId, 'published', { expectedVersion: 2 });
  let published = await provider.getContentMetadataWithVersion(contentId);
  assert.equal(published.value.approvalStatus, 'approved');
  assert.equal(published.value.publicationStatus, 'published');
  assert.equal(published.version, 3);
  await provider.updateApprovalStatus(contentId, 'rejected', { expectedVersion: 3 });
  published = await provider.getContentMetadataWithVersion(contentId);
  assert.equal(published.value.approvalStatus, 'rejected');
  assert.equal(published.value.publicationStatus, 'published');
  assert.equal(published.version, 4);
  const operations = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, event]) => event.operation);
  assert.deepEqual(operations, [
    'metadata.created', 'approval.approved', 'publication.published', 'approval.rejected',
  ]);
});

test('two Firestore updates with one expected version cannot both commit', async () => {
  const { provider, firestore } = setup();
  await provider.upsertContentMetadata(contentId, {
    ...metadata,
    approvalStatus: 'pending',
  }, { expectedVersion: 0 });

  const results = await Promise.allSettled([
    provider.updateApprovalStatus(contentId, 'approved', { expectedVersion: 1 }),
    provider.updateApprovalStatus(contentId, 'rejected', { expectedVersion: 1 }),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.equal(rejected.reason instanceof CatalogConflictError, true);
  assert.equal((await provider.getContentMetadataWithVersion(contentId)).version, 2);
  assert.equal([...firestore.documents.keys()].filter((path) => path.startsWith('catalogAuditEvents/')).length, 2);
});

test('creates and edits categories and taxonomy terms with version checks', async () => {
  const { firestore, provider } = setup();
  const category = {
    slug: 'iranian-movies',
    localizedTitle: { fa: 'فیلم ایرانی' },
    filters: { field: 'kind', op: 'eq', value: 'movie' },
    enabled: true,
    sortOrder: 1,
  };
  await provider.upsertCategory('iranian-movies', category, { expectedVersion: 0 });
  assert.equal((await provider.getCategoryWithVersion('iranian-movies')).version, 1);
  await provider.upsertCategory('iranian-movies', { ...category, sortOrder: 2 }, { expectedVersion: 1 });
  assert.equal((await provider.getCategoryWithVersion('iranian-movies')).value.sortOrder, 2);
  await assert.rejects(
    provider.upsertCategory('iranian-movies', category, { expectedVersion: 1 }),
    (error) => error instanceof CatalogConflictError,
  );

  await provider.upsertTaxonomyTerm('country', 'CA', {
    labelFa: 'کانادا', enabled: true,
  }, { expectedVersion: 0 });
  await provider.upsertTaxonomyTerm('country', 'CA', {
    labelFa: 'کانادا', enabled: false,
  }, { expectedVersion: 1 });
  assert.equal((await provider.getTaxonomyTermWithVersion('country', 'CA')).value.enabled, false);
  assert.equal((await provider.listTaxonomyTerms('country')).some(({ id }) => id === 'CA'), false);
  assert.equal((await provider.listAllTaxonomyTerms('country')).some(({ id }) => id === 'CA'), true);
  const operations = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, event]) => event.operation);
  assert.deepEqual(operations, [
    'category.created', 'category.updated', 'taxonomy.created', 'taxonomy.updated',
  ]);
});

test('hard deletes unused categories and taxonomy terms with transactional audit events', async () => {
  const { firestore, provider } = setup();
  await provider.upsertCategory('unused-category', {
    slug: 'unused-category', localizedTitle: { fa: 'دستهٔ بدون استفاده' }, enabled: true,
  }, { expectedVersion: 0, actorId: 'owner-test' });
  const deletedCategory = await provider.deleteCategory('unused-category', {
    expectedVersion: 1, actorId: 'owner-test',
  });
  assert.equal(deletedCategory.version, 2);
  assert.equal(await provider.getCategoryWithVersion('unused-category'), null);

  await provider.upsertTaxonomyTerm('genre', 'unused-genre', {
    labelFa: 'ژانر بدون استفاده', enabled: true,
  }, { expectedVersion: 0, actorId: 'owner-test' });
  const deletedGenre = await provider.deleteTaxonomyTerm('genre', 'unused-genre', {
    expectedVersion: 1, actorId: 'owner-test',
  });
  assert.equal(deletedGenre.version, 2);
  assert.equal(await provider.getTaxonomyTermWithVersion('genre', 'unused-genre'), null);

  const events = [...firestore.documents.entries()]
    .filter(([path]) => path.startsWith('catalogAuditEvents/'))
    .map(([, event]) => event);
  assert.deepEqual(events.slice(-3).map((event) => event.operation), ['category.deleted', 'taxonomy.created', 'taxonomy.deleted']);
  assert.deepEqual(events.slice(-2).map((event) => event.actorId), ['owner-test', 'owner-test']);
});

test('refuses hard deletion when a category or taxonomy term is referenced', async () => {
  const { provider } = setup();
  const category = { slug: 'used-category', localizedTitle: { fa: 'دستهٔ استفاده‌شده' }, enabled: true };
  await provider.upsertCategory('used-category', category, { expectedVersion: 0 });
  await provider.upsertContentMetadata(contentId, { ...metadata, categoryIds: ['used-category'] }, { expectedVersion: 0 });
  await assert.rejects(provider.deleteCategory('used-category', { expectedVersion: 1 }),
    (error) => error instanceof CatalogConflictError && error.code === 'CATEGORY_IN_USE');

  await assert.rejects(provider.deleteTaxonomyTerm('country', 'IR', { expectedVersion: 1 }),
    (error) => error instanceof CatalogConflictError && error.code === 'TAXONOMY_TERM_IN_USE');
});

test('rejects duplicate category slugs and disabling taxonomy used by content', async () => {
  const { provider } = setup();
  const category = {
    slug: 'catalog-featured',
    localizedTitle: { fa: 'منتخب' },
    enabled: true,
  };
  await provider.upsertCategory('featured', category, { expectedVersion: 0 });
  await assert.rejects(
    provider.upsertCategory('also-featured', category, { expectedVersion: 0 }),
    (error) => error instanceof CatalogConflictError,
  );

  await provider.upsertContentMetadata(contentId, metadata, { expectedVersion: 0 });
  await assert.rejects(
    provider.upsertTaxonomyTerm('country', 'IR', {
      labelFa: 'ایران', enabled: false,
    }, { expectedVersion: 1 }),
    (error) => error instanceof CatalogConflictError,
  );
  assert.equal((await provider.getTaxonomyTermWithVersion('country', 'IR')).value.enabled, true);
});

test('validates direct category membership, preserves omitted assignments, and blocks in-use disable', async () => {
  const { provider } = setup();
  const category = { slug: 'manual-only', localizedTitle: { fa: 'دستی' }, enabled: true, mode: 'manual' };
  await provider.upsertCategory('manual-only', category, { expectedVersion: 0 });
  await provider.upsertContentMetadata(contentId, { ...metadata, categoryIds: ['manual-only'] }, { expectedVersion: 0 });
  await provider.upsertContentMetadata(contentId, { ...metadata, publicationStatus: 'draft' }, { expectedVersion: 1 });
  assert.deepEqual((await provider.getContentMetadata(contentId)).categoryIds, ['manual-only']);
  await provider.upsertContentMetadata(contentId, { ...metadata, categoryIds: [] }, { expectedVersion: 2 });
  assert.deepEqual((await provider.getContentMetadata(contentId)).categoryIds, []);
  await assert.rejects(
    provider.upsertContentMetadata(contentId, { ...metadata, categoryIds: ['missing'] }, { expectedVersion: 3 }),
    (error) => error instanceof CatalogConflictError && error.code === 'CATEGORY_REFERENCE_INVALID',
  );
  await provider.upsertContentMetadata(contentId, { ...metadata, categoryIds: ['manual-only'] }, { expectedVersion: 3 });
  await assert.rejects(
    provider.upsertCategory('manual-only', { ...category, enabled: false }, { expectedVersion: 1 }),
    (error) => error instanceof CatalogConflictError && error.code === 'CATEGORY_IN_USE',
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, { ...metadata, categoryIds: Array.from({ length: 21 }, (_, i) => `c${i}`) }, { expectedVersion: 4 }),
    (error) => error instanceof CatalogInputError && error.code === 'TOO_MANY_CATEGORIES',
  );
});

test('rejects stale writes, missing versions, invalid data and invalid status combinations', async () => {
  const { provider } = setup();
  await assert.rejects(
    provider.upsertContentMetadata(contentId, metadata),
    (error) => error instanceof CatalogInputError,
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, { ...metadata, extra: 'value' }, { expectedVersion: 0 }),
    (error) => error instanceof CatalogInputError,
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, {
      approvalStatus: 'approved',
    }, { expectedVersion: 0 }),
    (error) => error instanceof CatalogInputError,
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, {
      ...metadata, publicationStatus: 'public',
    }, { expectedVersion: 0 }),
    (error) => error instanceof CatalogInputError,
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, {
      ...metadata, approvalStatus: 'pending', publicationStatus: 'published',
    }, { expectedVersion: 0 }),
    (error) => error instanceof CatalogConflictError,
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, { ...metadata, publicationStatus: 'unknown' }, { expectedVersion: -1 }),
    (error) => error instanceof CatalogInputError,
  );
  await assert.rejects(
    provider.upsertContentMetadata(contentId, {
      ...metadata, approvalStatus: 'pending', publicationStatus: 'published',
    }, { expectedVersion: 0 }),
    (error) => error instanceof CatalogConflictError,
  );
});

test('stores unknown states as non-public metadata without inferring publication', async () => {
  const { provider } = setup();
  const value = {
    approvalStatus: 'unknown',
    publicationStatus: 'unknown',
    countryIds: [],
    genreIds: [],
  };
  await provider.upsertContentMetadata(contentId, value, { expectedVersion: 0 });
  assert.deepEqual(await provider.getContentMetadata(contentId), { contentId, ...value });
});

test('storage and audit errors are sanitized and failed audit rolls back the mutation', async () => {
  const { firestore, provider } = setup({
    sink: {
      async appendInTransaction() {
        throw new Error('synthetic-private-audit-error');
      },
    },
  });
  await assert.rejects(
    provider.upsertContentMetadata(contentId, metadata, { expectedVersion: 0 }),
    (error) => error.message === 'Unable to access catalog metadata storage.' &&
      !error.message.includes('synthetic-private-audit-error'),
  );
  assert.equal(firestore.documents.has(`catalogContentMetadata/${contentId}`), false);

  firestore.failReads = true;
  await assert.rejects(
    provider.getContentMetadata(contentId),
    (error) => error.message === 'Unable to access catalog metadata storage.' &&
      !error.message.includes('synthetic-private-read-error'),
  );
  firestore.failReads = false;
  firestore.failWrites = true;
  await assert.rejects(
    provider.upsertContentMetadata(contentId, metadata, { expectedVersion: 0 }),
    (error) => error.message === 'Unable to access catalog metadata storage.' &&
      !error.message.includes('synthetic-private-write-error'),
  );
  assert.equal([...firestore.documents.keys()].some((path) => path.startsWith('catalogAuditEvents/')), false);
});

test('Firestore audit sink validates allowlisted events and uses the caller transaction', async () => {
  const firestore = new FakeFirestore();
  const sink = createFirestoreCatalogAuditEventSink({ firestore });
  const event = {
    eventId: '123e4567-e89b-42d3-a456-426614174000',
    operation: 'approval.approved',
    entityType: 'content',
    entityId: contentId,
    occurredAt: '2026-10-25T00:00:00.000Z',
    outcome: 'committed',
    previousVersion: 1,
    version: 2,
    changedFields: ['approvalStatus'],
  };
  await firestore.runTransaction(async (transaction) => sink.appendInTransaction(transaction, event));
  assert.deepEqual(firestore.documents.get(`catalogAuditEvents/${event.eventId}`), event);
  await assert.rejects(
    sink.appendInTransaction({ create() {} }, { ...event, token: 'synthetic-private-token' }),
    /Invalid catalog audit event/,
  );
  assert.equal(firestore.externalCalls, 0);
});
