(function (root) {
  'use strict';

  const currentScript = typeof document === 'object' && document.currentScript;
  const workerUrl = typeof URL === 'function' && typeof document === 'object'
    ? new URL('smart-search-worker.js', currentScript && currentScript.src || document.baseURI).href
    : 'smart-search-worker.js';

  function errorNamed(message, name = 'Error') {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function create() {
    if (typeof root.Worker !== 'function') return null;
    let worker;
    try {
      worker = new root.Worker(workerUrl, { name: 'Noteject Smart Engine' });
    } catch (_) {
      return null;
    }
    let closed = false;
    let sequence = 0;
    let active = null;
    let lastStats = { worker: true, sourceCount: 0, revision: 0 };
    const queue = [];

    function fail(error) {
      if (closed) return;
      closed = true;
      worker.terminate();
      if (active) active.reject(error);
      active = null;
      for (const request of queue.splice(0)) request.reject(error);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
    }

    function pump() {
      if (closed || active || !queue.length) return;
      active = queue.shift();
      try {
        // Only one message is in flight, so queued updates do not clone a large
        // library into the worker repeatedly while an earlier update is busy.
        worker.postMessage({ id: active.id, type: active.type, args: active.args });
        active.args = null;
      } catch (error) {
        const rejected = active;
        active = null;
        rejected.reject(error);
        pump();
      }
    }

    function request(type, args = {}) {
      if (closed) return Promise.reject(errorNamed('The local search worker is closed.', 'AbortError'));
      if (queue.length >= 64) return Promise.reject(errorNamed('The local search queue is full.', 'QueueFullError'));
      return new Promise((resolve, reject) => {
        queue.push({ id: ++sequence, type, args, resolve, reject });
        pump();
      });
    }

    worker.onmessage = event => {
      const message = event.data;
      if (closed || !message || !active || message.id !== active.id) return;
      const completed = active;
      active = null;
      if (message.stats && typeof message.stats === 'object') lastStats = { ...message.stats, worker: true };
      if (message.error) completed.reject(errorNamed(String(message.error.message || 'Local search failed.'), String(message.error.name || 'Error')));
      else completed.resolve(message.result);
      pump();
    };
    worker.onerror = event => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      fail(errorNamed(String(event && event.message || 'The local search worker could not be loaded.'), 'WorkerError'));
    };
    worker.onmessageerror = () => fail(errorNamed('The local search worker returned unreadable data.', 'DataCloneError'));

    return Object.freeze({
      sync(sources) {
        return request('sync', { sources: Array.isArray(sources) ? sources : [] });
      },
      syncDelta(upserts, removals) {
        return request('syncDelta', { upserts: Array.isArray(upserts) ? upserts : [], removals: Array.isArray(removals) ? removals : [] });
      },
      search(query, options) {
        return request('search', { query, options });
      },
      related(key, options) {
        return request('related', { key, options });
      },
      summarize(keys, options) {
        return request('summarize', { keys: Array.isArray(keys) ? keys : [], options });
      },
      suggestTags(key, options) {
        return request('suggestTags', { key, options });
      },
      insights() {
        return request('insights');
      },
      getStats() {
        return { ...lastStats, pending: queue.length + Number(!!active), closed };
      },
      destroy() {
        fail(errorNamed('The local search worker was closed.', 'AbortError'));
      }
    });
  }

  root.NotejectSmartSearchWorker = Object.freeze({ create });
})(typeof globalThis === 'object' ? globalThis : this);
