/* Batch local writes while keeping a synchronous flush for page exit. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotejectWorkspacePersistence = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function create({ storage, key = 'noteject', serialize, status = () => {}, delay = 180, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    let timer, pending = false, firstQueued = 0, lastValue;
    try { lastValue = storage.getItem(key); } catch {}
    function flush() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (!pending) return true;
      try {
        const value = serialize();
        if (value !== lastValue) storage.setItem(key, value);
        lastValue = value;
        pending = false;
        status('saved');
        return true;
      } catch (error) { status('error', error); return false; }
    }
    function schedule() {
      if (!pending) { firstQueued = now(); pending = true; status('pending'); }
      if (timer !== undefined) clearTimer(timer);
      // Continuous interactions still reach disk at least once a second.
      timer = setTimer(flush, Math.max(0, Math.min(delay, 1000 - (now() - firstQueued))));
    }
    return { schedule, flush, isPending: () => pending };
  }
  return { create };
});
