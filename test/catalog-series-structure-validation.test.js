'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CatalogSeriesStructureInputError,
  episodeDocumentId,
  seasonDocumentId,
  validateEpisode,
  validateSeason,
  validateSeriesId,
} = require('../src/catalog-series-structure-validation');

test('validates series IDs and deterministic season and episode identities', () => {
  assert.equal(validateSeriesId('series:show-1'), 'series:show-1');
  assert.equal(seasonDocumentId(2), 'season-2');
  assert.equal(episodeDocumentId(7), 'episode-7');
  assert.throws(() => validateSeriesId('movie:show-1'), CatalogSeriesStructureInputError);
});

test('validates season metadata and defaults lifecycle to active', () => {
  assert.deepEqual(validateSeason({ seasonNumber: 2, title: 'فصل دوم' }), {
    seasonNumber: 2,
    title: 'فصل دوم',
    lifecycleStatus: 'active',
  });
  assert.throws(() => validateSeason({ seasonNumber: 0 }), CatalogSeriesStructureInputError);
  assert.throws(() => validateSeason({ seasonNumber: 1, unexpected: true }), CatalogSeriesStructureInputError);
});

test('validates episode metadata and requires at least one independent download link', () => {
  const episode = validateEpisode({
    episodeNumber: 3,
    title: 'قسمت سوم',
    releaseDate: '2026-11-10',
    downloadLinks: [
      { id: '720p', label: '720p', url: 'https://download.example/episode-3-720', sizeBytes: 9000 },
      { id: '1080p', label: '1080p', url: 'https://download.example/episode-3-1080', sortOrder: 0 },
    ],
  });
  assert.equal(episode.lifecycleStatus, 'active');
  assert.deepEqual(episode.downloadLinks.map((link) => link.id), ['1080p', '720p']);
  assert.equal(episode.downloadLinks[0].enabled, true);
  assert.throws(() => validateEpisode({ episodeNumber: 1, downloadLinks: [] }), CatalogSeriesStructureInputError);
  assert.throws(() => validateEpisode({
    episodeNumber: 1,
    downloadLinks: [{ id: 'x', label: 'کیفیت', url: 'https://x' }, { id: 'x', label: 'تکراری', url: 'https://y' }],
  }), CatalogSeriesStructureInputError);
  assert.throws(() => validateEpisode({
    episodeNumber: 1,
    releaseDate: '2026-02-30',
    downloadLinks: [{ id: 'x', label: 'کیفیت', url: 'https://x' }],
  }), CatalogSeriesStructureInputError);
});
