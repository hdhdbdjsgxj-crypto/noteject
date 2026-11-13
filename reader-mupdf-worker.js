/* MuPDF document worker. MuPDF.js 1.28.1 is bundled under vendor/mupdf/LICENSE. */
// The native C engine stays off the UI thread. Never convert an entire PDF into
// an ArrayBuffer: MuPDF's seekable Stream reads only the file regions it needs.
// Module initialization awaits WASM compilation. Capture requests immediately:
// worker messages may arrive while that top-level import is still pending.
const startupMessages = [];
self.onmessage = event => startupMessages.push(event);
const runtime = {};
globalThis.$libmupdf_wasm_Module = runtime;
const mupdf = await import('./vendor/mupdf/dist/mupdf.js');
const { createRenderCache } = await import('./reader-mupdf-cache.js');
const renderCache = createRenderCache();
const VERSION = '1.28.1';
const BLOCK = 4096;
const CONTENT_READ = 65536;
let current = null;
let opening = null;
let generation = 0;

function failure(message, name = 'Error', code) {
  const error = new Error(message);
  error.name = name;
  if (code) error.code = code;
  return error;
}

class SeekableSource {
  constructor(size, mobile) {
    if (!Number.isSafeInteger(size) || size <= 0) throw failure('PDF file size is unavailable.');
    this.size = size;
    this.limit = (mobile ? 8 : 16) * 1024 * 1024;
    this.blocks = new Map();
    this.cacheBytes = 0;
    this.bytesRead = 0;
    this.readCount = 0;
    this.blockCacheHits = 0;
    this.content = false;
    this.closed = false;
  }
  fileSize() { return this.size; }
  remember(start, bytes) {
    for (let offset = 0; offset < bytes.length; offset += BLOCK) {
      const key = start + offset;
      const block = bytes.slice(offset, Math.min(offset + BLOCK, bytes.length));
      const old = this.blocks.get(key);
      if (old) this.cacheBytes -= old.length;
      this.blocks.delete(key);
      this.blocks.set(key, block);
      this.cacheBytes += block.length;
    }
    while (this.cacheBytes > this.limit) {
      const [key, bytes] = this.blocks.entries().next().value;
      this.blocks.delete(key);
      this.cacheBytes -= bytes.length;
    }
  }
  read(memory, offset, length, position) {
    if (this.closed) throw failure('PDF closed.', 'AbortError');
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) throw failure('Invalid PDF byte range.');
    const count = Math.min(length, Math.max(0, this.size - position));
    let copied = 0;
    while (copied < count) {
      const at = position + copied;
      const start = Math.floor(at / BLOCK) * BLOCK;
      let block = this.blocks.get(start);
      if (block) {
        this.blockCacheHits++;
        this.blocks.delete(start);
        this.blocks.set(start, block);
      } else {
        // Satisfy the native read in one I/O operation. An 8 KiB native read
        // crossing block boundaries previously caused three synchronous HTTP
        // requests per page dictionary. Keep 4 KiB cache granularity and combine
        // only the requested span; image streams may read ahead up to 64 KiB.
        const requested = Math.ceil((position + count - start) / BLOCK) * BLOCK;
        const span = this.content ? CONTENT_READ : Math.min(CONTENT_READ, Math.max(BLOCK, requested));
        const end = Math.min(this.size, start + span);
        const bytes = this.readRange(start, end);
        if (bytes.length !== end - start) throw failure('PDF byte range was truncated.');
        this.bytesRead += bytes.length;
        this.readCount++;
        this.remember(start, bytes);
        block = this.blocks.get(start);
      }
      const within = at - start;
      const take = Math.min(block.length - within, count - copied);
      if (take <= 0) throw failure('PDF byte range could not be read.');
      memory.set(block.subarray(within, within + take), offset + copied);
      copied += take;
    }
    return copied;
  }
  close() {
    this.closed = true;
    this.blocks.clear();
    this.cacheBytes = 0;
  }
}

class BlobSource extends SeekableSource {
  constructor(blob, mobile) {
    super(blob.size, mobile);
    this.blob = blob;
    this.reader = new FileReaderSync();
  }
  readRange(start, end) {
    return new Uint8Array(this.reader.readAsArrayBuffer(this.blob.slice(start, end)));
  }
  close() {
    super.close();
    this.blob = null;
    this.reader = null;
  }
}

