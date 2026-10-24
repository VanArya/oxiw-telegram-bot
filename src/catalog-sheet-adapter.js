'use strict';

const {
  filterCatalogItems,
  getCategoryItems,
} = require('./catalog-core');
const {
  mapCatalogSheetRow,
  toPublicCatalogDto,
} = require('./catalog-sheet-mapper');
const { assertCatalogMetadataProvider } = require('./catalog-metadata-provider');

const SHEETS = Object.freeze(['سینمایی', 'سریال']);
const REQUIRED_HEADERS = Object.freeze(['کد سیستم', 'اسم فیلم']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'unknown']);
const PUBLICATION_STATUSES = new Set(['draft', 'published', 'archived', 'unknown']);
const TAXONOMY_TYPES = Object.freeze(['country', 'genre']);

function validateSnapshot(sheetName, snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.headers) ||
    !Array.isArray(snapshot.rows)
  ) {
    throw new TypeError(`Invalid sheet snapshot: ${sheetName}`);
  }

  if (
    snapshot.headers.some((header) => typeof header !== 'string' || header.trim() === '') ||
    new Set(snapshot.headers).size !== snapshot.headers.length
  ) {
    throw new TypeError(`Invalid or duplicate headers: ${sheetName}`);
  }

  const missing = REQUIRED_HEADERS.filter((header) => !snapshot.headers.includes(header));
  if (missing.length > 0) {
    throw new TypeError(`Missing required headers in ${sheetName}: ${missing.join(', ')}`);
  }

  if (snapshot.rows.some((row) => !Array.isArray(row) || row.length > snapshot.headers.length)) {
    throw new TypeError(`Invalid row structure: ${sheetName}`);
  }
}

function rowToRecord(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
}

function validTaxonomyTerms(terms, type) {
  if (!Array.isArray(terms)) throw new TypeError('Invalid catalog taxonomy response.');
  const ids = new Set();
  for (const term of terms) {
    if (
      !term || typeof term !== 'object' || Array.isArray(term) ||
      !Object.hasOwn(term, 'id') || !Object.hasOwn(term, 'labelFa') || !Object.hasOwn(term, 'enabled') ||
      typeof term.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(term.id) ||
      typeof term.labelFa !== 'string' || term.labelFa.trim() === '' ||
      term.enabled !== true || ids.has(term.id)
    ) {
      throw new TypeError('Invalid catalog taxonomy response.');
    }
    if (type === 'country' && !/^[A-Z]{2}$/.test(term.id)) {
      throw new TypeError('Invalid catalog taxonomy response.');
    }
    ids.add(term.id);
  }
  return ids;
}

function validMetadata(value, countryIds, genreIds) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.hasOwn(value, 'visibility') ||
    !Object.hasOwn(value, 'approvalStatus') ||
    !Object.hasOwn(value, 'publicationStatus') ||
    !APPROVAL_STATUSES.has(value.approvalStatus) ||
    !PUBLICATION_STATUSES.has(value.publicationStatus)
  ) return false;

  for (const [field, allowed] of [['countryIds', countryIds], ['genreIds', genreIds]]) {
    if (!Object.hasOwn(value, field)) continue;
    if (value[field] === undefined) continue;
    if (
      !Array.isArray(value[field]) ||
      value[field].some((id) => typeof id !== 'string' || !allowed.has(id)) ||
      new Set(value[field]).size !== value[field].length
    ) return false;
  }
  return true;
}

