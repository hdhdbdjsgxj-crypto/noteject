const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const appRoot = path.join(root, 'site-build', 'app');
const workspace = { boards: [{ id: 'b', name: 'Board', items: [] }], activeBoard: 'b', notes: [], docs: [], folders: ['Inbox'], noteFolders: ['Inbox'], folderProjects: { Inbox: 'inbox' }, trash: [] };
test('hosted AI settings stay responsive and use the server plan; Reader sends the chosen AI mode', { timeout: 60000 }, async t => {
  let enabled = false;
  const publicConfig = () => ({ cloudEnabled: true, supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'sb_publishable_test', aiEnabled: enabled, checkoutPlans: enabled ? ['starter', 'pro'] : [] });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      const body = pathname === '/api/site-config' ? publicConfig() : pathname === '/api/key-status' ? { configured: enabled, hosted: true } : pathname === '/api/models' ? { models: [] } : pathname === '/api/account' ? { plan: 'pro', basic: { used: 100, limit: 1000 }, advanced: { used: 4, limit: 100 }, resetsAt: '2099-01-01', checkoutPlans: ['starter','pro'], canManageSubscription: true } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(body));
    }
    if (pathname !== '/app' && !pathname.startsWith('/app/')) return res.writeHead(404).end();
    const relative = pathname === '/app' ? 'index.html' : pathname.slice(5) || 'index.html', file = path.resolve(appRoot, relative);
    if (!file.startsWith(appRoot + path.sep) || !/\.(html|m?js|css|svg|png|woff2?|ttf|wasm)$/.test(file) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.wasm':'application/wasm' })[path.extname(file)] || 'application/octet-stream');
    const bytes = fs.readFileSync(file);
    res.end(relative === 'index.html' ? bytes.toString().replace('<head>', '<head><script>window.NotejectWebApp=true;</script>') : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTEJECT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  await t.test('missing service setup hides personal-key controls without freezing Settings', async () => {
    const page = await browser.newPage(); page.setDefaultTimeout(7000); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(data => localStorage.setItem('noteject', JSON.stringify(data)), workspace);
    await page.goto(origin + '/app'); await page.locator('#open-settings').click(); await page.locator('[data-settings-tab="ai"]').click();
    assert.equal(await page.evaluate(() => document.baseURI), origin + '/app/');
    await page.locator('.ai-plans-card').waitFor();
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => typeof window.NotejectCloud), 'object');
    assert.equal(await page.locator('#settings-api-key').count(), 0, 'Manual API-key controls have been removed');
    assert.equal(await page.locator('[data-ai-upgrade="starter"]').textContent(), 'Coming soon');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
    await page.locator('[data-settings-tab="general"]').click(); await page.locator('[data-settings-tab="ai"]').click();
    assert.equal(await page.locator('.ai-plan-card').count(), 4); assert.deepEqual(errors, []);
    await page.close();
  });
  await t.test('signed-in plan and separate remaining counts come from the server account endpoint', async () => {
    enabled = true;
    let refreshes = 0;
    const page = await browser.newPage(); page.setDefaultTimeout(7000); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://example.supabase.co/**', async route => {
      const user = { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.test', app_metadata: { noteject_plan: 'team' } };
      let body = route.request().url().includes('/auth/v1/user') ? user : [];
      if (route.request().url().includes('/auth/v1/token')) { refreshes++; await new Promise(resolve => setTimeout(resolve, 400)); body = { access_token: 'refreshed-test-token', refresh_token: 'new-refresh-token', expires_in: 3600, user }; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.addInitScript(({ data, origin }) => {
      localStorage.setItem('noteject', JSON.stringify(data));
      localStorage.setItem('noteject-cloud-session-v1:' + origin, JSON.stringify({ access_token: 'user-test-token', refresh_token: 'refresh-test-token', expires_at: 0, user: { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.test' } }));
    }, { data: workspace, origin });
    await page.goto(origin + '/app'); await page.locator('#open-settings').click(); await page.locator('[data-settings-tab="ai"]').click();
    assert.deepEqual(errors, []);
    assert.equal(refreshes, 1, 'concurrent account loads must share one token refresh');
    await page.waitForFunction(() => document.querySelector('[data-ai-account-status]')?.textContent.startsWith('Pro · Basic: 100 / 1000'), null, { timeout: 7000 });
    assert.equal(await page.locator('[data-ai-upgrade="pro"]').textContent(), 'Current plan');
    assert.equal(await page.locator('[data-ai-upgrade="team"]').isDisabled(), true);
    await page.locator('#noteject-cloud-trigger').click();
    await page.waitForFunction(() => document.querySelector('#cloud-account-plan')?.textContent.includes('900 basic remaining this month · 96 advanced remaining'));
    assert.deepEqual(errors, []);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
    await page.locator('.cloud-close').click();
    await fs.promises.mkdir(path.join(root, '.desktop-build'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.desktop-build/cloud-plan-review.png'), fullPage: true });
    await page.close();
  });
  await t.test('plan controls fit portrait and landscape layouts and retain touch targets', async () => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      const page = await browser.newPage({ viewport }); page.setDefaultTimeout(7000);
      await page.addInitScript(data => localStorage.setItem('noteject', JSON.stringify(data)), workspace);
      await page.goto(origin + '/app');
      if (viewport.width < 960) {
        await page.locator('.wm-bottom-nav [data-wm-view=menu]').click();
        await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
        assert.equal(await page.locator('.web-nav-close').evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.web-nav-toggle').getAttribute('aria-expanded'), 'false');
        await page.locator('.wm-bottom-nav [data-wm-view=menu]').click();
      }
      await page.locator('#open-settings').click(); await page.locator('[data-settings-tab="ai"]').click();
      await page.locator('.ai-plans-card').waitFor();
      const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, height: document.querySelector('[data-ai-refresh]').getBoundingClientRect().height, wide: [...document.querySelectorAll('.app,.main,.sidebar,.topbar,#view,.settings-menu-page,.settings-menu-layout,.settings-menu-content,.ai-plans-card,.ai-plan-grid')].map(el => ({ name: el.className || el.id, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })) }));
      assert.equal(layout.overflow, false, JSON.stringify(layout)); assert(layout.height >= 44);
      await page.close();
    }
  });
  await t.test('Reader Advanced selection reaches the AI request and citations stay clickable', async () => {
    const page = await browser.newPage(); await page.goto(origin + '/app');
    await page.evaluate(() => {
      window.NotejectWebApp = true;
      const doc = { id: 'test-document' }, sections = [{ id: 's1', body: 'A passage about gravity.', label: 'Page 1' }];
      window.NotejectSmartSearch = { tokenize: () => ['gravity'], create: () => ({ search: () => sections }) };
      window.readerFixture = NotejectReaderAssistant.create({ getDocument: () => doc, getSections: async () => sections, askAI: async request => { window.submittedAI = { aiTier: request.aiTier, context: request.context }; return 'An explanation. [S1]'; } });
      document.body.innerHTML = readerFixture.render(doc); readerFixture.mount();
    });
    await page.locator('[data-ra-mode="ai"]').click(); await page.locator('[data-ra-tier]').selectOption('advanced');
    await page.locator('[data-ra-question]').fill('Explain gravity'); await page.locator('.ra-submit').click();
    await page.locator('.ra-inline-citation').waitFor();
    assert.equal(await page.evaluate(() => submittedAI.aiTier), 'advanced');
    assert.equal(await page.locator('.ra-inline-citation').textContent(), '[S1]');
    await page.close();
  });
});