class URLSource extends SeekableSource {
  constructor(url, size, mobile) {
    super(size, mobile);
    this.url = url;
    this.controller = new AbortController();
  }
  static async create(url, size, mobile) {
    const controller = new AbortController();
    opening = controller;
    // Verify byte ranges before any synchronous native reads. Cancel a server
    // which ignores Range at the response headers, before consuming its body.
    const response = await fetch(url, { headers: { Range: 'bytes=0-4095' }, signal: controller.signal });
    const match = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(response.headers.get('Content-Range') || '');
    if (response.status !== 206 || !match || +match[1] > 4095 || (size && +match[2] !== size)) {
      await response.body?.cancel();
      throw failure('This PDF server does not support reliable partial file loading.', 'RangeError', 'RANGE_UNSUPPORTED');
    }
    const source = new URLSource(url, +match[2], mobile);
    const expected = +match[1] + 1;
    const chunks = [];
    let received = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > expected) {
          await reader.cancel();
          throw failure('PDF server returned an oversized range.', 'RangeError');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (received !== expected) throw failure('PDF server returned a truncated range.');
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    source.remember(0, bytes);
    source.bytesRead += received;
    source.readCount++;
    return source;
  }
  readRange(start, end) {
    const request = new XMLHttpRequest();
    request.open('GET', this.url, false);
    request.responseType = 'arraybuffer';
    request.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
    request.onreadystatechange = () => {
      if (request.readyState === 2 && request.status !== 206) request.abort();
    };
    request.send(null);
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(request.getResponseHeader('Content-Range') || '');
    if (request.status !== 206 || !match || +match[1] !== start || +match[2] !== end - 1 || +match[3] !== this.size) throw failure('PDF server returned an invalid byte range.', 'RangeError');
    return new Uint8Array(request.response);
  }
  close() {
    super.close();
    this.controller.abort();
    this.url = null;
  }
}

function statistics() {
  const source = current?.source;
  return {
    bytesRead: source?.bytesRead || 0,
    readCount: source?.readCount || 0,
    blockCacheHits: source?.blockCacheHits || 0,
    cacheBytes: source?.cacheBytes || 0,
    cacheLimit: source?.limit || 0,
    displayLists: current?.lists.size || 0,
    displayListLimit: current?.listLimit || 0,
    renderedPages: current?.renderedPages || 0,
    nativeRenders: current?.renderedPages || 0,
    cacheHits: current?.cacheHits || 0,
    persistentCache: renderCache.getStats(),
    nativeHeapBytes: runtime.HEAPU8?.byteLength || 0,
    // The unmodified official build initializes a 100 MiB native store. Public
    // shrinkStore keeps its retained entries below these thresholds after work.
    nativeStoreTargetBytes: current ? (current.mobile ? 24 : 48) * 1024 * 1024 : 0,
    nativeStoreRetentionPercent: current ? (current.mobile ? 24 : 48) : 0
  };
}

function closeDocument() {
  opening?.abort();
  opening = null;
  if (!current) return;
  for (const entry of current.lists.values()) entry.list.destroy();
  current.lists.clear();
  current.doc.destroy();
  current.stream.destroy();
  current.source.close();
  current = null;
  mupdf.emptyStore();
}

function pageNumber(page) {
  if (!current) throw failure('PDF is not open.');
  if (!Number.isInteger(page) || page < 1 || page > current.pages) throw failure('PDF page is outside this document.', 'RangeError');
  return page;
}

function pageBounds(number) {
  pageNumber(number);
  const cached = current.bounds.get(number);
  if (cached) return cached;
  // Building MuPDF's page lookup traverses page dictionaries throughout the
  // file. Keep these scattered metadata reads exact even during raster work.
  const content = current.source.content;
  let page;
  current.source.content = false;
  try {
    page = current.doc.loadPage(number - 1);
    const bounds = page.getBounds();
    if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value)) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw failure('PDF page has invalid dimensions.');
    current.bounds.set(number, bounds);
    return bounds;
  } finally {
    page?.destroy();
    current.source.content = content;
  }
}

async function documentFingerprint(source, doc) {
  // Stable across restarts, bounded to 8 KiB even for multi-gigabyte documents.
  // Include both file ends and size so reused app document IDs cannot return a
  // cached image for another book. No full-file buffer is created.
  const span = Math.min(BLOCK, source.size);
  const sample = new Uint8Array(span * 2 + 8);
  source.read(sample, 0, span, 0);
  source.read(sample, span, span, source.size - span);
  new DataView(sample.buffer).setBigUint64(span * 2, BigInt(source.size), true);
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', sample);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const byte of sample) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `${hash.toString(16)}-${source.size}`;
}

