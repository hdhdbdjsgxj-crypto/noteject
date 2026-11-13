const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { zip } = require('./backup-fixture.cjs');
const root = path.resolve(__dirname, '..'), appRoot = path.join(root, 'site-build/app');
const origin = process.env.NOTEJECT_LIVE_WEB ? 'https://noteject.vercel.app' : 'https://noteject.test', cloud = 'https://fixture.supabase.co';
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.test' };
const workspace = { boards: [{ id: 'board', name: 'Reading', items: [], edges: [] }], activeBoard: 'board', notes: [], docs: [], folders: ['Inbox'], noteFolders: ['Inbox'], folderProjects: { Inbox: 'inbox' }, trash: [] };
const text = 'This original document must survive import, reload, cloud upload, and restore.';

function pdf() {
  const stream = 'BT /F1 20 Tf 30 150 Td (Noteject Web Reader) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let content = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content);
  return Buffer.from(content + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}

async function fixture(browser) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const state = { head: null, archives: new Map(), localRequests: [], errors: [], failedRequests: [], chunks: [], loseChunkResponse: false, holdHead: false, failHead: false };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') { state.localRequests.push(request.url()); return route.abort('failed'); }
    if (url.origin === origin) {
      if (url.pathname === '/api/site-config') return json({ cloudEnabled: true, supabaseUrl: cloud, supabaseAnonKey: 'sb_publishable_fixture', aiEnabled: false, checkoutPlans: [], syncMaxBytes: 20 * 1024 * 1024 });
      if (url.pathname === '/api/account') return json({ plan: 'free', basic: { used: 0, limit: 10 }, advanced: { used: 0, limit: 0 }, checkoutPlans: [] });
      if (url.pathname.startsWith('/api/')) return json({ configured: false });
      if (process.env.NOTEJECT_LIVE_WEB) return route.continue();
      const relative = url.pathname === '/app' ? 'index.html' : url.pathname.slice('/app/'.length), filename = path.resolve(appRoot, relative);
      if (!url.pathname.startsWith('/app') || !filename.startsWith(appRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' })[path.extname(filename)] || 'application/octet-stream', body: fs.readFileSync(filename) });
    }
    if (url.hostname === 'fixture.supabase.co' || url.hostname === 'fixture.storage.supabase.co') {
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/rest/v1/workspace_sync_heads') {
        if (state.failHead) return route.abort('failed');
        if (state.holdHead) { state.holdHead = false; await new Promise(resolve => { state.releaseHead = resolve; }); }
        return json(state.head ? [state.head] : []);
      }
      if (url.pathname === '/rest/v1/rpc/noteject_advance_workspace') {
        const body = request.postDataJSON();
        assert.equal(body.p_expected_revision, state.head?.revision || 0);
        assert.equal(state.archives.get(body.p_snapshot_path)?.length, body.p_archive_size);
        state.head = { revision: (state.head?.revision || 0) + 1, snapshot_path: body.p_snapshot_path, archive_size: body.p_archive_size, updated_at: new Date().toISOString() };
        return json(state.head.revision);
      }
      const object = url.pathname.match(/^\/storage\/v1\/object\/(authenticated\/)?noteject-workspaces\/(.+)$/);
      if (object) {
        const key = decodeURIComponent(object[2]);
        assert(key.startsWith(user.id + '/'));
        assert.equal(request.headers().authorization, 'Bearer fixture-token');
        if (method === 'POST') { state.archives.set(key, request.postDataBuffer()); return json({ Key: key }); }
        if (method === 'DELETE') { state.archives.delete(key); return json({}); }
        if (method === 'GET') return route.fulfill({ status: 200, contentType: 'application/zip', body: state.archives.get(key) });
      }
      if (url.pathname === '/storage/v1/upload/resumable' && method === 'POST') {
        const metadata = Object.fromEntries(request.headers()['upload-metadata'].split(',').map(item => { const [key, value] = item.split(' '); return [key, Buffer.from(value, 'base64').toString()]; }));
        state.transfer = { key: metadata.objectName, size: Number(request.headers()['upload-length']), bytes: Buffer.alloc(0) };
        return route.fulfill({ status: 201, headers: { Location: cloud + '/storage/v1/upload/resumable/fixture', 'Tus-Resumable': '1.0.0', 'Access-Control-Expose-Headers': 'Location,Upload-Offset,Tus-Resumable' } });
      }
      if (url.pathname === '/storage/v1/upload/resumable/fixture') {
        const transfer = state.transfer;
        if (method === 'HEAD') return route.fulfill({ status: 200, headers: { 'Upload-Offset': String(transfer.bytes.length), 'Access-Control-Expose-Headers': 'Upload-Offset' } });
        assert.equal(Number(request.headers()['upload-offset']), transfer.bytes.length);
        const chunk = request.postDataBuffer(); state.chunks.push(chunk.length); transfer.bytes = Buffer.concat([transfer.bytes, chunk]);
        if (transfer.bytes.length === transfer.size) state.archives.set(transfer.key, transfer.bytes);
        if (state.loseChunkResponse) { state.loseChunkResponse = false; return route.abort('failed'); }
        return route.fulfill({ status: 204, headers: { 'Upload-Offset': String(transfer.bytes.length), 'Access-Control-Expose-Headers': 'Upload-Offset' } });
      }
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await context.addInitScript(({ workspace, origin, user }) => {
    if (!localStorage.getItem('noteject')) localStorage.setItem('noteject', JSON.stringify(workspace));
    localStorage.setItem('noteject-cloud-session-v1:' + origin, JSON.stringify({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_at: 4102444800, user }));
  }, { workspace, origin, user });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => state.errors.push(error.message));
  page.on('requestfailed', request => state.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) state.failedRequests.push({ url: response.url(), status: response.status() }); });
  await page.goto(origin + '/app?lang=en'); await page.locator('.home-hero').waitFor();
  assert.equal(await page.evaluate(() => window.NotejectWebApp), true, 'Use the real hosted bootstrap, including its platform detection');
  return { context, page, state };
}
async function openCloud(page) {
  await page.locator('#noteject-cloud-trigger').click();
  await page.waitForFunction(() => document.getElementById('cloud-head-status').textContent.startsWith('No cloud copy yet.') || document.getElementById('cloud-head-status').textContent.startsWith('Cloud copy'));
}
async function importFiles(page, files) {
  const count = await page.evaluate(() => data.docs.length);
  await page.locator('#file-picker').setInputFiles(files);
  await page.waitForFunction(expected => data.docs.length === expected, count + files.length);
  await page.waitForFunction(() => document.querySelector('.ip-card header small')?.textContent === 'IMPORT COMPLETE');
}

