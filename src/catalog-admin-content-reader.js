'use strict';

const { mapCatalogSheetRow } = require('./catalog-sheet-mapper');
const { isCanonicalContentId, validateCatalogContentMetadata } = require('./catalog-metadata-validation');

const SHEETS = Object.freeze(['سینمایی', 'سریال']);

function atStage(stage, operation) {
  return Promise.resolve().then(operation).catch((cause) => {
    const error = new Error('Catalog admin list stage failed.');
    error.name = 'CatalogAdminListStageError';
    error.dependency = stage.startsWith('sheet_') ? 'sheets' :
      stage.startsWith('metadata_') ? 'firestore' : 'catalog';
    error.stage = stage;
    error.errorCode = stage === 'metadata_read' ? 'METADATA_READ_FAILED' : 'CATALOG_STAGE_FAILED';
    error.cause = cause;
    throw error;
  });
}
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'unknown']);
const PUBLICATION_STATUSES = new Set(['draft', 'published', 'archived', 'unknown']);

class CatalogAdminListInputError extends Error {
  constructor() {
    super('Invalid catalog administration list query.');
    this.name = 'CatalogAdminListInputError';
  }
}

function validateSnapshot(sheetName, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.headers) || !Array.isArray(snapshot.rows) ||
      snapshot.headers.some((header) => typeof header !== 'string' || header.trim() === '') ||
      new Set(snapshot.headers).size !== snapshot.headers.length ||
      !snapshot.headers.includes('کد سیستم') || !snapshot.headers.includes('اسم فیلم') ||
      snapshot.rows.some((row) => !Array.isArray(row) || row.length > snapshot.headers.length)) {
    throw new TypeError(`Invalid catalog source snapshot: ${sheetName}`);
  }
}

function pageNumber(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new CatalogAdminListInputError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new CatalogAdminListInputError();
  }
  return parsed;
}

function parseQuery(query) {
  const allowed = new Set(['q', 'kind', 'approvalStatus', 'publicationStatus', 'page', 'pageSize']);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) {
    throw new CatalogAdminListInputError();
  }
  const q = query.get('q') ?? '';
  const kind = query.get('kind');
  const approvalStatus = query.get('approvalStatus');
  const publicationStatus = query.get('publicationStatus');
  if (q.length > 100 || (kind !== null && !['movie', 'series'].includes(kind)) ||
      (approvalStatus !== null && !APPROVAL_STATUSES.has(approvalStatus)) ||
      (publicationStatus !== null && !PUBLICATION_STATUSES.has(publicationStatus))) {
    throw new CatalogAdminListInputError();
  }
  return Object.freeze({
    q: q.trim().toLocaleLowerCase(),
    kind,
    approvalStatus,
    publicationStatus,
    page: pageNumber(query.get('page') ?? undefined, 1),
    pageSize: pageNumber(query.get('pageSize') ?? undefined, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX),
  });
}

