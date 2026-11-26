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

test('Firebase Auth explicitly uses in-memory persistence before auth listeners or sign-in', () => {
  assert.match(appSource, /initializeAuth\(app,\s*\{\s*persistence:\s*authModule\.inMemoryPersistence/s);
  assert.doesNotMatch(appSource, /authModule\.getAuth\(/);
  assert.doesNotMatch(appSource, /browserLocalPersistence|browserSessionPersistence/);
  assert.ok(appSource.indexOf('initializeAuth(app') < appSource.indexOf('onAuthStateChanged'));
  assert.ok(appSource.indexOf('initializeAuth(app') < appSource.indexOf('signInWithPopup'));
});

test('manager administration stays owner-gated and uses the manager APIs safely', () => {
  assert.match(html, /id="managers-nav"[^>]+data-view="managers"(?![^>]*hidden)/);
  assert.match(html, /id="view-managers"/);
  assert.match(html, /id="manager-email"[^>]+type="email"/);
  assert.match(html, /id="manager-rows"/);
  assert.match(appSource, /\/managers/);
  assert.match(appSource, /method: 'POST'/);
  assert.match(appSource, /method: 'DELETE'/);
  assert.match(appSource, /If-Match/);
  assert.match(appSource, /window\.confirm\(/);
  assert.match(appSource, /OWNER_REQUIRED/);
  assert.match(appSource, /setManagerAccessVisible\(false\)/);
  assert.match(appSource, /managerEmailById/);
  assert.match(appSource, /assignment\.email/);
  assert.match(appSource, /ایمیل در دسترس نیست/);
  assert.match(appSource, /ثبت و لغو دسترسی تا تأیید مالک/);
  assert.match(appSource, /managerSave\.disabled = !managerAccessAllowed/);
  assert.doesNotMatch(appSource, /roles\.includes\(['"]owner/);
});


test('source create form reads every generated field, not only the first', () => {
  assert.match(appSource, /container\.querySelectorAll\('\[data-source-header\]'\)\.forEach/);
});


test('season management stays sheet-backed, grouped and version-protected', () => {
  assert.match(html, /data-view="seasons"/);
  assert.match(html, /id="view-seasons"/);
  assert.match(html, /id="seasons-rows"/);
  assert.match(appSource, /\$\{API_ROOT\}\/seasons/);
  assert.match(appSource, /deleteRegisteredSeason/);
  assert.match(appSource, /sourceVersion: season\.sourceVersion/);
  assert.match(html, /ثبت قسمت و ایجاد فصل/);
});


test('admin source forms use the seven approved producer countries', () => {
  assert.match(appSource, /\(نوع\|سازنده\|زبان\|پیشنهادی\)/);
  assert.match(appSource, /normalizedHeader === 'سازنده'/);
  assert.match(html, /سازنده<select id="episode-country"/);
  assert.match(html, /سازنده<select id="episode-edit-country"/);
  for (const country of ['ایران', 'آمریکا', 'کره جنوبی', 'ژاپن', 'هند', 'مصر', 'اسپانیا']) {
    assert.ok(appSource.includes(country) || html.includes(country), country);
  }
  assert.match(html, /کشور سازنده از همان ستون تعیین می‌شود/);
});


test('producer country taxonomy is fixed and rendered read-only in the admin panel', () => {
  assert.match(html, /فهرست ثابت هفت کشور ستون «سازنده»/);
  assert.match(html, /data-type="country"[^>]*hidden/);
  assert.match(appSource, /if (type === 'country') {s*const record = document.createElement('div')/);
  assert.match(appSource, /مقدار ثابت ستون «سازنده»/);
});
