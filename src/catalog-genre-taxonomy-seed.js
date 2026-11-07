'use strict';

const GENRE_TERMS = Object.freeze([
  {
    "id": "Action",
    "labelFa": "اکشن",
    "enabled": true
  },
  {
    "id": "Adventure",
    "labelFa": "ماجراجویی",
    "enabled": true
  },
  {
    "id": "Thriller",
    "labelFa": "هیجان انگیز",
    "enabled": true
  },
  {
    "id": "Comedy",
    "labelFa": "کمدی",
    "enabled": true
  },
  {
    "id": "Crime",
    "labelFa": "جنایی",
    "enabled": true
  },
  {
    "id": "Horror",
    "labelFa": "ترسناک",
    "enabled": true
  },
  {
    "id": "SciFi",
    "labelFa": "علمی تخیلی",
    "enabled": true
  },
  {
    "id": "Fantasy",
    "labelFa": "فانتزی",
    "enabled": true
  },
  {
    "id": "Romance",
    "labelFa": "عاشقانه",
    "enabled": true
  },
  {
    "id": "Historical",
    "labelFa": "تاریخی",
    "enabled": true
  },
  {
    "id": "MartialArts",
    "labelFa": "مبارزه ای",
    "enabled": true
  },
  {
    "id": "Mystery",
    "labelFa": "رازآلود",
    "enabled": true
  },
  {
    "id": "War",
    "labelFa": "جنگی",
    "enabled": true
  },
  {
    "id": "Family",
    "labelFa": "خانوادگی",
    "enabled": true
  },
  {
    "id": "Biography",
    "labelFa": "زندگی نامه",
    "enabled": true
  },
  {
    "id": "Survival",
    "labelFa": "بقا",
    "enabled": true
  },
  {
    "id": "Mythological",
    "labelFa": "افسانه ای",
    "enabled": true
  },
  {
    "id": "Spy",
    "labelFa": "جاسوسی",
    "enabled": true
  },
  {
    "id": "Sports",
    "labelFa": "ورزشی",
    "enabled": true
  },
  {
    "id": "Western",
    "labelFa": "وسترن",
    "enabled": true
  },
  {
    "id": "Superhero",
    "labelFa": "ابرقهرمانی",
    "enabled": true
  },
  {
    "id": "Heist",
    "labelFa": "سرقت",
    "enabled": true
  },
  {
    "id": "Automotive",
    "labelFa": "ماشینی",
    "enabled": true
  },
  {
    "id": "Zombie",
    "labelFa": "زامبی",
    "enabled": true
  },
  {
    "id": "Marvel",
    "labelFa": "مارول",
    "enabled": true
  },
  {
    "id": "DC",
    "labelFa": "دی سی",
    "enabled": true
  },
  {
    "id": "Comic",
    "labelFa": "کمیک",
    "enabled": true
  }
]);

function normalizeLabel(value) {
  return typeof value === 'string'
    ? value.replace(/[\u200c\u200d]/g, ' ').replace(/[\s\u00a0]+/gu, ' ').trim()
    : '';
}

function planGenreTaxonomySeed(existingTerms = []) {
  if (!Array.isArray(existingTerms)) throw new TypeError('Existing genre terms must be an array.');
  const byId = new Map();
  const byLabel = new Map();
  const duplicateLabels = new Set();

  for (const term of existingTerms) {
    if (!term || typeof term.id !== 'string' || typeof term.labelFa !== 'string') continue;
    byId.set(term.id, term);
    const label = normalizeLabel(term.labelFa);
    if (byLabel.has(label) && byLabel.get(label).id !== term.id) duplicateLabels.add(label);
    else byLabel.set(label, term);
  }

  const create = [];
  const alreadyPresent = [];
  const conflicts = [];
  for (const term of GENRE_TERMS) {
    const normalized = normalizeLabel(term.labelFa);
    if (duplicateLabels.has(normalized)) {
      conflicts.push({ id: term.id, labelFa: term.labelFa, reason: 'DUPLICATE_EXISTING_LABEL' });
      continue;
    }
    const sameLabel = byLabel.get(normalized);
    const sameId = byId.get(term.id);
    if (sameLabel) {
      alreadyPresent.push({ id: sameLabel.id, labelFa: sameLabel.labelFa });
      continue;
    }
    if (sameId) {
      conflicts.push({ id: term.id, labelFa: term.labelFa, reason: 'TERM_ID_ALREADY_USED' });
      continue;
    }
    create.push(term);
  }
  return Object.freeze({
    create: Object.freeze(create),
    alreadyPresent: Object.freeze(alreadyPresent),
    conflicts: Object.freeze(conflicts),
  });
}

async function applyGenreTaxonomySeed({ writableProvider, actorId = 'genre-taxonomy-seed' } = {}) {
  if (!writableProvider || typeof writableProvider.listAllTaxonomyTerms !== 'function' ||
      typeof writableProvider.upsertTaxonomyTerm !== 'function') {
    throw new TypeError('A writable taxonomy provider is required.');
  }
  const existing = await writableProvider.listAllTaxonomyTerms('genre');
  const plan = planGenreTaxonomySeed(existing);
  if (plan.conflicts.length) {
    return { ...plan, created: [], blocked: true };
  }
  const created = [];
  for (const term of plan.create) {
    await writableProvider.upsertTaxonomyTerm('genre', term.id, term, {
      expectedVersion: 0,
      actorId,
    });
    created.push(term.id);
  }
  return { ...plan, created, blocked: false };
}

module.exports = { GENRE_TERMS, applyGenreTaxonomySeed, normalizeLabel, planGenreTaxonomySeed };
