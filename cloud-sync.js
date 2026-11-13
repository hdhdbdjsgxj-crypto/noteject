(() => {
  'use strict';
  const SESSION_PREFIX = 'noteject-cloud-session-v1:', SYNC_PREFIX = 'noteject-cloud-sync-v1:';
  const MAX_CLOUD_BACKUP_BYTES = 15 * 1024 * 1024 * 1024;
  const browserWorkspace = !!window.NotejectWebApp;
  const nativeApple = !!window.NotejectAppleNative;
  const hostedWeb = browserWorkspace && !nativeApple;
  if (browserWorkspace) document.documentElement.classList.add('noteject-web');
  let origin = nativeApple ? 'https://noteject.vercel.app' : hostedWeb ? location.origin : String(window.NOTEJECT_CLOUD_ORIGIN || 'https://noteject.vercel.app').replace(/\/+$/, '');
  let config = null, session = null, dialog = null, authMode = 'signin', syncBusy = false, account = null, refreshPromise = null, refreshOwner = '', paddlePromise = null, paddleInitialized = false;
  let accountGeneration = 0, authRequest = 0, transfer = null;
  const byId = id => document.getElementById(id);
  const setText = (node, text) => {
    const translated = window.NotejectI18n?.t?.(text) || text;
    if (node && node.textContent !== translated) {
      node.textContent = translated;
      if (node.firstChild) { node.firstChild.__notejectI18nSource = text; node.firstChild.__notejectI18nLast = translated; }
    }
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const sessionKey = () => SESSION_PREFIX + origin;
  const syncKey = userId => SYNC_PREFIX + userId;

  function restoreSession() {
    let value = null;
    try { value = origin ? JSON.parse(localStorage.getItem(sessionKey()) || 'null') : null; } catch {}
    saveSession(value);
  }
  const identity = value => value?.user?.id || value?.refresh_token || value?.access_token || '';
  const accountOwner = () => ({ generation: accountGeneration, origin, userId: session?.user?.id || '' });
  const ownsAccount = owner => owner.generation === accountGeneration && owner.origin === origin && owner.userId === (session?.user?.id || '') && !owner.controller?.signal.aborted;
  function assertOwner(owner) {
    if (!ownsAccount(owner)) throw Object.assign(Error('The cloud account changed. Start this action again.'), { accountChanged: true });
  }
  function cancelTransfer() {
    transfer?.controller.abort(); transfer = null; syncBusy = false;
    showProgress('', null);
    for (const id of ['cloud-upload', 'cloud-download', 'cloud-delete-backup']) {
      const node = byId(id); if (node) node.disabled = id !== 'cloud-upload';
    }
  }
  function beginTransfer() {
    const operation = { ...accountOwner(), controller: new AbortController() };
    transfer = operation; syncBusy = true;
    for (const id of ['cloud-upload', 'cloud-download', 'cloud-delete-backup']) byId(id).disabled = true;
    return operation;
  }
  async function endTransfer(operation) {
    if (transfer !== operation) return;
    transfer = null; syncBusy = false; showProgress('', null); byId('cloud-upload').disabled = false;
    await refreshHead();
  }
  function saveSession(value) {
    if (identity(value) !== identity(session)) {
      accountGeneration++; account = null; cancelTransfer();
    }
    session = value;
    try { if (value) localStorage.setItem(sessionKey(), JSON.stringify(value)); else localStorage.removeItem(sessionKey()); } catch {}
  }
  function notice(message, tone = 'info') {
    const node = byId('cloud-notice');
    if (node) { node.textContent = message; node.dataset.tone = tone; node.hidden = !message; }
  }
  function showProgress(message, percent = null) {
    const node = byId('cloud-progress'), fill = byId('cloud-progress-fill');
    if (node) { node.hidden = !message; node.querySelector('span').textContent = message || ''; }
    if (fill) fill.style.width = percent == null ? '0%' : Math.max(0, Math.min(100, percent)) + '%';
  }
  function apiUrl(path) { return (origin || location.origin) + path; }
  function safeMessage(payload, fallback) { return String(payload?.message || payload?.error_description || payload?.msg || payload?.error || fallback); }
  async function responseJson(response) { return response.json().catch(() => ({})); }
  async function cloudRequest(url, options = {}, owner) {
    if (owner) assertOwner(owner);
    const timeout = options.signal || AbortSignal.timeout(30000);
    const signal = owner?.controller ? AbortSignal.any([timeout, owner.controller.signal]) : timeout;
    try {
      const response = await fetch(url, { ...options, signal });
      if (owner) assertOwner(owner);
      return response;
    }
    catch (error) {
      if (owner) assertOwner(owner);
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw Error('The cloud connection timed out. Check your connection and try again.');
      throw Error('Could not reach Noteject Cloud. Check your connection and try again.');
    }
  }

  async function loadConfig(force = false) {
    if (config && !force) return config;
    if (!origin) throw Error('The Noteject account service is unavailable.');
    const requestedOrigin = origin;
    const response = await fetch(requestedOrigin + '/api/site-config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const result = await responseJson(response);
    if (!response.ok) throw Error(safeMessage(result, 'Could not connect to the Noteject site.'));
    if (origin !== requestedOrigin) throw Error('The Noteject website changed. Connect again.');
    if (!result.cloudEnabled || !result.supabaseUrl || !result.supabaseAnonKey) throw Error('Cloud accounts are not configured on this Noteject site yet.');
    config = result;
    return config;
  }
  async function getAccessToken() {
    if (!origin) return null;
    if (!session) restoreSession();
    if (!session?.access_token) return null;
    if (Number(session.expires_at || 0) > Math.floor(Date.now() / 1000) + 45) return session.access_token;
    const requestedOrigin = origin, refreshToken = session.refresh_token;
    const owner = requestedOrigin + ':' + refreshToken;
    if (refreshPromise && refreshOwner === owner) return refreshPromise;
    refreshOwner = owner;
    const task = (async () => { try {
      const settings = await loadConfig(), response = await fetch(settings.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: settings.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.timeout(10000)
      });
      const refreshed = await responseJson(response);
      if (origin !== requestedOrigin || session?.refresh_token !== refreshToken) return null;
      if (!response.ok || !refreshed.access_token) { saveSession(null); updateTrigger(); return null; }
      saveSession({ ...session, ...refreshed, user: refreshed.user || session?.user, expires_at: refreshed.expires_at || Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600) });
      return session.access_token;
    } catch { return null; } })();
    refreshPromise = task;
    try { return await task; } finally { if (refreshPromise === task) refreshPromise = null; }
  }
  function apiOrigin() { return origin || location.origin; }
  function encodeContext(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  async function transcribeAudioSegment(blob, context = '', signal) {
    const token = await getAccessToken();
    if (!token) throw Error('Sign in to your Noteject account to use AI transcription.');
    const url = new URL(apiUrl('/api/transcribe-audio'));
    if (context) url.searchParams.set('context', encodeContext(String(context).slice(-800)));
    const response = await fetch(url.href, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'audio/wav' },
      body: blob, ...(signal ? { signal } : {})
    });
    const result = await responseJson(response);
    if (!response.ok) throw Error(safeMessage(result, 'Could not transcribe this audio segment. Your recording is still saved.'));
    return result;
  }
  async function getAccount() {
    const owner = accountOwner();
    const token = await getAccessToken();
    assertOwner(owner);
    if (!token) { account = null; return null; }
    const response = await fetch(apiUrl('/api/account'), { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const result = await responseJson(response);
    assertOwner(owner);
    if (!response.ok) throw Error(safeMessage(result, 'Could not load your plan.'));
    account = result;
    updatePanels();
    return account;
  }
  async function startBilling(action, plan) {
    const token = await getAccessToken();
    if (!token) { await openDialog(); return null; }
    const response = await fetch(apiUrl('/api/billing'), { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, plan }), signal: AbortSignal.timeout(85000) });
    const result = await responseJson(response);
    if (!response.ok) throw Error(safeMessage(result, 'Could not open subscriptions.'));
    if (result.provider === 'paddle' && result.transactionId) {
      if (!result.token || !['sandbox', 'live'].includes(result.environment)) throw Error('Paddle checkout is not fully configured yet.');
      await openPaddleCheckout(result);
      return null;
    }
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || !['checkout.stripe.com', 'billing.stripe.com', 'customer-portal.paddle.com'].includes(url.hostname)) throw Error('The payment address could not be verified.');
    return url.href;
  }
  async function openPaddleCheckout(options) {
    if (!paddlePromise) paddlePromise = new Promise((resolve, reject) => {
      if (window.Paddle) return resolve(window.Paddle);
      const script = document.createElement('script');
      script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      script.async = true;
      script.onload = () => window.Paddle ? resolve(window.Paddle) : reject(Error('Paddle checkout did not load. Check your connection and try again.'));
      script.onerror = () => reject(Error('Paddle checkout did not load. Check your connection and try again.'));
      document.head.appendChild(script);
    });
    const Paddle = await paddlePromise;
    if (!paddleInitialized) {
      if (options.environment === 'sandbox') Paddle.Environment.set('sandbox');
      Paddle.Initialize({ token: options.token, eventCallback(event) {
        if (event?.name === 'checkout.completed') {
          void refreshPaddleAccount();
        }
      } });
      paddleInitialized = true;
    }
    Paddle.Checkout.open({ transactionId: options.transactionId, settings: { successUrl: apiOrigin() + '/app/?billing=success' } });
  }
  async function refreshPaddleAccount() {
    for (const delay of [700, 1500, 3000, 6000, 10000]) {
      await new Promise(resolve => window.setTimeout(resolve, delay));
      try {
        const updated = await getAccount();
        document.dispatchEvent(new Event('noteject-account-changed'));
        if (updated?.plan && updated.plan !== 'free') return;
      } catch { return; }
    }
  }
  window.NotejectCloud = Object.freeze({ getAccessToken, apiOrigin, getAccount, startBilling, openDialog, isConfigured: () => !!config?.cloudEnabled });

  function buildDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'noteject-cloud-dialog';
    dialog.className = 'cloud-dialog';
    dialog.setAttribute('aria-labelledby', 'cloud-dialog-title');
    dialog.innerHTML = `<form method="dialog" class="cloud-dialog-head"><div><div class="cloud-eyebrow">NOTEJECT CLOUD</div><h2 id="cloud-dialog-title">Sync your workspace</h2></div><button class="cloud-close" value="close" aria-label="Close">×</button></form>
      <div class="cloud-dialog-body">
        ${!hostedWeb ? `<p class="cloud-intro">Sign in with your Noteject account. This app is already connected to the official Noteject service.</p>` : ''}
        <p class="cloud-intro">Use the same account on Windows, Android, and web. Upload or restore your workspace when you choose.</p>
        <div id="cloud-notice" class="cloud-notice" role="status" hidden></div>
        <section id="cloud-auth-panel">
          <form id="cloud-auth-form"><label class="cloud-field">Email<input id="cloud-email" type="email" autocomplete="email" required maxlength="254"></label><label class="cloud-field">Password<input id="cloud-password" type="password" autocomplete="current-password" required minlength="8" maxlength="128"></label><button class="cloud-primary" type="submit" id="cloud-auth-submit">Sign in</button></form>
          <p class="cloud-switch"><span id="cloud-switch-copy">New to Noteject Cloud?</span> <button type="button" id="cloud-switch-mode">Create an account</button></p>
        </section>
        <section id="cloud-account-panel" hidden>
          <div class="cloud-account"><span class="cloud-account-mark">N</span><div><b id="cloud-account-email">Signed in</b><small id="cloud-account-plan">Free · 10 basic AI actions per month</small></div><button type="button" class="cloud-signout" id="cloud-signout">Sign out</button></div>
          <div class="cloud-sync-status" id="cloud-head-status">Checking cloud workspace…</div>
          <section class="cloud-backup-usage" id="cloud-backup-usage" aria-labelledby="cloud-backup-title" hidden>
            <div class="cloud-backup-heading"><b id="cloud-backup-title">Cloud backup storage</b><span><strong id="cloud-backup-size">0 KB</strong> / <span><span id="cloud-backup-limit">50 MB</span> maximum</span></span></div>
            <div class="cloud-backup-track" id="cloud-backup-track" role="progressbar" aria-label="Cloud backup storage used" aria-valuemin="0" aria-valuemax="52428800" aria-valuenow="0"><i id="cloud-backup-fill"></i></div>
            <details class="cloud-backup-manage"><summary>Manage backup size</summary><p id="cloud-backup-help">Each account keeps one current workspace ZIP; a successful upload replaces the previous cloud copy. Original PDFs, audio, and other files count toward its plan limit. To make a smaller next backup, export a local copy first, remove files you no longer need from this workspace, then upload again.</p></details>
          </section>
          <div class="cloud-progress" id="cloud-progress" hidden><span></span><div><i id="cloud-progress-fill"></i></div></div>
          <div class="cloud-actions"><button type="button" class="cloud-primary" id="cloud-upload">Upload this device</button><button type="button" class="cloud-secondary" id="cloud-download">Restore from cloud</button><button type="button" class="cloud-secondary" id="cloud-view-plan">AI plan and usage</button><button type="button" class="cloud-danger" id="cloud-delete-backup" disabled>Delete cloud backup</button></div>
          <small class="cloud-sync-foot">Sync uses a private, versioned backup. It asks before replacing a cloud copy changed by another device.</small>
        </section>
      </div>`;
    document.body.append(dialog);
    byId('cloud-auth-form').addEventListener('submit', event => { event.preventDefault(); void authenticate(); });
    byId('cloud-switch-mode').addEventListener('click', () => { authMode = authMode === 'signin' ? 'signup' : 'signin'; updateAuthMode(); });
    byId('cloud-signout').addEventListener('click', () => { void signOut(); });
    byId('cloud-upload').addEventListener('click', () => { void uploadWorkspace(); });
    byId('cloud-download').addEventListener('click', () => { void downloadWorkspace(); });
    byId('cloud-delete-backup').addEventListener('click', () => { void deleteWorkspaceBackup(); });
    byId('cloud-view-plan').addEventListener('click', () => {
      dialog.close(); byId('open-settings')?.click();
      document.querySelector('[data-settings-tab="ai"]')?.click();
    });
    dialog.addEventListener('close', () => { updateTrigger(); });
    return dialog;
  }
  function updateAuthMode() {
    if (!dialog) return;
    byId('cloud-auth-submit').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
    byId('cloud-password').autocomplete = authMode === 'signin' ? 'current-password' : 'new-password';
    byId('cloud-switch-copy').textContent = authMode === 'signin' ? 'New to Noteject Cloud?' : 'Already have an account?';
    byId('cloud-switch-mode').textContent = authMode === 'signin' ? 'Create an account' : 'Sign in';
  }
  async function authenticate() {
    const request = ++authRequest, owner = accountOwner();
    try {
      const settings = await loadConfig(), email = byId('cloud-email').value.trim(), password = byId('cloud-password').value;
      notice(authMode === 'signin' ? 'Signing in…' : 'Creating account…');
      const route = authMode === 'signin' ? '/auth/v1/token?grant_type=password' : '/auth/v1/signup';
      const response = await fetch(settings.supabaseUrl + route, { method: 'POST', headers: { apikey: settings.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) });
      const result = await responseJson(response);
      if (request !== authRequest || !ownsAccount(owner)) return;
      if (!response.ok) throw Error(safeMessage(result, 'Could not sign in. Check your email and password.'));
      if (!result.access_token) {
        notice('Check your email for the confirmation link, then sign in here.', 'success');
        authMode = 'signin'; updateAuthMode(); return;
      }
      saveSession({ ...result, expires_at: result.expires_at || Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600) });
      const signedInOwner = accountOwner();
      await refreshAccount();
      assertOwner(signedInOwner);
      notice('Signed in. Choose whether to upload this device or restore the cloud copy.', 'success');
      updateTrigger();
    } catch (error) { if (request === authRequest && !error.accountChanged) notice(error.message || 'Could not sign in.', 'error'); }
  }
  async function signedFetch(url, options = {}, owner = accountOwner()) {
    const settings = await loadConfig(), token = await getAccessToken();
    assertOwner(owner);
    if (!token) throw Error('Your session expired. Sign in again.');
    const headers = new Headers(options.headers || {});
    headers.set('apikey', settings.supabaseAnonKey); headers.set('Authorization', 'Bearer ' + token);
    const response = await cloudRequest(url, { ...options, headers }, owner);
    return response;
  }
  async function refreshAccount() {
    const owner = accountOwner();
    const token = await getAccessToken();
    if (!ownsAccount(owner)) return;
    if (!token) { saveSession(null); updatePanels(); updateTrigger(); return; }
    try {
      const settings = await loadConfig(), response = await fetch(settings.supabaseUrl + '/auth/v1/user', { headers: { apikey: settings.supabaseAnonKey, Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('Sign in again to continue.');
      const user = await response.json();
      assertOwner(owner);
      saveSession({ ...session, user });
      const refreshedOwner = accountOwner();
      account = null;
      await getAccount().catch(() => {});
      assertOwner(refreshedOwner);
      updatePanels(); updateTrigger(); await refreshHead();
      document.dispatchEvent(new Event('noteject-account-changed'));
    } catch (error) { if (ownsAccount(owner)) notice(error.message || 'Could not load the account.', 'error'); }
  }
  async function signOut() {
    const previousToken = session?.access_token, previousOrigin = origin, previousConfig = config;
    authRequest++;
    accountGeneration++; cancelTransfer(); saveSession(null); account = null;
    updatePanels(); updateTrigger(); notice('Signed out. This device’s local workspace remains here.', 'success');
    document.dispatchEvent(new Event('noteject-account-changed'));
    try {
      if (!previousToken) return;
      const settings = previousConfig || await fetch(previousOrigin + '/api/site-config', { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(responseJson);
      if (settings?.supabaseUrl && settings?.supabaseAnonKey) await fetch(settings.supabaseUrl + '/auth/v1/logout', { method: 'POST', headers: { apikey: settings.supabaseAnonKey, Authorization: 'Bearer ' + previousToken }, signal: AbortSignal.timeout(8000) });
    } catch { /* Local sign-out is complete even when the service is offline. */ }
  }
  function updateTrigger() {
    const trigger = byId('noteject-cloud-trigger');
    if (!trigger) return;
    trigger.textContent = session?.access_token ? '☁ Sync' : '☁ Sign in';
    trigger.title = session?.access_token ? 'Sync workspace with Noteject Cloud' : 'Sign in to sync across devices';
    trigger.setAttribute('aria-label', trigger.title);
  }
  function syncState(owner = accountOwner()) {
    assertOwner(owner);
    try { return JSON.parse(localStorage.getItem(syncKey(owner.userId)) || 'null') || { revision: 0 }; } catch { return { revision: 0 }; }
  }
  function saveSyncState(head, owner = accountOwner()) {
    assertOwner(owner);
    if (!owner.userId || !head) return;
    try { localStorage.setItem(syncKey(owner.userId), JSON.stringify({ revision: Number(head.revision) || 0, snapshotPath: head.snapshot_path || null, updatedAt: head.updated_at || null })); } catch {}
  }
  async function readHead(owner = accountOwner()) {
    const settings = await loadConfig(), token = await getAccessToken();
    assertOwner(owner);
    if (!token) throw Error('Your session expired. Sign in again.');
    if (!session?.user?.id) {
      const response = await signedFetch(settings.supabaseUrl + '/auth/v1/user', { signal: AbortSignal.timeout(10000) }, owner);
      const user = await responseJson(response);
      if (!response.ok || !user.id) throw Error('Your session expired. Sign in again.');
      saveSession({ ...session, user });
    }
    assertOwner(owner);
    const userId = encodeURIComponent(owner.userId);
    const response = await signedFetch(settings.supabaseUrl + '/rest/v1/workspace_sync_heads?select=revision,snapshot_path,archive_size,device_label,updated_at&user_id=eq.' + userId, { cache: 'no-store', signal: AbortSignal.timeout(15000) }, owner);
    const data = await responseJson(response);
    assertOwner(owner);
    if (!response.ok) throw Error(safeMessage(data, 'Could not read the cloud workspace. Apply the Noteject database setup first.'));
    return Array.isArray(data) ? data[0] || null : null;
  }
  async function refreshHead() {
    if (!dialog || !session?.access_token) return;
    const owner = accountOwner();
    try {
      const settings = await loadConfig();
      if (!account) await getAccount();
      const maximum = Math.max(1, Number(account?.backupLimitBytes) || Number(settings.syncMaxBytes) || 20 * 1024 * 1024);
      const head = await readHead(owner);
      assertOwner(owner);
      updateBackupMeter(Number(head?.archive_size) || 0, maximum);
      if (!head) { byId('cloud-head-status').textContent = 'No cloud copy yet. Upload this device to create one.'; byId('cloud-download').disabled = true; byId('cloud-delete-backup').disabled = true; return; }
      byId('cloud-head-status').textContent = `Cloud copy · revision ${head.revision} · updated ${new Date(head.updated_at).toLocaleString(globalThis.document?.documentElement?.lang || undefined)}`;
      byId('cloud-download').disabled = syncBusy;
      byId('cloud-delete-backup').disabled = syncBusy;
    } catch (error) { if (!ownsAccount(owner)) return; byId('cloud-head-status').textContent = error.message || 'Could not read cloud sync status.'; byId('cloud-download').disabled = true; byId('cloud-delete-backup').disabled = true; }
  }
  function updateBackupMeter(usedBytes, maximumBytes) {
    const used = Math.max(0, Number(usedBytes) || 0), maximum = Math.max(1, Number(maximumBytes) || 1);
    const percent = Math.min(100, used / maximum * 100);
    const size = byId('cloud-backup-size'), limit = byId('cloud-backup-limit'), fill = byId('cloud-backup-fill'), track = byId('cloud-backup-track'), meter = byId('cloud-backup-usage');
    if (!size || !limit || !fill || !track || !meter) return;
    meter.hidden = false;
    size.textContent = formatSize(used); limit.textContent = formatSize(maximum);
    fill.style.width = percent.toFixed(1) + '%';
    track.setAttribute('aria-valuemax', String(maximum)); track.setAttribute('aria-valuenow', String(Math.min(used, maximum)));
    track.setAttribute('aria-valuetext', `${formatSize(used)} of ${formatSize(maximum)}`);
    meter.dataset.nearLimit = String(percent >= 80);
  }
  function formatSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1048576) return Math.round(size / 1024) + ' KB';
    if (size < 1073741824) return (size / 1048576).toFixed(1) + ' MB';
    return (size / 1073741824).toFixed(2) + ' GB';
  }
  function base64(value) {
    const bytes = new TextEncoder().encode(value); let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function objectPathUrl(settings, path) {
    return settings.supabaseUrl + '/storage/v1/object/' + path.split('/').map(encodeURIComponent).join('/');
  }
  async function readCloudArchive(response, expectedSize, owner) {
    assertOwner(owner);
    if (expectedSize > MAX_CLOUD_BACKUP_BYTES) throw Error('This cloud backup exceeds the 15 GB safety limit.');
    if (!response.body?.pipeThrough) {
      const archive = await response.blob();
      assertOwner(owner);
      if (archive.size > expectedSize || archive.size > MAX_CLOUD_BACKUP_BYTES) throw Error('The downloaded cloud backup is larger than its saved size. No data was changed.');
      if (archive.size !== expectedSize) throw Error(`The cloud download ended at ${formatSize(archive.size)} of ${formatSize(expectedSize)}. No data was changed; retry the restore on a stable connection.`);
      showProgress('Verifying cloud backup…', 100);
      return archive;
    }
    let received = 0;
    const progress = new TransformStream({
      transform(chunk, controller) {
        assertOwner(owner);
        received += chunk.byteLength;
        if (!Number.isSafeInteger(received) || received > expectedSize || received > MAX_CLOUD_BACKUP_BYTES) throw Error('The downloaded cloud backup is larger than its saved size. No data was changed.');
        controller.enqueue(chunk);
        showProgress(`Downloading cloud backup · ${formatSize(received)} of ${formatSize(expectedSize)}`, received / expectedSize * 100);
      }
    });
    const archive = await new Response(response.body.pipeThrough(progress)).blob();
    assertOwner(owner);
    if (received !== expectedSize) throw Error(`The cloud download ended at ${formatSize(received)} of ${formatSize(expectedSize)}. No data was changed; retry the restore on a stable connection.`);
    showProgress('Verifying cloud backup…', 100);
    return archive.slice(0, archive.size, 'application/zip');
  }
  async function uploadObject(settings, path, archive, owner) {
    const token = await getAccessToken(), objectUrl = objectPathUrl(settings, 'noteject-workspaces/' + path);
    assertOwner(owner);
    if (archive.size <= 6 * 1024 * 1024) {
      const response = await signedFetch(objectUrl, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'Cache-Control': '3600' }, body: archive, signal: AbortSignal.timeout(120000) }, owner);
      const result = await responseJson(response);
      assertOwner(owner);
      if (!response.ok) throw Error(safeMessage(result, 'Cloud upload failed. Check the Storage file-size limit.'));
      showProgress('Uploading workspace…', 100); return;
    }
    const supabaseUrl = new URL(settings.supabaseUrl), ref = supabaseUrl.hostname.split('.')[0];
    const endpoint = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(settings.supabaseUrl)
      ? `https://${ref}.storage.supabase.co/storage/v1/upload/resumable` : settings.supabaseUrl + '/storage/v1/upload/resumable';
    const metadata = { bucketName: 'noteject-workspaces', objectName: path, contentType: 'application/zip', cacheControl: '3600' };
    const encoded = Object.entries(metadata).map(([key, value]) => key + ' ' + base64(value)).join(',');
    const start = await cloudRequest(endpoint, { method: 'POST', headers: { apikey: settings.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(archive.size), 'Upload-Metadata': encoded }, signal: AbortSignal.timeout(20000) }, owner);
    if (!start.ok) throw Error(safeMessage(await responseJson(start), 'Could not start the resumable cloud upload.'));
    const uploadUrl = new URL(start.headers.get('Location') || '', endpoint).href;
    if (!start.headers.get('Location')) throw Error('Cloud upload did not return a resumable transfer link.');
    let offset = 0, retries = 0;
    while (offset < archive.size) {
      assertOwner(owner);
      const end = Math.min(archive.size, offset + 6 * 1024 * 1024);
      try {
        const response = await cloudRequest(uploadUrl, { method: 'PATCH', headers: { apikey: settings.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: archive.slice(offset, end), signal: AbortSignal.timeout(45000) }, owner);
        if (!response.ok) {
          if (response.status === 409) throw new Error('The cloud upload encountered a transfer conflict. Start sync again.');
          throw Error(safeMessage(await responseJson(response), 'A cloud upload chunk failed.'));
        }
        const reported = Number(response.headers.get('Upload-Offset'));
        offset = Number.isFinite(reported) && reported > offset ? reported : end;
        retries = 0;
        showProgress(`Uploading workspace · ${formatSize(offset)} of ${formatSize(archive.size)}`, offset / archive.size * 100);
      } catch (error) {
        assertOwner(owner);
        if (++retries > 3) throw error;
        await new Promise(resolve => setTimeout(resolve, retries * 900));
        const check = await cloudRequest(uploadUrl, { method: 'HEAD', headers: { apikey: settings.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Tus-Resumable': '1.0.0' }, signal: AbortSignal.timeout(12000) }, owner);
        if (!check.ok) throw error;
        const resumed = Number(check.headers.get('Upload-Offset'));
        if (Number.isFinite(resumed) && resumed >= 0 && resumed <= archive.size) offset = resumed;
      }
    }
  }
  async function deleteObject(settings, path, owner) {
    if (!path) return;
    const response = await signedFetch(objectPathUrl(settings, 'noteject-workspaces/' + path), { method: 'DELETE' }, owner);
    if (!response.ok && response.status !== 404) throw Error('The old cloud snapshot could not be removed.');
  }
  async function uploadWorkspace() {
    if (!session?.access_token) { notice('Sign in to your Noteject account before uploading a backup.', 'error'); return; }
    if (syncBusy) { notice('A cloud transfer is already running. Its progress is shown below.'); return; }
    const operation = beginTransfer();
    notice('Connecting to your cloud backup…');
    showProgress('Connecting to your cloud backup…', 0);
    try {
      const settings = await loadConfig(), head = await readHead(operation), local = syncState(operation), remoteRevision = Number(head?.revision) || 0;
      if (remoteRevision && remoteRevision !== Number(local.revision || 0)) {
        const question = `The cloud copy is at revision ${remoteRevision}, while this device last saw revision ${Number(local.revision) || 0}. Uploading this device will replace the cloud copy for other devices. Continue?`;
        const confirm = window.NotejectDialogs?.confirm ? await window.NotejectDialogs.confirm(question) : window.confirm(question);
        assertOwner(operation);
        if (!confirm) return;
      }
      if (!account) await getAccount();
      assertOwner(operation);
      const backupLimit = Math.max(1, Number(account?.backupLimitBytes) || Number(settings.syncMaxBytes) || 20 * 1024 * 1024);
      if (!workspaceStore.flush()) throw Error('Could not save this device’s workspace before syncing.');
      notice('Preparing a verified backup with original files…');
      showProgress('Preparing cloud backup…', 0);
      const archive = await exportWorkspaceBackup({ download: false, silent: true, signal: operation.controller.signal });
      assertOwner(operation);
      if (!(archive instanceof Blob) || !archive.size) throw Error('Could not prepare a workspace archive.');
      if (archive.size > backupLimit) throw Error(`This backup is ${formatSize(archive.size)}. The maximum is ${formatSize(backupLimit)}. Open Manage backup size in your account to see ways to reduce it.`);
      const snapshotPath = operation.userId + '/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID() + '.zip';
      showProgress('Uploading workspace…', 0);
      await uploadObject(settings, snapshotPath, archive, operation);
      const token = await getAccessToken();
      assertOwner(operation);
      const advance = await cloudRequest(settings.supabaseUrl + '/rest/v1/rpc/noteject_advance_workspace', {
        method: 'POST', headers: { apikey: settings.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_expected_revision: remoteRevision, p_snapshot_path: snapshotPath, p_archive_size: archive.size, p_device_label: deviceLabel() }), signal: AbortSignal.timeout(15000)
      }, operation);
      const advanceBody = await advance.json().catch(() => null);
      assertOwner(operation);
      const revision = Number(advanceBody);
      if (!advance.ok || !Number.isSafeInteger(revision)) {
        await deleteObject(settings, snapshotPath, operation).catch(() => {});
        throw Error(/WORKSPACE_SYNC_CONFLICT/i.test(JSON.stringify(advanceBody))
          ? 'Another device updated the cloud workspace while this upload was running. Nothing was replaced; check the cloud status and retry.'
          : /Backup exceeds this plan storage limit/i.test(JSON.stringify(advanceBody))
            ? 'Your plan storage limit changed during upload. The uploaded file was removed; refresh your account and try again.'
            : 'The snapshot uploaded, but the cloud version could not be advanced. Nothing was overwritten; retry sync.');
      }
      saveSyncState({ revision, snapshot_path: snapshotPath, updated_at: new Date().toISOString() }, operation);
      if (head?.snapshot_path) await deleteObject(settings, head.snapshot_path, operation).catch(() => {});
      assertOwner(operation);
      notice('This device is synced. Your documents and notes are available from your other signed-in devices.', 'success');
      showProgress('', null); await refreshHead();
    } catch (error) { if (ownsAccount(operation)) notice(error.message || 'Could not sync this workspace.', 'error'); }
    finally { await endTransfer(operation); }
  }
  async function downloadWorkspace() {
    if (!session?.user?.id || syncBusy) return;
    const operation = beginTransfer();
    try {
      const settings = await loadConfig(), head = await readHead(operation);
      if (!head?.snapshot_path || !Number(head.revision)) throw Error('There is no cloud workspace to restore yet.');
      const expectedSize = Number(head.archive_size);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) throw Error('The cloud backup record has an invalid file size. Refresh the account and try again.');
      showProgress('Connecting to cloud backup…', 0);
      const response = await signedFetch(objectPathUrl(settings, 'authenticated/noteject-workspaces/' + head.snapshot_path), { cache: 'no-store', signal: AbortSignal.timeout(60 * 60 * 1000) }, operation);
      if (!response.ok) throw Error(safeMessage(await responseJson(response), 'Could not download the cloud workspace.'));
      const archive = await readCloudArchive(response, expectedSize, operation);
      assertOwner(operation);
      if (archive.size !== expectedSize) throw Error(`The cloud download ended at ${formatSize(archive.size)} of ${formatSize(expectedSize)}. No data was changed; retry the restore on a stable connection.`);
      const file = new File([archive], 'noteject-cloud-workspace.zip', { type: 'application/zip', lastModified: Date.now() });
      showProgress('Loading cloud backup on this device…', 100);
      const restored = await loadWorkspaceBackup(file, { signal: operation.controller.signal });
      assertOwner(operation);
      if (restored === null) { notice('Restore cancelled. Your cloud backup is unchanged.', 'info'); return; }
      if (restored !== true) throw Error('The cloud backup downloaded, but could not be loaded. Check available device storage and try again.');
      saveSyncState(head, operation);
      notice('Cloud workspace restored on this device.', 'success');
      await refreshHead();
    } catch (error) { if (ownsAccount(operation)) notice(error.message || 'Could not restore the cloud workspace.', 'error'); }
    finally { await endTransfer(operation); }
  }
  async function deleteWorkspaceBackup() {
    if (!session?.user?.id || syncBusy) return;
    const owner = accountOwner();
    const question = 'Delete the cloud backup? The workspace on this device will stay unchanged. Other devices will no longer be able to restore the current cloud copy.';
    const confirmed = window.NotejectDialogs?.confirm
      ? await window.NotejectDialogs.confirm(question, { title: 'Delete cloud backup?', confirmLabel: 'Delete cloud backup', danger: true })
      : window.confirm(question);
    if (!confirmed || !ownsAccount(owner) || syncBusy) return;
    const operation = beginTransfer();
    try {
      const settings = await loadConfig(), head = await readHead(operation);
      if (!head?.snapshot_path || !Number(head.revision)) {
        notice('There is no cloud backup to delete.', 'info');
        return;
      }
      const token = await getAccessToken();
      assertOwner(operation);
      if (!token) throw Error('Your session expired. Sign in again.');
      const response = await cloudRequest(apiUrl('/api/cloud-backup'), {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: Number(head.revision), snapshotPath: head.snapshot_path }), signal: AbortSignal.timeout(25000)
      }, operation);
      const result = await responseJson(response);
      assertOwner(operation);
      if (!response.ok || result?.ok !== true) throw Error(safeMessage(result, 'Could not delete the cloud backup.'));
      saveSyncState({ revision: 0, snapshot_path: null, updated_at: null }, operation);
      notice('Cloud backup deleted. The workspace on this device is unchanged.', 'success');
    } catch (error) { if (ownsAccount(operation)) notice(error.message || 'Could not delete the cloud backup.', 'error'); }
    finally { await endTransfer(operation); }
  }
  function deviceLabel() {
    if (window.NotejectAndroid) return 'Android';
    if (window.NotejectDesktop) return 'Windows';
    return 'Web browser';
  }
  function formatHeadStatus(head) {
    if (!head) return 'No cloud copy yet. Upload this device to create one.';
    return `Cloud copy · revision ${head.revision} · ${formatSize(head.archive_size)} · updated ${new Date(head.updated_at).toLocaleString(globalThis.document?.documentElement?.lang || undefined)}`;
  }
  async function openDialog() {
    buildDialog();
    dialog.showModal(); updateAuthMode(); updatePanels(); notice('');
    try { await loadConfig(); if (session?.access_token) await refreshAccount(); }
    catch (error) { if (!session?.access_token) notice(error.message || 'Cloud setup is unavailable.', 'error'); }
  }
  function injectTrigger() {
    if (byId('noteject-cloud-trigger')) return;
    const host = document.querySelector('.top-right');
    if (!host) return;
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.id = 'noteject-cloud-trigger'; trigger.className = 'cloud-trigger';
    trigger.addEventListener('click', () => { void openDialog(); });
    const search = host.querySelector('.search');
    if (search) search.after(trigger); else host.prepend(trigger);
    updateTrigger();
  }
  function setupWebNavigation() {
    if (!browserWorkspace) return;
    const sidebar = document.querySelector('.sidebar'), bar = document.querySelector('.topbar');
    if (!sidebar || !bar) return;
    sidebar.id ||= 'noteject-web-navigation';
    const toggle = document.createElement('button'), close = document.createElement('button'), scrim = document.createElement('button');
    toggle.className = 'web-nav-toggle'; toggle.type = 'button'; toggle.textContent = '☰';
    toggle.setAttribute('aria-label', 'Open workspace menu'); toggle.setAttribute('aria-controls', sidebar.id);
    close.className = 'web-nav-close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close workspace menu'); close.title = 'Close menu';
    scrim.className = 'web-nav-scrim'; scrim.type = 'button'; scrim.setAttribute('aria-label', 'Close workspace menu');
    scrim.tabIndex = -1; scrim.hidden = true;
    bar.prepend(toggle); (sidebar.querySelector('.brand') || sidebar).append(close); document.body.append(scrim);
    const narrow = matchMedia('(max-width:959px)');
    let opened = false;
    function setOpen(value) {
      opened = value && narrow.matches;
      document.documentElement.classList.toggle('web-nav-open', opened);
      sidebar.inert = narrow.matches && !opened;
      scrim.hidden = !opened;
      toggle.setAttribute('aria-expanded', String(opened));
      if (opened) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); sidebar.setAttribute('aria-label', 'Workspace menu'); close.focus(); }
      else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
    }
    toggle.onclick = () => setOpen(!opened);
    close.onclick = scrim.onclick = () => { setOpen(false); toggle.focus(); };
    sidebar.addEventListener('click', event => { if (event.target.closest('.nav-item,#open-settings,#brand-home,[data-open-board]')) setOpen(false); });
    document.addEventListener('keydown', event => {
      if (!opened) return;
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); toggle.focus(); }
      if (event.key === 'Tab') {
        const buttons = [...sidebar.querySelectorAll('button,a[href],input,select,[tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    narrow.addEventListener('change', () => setOpen(false));
    setOpen(false);
  }
  function applyAiSettings() {
    const status = byId('noteject-ai-status');
    if (status) setText(status, !config?.aiEnabled ? 'Noteject AI is temporarily unavailable. On-device reading tools still work.' : session?.access_token ? 'Signed in. Your plan and monthly usage are shown below.' : 'Sign in to your Noteject account to use AI and see your monthly allowance.');
    if (browserWorkspace) {
      setText(byId('storage-path'), 'This browser');
      setText(byId('storage-status'), 'Files stay in this browser unless you sign in and sync.');
      byId('choose-storage-path')?.setAttribute('hidden', '');
      document.querySelectorAll('[data-action="copy-storage-path"]').forEach(node => { node.hidden = true; });
    }
    window.NotejectAiPlans?.mount?.();
  }
  function updatePanels() {
    if (!dialog) return;
    const signedIn = !!session?.access_token;
    byId('cloud-auth-panel').hidden = signedIn;
    byId('cloud-account-panel').hidden = !signedIn;
    const intro = dialog.querySelector('.cloud-intro');
    if (intro) intro.hidden = signedIn;
    if (signedIn) {
      setText(byId('cloud-account-email'), session.user?.email || 'Signed in');
      const plan = String(account?.plan || 'free');
      const remainingBasic = Math.max(0, account?.basic?.limit - account?.basic?.used);
      const remainingAdvanced = Math.max(0, account?.advanced?.limit - account?.advanced?.used);
      setText(byId('cloud-account-plan'), account ? `${plan[0].toUpperCase() + plan.slice(1)} · ${remainingBasic} basic remaining this month · ${remainingAdvanced} advanced remaining` : 'Plan information is unavailable');
    }
  }

  restoreSession();
  // Keep the session token inside the cloud module. Features may request an
  // authenticated Noteject endpoint without reading or copying stored tokens.
  window.NotejectCloudSession = Object.freeze({ getAccount, transcribeAudioSegment });
  injectTrigger();
  setupWebNavigation();
  if (origin) void loadConfig().then(() => { applyAiSettings(); document.dispatchEvent(new Event('noteject-cloud-ready')); }).catch(() => applyAiSettings());
  if (session?.access_token) { void getAccessToken().then(token => { if (token) void refreshAccount(); }); }
  new MutationObserver(() => { injectTrigger(); applyAiSettings(); }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', event => { if (event.target.closest('#noteject-ai-account')) void openDialog(); });
  document.addEventListener('noteject-account-changed', applyAiSettings);
  if (['success', 'returned', 'cancelled'].includes(new URLSearchParams(location.search).get('billing'))) {
    byId('open-settings')?.click(); document.querySelector('[data-settings-tab="ai"]')?.click();
  }
})();
