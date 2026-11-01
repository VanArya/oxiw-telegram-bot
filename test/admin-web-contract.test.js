'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'admin-web');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('admin UI uses token-backed same-origin APIs without unsafe DOM or manual token storage', () => {
  assert.match(html, /lang="fa" dir="rtl"/);
  assert.match(appSource, /getIdToken\(/);
  assert.match(appSource, /Authorization/);
  assert.match(appSource, /\/api\/v1\/admin\/catalog/);
  assert.doesNotMatch(appSource, /innerHTML|localStorage|sessionStorage|console\.log/);
  assert.doesNotMatch(appSource, /firestore\.js|collection\(.*firebase/i);
});

test('Firebase browser configuration comes from the same-origin runtime endpoint', () => {
  assert.match(appSource, /fetch\('\/admin\/config\.json'/);
  assert.doesNotMatch(appSource, /from ['"].*firebase-config\.js/);
  assert.match(html, /\/admin\/app\.js/);
});
