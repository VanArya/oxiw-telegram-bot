'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { main } = require('../scripts/seed-country-taxonomy');

test('country taxonomy production writes require the explicit apply environment gate', async () => {
  await assert.rejects(
    main(['--apply'], {}),
    /CATALOG_CONFIRM_COUNTRY_TAXONOMY_APPLY=YES/,
  );
});

test('country taxonomy seed rejects unsupported command arguments before runtime setup', async () => {
  await assert.rejects(main(['--delete'], {}), /Only --apply is supported/);
});
