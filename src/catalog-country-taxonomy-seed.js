'use strict';

const { PRODUCER_COUNTRIES, normalizeProducerCountryLabel } = require('./catalog-producer-country');

const COUNTRY_TERMS = Object.freeze(PRODUCER_COUNTRIES.map((country, index) => Object.freeze({
  id: country.id,
  labelFa: country.labelFa,
  enabled: true,
  sortOrder: (index + 1) * 10,
})));

const FOREIGN_COUNTRY_IDS = Object.freeze(
  PRODUCER_COUNTRIES.filter((country) => country.id !== 'IR').map((country) => country.id),
);

function countryCondition(countryId) {
  return { field: 'countryIds', op: 'contains', value: countryId };
}

function categoryDefinition({ id, slug, title, sortOrder, kind, countryIds }) {
  const countryFilter = countryIds.length === 1
    ? countryCondition(countryIds[0])
    : { any: countryIds.map(countryCondition) };
  return Object.freeze({
    id,
    slug,
    localizedTitle: Object.freeze({ fa: title }),
    enabled: true,
    sortOrder,
    mode: 'dynamic',
    filters: Object.freeze({
      all: Object.freeze([
        Object.freeze({ field: 'kind', op: 'eq', value: kind }),
        Object.freeze(countryFilter),
      ]),
    }),
  });
}

