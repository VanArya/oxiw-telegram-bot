'use strict';

const crypto = require('node:crypto');
const { mapCatalogSheetRow } = require('./catalog-sheet-mapper');
const { assertFilter, matchesFilter } = require('./catalog-core');
const { isCanonicalContentId, validateCatalogContentMetadata } = require('./catalog-metadata-validation');
const { createCatalogContentId } = require('./catalog-content-identity');
const { isSeriesEpisodeRecord } = require('./series-episode-record');
const { createSeriesEpisodeSheetReader } = require('./series-episode-sheet-reader');
const { PRODUCER_COUNTRIES, isProducerCountry } = require('./catalog-producer-country');

const SHEETS = Object.freeze(['سینمایی', 'سریال']);
function hasSourceValue(value) {
  return (typeof value === 'string' && value.trim() !== '') ||
    (typeof value === 'number' && Number.isFinite(value));
}

function isCompletelyBlankSourceRow(record) {
  return !Object.values(record).some(hasSourceValue);
}

const CODE_HEADER = (sheetName, headers = [], record = null) => {
  if (sheetName !== 'سریال') return 'کد سیستم';
  if (record && hasSourceValue(record['کد سریال'])) return 'کد سریال';
  if (record && hasSourceValue(record['کد سیستم'])) return 'کد سیستم';
  return headers.includes('کد سریال') ? 'کد سریال' : 'کد سیستم';
};

const DIAGNOSTIC_CODE_FIELDS = Object.freeze([
  'کد سریال', 'کد سیستم', 'کد قسمت', 'کد سریال مادر',
]);
const DIAGNOSTIC_CONTENT_FIELDS = Object.freeze([
  'اسم فیلم', 'نوع', 'سال', 'سال شروع', 'سال پایان', 'تعداد فصل و قسمت',
]);

function safeDiagnosticCodeCandidates(record) {
  return Object.fromEntries(DIAGNOSTIC_CODE_FIELDS.flatMap((field) => {
    const value = record[field];
    if (!hasSourceValue(value)) return [];
    return [[field, String(value).normalize('NFC').trim().slice(0, 80)]];
  }));
}

function splitSourceMultiValue(value) {
  return [...new Set(String(value ?? '').normalize('NFC').split(/[،,;؛|\n]+/).map((part) => part.trim()).filter(Boolean))];
}

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
      snapshot.headers.some((header) => typeof header !== 'string') ||
      snapshot.rows.some((row) => !Array.isArray(row))) {
    throw new TypeError(`Invalid catalog source snapshot: ${sheetName}`);
  }

  // Normalize labels before validation so harmless whitespace and Unicode
  // normalization differences do not make a healthy sheet unreadable.
  const headers = snapshot.headers.map((header) => header.normalize('NFC').trim());
  const hasCodeHeader = sheetName === 'سریال'
    ? headers.includes('کد سریال') || headers.includes('کد سیستم')
    : headers.includes('کد سیستم');
  if (!hasCodeHeader || !headers.includes('اسم فیلم')) {
    const requiredCodeHeader = sheetName === 'سریال' ? 'کد سریال' : 'کد سیستم';
    throw new TypeError(`Invalid catalog source headers in ${sheetName}: expected ${requiredCodeHeader} and اسم فیلم.`);
  }

  return { ...snapshot, headers };
}