function createCatalogSheetAdapter(provider, { metadataProvider } = {}) {
  if (!provider || typeof provider.readSheet !== 'function') {
    throw new TypeError('Provider must implement readSheet(sheetName).');
  }
  if (metadataProvider !== undefined) assertCatalogMetadataProvider(metadataProvider);

  async function loadContents() {
    const snapshots = await Promise.all(SHEETS.map((sheetName) => provider.readSheet(sheetName)));
    const contents = [];

    const seenIds = new Set();
    snapshots.forEach((snapshot, sheetIndex) => {
      const sheetName = SHEETS[sheetIndex];
      validateSnapshot(sheetName, snapshot);

      snapshot.rows.forEach((row, rowIndex) => {
        const record = rowToRecord(snapshot.headers, row);
        let mapped;
        try {
          mapped = mapCatalogSheetRow(sheetName, record);
        } catch (error) {
          throw new TypeError(`Invalid catalog row in ${sheetName} at index ${rowIndex}.`, {
            cause: error,
          });
        }
        if (seenIds.has(mapped.content.id)) {
          throw new TypeError(`Duplicate catalog identity in ${sheetName} at index ${rowIndex}.`);
        }
        seenIds.add(mapped.content.id);
        // Country, genre, approval, and publication are maintained only in metadata;
        // similarly named legacy/test source columns are never authoritative.
        delete mapped.content.countryIds;
        delete mapped.content.genreIds;
        mapped.content.approvalStatus = 'unknown';
        mapped.content.publicationStatus = 'unknown';
        contents.push(mapped.content);
      });
    });

    if (!metadataProvider) {
      return { contents, countryLabels: undefined };
    }

    let countryIds;
    let genreIds;
    let countryLabels;
    let genreLabels;
    try {
      const [countryTerms, genreTerms] = await Promise.all(
        TAXONOMY_TYPES.map((type) => metadataProvider.listTaxonomyTerms(type)),
      );
      countryIds = validTaxonomyTerms(countryTerms, 'country');
      genreIds = validTaxonomyTerms(genreTerms, 'genre');
      countryLabels = Object.fromEntries(countryTerms.map(({ id, labelFa }) => [id, labelFa]));
      genreLabels = Object.fromEntries(genreTerms.map(({ id, labelFa }) => [id, labelFa]));
    } catch {
      throw new Error('Catalog metadata is unavailable.');
    }

    const resolvedContents = await Promise.all(contents.map(async (content) => {
      try {
        const metadata = await metadataProvider.getContentMetadata(content.id);

        // Metadata mode is authoritative: source-sheet country/status values are
        // deliberately ignored, including legacy fixture columns.
        delete content.countryIds;
        delete content.genreIds;
        if (!validMetadata(metadata, countryIds, genreIds)) {
          content.approvalStatus = 'unknown';
          content.publicationStatus = 'unknown';
          return content;
        }

        if (metadata.countryIds !== undefined) content.countryIds = [...metadata.countryIds];
        if (metadata.genreIds !== undefined) content.genreIds = [...metadata.genreIds];
        content.approvalStatus = metadata.approvalStatus;
        content.publicationStatus = metadata.publicationStatus;
        return content;
      } catch {
        throw new Error('Catalog metadata is unavailable.');
      }
    }));
    return { contents: resolvedContents, countryLabels, genreLabels };
  }

  return Object.freeze({
    async listItems(filter) {
      const { contents, countryLabels, genreLabels } = await loadContents();
      return filterCatalogItems(contents, filter)
        .map((content) => toPublicCatalogDto({ content }, countryLabels ? { countryLabels, genreLabels } : undefined))
        .filter(Boolean);
    },

    async listCategoryItems(category) {
      const { contents, countryLabels, genreLabels } = await loadContents();
      return getCategoryItems(contents, category)
        .map((content) => toPublicCatalogDto({ content }, countryLabels ? { countryLabels, genreLabels } : undefined))
        .filter(Boolean);
    },

    async listCategories(fallbackCategories = []) {
      if (!metadataProvider) return fallbackCategories;
      try {
        const categories = await metadataProvider.listCategories();
        if (!Array.isArray(categories)) throw new TypeError();
        return categories;
      } catch {
        throw new Error('Catalog metadata is unavailable.');
      }
    },

    async listTaxonomyTerms(type) {
      if (!TAXONOMY_TYPES.includes(type)) return [];
      if (!metadataProvider) {
        if (type === 'country') {
          return [
            { id: 'IR', labelFa: 'ایران', enabled: true },
            { id: 'US', labelFa: 'ایالات متحده', enabled: true },
          ];
        }
        return [];
      }
      try {
        const terms = await metadataProvider.listTaxonomyTerms(type);
        validTaxonomyTerms(terms, type);
        return terms;
      } catch {
        throw new Error('Catalog metadata is unavailable.');
      }
    },
  });
}

module.exports = { createCatalogSheetAdapter };
