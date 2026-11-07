'use strict';

const { mapCatalogSheetRow } = require('./catalog-sheet-mapper');
const { isCanonicalContentId, validateCatalogContentMetadata } = require('./catalog-metadata-validation');

const SHEETS = Object.freeze(['سینمایی', 'سریال']);
const GENRE_HEADERS = Object.freeze(['ژانر', 'ژانرها']);

function normalizeGenreLabel(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u200c\u200d]/g, ' ').replace(/[\s\u00a0]+/gu, ' ').trim();
}

function splitGenreCell(value) {
  if (typeof value !== 'string') return [];
  return value.split(/[,،|\n؛;]/u).map((part) => part.trim()).filter(Boolean);
}

function safeContentId(sheetName, row, headers) {
  try {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
    const mapped = mapCatalogSheetRow(sheetName, record);
    return isCanonicalContentId(mapped.content.id) ? mapped.content.id : null;
  } catch {
    return null;
  }
}

function taxonomyMap(terms) {
  const byLabel = new Map();
  const ambiguousLabels = new Set();
  const duplicateLabels = [];
  for (const term of terms) {
    if (!term || typeof term.id !== 'string' || typeof term.labelFa !== 'string') continue;
    const key = normalizeGenreLabel(term.labelFa);
    if (!key || ambiguousLabels.has(key)) continue;
    if (byLabel.has(key) && byLabel.get(key) !== term.id) {
      byLabel.delete(key);
      ambiguousLabels.add(key);
      duplicateLabels.push({ label: key });
    } else {
      byLabel.set(key, term.id);
    }
  }
  return { byLabel, ambiguousLabels, duplicateLabels };
}

