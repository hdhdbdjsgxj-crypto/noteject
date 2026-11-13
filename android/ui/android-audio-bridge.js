/* Bounded Android recording transport. Audio remains native until explicitly read. */
(() => {
  'use strict';
  const native = window.NotejectAndroid;
  if (!native || typeof native.audioRequest !== 'function') return;
  const pending = new Map(), listeners = new Set();
  const maxRecordingBytes = 230400044;
  let sequence = 0, deviceCapabilities = null;
  window.__notejectAndroidAudioEvent = value => {
    let event = value;
    try { if (typeof value === 'string') event = JSON.parse(value); } catch { return; }
    if (!event || typeof event !== 'object') return;
    const request = pending.get(String(event.requestId || ''));
    if (request) {
      clearTimeout(request.timer); pending.delete(String(event.requestId));
      if (event.ok === false || event.error) request.reject(Error(event.error || event.message || 'The audio action could not finish.'));
      else request.resolve(event.result && typeof event.result === 'object' ? { ...event, ...event.result } : event);
    }
    if (request && ['read', 'url', 'export', 'capabilities'].includes(event.action)) return;
    for (const listener of listeners) { try { listener(event); } catch (error) { console.warn('Audio view update failed', error); } }
  };
  function request(action, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = 'audio-' + Date.now() + '-' + (++sequence);
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Error(action === 'transcribe' ? 'Transcription took too long. Your recording is saved; try again.' : 'The audio action took too long. Reopen Recordings and try again.'));
      }, action === 'transcribe' ? 21600000 : action === 'export' ? 900000 : 90000);
      pending.set(requestId, { resolve, reject, timer });
      try { native.audioRequest(requestId, action, JSON.stringify(payload)); }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  }
  async function capabilities(result) {
    if (result.action === 'capabilities') deviceCapabilities = result;
    if (!deviceCapabilities) deviceCapabilities = await request('capabilities');
    const device = { ...deviceCapabilities, ...result.capabilities };
    return { ...result, capabilities: { ...device, localTranscription: device.localTranscription ?? !!device.onDeviceTranscription, localLanguage: 'English', cloudTranscription: false, cloudKeyConfigured: false, nativeAudioPlayback: true, nativeAudioExport: true } };
  }
  async function url(payload) {
    if (!payload?.id) throw Error('Choose a saved recording first.');
    const result = await request('url', { id: payload.id });
    const resource = new URL(String(result.url || ''), location.href);
    if (!result.url || resource.origin !== location.origin || !['http:', 'https:'].includes(resource.protocol)) throw Error('This recording could not be opened safely.');
    return resource.href;
  }
  async function read(payload) {
    if (!payload?.id) throw Error('Choose a saved recording first.');
    const parts = []; let offset = 0, size = null, mimeType = 'audio/wav';
    while (size === null || offset < size) {
      const chunk = await request('read', { id: payload.id, offset, length: 196608 });
      const binary = atob(String(chunk.base64 || chunk.data || ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const total = Number(chunk.size);
      if (!Number.isSafeInteger(total) || total < 44 || total > maxRecordingBytes || (size !== null && total !== size)) throw Error('This recording could not be read safely.');
      size = total; mimeType = chunk.mimeType || chunk.mime || mimeType;
      if (!bytes.length || bytes.length > 196608 || offset + bytes.length > size) throw Error('The recording data is incomplete. Your saved original is still available.');
      parts.push(bytes); offset += bytes.length;
      if (chunk.eof && offset !== size) throw Error('The recording stopped before all audio was read.');
    }
    return new Blob(parts, { type: mimeType });
  }
  async function readRange(payload) {
    if (!payload?.id) throw Error('Choose a saved recording first.');
    const start = Number(payload.offset), length = Number(payload.length);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1 || length > 4_000_000) throw Error('The requested audio segment is invalid.');
    const parts = []; let offset = start, size = null, remaining = length;
    while (remaining > 0) {
      const chunk = await request('read', { id: payload.id, offset, length: Math.min(196608, remaining) });
      const binary = atob(String(chunk.base64 || chunk.data || ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const total = Number(chunk.size), nextOffset = Number(chunk.nextOffset);
      if (!Number.isSafeInteger(total) || total < 44 || total > maxRecordingBytes || (size !== null && total !== size) || Number(chunk.offset) !== offset || !bytes.length || bytes.length > 196608 || nextOffset !== offset + bytes.length || offset + bytes.length > total) throw Error('The recording data is incomplete. Your saved original is still available.');
      size = total; parts.push(bytes); offset = nextOffset; remaining -= bytes.length;
      if (!bytes.length || (chunk.eof && remaining > 0)) throw Error('The recording ended before this audio segment was read.');
    }
    return { bytes: concatenate(parts), size };
  }
  function concatenate(parts) {
    const size = parts.reduce((total, part) => total + part.length, 0), result = new Uint8Array(size);
    let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  window.NotejectAndroidAudio = Object.freeze({
    read, readRange, url,
    command: async (action, payload = {}) => {
      if (action === 'read') return read(payload);
      const result = await request(action, payload);
      return ['get-state', 'capabilities', 'list'].includes(action) ? capabilities(result) : result;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
})();
