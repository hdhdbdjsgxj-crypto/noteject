'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const { root, builtins } = require('../scripts/localization-catalog.cjs');
const base = builtins();
test('All interface catalogs preserve placeholders and cover Windows native menus', () => {
  const inventory = require('../audits/languages/catalog-inventory.json');
  const native = require('../desktop/localization.cjs'), menus = require('../desktop/locale-catalogs.json');
  assert.equal(base.dictionaries.pt.Bookmarks, 'Marcadores');
  assert.notEqual(base.dictionaries.pt.Bookmarks, base.dictionaries.pt.Favorites);
  for (const { code } of base.languages.filter(item => item.code !== 'en')) {
    const extra = JSON.parse(fs.readFileSync(path.join(root, 'locales', code + '.json')));
    for (const key of inventory.keys) {
      const value = base.dictionaries[code]?.[key] || extra[key];
      assert.equal(typeof value, 'string', code + ': ' + key);
      assert.ok(value.trim(), code + ': empty ' + key);
      assert.deepEqual([...value.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), [...key.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), code + ': changed placeholders in ' + key);
      assert.doesNotMatch(value, /NXPH\d|NJT\d|881199\d{4}|771199\d{4}/);
      if (/[A-Za-z]{2,}\s+[a-z]{2,}/.test(key) && !/^Mac · Apple silicon$/.test(key)) {
        assert.notEqual(value, key, code + ': English phrase stored as a translation: ' + key);
      }
    }
    for (const key of Object.keys(menus[code])) assert.equal(typeof native.text(key, code), 'string');
    assert.notEqual(native.text('&File', code), '&File');
    assert.equal(native.resolveLanguage(code + '-XX'), code);
  }
});

test('Regional locales translate live placeholders and file actions while protecting note text and project names', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEJECT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.setContent('<article class="note-list-card"><p id="empty" data-i18n>No content yet.</p><p id="user-note">Home</p><small><span id="project" data-i18n-ignore>Home</span> · <span id="updated" data-i18n>Updated</span></small></article><article class="markdown" id="preview">Home</article><button id="return">Return to Documents</button><button id="import">Import</button><button id="named">Actions for USER DOCUMENT</button>');
    await page.addScriptTag({ path: path.join(root, 'localization-catalogs.js') });
    await page.addScriptTag({ path: path.join(root, 'localization.js') });
    for (const { code } of base.languages) {
      await page.evaluate(code => NotejectI18n.setLanguage(code.toUpperCase() + '_XX'), code);
      const state = await page.evaluate(() => ({ locale: NotejectI18n.getLanguage(), empty: document.querySelector('#empty').textContent, expectedEmpty: NotejectI18n.t('No content yet.'), updated: document.querySelector('#updated').textContent, expectedUpdated: NotejectI18n.t('Updated'), user: document.querySelector('#user-note').textContent, project: document.querySelector('#project').textContent, preview: document.querySelector('#preview').textContent, named: document.querySelector('#named').textContent, expectedNamed: NotejectI18n.t('Actions for USER DOCUMENT'), back: document.querySelector('#return').textContent, expectedBack: NotejectI18n.t('Return to Documents'), import: document.querySelector('#import').textContent, expectedImport: NotejectI18n.t('Import') }));
      assert.equal(state.locale, code);
      assert.equal(state.empty, state.expectedEmpty, code + ': stale empty-note placeholder');
      assert.equal(state.updated, state.expectedUpdated);
      assert.equal(state.import, state.expectedImport);
      assert.equal(state.back, state.expectedBack);
      assert.equal(state.named, state.expectedNamed); assert.ok(state.named.includes('USER DOCUMENT'));
      if (code !== 'en') assert.notEqual(state.named, 'Actions for USER DOCUMENT');
      const dynamic = await page.evaluate(() => ({color:NotejectI18n.t('Violet selected'), expectedColor:NotejectI18n.t('Violet'), count:NotejectI18n.t('3 selected')}));
      assert.ok(dynamic.color.includes(dynamic.expectedColor), code + ': color label must use translated color');
      assert.ok(dynamic.count.includes('3'));
      if(code !== 'en') assert.notEqual(dynamic.count,'3 selected');
      if (code !== 'en') {
        const counters = await page.evaluate(() => ['1–1 of 1 boards', '1 of 1 file'].map(source => [source, NotejectI18n.t(source)]));
        counters.forEach(([source, translated]) => assert.notEqual(translated, source, code + ': untranslated counter'));
      }
      assert.equal(state.user, 'Home'); assert.equal(state.project, 'Home'); assert.equal(state.preview, 'Home');
      if (code !== 'en') { assert.notEqual(state.import, 'Import'); assert.notEqual(state.back, 'Return to Documents'); }
    }
  } finally { await browser.close(); }
});
test('Switch every language, including pretranslated dynamic controls, without changing user content', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEJECT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.setContent('<main><button id="action">Save passage</button><button id="later"></button><input id="query" placeholder="Find in document"><p id="count">Page 12 of 240</p><div class="reader-content">Home Copy</div><div contenteditable="true">Home Copy</div><p data-i18n-ignore>Home</p></main>');
    await page.addScriptTag({ path: path.join(root, 'localization-catalogs.js') });
    await page.addScriptTag({ path: path.join(root, 'localization.js') });
    for (const { code } of base.languages) {
      await page.evaluate(code => { NotejectI18n.setLanguage(code); document.getElementById('later').textContent = NotejectI18n.t('Copy'); }, code);
      await page.waitForTimeout(20);
      const state = await page.evaluate(() => ({ action: document.querySelector('#action').textContent, expected: NotejectI18n.t('Save passage'), count: document.querySelector('#count').textContent, expectedCount: NotejectI18n.t('Page 12 of 240'), reader: document.querySelector('.reader-content').textContent, note: document.querySelector('[contenteditable]').textContent, ignored: document.querySelector('[data-i18n-ignore]').textContent, dir: document.documentElement.dir }));
      assert.equal(state.action, state.expected); assert.equal(state.count, state.expectedCount);
      assert.equal(state.reader, 'Home Copy'); assert.equal(state.note, 'Home Copy'); assert.equal(state.ignored, 'Home');
      assert.equal(state.dir, code === 'ar' ? 'rtl' : 'ltr');
      await page.evaluate(() => NotejectI18n.setLanguage('en')); await page.waitForTimeout(20);
      assert.equal(await page.locator('#action').textContent(), 'Save passage');
      assert.equal(await page.locator('#later').textContent(), 'Copy', code + ': control created in another language must restore');
      assert.equal(await page.locator('#query').getAttribute('placeholder'), 'Find in document');
    }
  } finally { await browser.close(); }
});