function safeText(record, field, maxLength = 10000) {
  const value = record[field];
  if (typeof value !== 'string') return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function projectAdminItem(mapped, record, metadataRecord) {
  const content = mapped.content;
  const metadata = metadataRecord?.value ?? null;
  const dto = {
    id: content.id,
    kind: content.kind,
    systemCode: String(record['کد سیستم']).normalize('NFC').trim(),
    title: content.title,
    approvalStatus: metadata?.approvalStatus ?? 'unknown',
    publicationStatus: metadata?.publicationStatus ?? 'unknown',
    countryIds: metadata?.countryIds ? [...metadata.countryIds] : [],
    genreIds: metadata?.genreIds ? [...metadata.genreIds] : [],
    hasMetadata: Boolean(metadata),
  };
  if (Number.isInteger(content.releaseYear)) dto.releaseYear = content.releaseYear;
  if (content.kind === 'series') dto.seriesMetadata = { ...content.seriesMetadata };
  // These optional detail fields are returned only as plain text. URL-like values
  // and the Telegram File ID are deliberately excluded because their source
  // formats and display policies have not been confirmed.
  for (const [sourceField, targetField, maxLength] of [
    ['خلاصه داستان', 'synopsis', 10000],
    ['بازیگران', 'cast', 2000],
    ['زبان', 'language', 200],
    ['امتیاز', 'rating', 100],
  ]) {
    const value = safeText(record, sourceField, maxLength);
    if (value !== undefined) dto[targetField] = value;
  }
  return Object.freeze(dto);
}

function createCatalogAdminContentReader({ sheetProvider, writableProvider } = {}) {
  if (!sheetProvider || typeof sheetProvider.readSheet !== 'function' ||
      !writableProvider || typeof writableProvider.getContentMetadataWithVersion !== 'function') {
    throw new TypeError('Catalog admin content reader dependencies are incomplete.');
  }

  async function readAllItems() {
    const snapshots = await Promise.all(SHEETS.map((name) => atStage('sheet_read', () => sheetProvider.readSheet(name))));
    const seen = new Set();
    const sourceItems = [];
    snapshots.forEach((snapshot, sheetIndex) => {
      const sheetName = SHEETS[sheetIndex];
      atStage('sheet_snapshot_validation', () => validateSnapshot(sheetName, snapshot));
      snapshot.rows.forEach((row) => {
        const record = Object.fromEntries(snapshot.headers.map((header, index) => [header, row[index]]));
        const mapped = (() => { try { return mapCatalogSheetRow(sheetName, record); } catch (cause) { const error = new Error('Catalog sheet row mapping failed.'); error.name = 'CatalogAdminListStageError'; error.dependency = 'sheets'; error.stage = 'sheet_row_mapping'; error.errorCode = 'CATALOG_STAGE_FAILED'; error.cause = cause; throw error; } })();
        if (!isCanonicalContentId(mapped.content.id) || seen.has(mapped.content.id)) { const error = new Error('Catalog sheet identity validation failed.'); error.name = 'CatalogAdminListStageError'; error.dependency = 'catalog'; error.stage = 'sheet_identity_validation'; error.errorCode = 'CATALOG_STAGE_FAILED'; throw error; }
        seen.add(mapped.content.id);
        sourceItems.push({ mapped, record });
      });
    });

    const metadataById = typeof writableProvider.listContentMetadataWithVersion === 'function'
      ? await atStage('metadata_read', async () => new Map((await writableProvider.listContentMetadataWithVersion())
        .map((entry) => [entry.value.contentId, entry])))
      : null;

    return Promise.all(sourceItems.map(async ({ mapped, record }) => {
      const versioned = metadataById
        ? metadataById.get(mapped.content.id) ?? null
        : await writableProvider.getContentMetadataWithVersion(mapped.content.id);
      let metadataRecord = null;
      if (versioned) {
        try {
          metadataRecord = {
            value: validateCatalogContentMetadata(mapped.content.id, versioned.value),
            version: versioned.version,
          };
        } catch (cause) {
          const error = new Error('Catalog metadata validation failed.'); error.name = 'CatalogAdminListStageError'; error.dependency = 'firestore'; error.stage = 'metadata_validation'; error.errorCode = 'CATALOG_STAGE_FAILED'; error.cause = cause; throw error;
        }
      }
      return projectAdminItem(mapped, record, metadataRecord);
    }));
  }

  return Object.freeze({
    async list(query) {
      const parsed = parseQuery(query);
      const allItems = await readAllItems();
      const stats = {
        total: allItems.length,
        movies: allItems.filter((item) => item.kind === 'movie').length,
        series: allItems.filter((item) => item.kind === 'series').length,
        pending: allItems.filter((item) => item.approvalStatus === 'pending').length,
        approved: allItems.filter((item) => item.approvalStatus === 'approved').length,
        published: allItems.filter((item) => item.publicationStatus === 'published').length,
        draft: allItems.filter((item) => item.publicationStatus === 'draft').length,
        missingMetadata: allItems.filter((item) => !item.hasMetadata).length,
      };
      const filtered = allItems.filter((item) => {
        if (parsed.kind && item.kind !== parsed.kind) return false;
        if (parsed.approvalStatus && item.approvalStatus !== parsed.approvalStatus) return false;
        if (parsed.publicationStatus && item.publicationStatus !== parsed.publicationStatus) return false;
        if (!parsed.q) return true;
        return item.title.toLocaleLowerCase().includes(parsed.q) ||
          item.systemCode.toLocaleLowerCase().includes(parsed.q);
      });
      const start = (parsed.page - 1) * parsed.pageSize;
      if (!Number.isSafeInteger(start)) throw new CatalogAdminListInputError();
      return Object.freeze({
        data: filtered.slice(start, start + parsed.pageSize),
        meta: Object.freeze({
          page: parsed.page,
          pageSize: parsed.pageSize,
          total: filtered.length,
          stats: Object.freeze(stats),
        }),
      });
    },
  });
}

module.exports = { CatalogAdminListInputError, createCatalogAdminContentReader };
