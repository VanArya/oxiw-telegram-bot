'use strict';

const PROVIDER_KIND = Symbol.for('oxiw.catalog.providerKind');

function markCatalogProviderKind(provider, kind) {
  if (!provider || typeof provider !== 'object' || typeof kind !== 'string' || kind.trim() === '') {
    throw new TypeError('Catalog provider kind is invalid.');
  }
  Object.defineProperty(provider, PROVIDER_KIND, {
    value: kind,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return provider;
}

function getCatalogProviderKind(provider) {
  return provider && typeof provider === 'object' ? provider[PROVIDER_KIND] : undefined;
}

module.exports = { getCatalogProviderKind, markCatalogProviderKind };
