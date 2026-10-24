'use strict';

const KINDS = new Set(['movie', 'series']);

function normalizeSystemCode(systemCode) {
  if (
    typeof systemCode !== 'string' &&
    !(typeof systemCode === 'number' && Number.isFinite(systemCode))
  ) {
    throw new TypeError('Invalid system code.');
  }
  const normalized = String(systemCode).normalize('NFC').trim();
  if (normalized.length === 0) {
    throw new TypeError('Invalid system code.');
  }
  return normalized;
}

function createCatalogContentId(kind, systemCode) {
  if (!KINDS.has(kind)) {
    throw new TypeError('Invalid content kind.');
  }
  return `${kind}:${encodeURIComponent(normalizeSystemCode(systemCode))}`;
}

module.exports = { createCatalogContentId, normalizeSystemCode };