async function openDocument(message) {
  const token = ++generation;
  closeDocument();
  const mobile = !!message.mobile;
  const source = message.blob instanceof Blob
    ? new BlobSource(message.blob, mobile)
    : await URLSource.create(message.url, message.size, mobile);
  if (token !== generation) { source.close(); throw failure('PDF opening canceled.', 'AbortError'); }
  opening = null;
  let stream;
  let doc;
  try {
    stream = new mupdf.Stream(source);
    doc = mupdf.Document.openDocument(stream, 'application/pdf');
    const protectedDocument = doc.needsPassword();
    if (protectedDocument && !doc.authenticatePassword(message.password || '')) {
      throw failure(message.password ? 'Incorrect PDF password.' : 'PDF password required.', 'PasswordException', message.password ? 'INCORRECT_PASSWORD' : 'PASSWORD_REQUIRED');
    }
    // The default page-tree map parses every page dictionary on the first
    // loadPage call. Walking only the requested branch avoids hundreds of
    // scattered reads before the first page of a large book can appear.
    if (doc.isPDF()) doc.setPageTreeCache(false);
    const pages = doc.countPages();
    if (!Number.isInteger(pages) || pages < 1) throw failure('This PDF has no readable pages.');
    const passwordProvided = message.password !== undefined && message.password !== null;
    const cacheKey = !protectedDocument && !passwordProvided && typeof message.cacheKey === 'string' && message.cacheKey.length < 1800 ? message.cacheKey : null;
    const fingerprint = await documentFingerprint(source, doc);
    if (token !== generation) throw failure('PDF opening canceled.', 'AbortError');
    current = { source, stream, doc, pages, mobile, lists: new Map(), bounds: new Map(), textCache: new Map(),
      listLimit: mobile ? 2 : 3, renderedPages: 0, cacheHits: 0, cacheKey: cacheKey ? `${cacheKey}:${fingerprint}` : null };
    // Geometry and text come from this same document and coordinate system.
    // Page lookup is deferred until the starting page is actually requested.
    return { pages, bounds: null, fingerprints: [fingerprint], engine: 'MuPDF', version: VERSION, stats: statistics() };
  } catch (error) {
    if (current?.doc === doc) current = null;
    doc?.destroy();
    stream?.destroy();
    source.close();
    mupdf.emptyStore();
    throw error;
  }
}