test('Web file storage and cloud backup workflows use browser files and report completion', { timeout: 120000 }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEJECT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  t.after(() => browser.close());
  await t.test('actual file-picker import survives reload and renders PDF pages', async () => {
    const { context, page, state } = await fixture(browser);
    try {
      await importFiles(page, [{ name: 'Reference.txt', mimeType: 'text/plain', buffer: Buffer.from(text) }, { name: 'Book.pdf', mimeType: 'application/pdf', buffer: pdf() }]);
      assert.equal(await page.evaluate(async () => (await getStoredFile(data.docs[0].id)).text()), text);
      await page.reload(); await page.locator('.home-hero').waitFor();
      await page.locator('.recent-card').filter({ hasText: 'Reference.txt' }).click();
      await page.waitForFunction(expected => document.getElementById('txt-content')?.textContent === expected, text);
      await page.evaluate(() => openDocument(data.docs.find(doc => doc.type === 'pdf').id));
      try {
        await page.waitForFunction(() => document.querySelector('.reader-pdf-canvas') || extractionError, null, { timeout: 20000 });
        assert.equal(await page.evaluate(() => extractionError), '', 'The deployed PDF engine must open the file');
      }
      catch (error) {
        fs.mkdirSync(path.join(root, '.desktop-build'), { recursive: true });
        await page.screenshot({ path: path.join(root, '.desktop-build/web-pdf-import-failure.png') });
        throw Error(error.message + '\nReader diagnostics: ' + JSON.stringify({ failures: state.failedRequests, errors: state.errors, reader: await page.evaluate(() => ({ error: extractionError, text: document.querySelector('.reader-content')?.innerText.slice(0, 700) })) }));
      }
      assert(await page.locator('.reader-pdf-canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0));
      fs.mkdirSync(path.join(root, '.desktop-build'), { recursive: true });
      await page.screenshot({ path: path.join(root, '.desktop-build/web-pdf-import-verified.png') });
      assert.deepEqual(state.localRequests, []); assert.deepEqual(state.errors, []);
    } finally { await context.close(); }
  });
  await t.test('cloud upload shows progress while connecting, then saves and restores original files', async () => {
    const { context, page, state } = await fixture(browser);
    try {
      await importFiles(page, [{ name: 'Reference.txt', mimeType: 'text/plain', buffer: Buffer.from(text) }]);
      await openCloud(page); state.holdHead = true;
      await page.locator('#cloud-upload').click();
      assert.equal(await page.locator('#cloud-progress').isVisible(), true);
      assert.match(await page.locator('#cloud-notice').textContent(), /Connecting to your cloud backup/);
      assert.equal(await page.locator('#cloud-upload').isDisabled(), true);
      await page.waitForFunction(() => document.getElementById('cloud-upload').disabled);
      // Release the held network request only after the interface reports progress.
      const deadline = Date.now() + 5000;
      while (!state.releaseHead && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert(state.releaseHead, 'Upload must request the current cloud revision');
      state.releaseHead();
      await page.waitForFunction(() => document.getElementById('cloud-notice').textContent.startsWith('This device is synced.'));
      assert(state.head.archive_size > text.length);
      await page.evaluate(() => { data.notes.push({ id: 'local-only', title: 'Local change', content: '', folder: 'Inbox' }); save(); });
      await page.locator('#cloud-download').click(); await page.locator('.noteject-dialog-confirm').click();
      await page.waitForFunction(() => document.getElementById('cloud-notice').textContent === 'Cloud workspace restored on this device.');
      assert.equal(await page.evaluate(() => data.notes.length), 0);
      assert.equal(await page.evaluate(async () => (await getStoredFile(data.docs[0].id)).text()), text);
      assert.match(await page.evaluate(() => data.attachmentKeys[data.docs[0].id]), /^import:/);
      await page.reload();
      assert.equal(await page.evaluate(async () => (await getDocumentBlob(data.docs[0])).text()), text);
      // A second device has no remembered revision, so upload requires a
      // confirmation above the account dialog. It must accept real clicks.
      await page.evaluate(userId => localStorage.removeItem('noteject-cloud-sync-v1:' + userId), user.id);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCloud(page); await page.locator('#cloud-upload').click();
      await page.locator('.noteject-dialog-cancel').click();
      await page.waitForFunction(() => !document.getElementById('cloud-upload').disabled);
      assert.equal(state.head.revision, 1, 'Cancelling keeps the cloud copy');
      await page.locator('#cloud-upload').click();
      await page.locator('.noteject-dialog-confirm').click();
      await page.waitForFunction(() => document.getElementById('cloud-notice').textContent.startsWith('This device is synced.'));
      assert.equal(state.head.revision, 2);
      assert.equal(state.archives.size, 1);
      assert.deepEqual(state.localRequests, []); assert.deepEqual(state.errors, []);
    } finally { await context.close(); }
  });
  await t.test('7 MB cloud upload resumes after a lost chunk response and finishes without duplicate bytes', async () => {
    const { context, page, state } = await fixture(browser);
    try {
      await importFiles(page, [{ name: 'Original.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(7 * 1024 * 1024, 42) }]);
      await openCloud(page); state.loseChunkResponse = true;
      await page.locator('#cloud-upload').click();
      await page.waitForFunction(() => ['success', 'error'].includes(document.getElementById('cloud-notice').dataset.tone), null, { timeout: 30000 });
      assert.match(await page.locator('#cloud-notice').textContent(), /^This device is synced\./);
      assert.equal(state.chunks.length, 2);
      assert.equal(state.transfer.bytes.length, state.head.archive_size);
      assert.deepEqual(state.localRequests, []); assert.deepEqual(state.errors, []);
    } finally { await context.close(); }
  });
  await t.test('failed cloud connection shows an error and enables upload for retry', async () => {
    const { context, page, state } = await fixture(browser);
    try {
      await openCloud(page); state.failHead = true;
      await page.locator('#cloud-upload').click();
      await page.waitForFunction(() => document.getElementById('cloud-notice').dataset.tone === 'error');
      assert.match(await page.locator('#cloud-notice').textContent(), /Could not reach Noteject Cloud/);
      assert.equal(await page.locator('#cloud-upload').isEnabled(), true);
      assert.equal(await page.locator('#cloud-progress').isVisible(), false);
      assert.equal(state.archives.size, 0);
      state.failHead = false;
      await page.locator('#cloud-upload').click();
      await page.waitForFunction(() => document.getElementById('cloud-notice').dataset.tone === 'success');
      assert.equal(state.archives.size, 1, 'Upload can be retried after the connection returns');
    } finally { await context.close(); }
  });
  await t.test('a failed ZIP restore cannot replace or delete an existing Web file with the same ID', async () => {
    const { context, page, state } = await fixture(browser);
    try {
      await importFiles(page, [{ name: 'Reference.txt', mimeType: 'text/plain', buffer: Buffer.from(text) }]);
      const current = await page.evaluate(() => JSON.parse(JSON.stringify(data))), first = current.docs[0];
      current.docs.push({ id: 'incomplete', name: 'Incomplete.txt', type: 'txt', folder: 'Inbox', size: 10 });
      const replacement = 'Replacement contents', manifest = { format: 'noteject-portable-backup', version: 1, workspace: current, attachments: [{ documentId: first.id, path: 'attachments/0', name: first.name, type: 'text/plain', size: replacement.length }, { documentId: 'incomplete', path: 'attachments/1', name: 'Incomplete.txt', type: 'text/plain', size: 10 }] };
      const archive = zip({ 'manifest.json': JSON.stringify(manifest), 'attachments/0': replacement, 'attachments/1': 'bad' });
      const result = page.evaluate(encoded => loadWorkspaceBackup(new File([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], 'Incomplete.zip', { type: 'application/zip' })), archive.toString('base64'));
      await page.locator('.noteject-dialog-confirm').click(); assert.equal(await result, false);
      assert.equal(await page.evaluate(() => data.docs.length), 1);
      await page.reload();
      assert.equal(await page.evaluate(async () => (await getStoredFile(data.docs[0].id)).text()), text);
      assert.deepEqual(state.localRequests, []); assert.deepEqual(state.errors, []);
    } finally { await context.close(); }
  });
  await t.test('legacy JSON backup publishes browser attachment bindings and returns success', async () => {
    const { context, page, state } = await fixture(browser);
    try {
      const backup = { ...workspace, docs: [{ id: 'legacy-file', name: 'Reference.txt', type: 'txt', folder: 'Inbox', size: Buffer.byteLength(text), attachment: { type: 'text/plain', data: Buffer.from(text).toString('base64') } }] };
      const result = page.evaluate(backup => loadWorkspaceBackup(new File([JSON.stringify(backup)], 'Legacy.json', { type: 'application/json' })), backup);
      await page.locator('.noteject-dialog-confirm').click(); assert.equal(await result, true);
      await page.reload();
      assert.equal(await page.evaluate(async () => (await getDocumentBlob(data.docs[0])).text()), text);
      assert.match(await page.evaluate(() => data.attachmentKeys['legacy-file']), /^import:/);
      assert.deepEqual(state.localRequests, []); assert.deepEqual(state.errors, []);
    } finally { await context.close(); }
  });
});