function rowToRecord(headers, row) {
  const record = {};
  headers.forEach((header, index) => {
    if (!header) return;
    const value = row[index] ?? '';
    // Duplicate headings are tolerated when they are blank aliases or repeated
    // columns; retain the first non-empty value for deterministic projection.
    if (!Object.hasOwn(record, header) || record[header] === '') {
      record[header] = value;
    }
  });
  return record;
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
    systemCode: String(record[CODE_HEADER(mapped.sourceSheet, Object.keys(record), record)]).normalize('NFC').trim(),
    title: content.title,
    approvalStatus: metadata?.approvalStatus ?? 'unknown',
    publicationStatus: metadata?.publicationStatus ?? 'unknown',
    countryIds: Object.hasOwn(record, 'سازنده')
      ? [...(content.countryIds || [])]
      : (metadata?.countryIds ? [...metadata.countryIds] : []),
    ...(content.producerCountry ? { producerCountry: content.producerCountry } : {}),
    genreIds: metadata?.genreIds ? [...metadata.genreIds] : [],
    directCategoryIds: metadata?.categoryIds ? [...metadata.categoryIds] : [],
    hasMetadata: Boolean(metadata),
    sourceSheet: mapped.sourceSheet,
    sourceRowNumber,
    sourceVersion: crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url'),
    sourceAvailableFields: Object.entries({ title: 'اسم فیلم', releaseYear: 'سال', startYear: 'سال شروع',
      endYear: 'سال پایان', seasonsAndEpisodes: 'تعداد فصل و قسمت', producerCountry: 'سازنده', synopsis: 'خلاصه داستان',
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

  const seriesEpisodeReader = createSeriesEpisodeSheetReader({ sheetProvider });

  async function readAllItems() {
    const snapshots = await Promise.all(SHEETS.map((name) => atStage('sheet_read', () => sheetProvider.readSheet(name))));
    const seen = new Set();
    const sourceItems = [];
    const invalidSourceRows = [];
    snapshots.forEach((sourceSnapshot, sheetIndex) => {
      const sheetName = SHEETS[sheetIndex];
      let snapshot;
      try { snapshot = validateSnapshot(sheetName, sourceSnapshot); } catch (cause) { const error = new Error('Catalog sheet snapshot validation failed.'); error.name = 'CatalogAdminListStageError'; error.dependency = 'sheets'; error.stage = 'sheet_snapshot_validation'; error.errorCode = 'CATALOG_STAGE_FAILED'; error.cause = cause; throw error; }
      snapshot.rows.forEach((row, rowIndex) => {
        const record = rowToRecord(snapshot.headers, row);
        // Intentionally unused sheet rows are not invalid catalog entries.
        if (isCompletelyBlankSourceRow(record)) return;
        // Episode rows are linked children, never standalone admin catalog titles.
        if (sheetName === 'سریال' && isSeriesEpisodeRecord(record)) return;
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

  async function readFieldOptions() {
    const options = {
      'نوع': ['سینمایی', 'سریال'],
      'سازنده': PRODUCER_COUNTRIES.map(({ labelFa }) => labelFa),
    };
    for (const sheetName of ['سینمایی', 'سریال']) {
      const snapshot = validateSnapshot(sheetName, await sheetProvider.readSheet(sheetName));
      for (const header of ['ژانر', 'زبان', 'پیشنهادی']) {
        const columnIndex = snapshot.headers.indexOf(header);
        if (columnIndex < 0) continue;
        const values = snapshot.rows.flatMap((row) => splitSourceMultiValue(row[columnIndex]));
        options[header] = [...new Set([...(options[header] || []), ...values])]
          .sort((left, right) => left.localeCompare(right, 'fa'));
      }
    }
    return Object.freeze(options);
  }

  async function readSourceRecord(kind, systemCode) {
    const sheetName = kind === 'movie' ? 'سینمایی' : kind === 'series' ? 'سریال' : null;
    if (!sheetName) return null;
    const snapshot = validateSnapshot(sheetName, await sheetProvider.readSheet(sheetName));
    const matches = snapshot.rows.map((row, index) => ({
      row, index, record: rowToRecord(snapshot.headers, row),
    })).filter(({ record }) => {
      if (sheetName === 'سریال' && isSeriesEpisodeRecord(record)) return false;
      const codeHeader = CODE_HEADER(sheetName, snapshot.headers, record);
      return String(record[codeHeader] ?? '').normalize('NFC').trim() === systemCode;
    });
    if (matches.length !== 1) return null;
    const { row, index, record } = matches[0];
    return {
      sourceSheet: sheetName,
      sourceRowNumber: index + 2,
      sourceVersion: crypto.createHash('sha256').update(JSON.stringify(record)).digest('base64url'),
      headers: [...snapshot.headers],
      fieldOptions: await readFieldOptions(),
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
      return Object.freeze({
        kind, sheetName, headers: await sheetProvider.getSheetSchema(sheetName),
        fieldOptions: await readFieldOptions(),
      });
    },
    async listSeriesEpisodes() {
      return seriesEpisodeReader.listAllEpisodes();
    },
    async listSeriesSeasons() {
      const result = await seriesEpisodeReader.listAllEpisodes();
      const grouped = new Map();
      for (const episode of result.episodes) {
        const season = Number(episode.season);
        if (!Number.isInteger(season) || season < 1 || season > 99) continue;
        const key = `${episode.seriesCode}:${season}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            seriesCode: episode.seriesCode,
            seriesTitle: episode.seriesTitle,
            season,
            episodes: [],
          });
        }
        grouped.get(key).episodes.push(episode);
      }
      const seasons = [...grouped.values()].map((group) => {
        const episodes = group.episodes.sort((a, b) => a.episode - b.episode);
        const fingerprint = episodes.map(({ episodeCode, sourceVersion }) => ({
          episodeCode, sourceVersion,
        })).sort((a, b) => a.episodeCode.localeCompare(b.episodeCode));
        return Object.freeze({
          seriesCode: group.seriesCode,
          seriesTitle: group.seriesTitle,
          season: group.season,
          episodeCount: episodes.length,
          firstEpisode: episodes[0].episode,
          lastEpisode: episodes[episodes.length - 1].episode,
          sourceVersion: crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('base64url'),
        });
      }).sort((a, b) =>
        a.seriesCode.localeCompare(b.seriesCode) || a.season - b.season);
      return Object.freeze({
        seasons: Object.freeze(seasons),
        invalidRows: Object.freeze(result.invalidRows),
      });
    },
    async deleteSeriesSeason(seriesCode, season, { sourceVersion } = {}) {
      if (typeof sheetProvider.deleteSeriesSeasonRows !== 'function') {
        throw new Error('Series season deletion is not configured.');
      }
      return sheetProvider.deleteSeriesSeasonRows({
        seriesCode, season, expectedVersion: sourceVersion,
      });
    },
    async getSeriesEpisode(episodeCode) {
      return seriesEpisodeReader.getEpisode(episodeCode);
    },
    async updateSeriesEpisode(episodeCode, { sourceVersion, title, country, telegramFileId } = {}) {
      if (typeof sheetProvider.updateSeriesEpisodeRow !== 'function') {
        throw new Error('Series episode updater is not configured.');
      }
      const current = await seriesEpisodeReader.getEpisode(episodeCode);
      if (!current) return null;
      if (current.sourceVersion !== sourceVersion) {
        throw Object.assign(new Error('Episode row changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }
      const fields = {
        'اسم فیلم': title,
        'سازنده': country,
        [current.fileHeader]: telegramFileId,
      };
      await sheetProvider.updateSeriesEpisodeRow({ episodeCode, expectedVersion: sourceVersion, fields });
      return seriesEpisodeReader.getEpisode(episodeCode);
    },
    async deleteSeriesEpisode(episodeCode, { sourceVersion } = {}) {
      if (typeof sheetProvider.deleteSeriesEpisodeRow !== 'function') {
        throw new Error('Series episode deletion is not configured.');
      }
      return sheetProvider.deleteSeriesEpisodeRow({ episodeCode, expectedVersion: sourceVersion });
    },
    async deleteItemSource(contentId, { sourceVersion, actorId } = {}) {
      const { items } = await readAllItems();
      const item = items.find((candidate) => candidate.id === contentId);
      if (!item) return null;
      const current = await readSourceRecord(item.kind, item.systemCode);
      if (!current) return null;
      if (current.sourceVersion !== sourceVersion) {
        throw Object.assign(new Error('Catalog row changed since it was loaded.'), { code: 'VERSION_CONFLICT' });
      }

      // Remove Firestore metadata first, then remove the source row(s). If the
      // Sheets operation fails, restore the metadata so the title remains usable.
      const metadata = await writableProvider.getContentMetadataWithVersion(contentId);
      let deletedMetadata = false;
      if (metadata) {
        if (typeof writableProvider.deleteContentMetadata !== 'function') {
          throw Object.assign(new Error('Content metadata deletion is not configured.'), { code: 'DELETE_NOT_CONFIGURED' });
        }
        await writableProvider.deleteContentMetadata(contentId, {
          expectedVersion: metadata.version,
          actorId,
        });
        deletedMetadata = true;
      }

      try {
        if (item.kind === 'series') {
          if (typeof sheetProvider.deleteSeriesWithEpisodes !== 'function') {
            throw Object.assign(new Error('Series deletion is not configured.'), { code: 'DELETE_NOT_CONFIGURED' });
          }
          return await sheetProvider.deleteSeriesWithEpisodes({
            seriesCode: item.systemCode,
            expectedVersion: sourceVersion,
          });
        }
        if (typeof sheetProvider.deleteCatalogRow !== 'function') {
          throw Object.assign(new Error('Catalog deletion is not configured.'), { code: 'DELETE_NOT_CONFIGURED' });
        }
        return await sheetProvider.deleteCatalogRow({
          sheetName: current.sourceSheet,
          systemCode: item.systemCode,
          expectedVersion: sourceVersion,
        });
      } catch (error) {
        if (deletedMetadata) {
          try {
            await writableProvider.upsertContentMetadata(contentId, metadata.value, {
              expectedVersion: 0,
              actorId,
            });
          } catch {
            throw Object.assign(new Error('Source deletion failed and metadata restoration also failed.'), {
              code: 'DELETE_ROLLBACK_FAILED',
            });
          }
        }
        throw error;
      }
    },
    async createSeriesEpisode({ seriesCode, episodeCode, fields } = {}) {
      if (typeof sheetProvider.createSeriesEpisodeRow !== 'function') {
        throw new Error('Series episode source writer is not configured.');
      }
      return sheetProvider.createSeriesEpisodeRow({ seriesCode, episodeCode, fields });
    },
    async createItemSource(kind, fields) {
      if (typeof sheetProvider.createCatalogRow !== 'function') throw new Error('Catalog source writer is not configured.');
      const schema = await this.getSheetSchema(kind);
      if (!schema) return null;
      if (schema.headers.includes('سازنده') && !isProducerCountry(fields?.['سازنده'])) {
        throw Object.assign(new Error('Invalid producer country.'), { code: 'INVALID_INPUT' });
      }
      const candidate = Object.fromEntries(schema.headers.map((header) => [header, fields[header] ?? '']));
      try { mapCatalogSheetRow(schema.sheetName, candidate); } catch {
        throw Object.assign(new Error('Invalid catalog source row.'), { code: 'INVALID_INPUT' });
      }
      const result = await sheetProvider.createCatalogRow({ sheetName: schema.sheetName, fields });
      const mapped = mapCatalogSheetRow(schema.sheetName, result.record);
      return Object.freeze({
        id: mapped.content.id, kind, systemCode: String(result.record[CODE_HEADER(schema.sheetName, Object.keys(result.record), result.record)]).normalize('NFC').trim(),
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
      if (Object.hasOwn(fields, 'سازنده') &&
          String(record['سازنده'] ?? '') !== String(current.record['سازنده'] ?? '') &&
          !isProducerCountry(record['سازنده'])) {
        throw Object.assign(new Error('Invalid producer country.'), { code: 'INVALID_INPUT' });
      }
      const codeHeader = CODE_HEADER(current.sourceSheet, Object.keys(current.record), current.record);
      const nextSystemCode = String(record[codeHeader] ?? '').normalize('NFC').trim();
      if (!nextSystemCode) throw Object.assign(new Error('Invalid system code.'), { code: 'INVALID_INPUT' });
      try { mapCatalogSheetRow(current.sourceSheet, record); } catch {
        throw Object.assign(new Error('Invalid catalog source row.'), { code: 'INVALID_INPUT' });
      }
      const nextId = createCatalogContentId(item.kind, nextSystemCode);
      const result = await sheetProvider.updateCatalogRow({
        sheetName: current.sourceSheet, systemCode: item.systemCode,
        expectedVersion: sourceVersion, fields, actorId,
      });
      if (nextId !== item.id) {
        try {
          if (typeof writableProvider.moveContentMetadata !== 'function') {
            throw new Error('Metadata identity migration is unavailable.');
          }
          await writableProvider.moveContentMetadata(item.id, nextId, { actorId });
        } catch {
          try {
            await sheetProvider.updateCatalogRow({
              sheetName: current.sourceSheet, systemCode: nextSystemCode,
              expectedVersion: result.sourceVersion,
              fields: { [codeHeader]: item.systemCode }, actorId,
            });
          } catch {
            throw Object.assign(new Error('Catalog identity migration and rollback failed.'), {
              code: 'IDENTITY_METADATA_MIGRATION_FAILED',
            });
          }
          throw Object.assign(new Error('Catalog metadata identity migration failed; source code was restored.'), {
            code: 'IDENTITY_METADATA_MIGRATION_FAILED',
          });
        }
      }
      return Object.freeze({
        id: nextId, kind: item.kind, systemCode: nextSystemCode,
        sourceSheet: current.sourceSheet, sourceRowNumber: result.rowNumber,
        sourceVersion: result.sourceVersion, headers: current.headers, record,
      });
    },
    async listSourceDiagnostics() {
      const snapshots = await Promise.all(SHEETS.map((name) =>
        atStage('sheet_read', () => sheetProvider.readSheet(name))));
      const diagnostics = [];

      snapshots.forEach((sourceSnapshot, sheetIndex) => {
        const sheetName = SHEETS[sheetIndex];
        let snapshot;
        try {
          snapshot = validateSnapshot(sheetName, sourceSnapshot);
        } catch (cause) {
          const error = new Error('Catalog sheet snapshot validation failed.');
          error.name = 'CatalogAdminListStageError';
          error.dependency = 'sheets';
          error.stage = 'sheet_snapshot_validation';
          error.errorCode = 'CATALOG_STAGE_FAILED';
          error.cause = cause;
          throw error;
        }

        snapshot.rows.forEach((row, rowIndex) => {
          const record = rowToRecord(snapshot.headers, row);
          // Do not report reserved/unused blank rows as bad source data.
          if (isCompletelyBlankSourceRow(record)) return;
          if (sheetName === 'سریال' && isSeriesEpisodeRecord(record)) return;
          try {
            mapCatalogSheetRow(sheetName, record);
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
            diagnostics.push(Object.freeze({
              sheetName,
              rowNumber: rowIndex + 2,
              validationIssue,
              ...(requiredFieldMatch ? { fieldName: requiredFieldMatch[1] } : {}),
              ...(yearFieldMatch ? { fieldName: yearFieldMatch[1] } : {}),
              codeCandidates: safeDiagnosticCodeCandidates(record),
              titlePresent: hasSourceValue(record['اسم فیلم']),
              otherContentFieldsPresent: DIAGNOSTIC_CONTENT_FIELDS
                .filter((field) => field !== 'اسم فیلم' && hasSourceValue(record[field])),
            }));
          }
        });
      });

      const bySheet = {};
      const byField = {};
      for (const diagnostic of diagnostics) {
        bySheet[diagnostic.sheetName] = (bySheet[diagnostic.sheetName] || 0) + 1;
        const field = diagnostic.fieldName || diagnostic.validationIssue;
        byField[field] = (byField[field] || 0) + 1;
      }
      return Object.freeze({
        data: Object.freeze(diagnostics.slice(0, 500)),
        meta: Object.freeze({
          total: diagnostics.length,
          returned: Math.min(diagnostics.length, 500),
          truncated: diagnostics.length > 500,
          bySheet: Object.freeze(bySheet),
          byField: Object.freeze(byField),
        }),
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