const COUNTRY_CATEGORIES = Object.freeze([
  categoryDefinition({
    id: 'iranian-movies', slug: 'iranian-movies', title: 'فیلم سینمایی ایرانی',
    sortOrder: 10, kind: 'movie', countryIds: ['IR'],
  }),
  categoryDefinition({
    id: 'iranian-series', slug: 'iranian-series', title: 'سریال ایرانی',
    sortOrder: 20, kind: 'series', countryIds: ['IR'],
  }),
  categoryDefinition({
    id: 'foreign-movies', slug: 'foreign-movies', title: 'فیلم سینمایی خارجی',
    sortOrder: 30, kind: 'movie', countryIds: FOREIGN_COUNTRY_IDS,
  }),
  categoryDefinition({
    id: 'foreign-series', slug: 'foreign-series', title: 'سریال خارجی',
    sortOrder: 40, kind: 'series', countryIds: FOREIGN_COUNTRY_IDS,
  }),
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function normalizeCategory(value) {
  return {
    id: value.id,
    slug: value.slug,
    localizedTitle: value.localizedTitle,
    enabled: value.enabled,
    sortOrder: Number.isFinite(value.sortOrder) ? value.sortOrder : 0,
    mode: value.mode || 'dynamic',
    filters: value.filters,
  };
}

function planCountryTaxonomySeed(existingTerms = [], existingCategories = []) {
  if (!Array.isArray(existingTerms) || !Array.isArray(existingCategories)) {
    throw new TypeError('Existing country taxonomy and categories must be arrays.');
  }

  const conflicts = [];
  const createTerms = [];
  const updateTerms = [];
  const alreadyPresentTerms = [];
  const existingTermIds = new Map();
  for (const term of existingTerms) {
    if (!term || typeof term.id !== 'string' || typeof term.labelFa !== 'string') {
      conflicts.push({ entity: 'country', reason: 'INVALID_EXISTING_TERM' });
      continue;
    }
    if (existingTermIds.has(term.id)) {
      conflicts.push({ entity: 'country', id: term.id, reason: 'DUPLICATE_EXISTING_ID' });
    }
    existingTermIds.set(term.id, term);
  }

  for (const desired of COUNTRY_TERMS) {
    const sameId = existingTermIds.get(desired.id);
    const labelMatches = existingTerms.filter((term) =>
      normalizeProducerCountryLabel(term?.labelFa) === normalizeProducerCountryLabel(desired.labelFa));
    const conflictingLabel = labelMatches.find((term) => term.id !== desired.id);
    if (conflictingLabel || labelMatches.length > 1) {
      conflicts.push({
        entity: 'country', id: desired.id, labelFa: desired.labelFa,
        reason: 'LABEL_OWNED_BY_OTHER_ID',
      });
      continue;
    }

    if (!sameId) {
      createTerms.push(desired);
      continue;
    }

    if (sameValue(sameId, desired)) {
      alreadyPresentTerms.push({ id: desired.id, labelFa: desired.labelFa });
    } else {
      updateTerms.push({
        id: desired.id,
        previous: sameId,
        value: desired,
      });
    }
  }

  const createCategories = [];
  const updateCategories = [];
  const alreadyPresentCategories = [];
  const categoryIds = new Map();
  for (const category of existingCategories) {
    if (!category || typeof category.id !== 'string' || typeof category.slug !== 'string') {
      conflicts.push({ entity: 'category', reason: 'INVALID_EXISTING_CATEGORY' });
      continue;
    }
    if (categoryIds.has(category.id)) {
      conflicts.push({ entity: 'category', id: category.id, reason: 'DUPLICATE_EXISTING_ID' });
    }
    categoryIds.set(category.id, category);
  }

  for (const desired of COUNTRY_CATEGORIES) {
    const sameId = categoryIds.get(desired.id);
    const slugMatches = existingCategories.filter((category) => category?.slug === desired.slug);
    const conflictingSlug = slugMatches.find((category) => category.id !== desired.id);
    if (conflictingSlug || slugMatches.length > 1) {
      conflicts.push({
        entity: 'category', id: desired.id, slug: desired.slug,
        reason: 'SLUG_OWNED_BY_OTHER_ID',
      });
      continue;
    }

    if (!sameId) {
      createCategories.push(desired);
      continue;
    }

    if (sameId.slug !== desired.slug) {
      conflicts.push({ entity: 'category', id: desired.id, reason: 'CATEGORY_ID_REUSED' });
      continue;
    }
    if (sameId.mode !== undefined && sameId.mode !== 'dynamic') {
      conflicts.push({ entity: 'category', id: desired.id, reason: 'NON_DYNAMIC_CATEGORY_REQUIRES_REVIEW' });
      continue;
    }

    const current = normalizeCategory(sameId);
    if (sameValue(current, desired)) {
      alreadyPresentCategories.push({ id: desired.id, slug: desired.slug });
    } else {
      updateCategories.push({
        id: desired.id,
        previous: sameId,
        value: desired,
      });
    }
  }

  return Object.freeze({
    createTerms: Object.freeze(createTerms),
    updateTerms: Object.freeze(updateTerms),
    alreadyPresentTerms: Object.freeze(alreadyPresentTerms),
    createCategories: Object.freeze(createCategories),
    updateCategories: Object.freeze(updateCategories),
    alreadyPresentCategories: Object.freeze(alreadyPresentCategories),
    conflicts: Object.freeze(conflicts),
  });
}

async function applyCountryTaxonomySeed({
  writableProvider,
  actorId = 'country-taxonomy-seed',
} = {}) {
  const requiredMethods = [
    'listAllTaxonomyTerms', 'listCategories', 'getTaxonomyTermWithVersion',
    'getCategoryWithVersion', 'upsertTaxonomyTerm', 'upsertCategory',
  ];
  if (!writableProvider || requiredMethods.some((method) => typeof writableProvider[method] !== 'function')) {
    throw new TypeError('A versioned writable catalog metadata provider is required.');
  }

  const [existingTerms, existingCategories] = await Promise.all([
    writableProvider.listAllTaxonomyTerms('country'),
    writableProvider.listCategories(),
  ]);
  const plan = planCountryTaxonomySeed(existingTerms, existingCategories);
  if (plan.conflicts.length) {
    return {
      ...plan,
      createdTerms: [],
      updatedTerms: [],
      createdCategories: [],
      updatedCategories: [],
      blocked: true,
    };
  }

  const createdTerms = [];
  const updatedTerms = [];
  const createdCategories = [];
  const updatedCategories = [];

  for (const update of plan.updateTerms) {
    const current = await writableProvider.getTaxonomyTermWithVersion('country', update.id);
    if (!current || !sameValue(current.value, update.previous)) {
      throw Object.assign(new Error('Country taxonomy changed after the seed plan was created.'), {
        code: 'SEED_PLAN_STALE',
      });
    }
    await writableProvider.upsertTaxonomyTerm('country', update.id, update.value, {
      expectedVersion: current.version,
      actorId,
    });
    updatedTerms.push(update.id);
  }

  for (const term of plan.createTerms) {
    await writableProvider.upsertTaxonomyTerm('country', term.id, term, {
      expectedVersion: 0,
      actorId,
    });
    createdTerms.push(term.id);
  }

  for (const update of plan.updateCategories) {
    const current = await writableProvider.getCategoryWithVersion(update.id);
    if (!current || !sameValue(current.value, update.previous)) {
      throw Object.assign(new Error('Country category changed after the seed plan was created.'), {
        code: 'SEED_PLAN_STALE',
      });
    }
    await writableProvider.upsertCategory(update.id, update.value, {
      expectedVersion: current.version,
      actorId,
    });
    updatedCategories.push(update.id);
  }

  for (const category of plan.createCategories) {
    await writableProvider.upsertCategory(category.id, category, {
      expectedVersion: 0,
      actorId,
    });
    createdCategories.push(category.id);
  }

  return {
    ...plan,
    createdTerms,
    updatedTerms,
    createdCategories,
    updatedCategories,
    blocked: false,
  };
}

module.exports = {
  COUNTRY_CATEGORIES,
  COUNTRY_TERMS,
  FOREIGN_COUNTRY_IDS,
  applyCountryTaxonomySeed,
  planCountryTaxonomySeed,
};