async function runGenreMigrationDryRun({ sheetProvider, metadataProvider, taxonomyProvider } = {}) {
  if (!sheetProvider || typeof sheetProvider.readSheet !== 'function' ||
      !metadataProvider || typeof metadataProvider.listContentMetadataWithVersion !== 'function' ||
      !taxonomyProvider || typeof taxonomyProvider.listAllTaxonomyTerms !== 'function') {
    throw new TypeError('Genre migration dry-run dependencies are incomplete.');
  }

  const summary = {
    sheets: {}, totalRows: 0, totalTitles: 0, rawGenreValues: 0, uniqueRawGenres: 0,
    uniqueNormalizedGenres: 0, emptyGenres: 0, duplicateContentIds: 0,
    invalidContentRows: 0, metadataMissing: 0, metadataCreateCandidates: 0, metadataConflicts: 0,
    transferableAssignments: 0, needsReview: 0,
  };
  const normalization = [];
  const frequencies = new Map();
  const rawGenreSet = new Set();
  const normalizedGenreSet = new Set();
  const sourceByContent = new Map();
  const duplicateContentIds = new Set();
  const invalidRows = [];

  for (const sheetName of SHEETS) {
    const snapshot = await sheetProvider.readSheet(sheetName);
    const headers = Array.isArray(snapshot?.headers) ? snapshot.headers : [];
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const genreHeader = GENRE_HEADERS.find((header) => headers.includes(header));
    const sheetReport = { rows: rows.length, titles: 0, emptyGenres: 0, genreHeader: genreHeader || null };
    summary.totalRows += rows.length;
    if (!genreHeader) sheetReport.issue = 'GENRE_COLUMN_MISSING';
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      sheetReport.titles += 1;
      summary.totalTitles += 1;
      const contentId = safeContentId(sheetName, row, headers);
      if (!contentId) {
        summary.invalidContentRows += 1;
        invalidRows.push({ sheet: sheetName, row: rowIndex + 2, issue: 'CONTENT_ID_INVALID' });
        continue;
      }
      if (sourceByContent.has(contentId)) {
        summary.duplicateContentIds += 1;
        duplicateContentIds.add(contentId);
        invalidRows.push({ sheet: sheetName, row: rowIndex + 2, issue: 'CONTENT_ID_DUPLICATE' });
        continue;
      }
      const labels = genreHeader ? splitGenreCell(row[headers.indexOf(genreHeader)]) : [];
      if (!labels.length) {
        sheetReport.emptyGenres += 1;
        summary.emptyGenres += 1;
      }
      sourceByContent.set(contentId, {
        sheet: sheetName, row: rowIndex + 2, labels, genreColumnMissing: !genreHeader,
      });
      summary.rawGenreValues += labels.length;
      for (const raw of labels) {
        const normalized = normalizeGenreLabel(raw);
        rawGenreSet.add(raw);
        normalizedGenreSet.add(normalized);
        frequencies.set(normalized, (frequencies.get(normalized) || 0) + 1);
        if (raw !== normalized) normalization.push({ raw, normalized, sheet: sheetName, row: rowIndex + 2 });
      }
    }
    summary.sheets[sheetName] = sheetReport;
  }

  const metadataEntries = await metadataProvider.listContentMetadataWithVersion();
  const metadataById = new Map();
  for (const entry of Array.isArray(metadataEntries) ? metadataEntries : []) {
    const value = entry?.value;
    if (value?.contentId) metadataById.set(value.contentId, value);
  }
  const terms = await taxonomyProvider.listAllTaxonomyTerms('genre');
  const { byLabel: termByLabel, ambiguousLabels: ambiguousTaxonomyLabels, duplicateLabels } =
    taxonomyMap(Array.isArray(terms) ? terms : []);
  const previews = [];
  const newGenres = new Set();

  for (const [contentId, source] of sourceByContent) {
    const metadata = metadataById.get(contentId);
    const existingIds = metadata && Array.isArray(metadata.genreIds) ? [...metadata.genreIds] : [];
    const targetIds = [];
    const unresolved = [];
    const ambiguous = [];
    const repeated = [];
    const seenNormalizedLabels = new Set();

    // Discover taxonomy labels from every source title, including titles that
    // do not yet have a Firestore metadata document.
    for (const label of source.labels) {
      const normalizedLabel = normalizeGenreLabel(label);
      if (!normalizedLabel) {
        unresolved.push(label);
        continue;
      }
      if (seenNormalizedLabels.has(normalizedLabel)) {
        repeated.push(label);
        continue;
      }
      seenNormalizedLabels.add(normalizedLabel);
      if (ambiguousTaxonomyLabels.has(normalizedLabel)) {
        ambiguous.push(label);
        continue;
      }
      const id = termByLabel.get(normalizedLabel);
      if (id) targetIds.push(id);
      else {
        unresolved.push(label);
        newGenres.add(normalizedLabel);
      }
    }

    if (!metadata) {
      summary.metadataMissing += 1;
      if (!source.genreColumnMissing && source.labels.length > 0 &&
          !duplicateContentIds.has(contentId) && unresolved.length === 0 &&
          ambiguous.length === 0 && repeated.length === 0) {
        summary.metadataCreateCandidates += 1;
        summary.transferableAssignments += targetIds.length;
        previews.push({
          contentId, status: 'create_metadata', reason: 'METADATA_MISSING',
          proposedMetadata: {
            approvalStatus: 'pending', publicationStatus: 'draft',
            countryIds: [], genreIds: targetIds,
          },
        });
      } else {
        summary.needsReview += 1;
        previews.push({
          contentId, status: 'needs_review',
          reason: source.genreColumnMissing ? 'GENRE_COLUMN_MISSING' :
            !source.labels.length ? 'GENRE_SOURCE_EMPTY' :
            ambiguous.length ? 'GENRE_TERM_AMBIGUOUS' :
            repeated.length ? 'GENRE_LABEL_DUPLICATE' :
            duplicateContentIds.has(contentId) ? 'CONTENT_ID_DUPLICATE' : 'GENRE_TERM_UNMAPPED',
          sourceGenres: source.labels,
          ...(unresolved.length ? { unresolvedGenres: unresolved } : {}),
          ...(ambiguous.length ? { ambiguousGenres: ambiguous } : {}),
          ...(repeated.length ? { duplicateGenres: repeated } : {}),
        });
      }
      continue;
    }
    let valid;
    try { valid = validateCatalogContentMetadata(contentId, metadata); } catch { valid = null; }
    if (!valid) {
      summary.metadataConflicts += 1;
      summary.needsReview += 1;
      previews.push({ contentId, status: 'needs_review', reason: 'METADATA_INVALID', sourceGenres: source.labels });
      continue;
    }
    const existingIds = Array.isArray(valid.genreIds) ? [...valid.genreIds] : [];
    if (duplicateContentIds.has(contentId)) {
      summary.needsReview += 1;
      previews.push({ contentId, status: 'needs_review', reason: 'CONTENT_ID_DUPLICATE', existingGenreIds: existingIds, sourceGenres: source.labels });
      continue;
    }
    if (source.genreColumnMissing) {
      summary.needsReview += 1;
      previews.push({ contentId, status: 'needs_review', reason: 'GENRE_COLUMN_MISSING', existingGenreIds: existingIds });
      continue;
    }
    if (!source.labels.length) {
      summary.needsReview += 1;
      previews.push({ contentId, status: 'needs_review', reason: 'GENRE_SOURCE_EMPTY', existingGenreIds: existingIds, sourceGenres: [] });
      continue;
    }

    const same = unresolved.length === 0 && ambiguous.length === 0 && repeated.length === 0 &&
      existingIds.length === targetIds.length && existingIds.every((id) => targetIds.includes(id));
    if (same) {
      previews.push({ contentId, status: 'unchanged', existingGenreIds: existingIds });
    } else if (ambiguous.length || repeated.length || unresolved.length) {
      summary.needsReview += 1;
      const reason = ambiguous.length ? 'GENRE_TERM_AMBIGUOUS' :
        repeated.length ? 'GENRE_LABEL_DUPLICATE' : 'GENRE_TERM_UNMAPPED';
      previews.push({
        contentId, status: 'needs_review', reason, existingGenreIds: existingIds,
        sourceGenres: source.labels,
        ...(ambiguous.length ? { ambiguousGenres: ambiguous } : {}),
        ...(repeated.length ? { duplicateGenres: repeated } : {}),
        ...(unresolved.length ? { unresolvedGenres: unresolved } : {}),
      });
    } else {
      if (existingIds.length && !same) summary.metadataConflicts += 1;
      summary.transferableAssignments += targetIds.length;
      previews.push({ contentId, status: 'transferable', existingGenreIds: existingIds, proposedGenreIds: targetIds });
    }
  }

  summary.uniqueRawGenres = rawGenreSet.size;
  summary.uniqueNormalizedGenres = normalizedGenreSet.size;
  return {
    summary,
    'genre-frequency': [...frequencies.entries()].sort((a, b) => b[1] - a[1]).map(([genre, count]) => ({ genre, count })),
    'normalization-report': { changes: normalization, invalidRows, duplicateTaxonomyLabels: duplicateLabels },
    'migration-preview': {
      existingGenres: Array.isArray(terms) ? terms.map(({ id, labelFa, enabled }) => ({ id, labelFa, enabled })) : [],
      newGenres: [...newGenres].sort((a, b) => a.localeCompare(b, 'fa')).map((label) => ({ label, status: 'needs_review', reason: 'TERM_ID_REQUIRED' })),
      assignments: previews,
    },
  };
}

module.exports = { normalizeGenreLabel, runGenreMigrationDryRun, splitGenreCell };