function textContent(number) {
  pageNumber(number);
  const cached = current.textCache.get(number);
  if (cached) {
    current.textCache.delete(number); current.textCache.set(number, cached);
    return cached;
  }
  const bounds = pageBounds(number);
  let page, structured;
  const previous = current.source.content;
  current.source.content = true;
  try {
    // Reuse parsed display commands when the page has already been painted.
    const list = current.lists.get(number)?.list;
    if (!list) page = current.doc.loadPage(number - 1);
    structured = (list || page).toStructuredText('preserve-whitespace');
    const lineGeometry = [];
    structured.walk({ beginLine(box, writingMode, direction) {
      const magnitude = Math.hypot(direction[0], direction[1]) || 1;
      const ux = direction[0] / magnitude, uy = direction[1] / magnitude;
      lineGeometry.push({ angle: Math.atan2(uy, ux), box, ux, uy });
    } });
    // Most text is horizontal, for which the line box is already exact. Only
    // rotated pages need character-quad projections to obtain their real local
    // top-left anchor and width along the baseline.
    if (lineGeometry.some(line => Math.abs(line.angle) > .0001)) {
      let at = -1, line;
      structured.walk({
        beginLine() {
          line = lineGeometry[++at];
          if (line) { line.minU = Infinity; line.minV = Infinity; line.maxU = -Infinity; line.maxV = -Infinity; }
        },
        onChar(character, origin, font, size, quad) {
          try {
            if (!line) return;
            for (let point = 0; point < quad.length; point += 2) {
              const u = quad[point] * line.ux + quad[point + 1] * line.uy;
              const v = -quad[point] * line.uy + quad[point + 1] * line.ux;
              line.minU = Math.min(line.minU, u); line.maxU = Math.max(line.maxU, u);
              line.minV = Math.min(line.minV, v); line.maxV = Math.max(line.maxV, v);
            }
          } finally { font.destroy(); }
        },
      });
    }
    // The JSON printer preserves Unicode, fonts and line boxes without creating
    // one native Font wrapper for every character. Scaling improves its integer
    // geometry precision to 1/100 of a page unit.
    const precision = 100;
    const json = JSON.parse(structured.asJSON(precision));
    const items = [], styles = {};
    let lineIndex = -1;
    for (const block of json.blocks || []) {
      if (block.type !== 'text') continue;
      for (const line of block.lines || []) {
        const geometry = lineGeometry[++lineIndex];
        if (typeof line.text !== 'string' || !line.text.length) continue;
        const box = line.bbox || block.bbox, font = line.font || {};
        const x = Number(box?.x) / precision - bounds[0], y = Number(box?.y) / precision - bounds[1];
        const width = Number(box?.w) / precision, height = Number(box?.h) / precision;
        const fontSize = Number(font.size) / precision || height;
        if (![x, y, width, height, fontSize].every(Number.isFinite) || width <= 0 || height <= 0) continue;
        const fontName = String(font.name || 'MuPdfText');
        const fontFamily = String(font.family || 'sans-serif');
        const baseline = Number(line.y) / precision - bounds[1];
        styles[fontName] ||= { fontFamily, ascent: .8, descent: -.2, vertical: !!line.wmode };
        const hasProjection = geometry && Number.isFinite(geometry.minU) && geometry.maxU > geometry.minU && geometry.maxV > geometry.minV;
        const textOrigin = hasProjection ? {
          x: geometry.ux * geometry.minU - geometry.uy * geometry.minV - bounds[0],
          y: geometry.uy * geometry.minU + geometry.ux * geometry.minV - bounds[1],
        } : { x, y };
        items.push({ str: line.text, x, y, width, height, fontSize, fontFamily, fontName,
          angle: geometry?.angle || 0, textOrigin,
          advanceWidth: hasProjection ? geometry.maxU - geometry.minU : width,
          thickness: hasProjection ? geometry.maxV - geometry.minV : height,
          fontWeight: font.weight || 'normal', fontStyle: font.style || 'normal', dir: line.wmode ? 'ttb' : 'ltr',
          transform: [fontSize, 0, 0, fontSize, x, Number.isFinite(baseline) ? baseline : y + height], hasEOL: true });
      }
    }
    const content = { items, styles, bounds: [0, 0, bounds[2] - bounds[0], bounds[3] - bounds[1]], plainText: structured.asText() };
    if (content.plainText.length < 250000 && items.length < 10000) {
      current.textCache.set(number, content);
      while (current.textCache.size > (current.mobile ? 3 : 6)) current.textCache.delete(current.textCache.keys().next().value);
    }
    return content;
  } finally {
    structured?.destroy(); page?.destroy(); current.source.content = previous;
  }
}

function pageLinks(number) {
  pageNumber(number);
  const bounds = pageBounds(number);
  let page, links = [];
  try {
    page = current.doc.loadPage(number - 1);
    links = page.getLinks();
    const result = [];
    for (const link of links) {
      const raw = link.getBounds(), uri = link.getURI();
      if (!Array.isArray(raw) || raw.length !== 4 || raw.some(value => !Number.isFinite(value))) continue;
      const item = { subtype: 'Link', rect: [raw[0] - bounds[0], raw[1] - bounds[1], raw[2] - bounds[0], raw[3] - bounds[1]] };
      if (link.isExternal()) {
        if (!/^(https?:|mailto:|tel:)/i.test(uri)) continue;
        item.url = uri;
      } else {
        const index = current.doc.resolveLink(link);
        if (!Number.isInteger(index) || index < 0 || index >= current.pages) continue;
        item.dest = [index];
      }
      result.push(item);
    }
    return result;
  } finally {
    for (const link of links) link.destroy();
    page?.destroy();
  }
}

