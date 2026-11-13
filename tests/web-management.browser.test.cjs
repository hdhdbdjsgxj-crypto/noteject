const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), appRoot = path.join(root, 'site-build/app');
const origin = process.env.NOTEJECT_LIVE_WEB ? 'https://noteject.vercel.app' : 'https://noteject.test';
const fixtureData = {
  boards: [{ id: 'b', name: 'Research board', items: [], edges: [] }, { id: 'b2', name: 'Other board', items: [], edges: [] }], activeBoard: 'b',
  notes: [{ id: 'n', title: 'Research note', content: 'Original note text', folder: 'Inbox', color: 'violet', tags: [], updated: 100 }, { id: 'keep', title: 'Keep this note', content: 'Other content', folder: 'Inbox', updated: 90 }],
  docs: [{ id: 'd', name: 'Reference.txt', type: 'txt', folder: 'Inbox', size: 8, added: 100 }],
  folders: ['Inbox', 'Research'], noteFolders: ['Inbox', 'Research'], folderProjects: { Inbox: 'inbox', Research: 'research' }, trash: [],
  workspace: { projects: [{ id: 'p', folder: 'Research', name: 'Research', color: 'violet', boardIds: ['b'] }], collections: [{ id: 'c', name: 'Saved notes', kind: 'note', query: '', folder: '', tag: '', fileType: '', favorite: false }], history: [] }
};
async function app(browser, { desktop = false, language = 'en', viewport = { width: 1360, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport }), failures = [], errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') { failures.push(url.href); return route.abort('failed'); }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, configured: false, cloudEnabled: false }) });
    if (url.origin !== origin) return route.fulfill({ status: 404, body: '' });
    if (process.env.NOTEJECT_LIVE_WEB) return route.continue();
    const name = url.pathname === '/app' ? 'index.html' : url.pathname.slice(5), filename = path.resolve(appRoot, name);
    if (!filename.startsWith(appRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' })[path.extname(filename)] || 'application/octet-stream', body: fs.readFileSync(filename) });
  });
  await context.addInitScript(({ data, desktop, origin }) => { if (!localStorage.getItem('noteject')) localStorage.setItem('noteject', JSON.stringify(data)); if (desktop) window.NotejectDesktop = { version: 'fixture', fileApiBase: origin }; }, { data: fixtureData, desktop, origin });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app?lang=' + language); await page.locator('.home-hero').waitFor();
  await page.evaluate(() => storeFile('d', new Blob(['ORIGINAL'], { type: 'text/plain' })));
  return { page, context, errors, failures };
}
const menu = page => page.locator('.nw-workspace-menu');
async function view(page, name, options) { await page.evaluate(({ name, options }) => openWorkspaceView(name, options), { name, options }); }
async function noteMenu(page, desktop = false) { await page.locator('.note-list-card[data-note="n"] ' + (desktop ? '.nw-note-more' : '.web-management-trigger')).click(); }
async function fileMenu(page) { await page.locator('[data-library-doc="d"] .web-management-trigger').click(); }

