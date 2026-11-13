/* Android transport and file saving. This runs before the shared workspace. */
(() => {
  'use strict';
  const native = window.NotejectAndroid;
  if (!native) return;
  const originalFetch = window.fetch.bind(window);
  const requests = new Map(), exports = new Map();
  let next = 0, saving = false;
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const recordingUrl = doc => {
    const id = String(doc?.audioRecordingId || '');
    return (doc?.nativeRecording || doc?.nativeAudio) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? new URL('/recordings/' + id + '.wav', location.href).href : '';
  };
  const announce = message => {
    if (typeof notify === 'function') notify(message);
    else {
      const toast = document.getElementById('toast');
      if (toast) { toast.textContent = message; toast.hidden = false; setTimeout(() => { toast.hidden = true; }, 4000); }
    }
  };
  window.addEventListener('noteject:android-notice', event => {
    const message = event.detail?.message;
    if (typeof message !== 'string' || !message) return;
    announce(message);
    if (typeof notify === 'function') {
      clearTimeout(notify.timer);
      notify.timer = setTimeout(() => { const toast = document.getElementById('toast'); if (toast) toast.hidden = true; }, 8000);
    }
  });
  window.__notejectAndroidResponse = (id, payload, status = 200) => {
    const pending = requests.get(String(id));
    if (!pending) return;
    pending.finish(new Response(payload, { status: Number(status) || 200, headers: { 'Content-Type': 'application/json' } }));
  };
  async function storedAttachment(documentId, remove = false) {
    if (!documentId) throw Error('The attachment ID is missing.');
    if (typeof fileDb !== 'function') throw Error('Document storage is not ready.');
    // Shared helpers resolve imported generations and retain recovery owners.
    return remove ? removeStoredFile(documentId) : getStoredFile(documentId);
  }

  window.fetch = async (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '', location.href); }
    catch { return originalFetch(input, init); }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, init);
    const method = (init.method || input?.method || 'GET').toUpperCase();
    const signal = init.signal || input?.signal;
    if (signal?.aborted) return Promise.reject(new DOMException('The request was aborted.', 'AbortError'));
    let body = init.body ?? '';
    if (!Object.prototype.hasOwnProperty.call(init, 'body') && input instanceof Request && !['GET', 'HEAD'].includes(method)) {
      body = await input.clone().text();
      if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    }
    if (url.pathname === '/api/files' && ['GET', 'DELETE'].includes(method)) {
      return storedAttachment(url.searchParams.get('id'), method === 'DELETE').then(async blob => {
        if (method === 'DELETE') return jsonResponse({ ok: true });
        if (blob instanceof Blob) return new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
        const doc = typeof data !== 'undefined' ? data.docs.find(item => item.id === url.searchParams.get('id')) : null;
        const savedUrl = recordingUrl(doc);
        return savedUrl ? originalFetch(savedUrl, { signal }) : jsonResponse({ error: 'The original file is unavailable on this device.' }, 404);
      }).catch(error => jsonResponse({ error: error.message || 'Could not access the attachment.' }, 400));
    }
    // Imported Android attachments are stored by document ID in IndexedDB. Their
    // visible names and project assignments are metadata, not native disk paths.
    if (method === 'POST' && ['/api/files/rename', '/api/files/move'].includes(url.pathname)) {
      try {
        const record = JSON.parse(body || '{}');
        if (!record.id) return Promise.resolve(jsonResponse({ error: 'The attachment ID is missing.' }, 400));
        return Promise.resolve(jsonResponse({ ok: true, name: record.newName || record.name || '' }));
      } catch { return Promise.resolve(jsonResponse({ error: 'Invalid file request.' }, 400)); }
    }
    if (typeof body !== 'string' && body !== null) return Promise.resolve(jsonResponse({ error: 'This Android service accepts JSON requests only.' }, 415));
    return new Promise((resolve, reject) => {
      const id = String(++next);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); requests.delete(id); };
      const abort = () => { cleanup(); reject(new DOMException('The request was aborted.', 'AbortError')); };
      const timer = setTimeout(() => {
        cleanup(); resolve(jsonResponse({ error: 'The request took too long. Check your connection and try again.' }, 504));
      }, 90000);
      requests.set(id, { finish: response => { cleanup(); resolve(response); } });
      signal?.addEventListener('abort', abort, { once: true });
      try { native.apiRequest(url.pathname + url.search, method, body || '', id); }
      catch (error) { cleanup(); resolve(jsonResponse({ error: error.message || 'Android service unavailable.' }, 503)); }
    });
  };

  window.__notejectAndroidExportResult = (id, status, message) => {
    const pending = exports.get(String(id));
    if (!pending) return;
    exports.delete(String(id));
    pending({ status, message });
  };
  const base64Chunk = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || Error('Could not read the file for saving.'));
    reader.readAsDataURL(blob);
  });
  async function save(blob, filename = 'noteject-export') {
    if (saving) { announce('Finish or cancel the current save first.'); return { status: 'busy' }; }
    if (!(blob instanceof Blob)) throw Error('The original file is unavailable.');
    if (typeof native.beginExport !== 'function') throw Error('Update the Android app to enable saving files.');
    const id = crypto.randomUUID();
    saving = true;
    let started = false;
    try {
      const error = native.beginExport(id, String(filename), blob.type || 'application/octet-stream', blob.size);
      if (error) throw Error(error);
      started = true;
      const completed = new Promise(resolve => exports.set(id, resolve));
      announce('Preparing ' + filename + ' for saving…');
      for (let offset = 0; offset < blob.size; offset += 196608) {
        const error = native.appendExport(id, await base64Chunk(blob.slice(offset, offset + 196608)));
        if (error) throw Error(error);
      }
      const errorComplete = native.completeExport(id);
      if (errorComplete) throw Error(errorComplete);
      announce('Choose where to save ' + filename);
      const result = await completed;
      announce(result.message || (result.status === 'saved' ? 'File saved' : 'Save cancelled'));
      return result;
    } catch (error) {
      if (started) native.cancelExport(id);
      exports.delete(id);
      announce(error.message || 'Could not save this file.');
      return { status: 'error', message: error.message };
    } finally { saving = false; }
  }

  async function saveAnchor(anchor) {
    try {
      let url = new URL(anchor.href, location.href);
      const recording = url.origin === location.origin && url.pathname.match(/^\/recordings\/([0-9a-f-]{36})\.wav$/i);
      if (recording && window.NotejectAndroidAudio?.command) {
        await window.NotejectAndroidAudio.command('export', { id: recording[1], name: anchor.download || 'Recording.wav' }); return;
      }
      if (url.protocol === 'blob:') url = new URL(url.href.split(/[?#]/)[0]);
      if (!['blob:', 'data:'].includes(url.protocol) && url.origin !== location.origin) {
        if (['http:', 'https:'].includes(url.protocol) && localHost(url.hostname)) return;
        native.openExternal?.(url.href); return;
      }
      const response = await window.fetch(url.href);
      if (!response.ok) throw Error('The original file is unavailable.');
      await save(await response.blob(), anchor.download || 'noteject-download');
    } catch (error) { announce(error.message || 'Could not save this file.'); }
  }
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    // Workspace exports use detached anchors, which never reach document events.
    if (this.hasAttribute('download')) { void saveAnchor(this); return; }
    return originalAnchorClick.call(this);
  };
  document.addEventListener('click', event => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    if (anchor.hasAttribute('download')) {
      event.preventDefault(); event.stopImmediatePropagation(); void saveAnchor(anchor); return;
    }
    const url = new URL(anchor.href, location.href);
    if (anchor.target === '_blank' && ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (url.origin !== location.origin && (!['http:', 'https:'].includes(url.protocol) || !localHost(url.hostname))) native.openExternal?.(url.href);
    }
  }, true);
  const localHost = host => {
    const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    return !value || value === 'localhost' || value.endsWith('.localhost') || value === '127.0.0.1' || value.startsWith('127.') || value === '::1' || value === '0.0.0.0' || value === '::';
  };
  window.open = (url = '') => {
    if (!url) return null;
    try {
      const target = new URL(String(url), location.href);
      if (target.origin !== location.origin && ['http:', 'https:', 'mailto:', 'tel:'].includes(target.protocol) && (!['http:', 'https:'].includes(target.protocol) || !localHost(target.hostname))) native.openExternal?.(target.href);
    } catch { /* Ignore malformed or internal navigation requests. */ }
    return null;
  };
  const saveFolderRequests = new Map();
  window.__notejectAndroidSaveFolderResult = (id, status, value) => {
    const finish = saveFolderRequests.get(String(id));
    if (!finish) return;
    saveFolderRequests.delete(String(id));
    if (status === 'selected') finish.resolve({ status, name: String(value || 'Selected folder') });
    else if (status === 'cancelled') finish.resolve({ status });
    else finish.reject(Error(String(value || 'Could not choose that folder.')));
  };
  function chooseSaveFolder() {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      saveFolderRequests.set(id, { resolve, reject });
      try {
        const error = native.chooseSaveFolder(id);
        if (error) { saveFolderRequests.delete(id); reject(Error(error)); }
      } catch (error) { saveFolderRequests.delete(id); reject(error); }
    });
  }
  function getSaveFolderName() {
    try { return String(native.getSaveFolderName?.() || ''); } catch { return ''; }
  }
  function clearSaveFolder() {
    try { return native.clearSaveFolder?.() === true; } catch { return false; }
  }
  window.NotejectAndroidFiles = Object.freeze({ save, recordingUrl, chooseSaveFolder, getSaveFolderName, clearSaveFolder });
})();
