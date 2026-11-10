'use strict';

const crypto = require('node:crypto');
const { mapCatalogSheetRow } = require('./catalog-sheet-mapper');
const { assertFilter, matchesFilter } = require('./catalog-core');
const { isCanonicalContentId, validateCatalogContentMetadata } = require('./catalog-metadata-validation');

const SHEETS = Object.freeze(['سینمایی', 'سریال']);

function atStage(stage, operation) {
  return Promise.resolve().then(operation).catch((cause) => {
    const error = new Error('Catalog admin list stage failed.');
    error.name = 'CatalogAdminListStageError';
    error.dependency = stage.startsWith('sheet_') ? 'sheets' :
      stage.startsWith('metadata_') ? 'firestore' : 'catalog';
    const preservesMetadataFailure = stage.startsWith('metadata_') &&
      cause?.dependency === 'firestore' &&
      typeof cause?.stage === 'string' && cause.stage.startsWith('metadata_') &&
      typeof cause?.errorCode === 'string';
    error.stage = preservesMetadataFailure ? cause.stage : stage;
    error.errorCode = preservesMetadataFailure
      ? cause.errorCode
      : (stage === 'metadata_read' ? 'METADATA_READ_FAILED' : 'CATALOG_STAGE_FAILED');
    if (preservesMetadataFailure && typeof cause.validationIssue === 'string') {
      error.validationIssue = cause.validationIssue;
    }
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
  const allowed = new Set(['q', 'kind', 'approvalStatus', 'publicationStatus', 'countryId', 'genreId', 'categoryId', 'page', 'pageSize']);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) {
    throw new CatalogAdminListInputError();
  }
  const q = query.get('q') ?? '';
  const kind = query.get('kind');
  const approvalStatus = query.get('approvalStatus');
  const publicationStatus = query.get('publicationStatus');
  const countryId = query.get('countryId');
  const genreId = query.get('genreId');
  const categoryId = query.get('categoryId');
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
    countryId,
    genreId,
    categoryId,
    page: pageNumber(query.get('page') ?? undefined, 1),
    pageSize: pageNumber(query.get('pageSize') ?? undefined, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX),
  });
}

function safeText(record, field, maxLength = 10000) {
  const value = record[field];
  if (typeof value !== 'string') return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function projectAdminItem(mapped, record, metadataRecord, sourceRowNumber) {
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
    directCategoryIds: metadata?.categoryIds ? [...metadata.categoryIds] : [],
    hasMetadata: Boolean(metadata),
    sourceSheet: mapped.sourceSheet,
    sourceRowNumber,
    sourceVersion: crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url'),
    sourceAvailableFields: Object.entries({ title: 'اسم فیلم', releaseYear: 'سال', startYear: 'سال شروع',
      endYear: 'سال پایان', seasonsAndEpisodes: 'تعداد فصل و قسمت', synopsis: 'خلاصه داستان',
      cast: 'بازیگران', language: 'زبان', rating: 'امتیاز', trailerUrl: 'لینک تریلر', posterUrl: 'پوستر فیلم' })
      .filter(([, header]) => Object.hasOwn(record, header)).map(([field]) => field),
  };
  if (Number.isInteger(content.releaseYear)) dto.releaseYear = content.releaseYear;
  if (content.kind === 'series') dto.seriesMetadata = { ...content.seriesMetadata };
  // Only a strict allowlist of editable, non-credential source columns is projected.
  for (const [sourceField, targetField, maxLength] of [
    ['خلاصه داستان', 'synopsis', 10000],
    ['بازیگران', 'cast', 2000],
    ['زبان', 'language', 200],
    ['امتیاز', 'rating', 100],
    ['لینک تریلر', 'trailerUrl', 2000],
    ['پوستر فیلم', 'posterUrl', 2000],
  ]) {
    const value = safeText(record, sourceField, maxLength);
    if (value !== undefined) dto[targetField] = value;
  }
  return Object.freeze(dto);
}