test('Web exposes the same management actions as Windows without changing its page layouts', { timeout: 100000 }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEJECT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  t.after(() => browser.close());
  await t.test('notes support edit, favorite, move, archive, and recoverable deletion', async () => {
    const { page, context, errors, failures } = await app(browser);
    try {
      await view(page, 'notes'); await noteMenu(page);
      assert.deepEqual(await menu(page).getByRole('menuitem').allTextContents(), ['Edit noteEnter', 'Add to favorites', 'Move to project…', 'Archive note', 'Delete note…Del']);
      await menu(page).getByRole('menuitem', { name: 'Add to favorites', exact: true }).click();
      assert.equal(await page.evaluate(() => data.notes.find(note => note.id === 'n').favorite), true);
      await noteMenu(page); await menu(page).getByRole('menuitem', { name: 'Edit note', exact: false }).click(); await page.locator('.note-visual-editor').waitFor();
      assert.equal(await page.locator('#edit-body').inputValue(), 'Original note text');
      await page.locator('.note-visual-editor').fill('Updated through the Web menu');
      await page.locator('.detail-panel [data-action="save-note"]').click();
      await page.waitForFunction(() => data.notes.find(note => note.id === 'n').content.includes('Updated through the Web menu'));
      await view(page, 'notes'); await noteMenu(page); await menu(page).getByRole('menuitem', { name: 'Move to project…', exact: true }).click();
      await page.locator('#move-notes-folder').selectOption('Research'); await page.locator('#move-notes-confirm').click();
      assert.equal(await page.evaluate(() => data.notes.find(note => note.id === 'n').folder), 'Research');
      await view(page, 'notes'); await noteMenu(page); await menu(page).getByRole('menuitem', { name: 'Delete note…', exact: false }).click();
      await page.locator('.noteject-dialog-confirm').click();
      assert.equal(await page.evaluate(() => data.notes.some(note => note.id === 'n')), false);
      assert.equal(await page.evaluate(() => data.notes.some(note => note.id === 'keep')), true);
      assert.equal(await page.evaluate(() => data.trash.some(entry => entry.type === 'note' && entry.payload.item.id === 'n')), true);
      assert.deepEqual(failures, []); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('file menu changes metadata and project without losing the original bytes', async () => {
    const { page, context, errors, failures } = await app(browser);
    try {
      await view(page, 'library'); await fileMenu(page);
      await menu(page).getByRole('menuitem', { name: 'Rename…', exact: false }).click();
      await page.locator('.nw-workspace-dialog input[name="name"]').fill('Renamed.txt'); await page.locator('.nw-workspace-dialog button[type="submit"]').click();
      await fileMenu(page); await menu(page).getByRole('menuitem', { name: 'Edit tags…', exact: true }).click();
      await page.locator('.nw-workspace-dialog input[name="tags"]').fill('science, reference'); await page.locator('.nw-workspace-dialog button[type="submit"]').click();
      assert.deepEqual(await page.evaluate(() => data.docs[0].tags), ['science', 'reference']);
      await fileMenu(page); await menu(page).getByRole('menuitem', { name: 'Move to project…', exact: true }).click();
      await page.locator('#move-folder-select').selectOption('Research'); await page.locator('#move-confirm').click();
      assert.equal(await page.evaluate(() => data.docs[0].folder), 'Research');
      assert.equal(await page.evaluate(async () => (await getDocumentBlob(data.docs[0])).text()), 'ORIGINAL');
      await fileMenu(page); await menu(page).getByRole('menuitem', { name: 'Delete file…', exact: true }).click(); await page.locator('.noteject-dialog-confirm').click();
      assert.equal(await page.evaluate(() => data.docs.length), 0);
      assert.equal(await page.evaluate(async () => (await getStoredFile('d')).text()), 'ORIGINAL');
      assert.deepEqual(failures, []); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('project management edits details, creates notes in the project, and moves assets safely on deletion', async () => {
    const { page, context, errors, failures } = await app(browser);
    try {
      await view(page, 'projects'); await page.locator('.nw-project-more').click();
      await menu(page).getByRole('menuitem', { name: 'Edit project…', exact: true }).click();
      await page.locator('.nw-workspace-dialog input[name="name"]').fill('Research updated');
      await page.locator('.nw-workspace-dialog textarea[name="description"]').fill('A project goal');
      await page.locator('.nw-workspace-dialog select[name="color"]').selectOption('teal');
      await page.locator('.nw-workspace-dialog button[type="submit"]').click();
      assert.deepEqual(await page.evaluate(() => { const project = data.workspace.projects.find(item => item.folder === 'Research updated'); return [project.name, project.description, project.color]; }), ['Research updated', 'A project goal', 'teal']);
      await page.getByRole('button', { name: 'Manage project ⋯', exact: true }).click();
      await menu(page).getByRole('menuitem', { name: 'New note in project', exact: true }).click(); await page.locator('.note-visual-editor').waitFor();
      assert.equal(await page.evaluate(() => data.notes.find(note => note.id === data.selected.id).folder), 'Research updated');
      await view(page, 'projects', { folder: 'Research updated' }); await page.getByRole('button', { name: 'Manage project ⋯', exact: true }).click();
      await menu(page).getByRole('menuitem', { name: 'Delete project…', exact: true }).click(); await page.locator('.nw-workspace-dialog button[type="submit"]').click();
      assert.equal(await page.evaluate(() => data.folders.includes('Research updated')), false);
      assert.equal(await page.evaluate(() => data.notes.length), 3);
      assert.equal(await page.evaluate(() => data.notes.every(note => note.folder === 'Inbox')), true);
      assert.deepEqual(failures, []); assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('Boards and Smart Collections share visible menus with working duplicate actions', async () => {
    const { page, context, errors } = await app(browser);
    try {
      await view(page, 'boardIndex'); await page.locator('.board-gallery-management > summary').first().click();
      await menu(page).getByRole('menuitem', { name: 'Duplicate board', exact: true }).click();
      await page.waitForFunction(() => data.boards.length === 3);
      await view(page, 'collections'); await page.locator('.wo-collection-management > summary').first().click();
      await menu(page).getByRole('menuitem', { name: 'Duplicate collection', exact: true }).click();
      await page.waitForFunction(() => data.workspace.collections.length === 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('Ukrainian menus fit narrow screens and Escape returns focus to their control', async () => {
    const { page, context, errors } = await app(browser, { language: 'uk', viewport: { width: 390, height: 844 } });
    try {
      await view(page, 'projects'); await page.locator('.nw-project-more').click();
      await page.waitForFunction(() => document.querySelector('.nw-workspace-menu')?.textContent.includes('Відкрити проєкт'));
      const bounds = await menu(page).boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845);
      assert(await menu(page).getByRole('menuitem').first().evaluate(button => button.getBoundingClientRect().height >= 44));
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.nw-project-more').evaluate(button => button === document.activeElement), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await t.test('Windows retains the shared note management actions', async () => {
    const { page, context, errors } = await app(browser, { desktop: true });
    try {
      await view(page, 'notes'); await noteMenu(page, true);
      await menu(page).getByRole('menuitem', { name: 'Delete note…', exact: false }).click(); await page.locator('.noteject-dialog-confirm').click();
      assert.equal(await page.evaluate(() => data.notes.length), 1); assert.equal(await page.evaluate(() => data.notes[0].id), 'keep');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
