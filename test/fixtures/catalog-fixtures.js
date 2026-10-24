'use strict';

const items = [
  {
    id: 'fixture-movie-ir-1',
    kind: 'movie',
    title: 'فیلم نمونه یک',
    countryIds: ['IR'],
    genreIds: ['drama'],
    releaseYear: 2020,
    status: 'published',
  },
  {
    id: 'fixture-series-ir-1',
    kind: 'series',
    title: 'سریال نمونه یک',
    countryIds: ['IR'],
    genreIds: ['drama'],
    releaseYear: 2022,
    status: 'published',
  },
  {
    id: 'fixture-movie-us-1',
    kind: 'movie',
    title: 'فیلم نمونه دو',
    countryIds: ['US'],
    genreIds: ['drama'],
    releaseYear: 2019,
    status: 'published',
  },
  {
    id: 'fixture-series-us-1',
    kind: 'series',
    title: 'سریال نمونه خارجی',
    countryIds: ['US'],
    genreIds: ['drama'],
    status: 'published',
  },
  {
    id: 'fixture-movie-country-unknown',
    kind: 'movie',
    title: 'فیلم با کشور نامشخص',
    genreIds: ['drama'],
    status: 'published',
  },
  {
    id: 'fixture-movie-ir-draft',
    kind: 'movie',
    title: 'پیش‌نویس ساختگی',
    countryIds: ['IR'],
    genreIds: ['comedy'],
    releaseYear: 2024,
    status: 'draft',
  },
];

const categories = [
  {
    id: 'fixture-category-iranian-series',
    slug: 'iranian-series',
    localizedTitle: { fa: 'سریال ایرانی' },
    enabled: true,
    sortOrder: 20,
    filters: {
      all: [
        { field: 'kind', op: 'eq', value: 'series' },
        { field: 'countryIds', op: 'contains', value: 'IR' },
      ],
    },
  },
  {
    id: 'fixture-category-iranian-movies',
    slug: 'iranian-movies',
    localizedTitle: { fa: 'فیلم سینمایی ایرانی' },
    enabled: true,
    sortOrder: 10,
    filters: {
      all: [
        { field: 'kind', op: 'eq', value: 'movie' },
        { field: 'countryIds', op: 'contains', value: 'IR' },
      ],
    },
  },
  {
    id: 'fixture-category-disabled',
    slug: 'disabled-category',
    localizedTitle: { fa: 'دستهٔ غیرفعال' },
    enabled: false,
    sortOrder: 0,
    filters: { field: 'kind', op: 'eq', value: 'movie' },
  },
];

module.exports = { categories, items };
