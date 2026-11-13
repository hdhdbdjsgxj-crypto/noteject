/* Opens PDF/DjVu in the shared native Reader and migrates saved attachments once. */
(() => {
  'use strict';
  const native = window.NotejectAndroid;
  const CHUNK_BYTES = 256 * 1024;
  let active = null, sequence = 0;

  function readReply(value, fallback) {
    let result;
    try { result = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new Error(fallback); }
    if (!result || typeof result !== 'object') throw new Error(fallback);
    if (result.error || result.ok === false) throw new Error(result.error || fallback);
    return result;
  }

  function check(session) {
    if (session.controller.signal.aborted || active !== session) throw new DOMException('The document was closed.', 'AbortError');
  }

  function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error || new Error('Could not read this document.'));
      reader.readAsDataURL(blob);
    });
  }

  async function sampleHash(blob) {
    const span = Math.min(65536, blob.size);
    const [head, tail] = await Promise.all([blob.slice(0, span).arrayBuffer(), blob.slice(Math.max(0, blob.size - span)).arrayBuffer()]);
    const bytes = new Uint8Array(head.byteLength + tail.byteLength);
    bytes.set(new Uint8Array(head));
    bytes.set(new Uint8Array(tail), head.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function available() {
    return !!(native?.prepareNativeReader && native?.writeNativeReaderChunk && native?.finishNativeReaderUpload && native?.cancelNativeReaderUpload && native?.openNativeReader);
  }

  // Native Reader chrome follows the same resolved palette as the Books/Document
  // workspace. Pass values, rather than a second independently selected theme.
  function workspaceTheme() {
    const palette = { mode: 'dark', background: '#111722', panel: '#1b2535', raised: '#273349',
      line: '#36445b', ink: '#e9e9ec', muted: '#b1bfd6', accent: '#c8afff', accentInk: '#281c3b' };
    try {
      const style = window.getComputedStyle(document.body);
      const properties = { background: '--am-bg', panel: '--am-panel', raised: '--am-raised', line: '--am-line',
        ink: '--am-ink', muted: '--am-muted', accent: '--am-accent', accentInk: '--am-accent-ink' };
      for (const [key, property] of Object.entries(properties)) {
        const value = style.getPropertyValue(property).trim();
        if (value && value.length <= 80) palette[key] = value;
      }
      palette.mode = style.getPropertyValue('--am-color-scheme').trim() === 'light' ? 'light' : 'dark';
    } catch { /* A restored workspace may launch before its DOM is attached. */ }
    return palette;
  }

  function cancel() {
    const session = active;
    if (!session || session.launched) return;
    session.controller.abort();
    if (session.uploadId) {
      try { native.cancelNativeReaderUpload(session.uploadId); } catch {}
      session.uploadId = null;
    }
    active = null;
  }

  function open(options = {}) {
    if (!available()) return Promise.reject(new Error('The native Reader is unavailable. Update Noteject and try again.'));
    const doc = options.document;
    if (!doc?.id || !['pdf', 'djvu'].includes(doc.type)) return Promise.reject(new Error('Choose a PDF or DjVu document.'));
    if (active?.documentId === doc.id && !active.controller.signal.aborted) return active.promise;
    if (active?.launched) return Promise.reject(new Error('Close the current Reader before opening another document.'));
    cancel();
    const session = { documentId: doc.id, requestId: options.requestId || 'reader-' + Date.now().toString(36) + '-' + (++sequence), controller: new AbortController(), uploadId: null, launched: false, promise: null };
    active = session;
    const abort = () => { if (active === session) cancel(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) session.controller.abort();
    session.promise = (async () => {
      try {
        check(session);
        const sourceRevision = doc.sourceRevision ||= crypto.randomUUID();
        const workspaceGeneration = String(options.workspaceGeneration || 'original');
        const blob = typeof options.getBlob === 'function' ? await options.getBlob(doc) : doc.blob;
        check(session);
        if (!(blob instanceof Blob) || !Number.isSafeInteger(blob.size) || blob.size < 1) throw new Error('The original document is unavailable. Reconnect it from Documents.');
        const fingerprint = await sampleHash(blob);
        check(session);
        if (doc.sourceRevision !== sourceRevision) throw new Error('The document changed while opening. Open it again from Documents.');
        let prepared = readReply(native.prepareNativeReader(JSON.stringify({ documentId: doc.id, documentType: doc.type, name: doc.name, size: blob.size, sampleHash: fingerprint, sourceRevision, workspaceGeneration })), 'Could not prepare this document.');
        session.uploadId = prepared.uploadId || null;
        check(session);
        if (session.uploadId) {
          for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
            check(session);
            const chunk = await base64(blob.slice(offset, Math.min(blob.size, offset + CHUNK_BYTES)));
            check(session);
            if (!native.writeNativeReaderChunk(session.uploadId, chunk)) throw new Error('The document transfer was interrupted. Try opening the book again.');
            options.onProgress?.({ phase: 'copy', loaded: Math.min(blob.size, offset + CHUNK_BYTES), total: blob.size });
          }
          check(session);
          prepared = readReply(native.finishNativeReaderUpload(session.uploadId), 'Could not finish preparing this document.');
          session.uploadId = null;
        }
        check(session);
        if (!prepared.ready || (!prepared.fileKey && !prepared.sourceUri)) throw new Error('The complete document is not ready to open.');
        if (doc.sourceRevision !== sourceRevision) throw new Error('The document changed while opening. Open it again from Documents.');
        const request = {
          requestId: session.requestId,
          documentId: doc.id,
          documentType: doc.type,
          workspaceGeneration,
          sourceRevision,
          name: doc.name,
          size: blob.size,
          sampleHash: fingerprint,
          fileKey: prepared.fileKey || null,
          sourceUri: prepared.sourceUri || null,
          page: Math.max(1, Math.trunc(Number(options.page ?? doc.readerPage) || 1)),
          offset: Math.max(0, Math.min(1, Number(options.offset ?? doc.readerPageOffset) || 0)),
          zoom: options.zoom ?? 1,
          folder: doc.folder || 'Inbox',
          bookmarks: options.bookmarks || doc.bookmarks || [],
          passages: options.passages || [],
          boards: options.boards || [],
          notes: options.notes || [],
          readerMenu: options.readerMenu || [],readerWorkflow:String(options.readerWorkflow||''),
          passageFolder: String(options.passageFolder || doc.folder || 'Inbox'),
          noteFolders: options.noteFolders || [],
          passageBoardId: String(options.passageBoardId || ''),
          captureBoardId: String(options.captureBoardId || ''),
          defaultBoardId: String(options.defaultBoardId || ''),
          quote: String(options.quote || ''),
          selectionLocation: options.selectionLocation || null,
          textOffset: Number.isInteger(options.textOffset) && options.textOffset >= 0 ? options.textOffset : -1,
          passageSourceRevision: String(options.passageSourceRevision || ''),
          forceLocation: !!options.forceLocation,
          progressUpdatedAt: Number(options.progressUpdatedAt) || 0,
          uiTheme: workspaceTheme(),
        };
        readReply(native.openNativeReader(JSON.stringify(request)), 'Could not open the native Reader.');
        session.launched = true;
        options.onProgress?.({ phase: 'ready', loaded: blob.size, total: blob.size });
        return { requestId: session.requestId, documentId: doc.id, ...prepared };
      } catch (error) {
        if (session.uploadId) { try { native.cancelNativeReaderUpload(session.uploadId); } catch {} session.uploadId = null; }
        if (active === session) active = null;
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', abort);
      }
    })();
    return session.promise;
  }

  window.__notejectNativeReaderEvent = event => {
    if (!event || typeof event !== 'object') return;
    if (active && (event.requestId === active.requestId || (!event.requestId && event.documentId === active.documentId)) && ['closed', 'error'].includes(event.type)) active = null;
    window.dispatchEvent(new CustomEvent('noteject-native-reader', { detail: event }));
  };
  function drain() {
    if (!native?.getNativeReaderEvents) return;
    try {
      const events = JSON.parse(native.getNativeReaderEvents() || '[]');
      if (Array.isArray(events)) events.forEach(event => window.__notejectNativeReaderEvent(event));
    } catch (error) { console.warn('Native Reader updates could not be restored.', error); }
  }
  function acknowledge(ids) {
    if (!Array.isArray(ids) || !ids.length || !native?.acknowledgeNativeReaderEvents) return false;
    return native.acknowledgeNativeReaderEvents(JSON.stringify(ids.map(String)));
  }
  async function readTextIndex(key, documentId) {
    if (!native?.readNativeReaderTextIndex) throw new Error('Update Noteject to index native documents.');
    const decoder = new TextDecoder(); let offset = 0, text = '', snapshot = null;
    do {
      const chunk = readReply(native.readNativeReaderTextIndex(key, offset), 'The document text cache is unavailable.');
      if (chunk.missing) return null;
      if (chunk.documentId !== documentId || chunk.next < offset || chunk.size > 12 * 1024 * 1024 || (chunk.next === offset && !chunk.done)) throw new Error('Invalid native document text cache.');
      const bytes = Uint8Array.from(atob(chunk.base64 || ''), char => char.charCodeAt(0));
      text += decoder.decode(bytes, { stream: !chunk.done }); offset = chunk.next; snapshot = chunk;
      if (text.length > 2_100_000) throw new Error('The document text cache exceeds its size limit.');
      if (chunk.done) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    } while (true);
    return { ...snapshot, text };
  }
  async function readCapture(id) {
    if (!native?.readNativeReaderCapture) throw Error('Update Noteject to save page captures.');
    let offset = 0, total = null;
    const parts = [];
    do {
      const chunk = readReply(native.readNativeReaderCapture(id, offset), 'This page capture is unavailable.');
      if (!Number.isSafeInteger(chunk.total) || chunk.total < 1 || chunk.total > 25 * 1024 * 1024 || (total !== null && chunk.total !== total)) throw Error('Invalid Reader capture size.');
      const bytes = Uint8Array.from(atob(chunk.data || ''), char => char.charCodeAt(0));
      if (!bytes.length || chunk.next !== offset + bytes.length || chunk.next > chunk.total || Boolean(chunk.done) !== (chunk.next === chunk.total)) throw Error('Incomplete Reader capture.');
      total = chunk.total; parts.push(bytes); offset = chunk.next;
      if (chunk.done) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    } while (true);
    return new Blob(parts, { type: 'image/png' });
  }
  window.NotejectNativeReader = Object.freeze({ open, cancel, available, drain, acknowledge, readTextIndex, readCapture, theme:workspaceTheme });
})();
