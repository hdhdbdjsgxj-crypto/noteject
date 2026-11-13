// Optional worker-side bitmap cache. Failure of this cache must never prevent
// a page from being rendered by the PDF engine.
const DATABASE = 'noteject-mupdf-cache';
const STORE = 'renders';
let lastUsed = 0;
const timestamp = () => (lastUsed = Math.max(Date.now(), lastUsed + 1));

export function createRenderCache({ maxBytes = 96 * 1024 * 1024, maxEntries = 96 } = {}) {
  maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 96 * 1024 * 1024;
  maxEntries = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 96;
  const counters = { hits: 0, misses: 0, writes: 0, evictions: 0, errors: 0, bytes: 0, entries: 0 };
  let database = null, opening = null, queue = Promise.resolve(), queuedBytes = 0, queuedEntries = 0;

  const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 2048;
  const validRecord = record => {
    if (!record || !Number.isSafeInteger(record.width) || !Number.isSafeInteger(record.height)
      || record.width < 1 || record.height < 1 || !(record.pixels instanceof ArrayBuffer)) return false;
    const bytes = record.width * record.height * 4;
    return Number.isSafeInteger(bytes) && bytes <= maxBytes && record.pixels.byteLength === bytes;
  };
  const request = operation => new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error || new Error('Bitmap cache request failed'));
  });
  const transaction = (db, run) => new Promise((resolve, reject) => {
    let tx, result;
    try {
      tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Bitmap cache transaction failed'));
      Promise.resolve(run(tx.objectStore(STORE))).then(value => { result = value; }, error => {
        try { tx.abort(); } catch {}
        reject(error);
      });
    } catch (error) { reject(error); }
  });
  function open() {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    opening = new Promise(resolve => {
      let settled = false, operation;
      const finish = value => {
        if (settled) { value?.close(); return; }
        settled = true; clearTimeout(timer); resolve(value);
      };
      const timer = setTimeout(() => finish(null), 2000);
      try {
        operation = indexedDB.open(DATABASE, 1);
        operation.onupgradeneeded = () => {
          const db = operation.result;
          const store = db.objectStoreNames.contains(STORE)
            ? operation.transaction.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: 'key' });
          if (!store.indexNames.contains('lastUsed')) store.createIndex('lastUsed', 'lastUsed');
          // Key-only cursors inspect the byte budget without cloning all cached
          // pixel buffers back into the worker on every page turn.
          if (!store.indexNames.contains('budget')) store.createIndex('budget', ['lastUsed', 'byteLength']);
        };
        operation.onsuccess = () => {
          const db = operation.result;
          db.onversionchange = () => { db.close(); if (database === db) database = null; opening = null; };
          db.onclose = () => { if (database === db) database = null; opening = null; };
          if (!settled) database = db;
          finish(db);
        };
        operation.onerror = () => finish(null);
        operation.onblocked = () => finish(null);
      } catch { finish(null); }
    }).then(value => { if (!value) opening = null; return value; });
    return opening;
  }
  function enqueue(run, fallback) {
    const job = queue.then(run).catch(() => { counters.errors++; return fallback; });
    queue = job.then(() => undefined);
    return job;
  }
  function visit(cursorRequest, inspect) {
    return new Promise((resolve, reject) => {
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Bitmap cache cursor failed'));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) { resolve(); return; }
        try {
          if (inspect(cursor) === false) resolve();
          else cursor.continue();
        } catch (error) { reject(error); }
      };
    });
  }
  async function measure(store) {
    let bytes = 0, entries = 0, needsRepair = false;
    await visit(store.index('budget').openKeyCursor(), cursor => {
      if (!Number.isFinite(cursor.key[0]) || !Number.isSafeInteger(cursor.key[1]) || cursor.key[1] < 4) needsRepair = true;
      else bytes += cursor.key[1];
      entries++;
    });
    // Old/corrupt records missing indexed metadata are uncommon. Repair those
    // with one record at a time; normal writes only scan small index keys.
    if (needsRepair || entries !== await request(store.count())) {
      bytes = 0; entries = 0;
      await visit(store.openCursor(), cursor => {
        const record = cursor.value;
        if (!validKey(record?.key) || !validRecord(record)) {
          cursor.delete(); counters.evictions++; return;
        }
        record.byteLength = record.pixels.byteLength;
        if (!Number.isFinite(record.lastUsed)) record.lastUsed = timestamp();
        cursor.update(record);
        bytes += record.byteLength; entries++;
      });
    }
    return { bytes, entries };
  }
  async function reserve(store, bytesNeeded, entriesNeeded) {
    const total = await measure(store);
    if (total.bytes + bytesNeeded > maxBytes || total.entries + entriesNeeded > maxEntries) {
      await visit(store.index('budget').openKeyCursor(), cursor => {
        if (total.bytes + bytesNeeded <= maxBytes && total.entries + entriesNeeded <= maxEntries) return false;
        store.delete(cursor.primaryKey);
        total.bytes -= cursor.key[1]; total.entries--; counters.evictions++;
      });
    }
    return total;
  }
  return {
    get(key) {
      return enqueue(async () => {
        if (!validKey(key)) { counters.misses++; return null; }
        const db = await open();
        if (!db) { counters.misses++; return null; }
        const record = await transaction(db, async store => {
          const found = await request(store.get(key));
          if (!validRecord(found)) { if (found) store.delete(key); return null; }
          found.byteLength = found.pixels.byteLength;
          found.lastUsed = timestamp();
          store.put(found);
          return found;
        });
        if (record) counters.hits++; else counters.misses++;
        return record;
      }, null);
    },
    put(key, value) {
      // Copy before entering the async queue, so transferring or mutating the
      // caller's buffer immediately after put() cannot corrupt the cache.
      let record;
      try {
        if (!validKey(key) || !value) return Promise.resolve(false);
        let source = value.pixels;
        if (ArrayBuffer.isView(source)) source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        else if (source instanceof ArrayBuffer) source = new Uint8Array(source);
        else return Promise.resolve(false);
        if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
          || value.width < 1 || value.height < 1 || value.width * value.height * 4 !== source.byteLength
          || source.byteLength > maxBytes || queuedBytes + source.byteLength > maxBytes
          || queuedEntries >= maxEntries) return Promise.resolve(false);
        record = { key, width: value.width, height: value.height,
          pixels: source.slice().buffer, byteLength: source.byteLength, lastUsed: timestamp() };
      } catch { return Promise.resolve(false); }
      queuedBytes += record.byteLength; queuedEntries++;
      return enqueue(async () => {
        const db = await open();
        if (!db) return false;
        record.lastUsed = timestamp();
        const totals = await transaction(db, async store => {
          store.delete(key);
          const total = await reserve(store, record.byteLength, 1);
          await request(store.put(record));
          return { bytes: total.bytes + record.byteLength, entries: total.entries + 1 };
        });
        counters.bytes = totals.bytes; counters.entries = totals.entries; counters.writes++;
        return true;
      }, false).finally(() => { queuedBytes -= record.byteLength; queuedEntries--; });
    },
    removeDocument(prefix) {
      return enqueue(async () => {
        if (typeof prefix !== 'string') return false;
        const db = await open();
        if (!db) return false;
        const totals = await transaction(db, async store => {
          // A string prefix range avoids reading pixel buffers for other books.
          await visit(store.openKeyCursor(IDBKeyRange.lowerBound(prefix)), cursor => {
            if (typeof cursor.primaryKey !== 'string' || !cursor.primaryKey.startsWith(prefix)) return false;
            store.delete(cursor.primaryKey);
          });
          return reserve(store, 0, 0);
        });
        counters.bytes = totals.bytes; counters.entries = totals.entries;
        return true;
      }, false);
    },
    get stats() { return { ...counters }; },
    getStats() { return { ...counters }; },
  };
}
