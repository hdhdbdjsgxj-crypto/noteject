'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { root, builtins } = require('./localization-catalog.cjs');
const base = builtins(), origin = 'https://noteject.test';
const output = path.join(root, 'audits/languages'); fs.mkdirSync(output, { recursive: true });
const modes = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : ['web-desktop', 'web-mobile', 'windows', 'android', 'site'];
const codes = process.argv[3] ? [process.argv[3]] : base.languages.map(item => item.code);
const fixture = { boards: [{ id: 'loc-board', name: 'USER BOARD', items: [], edges: [] }], activeBoard: 'loc-board',
  notes: [{ id: 'loc-note', title: 'USER NOTE', content: 'Home\n\nCopy', folder: 'Inbox', color: 'violet', tags: [], updated: Date.now() }],
  docs: [{ id: 'loc-doc', name: 'USER DOCUMENT.txt', type: 'txt', text: 'Home\n\nCopy', localUrl: 'data:text/plain,Home%0A%0ACopy', folder: 'Inbox', size: 10, added: Date.now() }], folders: ['Inbox'], noteFolders: ['Inbox'], folderProjects: {}, trash: [] };
const supplement = fs.existsSync(path.join(root, 'localization-catalogs.js')) ? fs.readFileSync(path.join(root, 'localization-catalogs.js'), 'utf8') : '';
const reports = [], missing = new Set();
async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEJECT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try { for (const mode of modes) {
    const mobile = mode === 'android' || mode === 'web-mobile';
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 } });
    const assetRoot = mode === 'android' ? path.join(root, 'android/app/src/main/assets') : root;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.fulfill({ status: 404, body: '' });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, configured: false, cloudEnabled: false, aiEnabled: false, fileStorage: true, models: [] }) });
      const actualRoot = mode === 'site' && !url.pathname.startsWith('/app/') ? path.join(root, 'site') : assetRoot;
      const routePath = mode === 'site' ? url.pathname.replace(/^\/app\//, '/') : url.pathname;
      const file = path.resolve(actualRoot, '.' + (routePath === '/' ? '/index.html' : routePath));
      if (!file.startsWith(assetRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    });
    await context.addInitScript(({ fixture, mode, supplement }) => {
      localStorage.setItem('noteject', JSON.stringify(fixture)); localStorage.setItem('noteject-language-v1', 'en');
      if (supplement) (0, eval)(supplement);
      if (mode === 'windows') window.NotejectDesktop = { version: '0.2.48', fileApiBase: location.origin, setAppLanguage() {} };
      else if (mode === 'android') window.NotejectAndroid = { getAppVersion() { return '1.10.46'; }, setAppLanguage() {}, apiRequest(route, method, body, id) { queueMicrotask(() => window.__notejectAndroidResponse(id, JSON.stringify({ ok: true, configured: false, fileStorage: true }), 200)); } };
      else if (mode !== 'site') { window.NotejectWebApp = true; document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('noteject-web'), { once: true }); }
    }, { fixture, mode, supplement });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.waitForFunction(site => !!window.NotejectI18n && (site || !!window.openWorkspaceView), mode === 'site');
    async function capture(code, name) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const values = await page.evaluate(({ code, baseValues }) => {
        if (code === 'en') return { missing: [], unapplied: [] };
        const catalog = { ...(window.NotejectLocaleCatalogs?.[code] || {}), ...baseValues }, translatedValues = new Set(Object.values(catalog));
        const dateValues = new Set([{}, {dateStyle:'full'}, {dateStyle:'long'}, {weekday:'long',year:'numeric',month:'long',day:'numeric'}].map(options => new Date().toLocaleDateString(code, options)));
        const skip = 'script,style,noscript,kbd,code,textarea,[contenteditable],[data-i18n-ignore],.reader-content,.reader-document-identity,.note-list-card h3,.note-list-card p,.canvas-card h3,.canvas-card p,.board-nav-row,.recent-card h3,.search-result h3,.search-result p,.inbox-item-copy>p,.inbox-item-title,.ib-item-menu strong,.aa-transcript-preview,.aa-recording-copy strong,.smart-source-preview,.smart-source-copy>b';
        const technical = /^(?:USER .+|noteject|Windows|Android|macOS|iPhone|iPad|iMac|Safari|PDF|DjVu|EPUB|TXT|DOCX?|XLSX?|PPTX?|OCR|CSV|ZIP|JSON|HTML|Markdown|OpenAI|MuPDF|DjVuLibre|AGPL|GNU|Artifex|API|APK|Free|Starter|Pro|Team|Cloud|UTC|English|Español|Français|Deutsch|Italiano|Português|Türkçe|[A-Z0-9.+/#@:_\- ]+)$/;
        const found = new Set(), unapplied = new Set();
        function check(source, current) {
          source = source?.trim();
          current = current?.trim();
          if (dateValues.has(source)) return;
          if (/^\d+(?:\.\d+){1,3}(?:\s*·\s*(?:Android|Windows))?$/.test(source || '')) return;
          const core = source?.replace(/^[＋+☆★☰▦●←→↗↓↑✦✧▤✎⇩⛶↶↷‹•⌕☷⋯☼▶■Ⅱ◇▧]\s*/, '').replace(/\s*[←→↗↓↑›⋯]$/, '');
          if (core && catalog[core] === core) {
            if (/[A-Za-z]{2,}\s+[a-z]{2,}/.test(core) && !/^Mac · Apple silicon$/.test(core)) found.add(source);
            return;
          }
          if (source && current === source && window.NotejectI18n.t(source) !== source) { unapplied.add(source); return; }
          if (!source || technical.test(source) || !/[A-Za-z]{3}/.test(source) || source.includes('USER ') || /^(?:[●·•]\s*)?(?:PDF|DjVu|EPUB|TXT|DOC|XLS|PPT)(?:\s*·\s*(?:PDF|DjVu|EPUB|TXT|DOC|XLS|PPT))*$/.test(source) || catalog[source] || translatedValues.has(source) || window.NotejectI18n.t(source) !== source || /^https?:|^\S+@\S+\.\S+$/.test(source)) return;
          found.add(source);
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) if (!node.parentElement.closest(skip) && !node.parentElement.closest('#noteject-language,#noteject-language-quick') && node.parentElement.checkVisibility({ checkVisibilityCSS: true })) check(node.__notejectI18nSource || node.nodeValue, node.nodeValue);
        for (const element of document.querySelectorAll('[aria-label],[placeholder],[title]')) if (!element.closest(skip) && element.checkVisibility({ checkVisibilityCSS: true })) for (const attr of ['aria-label','placeholder','title']) check(element.__notejectI18nAttrs?.[attr]?.source || element.getAttribute(attr), element.getAttribute(attr));
        return { missing: [...found], unapplied: [...unapplied] };
      }, { code, baseValues: base.dictionaries[code] || {} });
      values.missing.forEach(value => missing.add(value)); reports.push({ mode, language: code, page: name, ...values });
    }
    for (const code of codes) {
      if (mode === 'site') {
        for (const file of ['index.html','privacy.html','terms.html','source.html']) { await page.goto(origin + '/' + file); await page.waitForFunction(() => !!window.NotejectI18n); await page.evaluate(code => window.NotejectI18n.setLanguage(code), code); await capture(code, file); }
        console.log(mode + ' / ' + code + ': audited 4 pages'); continue;
      }
      await page.evaluate(code => window.NotejectI18n.setLanguage(code), code);
      for (const target of ['home','notes','reading','projects','favorites','history','collections','boardIndex','graph','smart','inbox','library','trash']) {
        await page.evaluate(target => { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); view = target; data.selected = null; render(); document.querySelectorAll('#view details').forEach(details => details.open = true); }, target);
        await capture(code, target);
      }
      await page.locator('#open-settings').evaluate(el => el.click());
      for (const section of ['general','storage','ai','about']) { await page.locator('[data-settings-tab="' + section + '"]').evaluate(el => el.click()); await capture(code, 'settings-' + section); }
      await page.evaluate(() => { view = 'projects'; render(); document.querySelector('[data-wo-action="new-project"]')?.click(); });
      const steps = await page.locator('[data-ps-step]').count();
      for (let i = 0; i < steps; i++) { await page.locator('[data-ps-step]').nth(i).evaluate(el => el.click()); await capture(code, 'project-setup-' + i); }
      await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); view = 'collections'; render(); document.querySelector('[data-wo-action="new-collection"]')?.click(); }); await capture(code, 'collection-editor');
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
      await page.evaluate(() => { view = 'board'; data.boards[0].items = [{ id: 'loc-note', type: 'note', x: 400, y: 400 }, { id: 'loc-doc', type: 'document', x: 800, y: 400 }]; boardSelection = new Set(['loc-note','loc-doc']); render(); }); await capture(code, 'board-selection');
      await page.evaluate(() => { view = 'notes'; data.selected = { type: 'note', id: 'loc-note' }; render(); edit(data.notes[0]); }); await capture(code, 'note-editor');
      if (await page.locator('#edit-body').inputValue() !== 'Home\n\nCopy') throw Error('Localization changed user note content');
      await page.locator('[data-format="link"]').evaluate(el => el.click()); await capture(code, 'note-link-picker');
      await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); view = 'library'; data.selected = null; render(); openDocument('loc-doc'); }); await capture(code, 'reader');
      await page.evaluate(() => document.querySelectorAll('.reader-shell details').forEach(details => details.open = true)); await capture(code, 'reader-menu');
      await page.evaluate(() => window.NotejectReaderMenu.showHelp()); await capture(code, 'reader-help');
      await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); document.querySelector('#noteject-cloud-trigger')?.click(); }); await capture(code, 'account');
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
      if (mode === 'android') { await page.evaluate(async () => { window.NotejectAndroidAudio = { command: async () => ({ status:'idle', recordings:[], capabilities:{localTranscription:true} }), subscribe(){return ()=>{};} }; await window.NotejectAndroidAudioUI.open(); }); await capture(code, 'recordings'); await page.evaluate(() => window.NotejectAndroidAudioUI.leavePage()); }
      console.log(mode + ' / ' + code + ': audited pages, menus, and workflows');
    }
    if (errors.length) throw Error(mode + ': ' + errors.join('; '));
    await context.close();
  } } finally { await browser.close(); fs.writeFileSync(path.join(output, 'runtime-' + (process.argv[2] || 'all') + '.json'), JSON.stringify(reports, null, 2)); const previousFile = path.join(output, 'missing-keys.json'); const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile)) : []; fs.writeFileSync(previousFile, JSON.stringify([...new Set([...previous,...missing])].sort(), null, 2)); }
  console.log('Untranslated interface phrases: ' + missing.size);
  console.log('Translations not applied: ' + [...new Set(reports.flatMap(row => row.unapplied || []))].length);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