function documentOutline() {
  if (!current) throw failure('PDF is not open.');
  let count = 0;
  function convert(entries, depth) {
    if (depth > 64) return [];
    const result = [];
    for (const entry of entries || []) {
      if (++count > 10000) break;
      let index = entry.page;
      if (!Number.isInteger(index) && entry.uri) {
        try { index = current.doc.resolveLink(entry.uri); } catch {}
      }
      result.push({ title: String(entry.title || ''),
        dest: Number.isInteger(index) && index >= 0 && index < current.pages ? [index] : null,
        items: convert(entry.down, depth + 1), bold: false, italic: false, count: entry.open ? 1 : -1 });
    }
    return result;
  }
  const result = convert(current.doc.loadOutline(), 0);
  return result.length ? result : null;
}

function documentMetadata() {
  if (!current) throw failure('PDF is not open.');
  const info = {};
  for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
    const value = current.doc.getMetaData(`info:${key}`);
    if (value) info[key] = value;
  }
  return { info, metadata: null, contentDispositionFilename: null, contentLength: current.source.size };
}

function pageLabels() {
  if (!current) throw failure('PDF is not open.');
  if (!current.doc.isPDF()) return null;
  const trailer = current.doc.getTrailer();
  let root;
  const ranges = [];
  let visited = 0;
  function read(node, depth) {
    if (depth > 32 || ++visited > 2048) return;
    const nums = node.get('Nums'), kids = node.get('Kids');
    try {
      for (let at = 0; at + 1 < nums.length && ranges.length < 10000; at += 2) {
        const index = nums.get(at), value = nums.get(at + 1);
        const style = value.get('S'), prefix = value.get('P'), start = value.get('St');
        try {
          const page = index.asNumber();
          if (Number.isInteger(page) && page >= 0 && page < current.pages) ranges.push({ page,
            style: style.isName() ? style.asName() : '', prefix: prefix.isString() ? prefix.asString() : '',
            start: start.isNumber() ? Math.max(1, Math.min(100000, start.asNumber())) : 1 });
        } finally { index.destroy(); value.destroy(); style.destroy(); prefix.destroy(); start.destroy(); }
      }
      for (let at = 0; at < kids.length && at < 2048; at++) {
        const child = kids.get(at);
        try { read(child, depth + 1); } finally { child.destroy(); }
      }
    } finally { nums.destroy(); kids.destroy(); }
  }
  try {
    root = trailer.get('Root', 'PageLabels');
    if (root.isNull()) return null;
    read(root, 0);
  } finally { root?.destroy(); trailer.destroy(); }
  if (!ranges.length) return null;
  ranges.sort((a, b) => a.page - b.page);
  if (ranges[0].page > 0) ranges.unshift({ page: 0, style: 'D', prefix: '', start: 1 });
  function roman(number) {
    let output = '';
    for (const [value, symbol] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
      [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
      const repeats = Math.floor(number / value); output += symbol.repeat(repeats); number %= value;
    }
    return output;
  }
  const labels = [];
  let rangeIndex = 0;
  for (let page = 0; page < current.pages; page++) {
    while (rangeIndex + 1 < ranges.length && ranges[rangeIndex + 1].page <= page) rangeIndex++;
    const range = ranges[rangeIndex], number = range.start + page - range.page;
    let label = '';
    if (range.style === 'D') label = String(number);
    else if (range.style === 'R' || range.style === 'r') label = roman(number);
    else if (range.style === 'A' || range.style === 'a') label = String.fromCharCode(65 + (number - 1) % 26).repeat(Math.floor((number - 1) / 26) + 1);
    if (range.style === 'r' || range.style === 'a') label = label.toLowerCase();
    labels.push(range.prefix + label);
  }
  return labels;
}

function destination(name) {
  if (!current) throw failure('PDF is not open.');
  if (typeof name !== 'string' || !name.length || name.length > 4096) return null;
  for (const uri of name.startsWith('#') ? [name] : [`#nameddest=${encodeURIComponent(name)}`, name]) {
    try {
      const index = current.doc.resolveLink(uri);
      if (Number.isInteger(index) && index >= 0 && index < current.pages) return [index];
    } catch {}
  }
  return null;
}

function displayList(number) {
  let entry = current.lists.get(number);
  if (entry) {
    current.lists.delete(number);
    current.lists.set(number, entry);
    return entry;
  }
  // Evict before allocation so turning pages cannot accumulate native lists.
  while (current.lists.size >= current.listLimit) {
    const [key, oldest] = current.lists.entries().next().value;
    current.lists.delete(key);
    oldest.list.destroy();
  }
  const content = current.source.content;
  let page;
  try {
    let bounds;
    current.source.content = false;
    try {
      page = current.doc.loadPage(number - 1);
      bounds = current.bounds.get(number) || page.getBounds();
      if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value)) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw failure('PDF page has invalid dimensions.');
      current.bounds.set(number, bounds);
    } finally { current.source.content = content; }
    entry = { bounds, list: page.toDisplayList(true) };
    current.lists.set(number, entry);
    return entry;
  } finally { page?.destroy(); }
}