function createCatalogAdminContentReader({ sheetProvider, writableProvider, onInvalidSourceRow } = {}) {
  if (!sheetProvider || typeof sheetProvider.readSheet !== 'function' ||
      !writableProvider || typeof writableProvider.getContentMetadataWithVersion !== 'function') {
    throw new TypeError('Catalog admin content reader dependencies are incomplete.');
  }

  async function readAllItems() {
    const snapshots = await Promise.all(SHEETS.map((name) => atStage('sheet_read', () => sheetProvider.readSheet(name))));
    const seen = new Set();
    const sourceItems = [];
    const invalidSourceRows = [];
    snapshots.forEach((snapshot, sheetIndex) => {
      const sheetName = SHEETS[sheetIndex];
      try { validateSnapshot(sheetName, snapshot); } catch (cause) { const error = new Error('Catalog sheet snapshot validation failed.'); error.name = 'CatalogAdminListStageError'; error.dependency = 'sheets'; error.stage = 'sheet_snapshot_validation'; error.errorCode = 'CATALOG_STAGE_FAILED'; error.cause = cause; throw error; }
      snapshot.rows.forEach((row, rowIndex) => {
        const record = Object.fromEntries(snapshot.headers.map((header, index) => [header, row[index] ?? '']));
        const sourceRowNumber = rowIndex + 2;
        let mapped;
        try {
          mapped = mapCatalogSheetRow(sheetName, record);
        } catch (cause) {
          const message = typeof cause?.message === 'string' ? cause.message : '';
          const requiredFieldMatch = /^Missing or invalid required field: (.+)$/.exec(message);
          const yearFieldMatch = /^Invalid year field: (.+)$/.exec(message);
          const validationIssue = requiredFieldMatch
            ? 'required_field_invalid'
            : yearFieldMatch
              ? 'year_field_invalid'
              : message.includes('start year cannot be after end year')
                ? 'series_year_range_invalid'
                : 'row_mapping_invalid';
          const diagnostic = Object.freeze({
            sheetName,
            rowNumber: sourceRowNumber,
            stage: 'sheet_row_mapping',
            validationIssue,
            ...(requiredFieldMatch ? { fieldName: requiredFieldMatch[1] } : {}),
            ...(yearFieldMatch ? { fieldName: yearFieldMatch[1] } : {}),
          });
          invalidSourceRows.push(diagnostic);
          if (typeof onInvalidSourceRow === 'function') {
            try { onInvalidSourceRow(diagnostic); } catch { /* diagnostics must not break reads */ }
          }
          return;
        }
        if (!isCanonicalContentId(mapped.content.id) || seen.has(mapped.content.id)) { const error = new TypeError('Catalog sheet identity validation failed.'); error.name = 'CatalogAdminListStageError'; error.dependency = 'catalog'; error.stage = 'sheet_identity_validation'; error.errorCode = 'CATALOG_STAGE_FAILED'; throw error; }
        seen.add(mapped.content.id);
        sourceItems.push({ mapped, record, sourceRowNumber });
      });
    });

    const metadataById = typeof writableProvider.listContentMetadataWithVersion === 'function'
      ? await atStage('metadata_read', async () => new Map((await writableProvider.listContentMetadataWithVersion())
        .map((entry) => [entry.value.contentId, entry])))
      : null;

    const items = await Promise.all(sourceItems.map(async ({ mapped, record, sourceRowNumber }) => {
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
      return projectAdminItem(mapped, record, metadataRecord, sourceRowNumber);
    }));
    return { items, invalidSourceRows };
  }

  async function readSourceRecord(kind, systemCode) {
    const sheetName = kind === 'movie' ? 'سینمایی' : kind === 'series' ? 'سریال' : null;
    if (!sheetName) return null;
    const snapshot = await sheetProvider.readSheet(sheetName);
    validateSnapshot(sheetName, snapshot);
    const codeIndex = snapshot.headers.indexOf('کد سیستم');
    const matches = snapshot.rows.map((row, index) => ({ row, index }))
      .filter(({ row }) => String(row[codeIndex] ?? '').normalize('NFC').trim() === systemCode);
    if (matches.length !== 1) return null;
    const { row, index } = matches[0];
    const record = Object.fromEntries(snapshot.headers.map((header, column) => [header, row[column] ?? '']));
    return {
      sourceSheet: sheetName,
      sourceRowNumber: index + 2,
      sourceVersion: crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url'),
      headers: [...snapshot.headers],
      record,
    };
  }

  return Object.freeze({
    async getItem(contentId) {
      const { items } = await readAllItems();
      const item = items.find((candidate) => candidate.id === contentId);
      return item || null;
    },
    async getItemSource(contentId) {
      const { items } = await readAllItems();
      const item = items.find((candidate) => candidate.id === contentId);
      if (!item) return null;
      const source = await readSourceRecord(item.kind, item.systemCode);
      return source ? Object.freeze({ id: item.id, kind: item.kind, systemCode: item.systemCode, ...source }) : null;
    },
    async getSheetSchema(kind) {
      if (typeof sheetProvider.getSheetSchema !== 'function') throw new Error('Catalog sheet schema is unavailable.');
      const sheetName = kind === 'movie' ? 'سینمایی' : kind === 'series' ? 'سریال' : null;
      if (!sheetName) return null;
      return Object.freeze({ kind, sheetName, headers: await sheetProvider.getSheetSchema(sheetName) });
    },
    async createItemSource(kind, fields) {
      if (typeof sheetProvider.createCatalogRow !== 'function') throw new Error('Catalog source writer is not configured.');
      const schema = await this.getSheetSchema(kind);
      if (!schema) return null;
      const candidate = Object.fromEntries(schema.headers.map((header) => [header, fields[header] ?? '']));
      try { mapCatalogSheetRow(schema.sheetName, candidate); } catch {
        throw Object.assign(new Error('Invalid catalog source row.'), { code: 'INVALID_INPUT' });
      }
      const result = await sheetProvider.createCatalogRow({ sheetName: schema.sheetName, fields });
      const mapped = mapCatalogSheetRow(schema.sheetName, result.record);
      return Object.freeze({
        id: mapped.content.id, kind, systemCode: String(result.record['کد سیستم']).normalize('NFC').trim(),
        sourceSheet: schema.sheetName, sourceRowNumber: result.rowNumber,
        sourceVersion: result.sourceVersion, headers: schema.headers, record: result.record,
      });
    },
    async updateItemSource(contentId, { sourceVersion, fields, actorId } = {}) {
      if (typeof sheetProvider.updateCatalogRow !== 'function') throw new Error('Catalog source writer is not configured.');
      const { items } = await readAllItems();
      const item = items.find((candidate) => candidate.id === contentId);
      if (!item) return null;
      const current = await readSourceRecord(item.kind, item.systemCode);
      if (!current) return null;
      const record = { ...current.record };
      for (const [header, value] of Object.entries(fields)) record[header] = String(value);
      try { mapCatalogSheetRow(current.sourceSheet, record); } catch {
        throw Object.assign(new Error('Invalid catalog source row.'), { code: 'INVALID_INPUT' });
      }
      const result = await sheetProvider.updateCatalogRow({
        sheetName: current.sourceSheet, systemCode: item.systemCode,
        expectedVersion: sourceVersion, fields, actorId,
      });
      return Object.freeze({
        id: item.id, kind: item.kind, systemCode: item.systemCode,
        sourceSheet: current.sourceSheet, sourceRowNumber: result.rowNumber,
        sourceVersion: result.sourceVersion, headers: current.headers, record,
      });
    },
    async list(query) {
      const parsed = parseQuery(query);
      const { items: allItems, invalidSourceRows } = await readAllItems();
      const [categories, countries, genres] = await Promise.all([
        writableProvider.listCategories(),
        writableProvider.listTaxonomyTerms('country'),
        writableProvider.listTaxonomyTerms('genre'),
      ]);
      const enabledCategoryIds = new Set(categories.filter((entry) => entry.enabled).map((entry) => entry.id));
      const enabledCountryIds = new Set(countries.filter((entry) => entry.enabled).map((entry) => entry.id));
      const enabledGenreIds = new Set(genres.filter((entry) => entry.enabled).map((entry) => entry.id));
      if ((parsed.countryId && !enabledCountryIds.has(parsed.countryId)) ||
          (parsed.genreId && !enabledGenreIds.has(parsed.genreId)) ||
          (parsed.categoryId && !enabledCategoryIds.has(parsed.categoryId))) {
        throw new CatalogAdminListInputError();
      }
      const categoryById = new Map(categories.map((category) => [category.id, category]));
      for (const category of categories) {
        if (category.filters !== undefined && category.filters !== null) assertFilter(category.filters);
      }
      const categoryMatches = (item, category) => {
        const mode = category.mode || 'dynamic';
        const direct = item.directCategoryIds.includes(category.id);
        const dynamic = mode !== 'manual' && matchesFilter(item, category.filters);
        return (mode === 'manual' && direct) || (mode === 'dynamic' && dynamic) ||
          (mode === 'hybrid' && (direct || dynamic));
      };
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
        if (parsed.countryId && !item.countryIds.includes(parsed.countryId)) return false;
        if (parsed.genreId && !item.genreIds.includes(parsed.genreId)) return false;
        if (parsed.categoryId && !categoryMatches(item, categoryById.get(parsed.categoryId))) return false;
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
          invalidSourceRows: invalidSourceRows.length,
        }),
      });
    },
  });
}

module.exports = { CatalogAdminListInputError, createCatalogAdminContentReader };