function bitmapDimensions(message) {
  pageNumber(message.page);
  const width = Number(message.width);
  const height = Number(message.height);
  const maxPixels = current.mobile ? 4000000 : 12000000;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > maxPixels) throw failure('Requested PDF bitmap exceeds the rendering memory limit.', 'RangeError', 'BITMAP_LIMIT');
  return { width, height };
}

function renderNative(message) {
  const number = pageNumber(message.page);
  const { width, height } = bitmapDimensions(message);
  let pixmap;
  let device;
  current.source.content = true;
  try {
    const entry = displayList(number);
    const bounds = entry.bounds;
    const sx = width / (bounds[2] - bounds[0]);
    const sy = height / (bounds[3] - bounds[1]);
    const matrix = [sx, 0, 0, sy, -bounds[0] * sx, -bounds[1] * sy];
    pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true);
    pixmap.clear(255);
    device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    entry.list.run(device, matrix);
    device.close();
    device.destroy();
    device = null;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const nativePixels = pixmap.getPixels();
    const stride = pixmap.getStride();
    if (pixmap.getNumberOfComponents() !== 4 || stride < width * 4) throw failure('MuPDF returned an unsupported bitmap format.');
    for (let y = 0; y < height; y++) pixels.set(nativePixels.subarray(y * stride, y * stride + width * 4), y * width * 4);
    current.renderedPages++;
    return { width, height, pixels: pixels.buffer };
  } finally {
    device?.destroy();
    pixmap?.destroy();
    current.source.content = false;
    // MuPDF's 100 MiB default store is reduced after each operation, retaining
    // useful decoded resources without keeping a whole textbook in memory.
    if (!mupdf.shrinkStore(current.mobile ? 24 : 48)) mupdf.emptyStore();
  }
}

async function render(message) {
  const { width, height } = bitmapDimensions(message);
  const state = current;
  const key = state.cacheKey ? `${state.cacheKey}:MuPDF-${VERSION}:${message.page}:${width}x${height}` : null;
  if (key) {
    const cached = await renderCache.get(key);
    if (current !== state) throw failure('PDF rendering canceled.', 'AbortError');
    if (cached && cached.width === width && cached.height === height && cached.pixels instanceof ArrayBuffer && cached.pixels.byteLength === width * height * 4) {
      state.cacheHits++;
      return { width, height, pixels: cached.pixels, stats: statistics() };
    }
  }
  const result = renderNative(message);
  if (key) await renderCache.put(key, result);
  if (current !== state) throw failure('PDF rendering canceled.', 'AbortError');
  return { ...result, stats: statistics() };
}

self.onmessage = async ({ data: message }) => {
  const id = message?.id;
  try {
    let result;
    if (message.type === 'open') result = await openDocument(message);
    else if (message.type === 'render') result = await render(message);
    else if (message.type === 'bounds') result = { bounds: pageBounds(message.page), stats: statistics() };
    else if (message.type === 'text') result = { content: textContent(message.page), stats: statistics() };
    else if (message.type === 'links') result = { links: pageLinks(message.page), stats: statistics() };
    else if (message.type === 'outline') result = { outline: documentOutline(), stats: statistics() };
    else if (message.type === 'labels') result = { labels: pageLabels(), stats: statistics() };
    else if (message.type === 'metadata') result = { metadata: documentMetadata(), stats: statistics() };
    else if (message.type === 'destination') result = { destination: destination(message.name), stats: statistics() };
    else if (message.type === 'stats') result = statistics();
    else if (message.type === 'close') { ++generation; closeDocument(); result = { closed: true, stats: statistics() }; }
    else throw failure('Unknown MuPDF worker request.');
    self.postMessage({ id, result }, result.pixels ? [result.pixels] : []);
  } catch (error) {
    self.postMessage({ id, error: { name: error?.name || 'Error', message: error?.message || String(error), code: error?.code }, stats: statistics() });
  }
};
for (const message of startupMessages.splice(0)) self.onmessage(message);
