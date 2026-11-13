/* Bounded page view for MuPDF documents and DjVu. Document engines remain caller-owned. */
(function (global) {
  'use strict';
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const aborted = () => new DOMException('The document was closed.', 'AbortError');
  const cancelled = error => /^(AbortError|AbortException|RenderingCancelledException)$/.test(error?.name || '');
  const mobile = !!global.NotejectAndroid || (!!global.NotejectWebApp && (global.innerWidth < 960 || global.matchMedia?.('(pointer: coarse)').matches));
  const PAGE_PIXELS = mobile ? 3000000 : 6000000;
  const CACHE_PIXELS = mobile ? 9000000 : 24000000;
  const CACHE_PAGES = mobile ? 6 : 10;
  const MAX_EDGE = 8192;

  function create(options = {}) {
    let container = null, viewport = null, pdf = null, rasterizer = null;
    let documentId = '', current = 1, mode = 'continuous', zoom = 'fit';
    let alive = false, epoch = 0, layoutRevision = 0, navigationRevision = 0, navigationTarget = null;
    let entries = [], queue = [], activeJob = null, desired = new Set(), visible = new Set();
    let intersection = null, resizeObserver = null, signal = null, onAbort = null;
    let frame = 0, resizeTimer = 0, prefetchTimer = 0, textTimer = 0, thumbTimer = 0, previewFrame = 0, wheelTimer = 0;
    let layoutWidth = 900, previousTop = 0, direction = 1, preview = null, previousOverflowAnchor = '';
    let outlinePromise = null, pageLabelsPromise = null, thumbnailQueue = [], activeThumbnail = null;
    let touchGesture = null, multiTouch = false, suppressTouchClickUntil = 0, previousTouchAction = '', touchViewport = null, interactionRevision = 0;
    const thumbnails = new Map();
    const meter = document.createElement('canvas').getContext('2d');

    function emit(name, ...args) {
      try { return options[name]?.(...args); }
      catch (error) { console.error('Reader callback failed:', error); }
    }
    function number(value) { return clamp(Math.trunc(Number(value) || 1), 1, pdf?.numPages || 1); }
    function entryFor(value = current) { return entries[number(value) - 1] || null; }
    function valid(ticket) { return alive && epoch === ticket; }
    function availableWidth() {
      if (!viewport) return 900;
      const style = global.getComputedStyle(viewport);
      return Math.max(120, viewport.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - 4);
    }
    function scale(entry) { return zoom === 'fit' ? clamp(layoutWidth / entry.size.width, .1, 4) : zoom; }
    function currentScale(point) {
      if (preview) return preview.target;
      return scale(point && Number.isFinite(point.y) ? entryAt(point.y) || entryFor() : entryFor() || { size: { width: 612 } });
    }
    function dimensions(entry) {
      const factor = scale(entry);
      entry.width = Math.max(1, entry.size.width * factor);
      entry.height = Math.max(1, entry.size.height * factor);
      entry.host.style.width = entry.width + 'px';
      entry.host.style.height = entry.height + 'px';
      entry.host.hidden = mode === 'single' && entry.number !== current;
      entry.host.style.display = entry.host.hidden ? 'none' : 'block';
      if (entry.layer) entry.layer.style.transform = 'scale(' + factor + ')';
      if (entry.links) entry.links.style.transform = 'scale(' + factor + ')';
    }
    function setCurrent(value, source = 'scroll') {
      const next = number(value);
      if (next === current) return;
      current = next;
      emit('onPageChange', current, { numPages: pdf.numPages, source });
    }
    function entryAt(y) {
      if (!entries.length || mode === 'single') return entryFor();
      let low = 0, high = entries.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (entries[middle].host.getBoundingClientRect().bottom < y) low = middle + 1;
        else high = middle;
      }
      return entries[low];
    }
    function captureAnchor(point = {}) {
      if (!viewport || !entries.length) return null;
      const bounds = viewport.getBoundingClientRect();
      const x = Number.isFinite(point.x) ? point.x : bounds.left + viewport.clientWidth / 2;
      const y = Number.isFinite(point.y) ? point.y : bounds.top + Math.min(64, viewport.clientHeight / 4);
      const entry = entryAt(y) || entryFor(), rect = entry.host.getBoundingClientRect();
      return { page: entry.number, x: (x - rect.left) / Math.max(1, rect.width), y: (y - rect.top) / Math.max(1, rect.height), screenX: x - bounds.left, screenY: y - bounds.top };
    }
    function restoreAnchor(anchor) {
      if (!anchor || !alive) return;
      const entry = entryFor(anchor.page);
      if (!entry || entry.host.hidden) return;
      const bounds = viewport.getBoundingClientRect(), rect = entry.host.getBoundingClientRect();
      viewport.scrollLeft += rect.left + anchor.x * rect.width - bounds.left - anchor.screenX;
      viewport.scrollTop += rect.top + anchor.y * rect.height - bounds.top - anchor.screenY;
    }
    function scrollToEntry(entry) {
      if (!entry || !viewport) return;
      const top = entry.host.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      const padding = parseFloat(global.getComputedStyle(viewport).paddingTop) || 0;
      viewport.scrollTop += top - padding;
    }
    async function loadPage(entry, ticket = epoch) {
      if (entry.page) return entry.page;
      if (!entry.pagePromise) {
        entry.pagePromise = Promise.resolve(pdf.getPage(entry.number)).then(page => {
          if (!valid(ticket)) { page.cleanup?.(); throw aborted(); }
          entry.page = page;
          const box = page.getViewport({ scale: 1 });
          if (!(Number.isFinite(box.width) && box.width > 0 && Number.isFinite(box.height) && box.height > 0)) throw new Error('Page ' + entry.number + ' has invalid dimensions.');
          if (Math.abs(entry.size.width - box.width) > .01 || Math.abs(entry.size.height - box.height) > .01) {
            const anchor = captureAnchor();
            entry.size = { width: box.width, height: box.height };
            dimensions(entry);
            restoreAnchor(anchor);
          }
          return page;
        }).finally(() => { entry.pagePromise = null; });
      }
      return entry.pagePromise;
    }
    function selected(entry) {
      const selection = global.getSelection?.();
      return !!(selection && !selection.isCollapsed && entry.layer && (entry.layer.contains(selection.anchorNode) || entry.layer.contains(selection.focusNode)));
    }
    function freeCanvas(canvas) {
      if (!canvas) return;
      canvas.remove();
      canvas.width = canvas.height = 0;
    }
    function release(entry) {
      if (!entry || entry.job) return;
      freeCanvas(entry.canvas);
      entry.canvas = null; entry.visualRevision = -1;
      entry.layer?.remove(); entry.links?.remove(); entry.layer = entry.links = null;
      entry.textContent = null; entry.textReady = false;
      entry.host.classList.remove('is-rendered');
      entry.host.dataset.placeholder = 'Page ' + entry.number;
      if (!entry.textPromise && !entry.pagePromise) { entry.page?.cleanup?.(); entry.page = null; }
    }
    function trimCache() {
      let residents = entries.filter(entry => entry.canvas);
      let pixels = residents.reduce((sum, entry) => sum + entry.canvas.width * entry.canvas.height, 0);
      residents.sort((a, b) => {
        const keep = entry => (entry.number === current ? 1000000 : 0) + (selected(entry) ? 1000000 : 0) + (visible.has(entry.number) ? 100000 : 0) + (desired.has(entry.number) ? 10000 : 0);
        return keep(a) - keep(b) || a.lastUsed - b.lastUsed;
      });
      let count = residents.length;
      for (const entry of residents) {
        if (pixels <= CACHE_PIXELS && count <= CACHE_PAGES) break;
        if (entry.number === current || entry.job || selected(entry)) continue;
        pixels -= entry.canvas.width * entry.canvas.height; count--;
        release(entry);
      }
    }
    function finishJob(job, result) {
      if (job.settled) return;
      job.settled = true;
      if (job.entry.job === job) job.entry.job = null;
      job.resolve(result);
    }
    function cancelJob(job) {
      if (!job || job.cancelled) return;
      job.cancelled = true;
      try { job.task?.cancel?.(); } catch {}
      queue = queue.filter(item => item !== job);
      finishJob(job, false);
      if (job.entry.job == null) {
        job.entry.host.classList.remove('is-loading');
        job.entry.host.removeAttribute('aria-busy');
        if (!job.entry.canvas) job.entry.host.dataset.placeholder = 'Page ' + job.entry.number;
      }
    }
    function cancelUnwanted() {
      for (const job of [...queue]) if (!desired.has(job.entry.number)) cancelJob(job);
      if (activeJob && !desired.has(activeJob.entry.number)) cancelJob(activeJob);
      if (activeThumbnail && (queue.length || activeJob || preview)) cancelThumbnail(activeThumbnail.canvas);
    }
    function render(entry, priority = 0) {
      if (!entry || !alive) return Promise.resolve(false);
      entry.lastUsed = performance.now();
      if (entry.canvas && entry.visualRevision === layoutRevision) return Promise.resolve(true);
      if (entry.job && entry.job.layout === layoutRevision && !entry.job.cancelled) {
        entry.job.priority = Math.min(entry.job.priority, priority);
        pump(); return entry.job.promise;
      }
      cancelJob(entry.job);
      entry.host.querySelector('.reader-pdf-page-error')?.remove();
      entry.host.classList.remove('has-error');
      const job = { entry, priority, layout: layoutRevision, epoch, cancelled: false, settled: false, task: null, resolve: null, promise: null };
      job.promise = new Promise(resolve => { job.resolve = resolve; });
      entry.job = job; entry.error = null;
      entry.host.classList.add('is-loading'); entry.host.setAttribute('aria-busy', 'true');
      if (!entry.canvas) entry.host.dataset.placeholder = 'Rendering page ' + entry.number + '…';
      queue.push(job);
      if (activeThumbnail) cancelThumbnail(activeThumbnail.canvas);
      pump();
      return job.promise;
    }
    function currentJob(job) { return valid(job.epoch) && !job.cancelled && job.layout === layoutRevision && job.entry.job === job; }
    function outputSize(entry, maximum = PAGE_PIXELS, width = null) {
      const ratio = Math.min(2, Math.max(1, global.devicePixelRatio || 1));
      let w = width || entry.width * ratio, h = w * entry.size.height / entry.size.width;
      const reduction = Math.min(1, Math.sqrt(maximum / (w * h)), MAX_EDGE / w, MAX_EDGE / h);
      return { width: Math.max(1, Math.floor(w * reduction)), height: Math.max(1, Math.floor(h * reduction)) };
    }
    function completedCanvas(result, requested) {
      const canvas = document.createElement('canvas');
      const bitmap = result?.bitmap;
      canvas.width = Math.max(1, result?.width || bitmap?.width || requested.width);
      canvas.height = Math.max(1, result?.height || bitmap?.height || requested.height);
      if (canvas.width > MAX_EDGE || canvas.height > MAX_EDGE || canvas.width * canvas.height > PAGE_PIXELS + MAX_EDGE) throw new Error('The rendered page exceeded the Reader bitmap budget.');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('The page drawing surface is unavailable.');
      if (bitmap) context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      else if (result?.pixels) {
        const pixels = result.pixels instanceof Uint8ClampedArray ? result.pixels : new Uint8ClampedArray(result.pixels);
        if (pixels.length !== canvas.width * canvas.height * 4) throw new Error('The document engine returned an incomplete page image.');
        context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      } else throw new Error('The document engine returned no page image.');
      return canvas;
    }
    function pump() {
      if (!alive || preview || activeJob || activeThumbnail) return;
      queue.sort((a, b) => a.priority - b.priority || Math.abs(a.entry.number - current) - Math.abs(b.entry.number - current));
      let job;
      while (queue.length && !job) { const candidate = queue.shift(); if (!candidate.cancelled && !candidate.settled) job = candidate; }
      if (!job) { scheduleText(); scheduleThumbnails(); return; }
      activeJob = job;
      void draw(job).finally(() => {
        if (activeJob === job) activeJob = null;
        pump();
      });
    }
    async function draw(job) {
      const entry = job.entry;
      let result = null, canvas = null;
      try {
        await loadPage(entry, job.epoch);
        if (!currentJob(job)) return;
        const size = outputSize(entry);
        job.task = rasterizer.renderPage({ page: entry.number, ...size });
        result = await job.task.promise;
        if (!currentJob(job)) return;
        canvas = completedCanvas(result, size);
        if (!currentJob(job)) return;
        canvas.className = 'reader-pdf-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
        const previous = entry.canvas;
        if (previous) previous.replaceWith(canvas); else entry.host.prepend(canvas);
        entry.canvas = canvas; canvas = null; entry.visualRevision = job.layout; entry.lastUsed = performance.now();
        freeCanvas(previous);
        delete entry.host.dataset.placeholder;
        entry.host.classList.remove('is-loading'); entry.host.classList.add('is-rendered'); entry.host.removeAttribute('aria-busy');
        finishJob(job, true);
        trimCache(); scheduleText();
      } catch (error) {
        if (currentJob(job) && !cancelled(error)) {
          entry.error = error;
          entry.host.classList.remove('is-loading'); entry.host.removeAttribute('aria-busy');
          delete entry.host.dataset.placeholder;
          entry.host.classList.add('has-error');
          const message = document.createElement('div'); message.className = 'reader-pdf-page-error';
          Object.assign(message.style, { position: 'absolute', inset: '0', zIndex: '5', display: 'grid', alignContent: 'center', justifyItems: 'center', padding: '20px', boxSizing: 'border-box', background: entry.canvas ? '#ffffffdd' : '#fff', color: '#343b48' });
          const label = document.createElement('p'); label.textContent = 'Page ' + entry.number + ' could not be displayed.';
          const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again';
          retry.onclick = event => { event.stopPropagation(); entry.error = null; void render(entry, -10); };
          message.append(label, retry); entry.host.append(message);
          emit('onError', error);
        }
      } finally {
        result?.bitmap?.close?.();
        freeCanvas(canvas);
        finishJob(job, false);
        if (!entry.canvas && !entry.job && !entry.textPromise && !entry.pagePromise) { entry.page?.cleanup?.(); entry.page = null; }
      }
    }
    function buildText(entry, content) {
      const layer = document.createElement('div');
      layer.className = 'pdf-text-layer reader-pdf-text-layer textLayer';
      layer.dataset.readerDocument = documentId; layer.dataset.readerPage = String(entry.number);
      Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', width: entry.size.width + 'px', height: entry.size.height + 'px', transform: 'scale(' + scale(entry) + ')', transformOrigin: '0 0', zIndex: '2', color: 'transparent', userSelect: 'text', WebkitUserSelect: 'text', lineHeight: '1', textAlign: 'left', overflow: 'hidden' });
      const items = Array.isArray(content?.items) ? content.items : [];
      let plainY = 0;
      for (const item of items) {
        if (typeof item.str !== 'string' || !item.str) continue;
        const span = document.createElement('span'); span.textContent = item.str;
        let x = Number(item.x), y = Number(item.y), height = Number(item.height), width = Number(item.width);
        const angle = Number.isFinite(Number(item.angle)) ? Number(item.angle) : 0;
        if (Number.isFinite(item.textOrigin?.x) && Number.isFinite(item.textOrigin?.y)) { x = item.textOrigin.x; y = item.textOrigin.y; }
        if (Number(item.advanceWidth) > 0) width = Number(item.advanceWidth);
        if (Number(item.thickness) > 0) height = Number(item.thickness);
        let fontSize = Number(item.fontSize) || height || Math.hypot(item.transform?.[2] || 0, item.transform?.[3] || 0) || 12;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          if (Array.isArray(item.transform) && item.transform.length >= 6) {
            x = item.transform[4]; y = entry.size.height - item.transform[5] - fontSize;
          } else { x = 0; y = plainY; plainY += fontSize * 1.2; }
        }
        height = height > 0 ? height : fontSize * 1.2;
        fontSize = clamp(fontSize, 1, Math.max(1, height * 1.5));
        const family = typeof item.fontFamily === 'string' ? item.fontFamily.replace(/[;{}]/g, '') : 'sans-serif';
        if (meter) meter.font = fontSize + 'px ' + family;
        const measured = meter?.measureText(item.str).width || item.str.length * fontSize * .5;
        if (!(width > 0)) width = measured;
        const scaleX = width / Math.max(.01, measured);
        Object.assign(span.style, { position: 'absolute', left: x + 'px', top: y + 'px', fontFamily: family, fontSize: fontSize + 'px', lineHeight: height + 'px', height: height + 'px', whiteSpace: 'pre', color: 'transparent', transformOrigin: '0 0', transform: 'rotate(' + angle + 'rad) scaleX(' + scaleX + ')', userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' });
        if (item.dir) span.dir = item.dir;
        layer.append(span);
      }
      entry.layer?.replaceWith(layer);
      if (!layer.parentElement) entry.host.append(layer);
      entry.layer = layer; entry.textReady = true;
      emit('onTextReady', { page: entry.number, text: items.map(item => item.str || '').join(' '), items, layer, documentId });
    }
    function safeUrl(value) {
      if (typeof value !== 'string' || !value.trim()) return null;
      try { const url = new URL(value, document.baseURI); return /^(https?:|mailto:|tel:|file:|blob:)$/.test(url.protocol) ? url.href : null; }
      catch { return null; }
    }
    function buildLinks(entry, annotations) {
      const layer = document.createElement('div'); layer.className = 'reader-pdf-links';
      Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', width: entry.size.width + 'px', height: entry.size.height + 'px', transform: 'scale(' + scale(entry) + ')', transformOrigin: '0 0', pointerEvents: 'none', zIndex: '3' });
      for (const item of annotations || []) {
        const external = safeUrl(item.url || item.unsafeUrl);
        if ((!external && !item.dest && !item.action) || !Array.isArray(item.rect) || !item.rect.every(Number.isFinite)) continue;
        const [x0, y0, x1, y1] = item.rect;
        const link = document.createElement('a'); link.className = 'pdf-link-overlay'; link.href = external || '#';
        link.setAttribute('aria-label', external || 'Go to linked page');
        Object.assign(link.style, { position: 'absolute', pointerEvents: 'auto', left: Math.min(x0, x1) + 'px', top: Math.min(y0, y1) + 'px', width: Math.abs(x1 - x0) + 'px', height: Math.abs(y1 - y0) + 'px' });
        if (external) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        link.onclick = event => {
          event.preventDefault(); event.stopPropagation();
          if (item.dest) { void goToDestination(item.dest); return; }
          if (item.action) {
            const next = item.action === 'FirstPage' ? 1 : item.action === 'LastPage' ? pdf.numPages : current + (item.action === 'PrevPage' ? -1 : 1);
            void goToPage(next); return;
          }
          if (external && options.onLink) Promise.resolve(emit('onLink', external, item)).catch(error => emit('onError', error));
          else if (external) global.open(external, '_blank', 'noopener,noreferrer');
        };
        layer.append(link);
      }
      entry.links?.replaceWith(layer);
      if (!layer.parentElement) entry.host.append(layer);
      entry.links = layer;
    }
    function scheduleText() {
      global.clearTimeout(textTimer);
      if (!alive || preview) return;
      textTimer = global.setTimeout(() => {
        textTimer = 0;
        if (!alive || preview || activeJob || queue.length) return;
        const candidates = entries.filter(entry => entry.canvas && !entry.textReady && !entry.textPromise && (visible.has(entry.number) || entry.number === current));
        candidates.sort((a, b) => Math.abs(a.number - current) - Math.abs(b.number - current));
        const entry = candidates[0];
        if (!entry) return;
        const ticket = epoch;
        entry.textPromise = (async () => {
          try {
            const page = await loadPage(entry, ticket);
            const content = await page.getTextContent();
            if (!valid(ticket) || !entry.canvas || preview) return;
            entry.textContent = content;
            buildText(entry, content);
            if (page.getAnnotations && !activeJob && !queue.length) {
              const annotations = await page.getAnnotations();
              if (valid(ticket) && entry.canvas && !preview) buildLinks(entry, annotations);
            }
          } catch (error) { if (valid(ticket) && !cancelled(error)) console.warn('Page text could not be read.', error); }
          finally {
            entry.textPromise = null;
            if (!entry.canvas && !entry.job && !entry.pagePromise) { entry.page?.cleanup?.(); entry.page = null; }
            if (valid(ticket)) scheduleText();
          }
        })();
      }, 50);
    }
    function viewportEntries() {
      if (mode === 'single') return entryFor() ? [entryFor()] : [];
      const bounds = viewport.getBoundingClientRect(), first = entryAt(bounds.top);
      if (!first) return [];
      const found = [];
      for (let index = first.number - 1; index < entries.length && found.length < 24; index++) {
        const entry = entries[index], rect = entry.host.getBoundingClientRect();
        if (rect.top > bounds.bottom) break;
        if (rect.bottom >= bounds.top) found.push(entry);
      }
      return found;
    }
    function updateViewport() {
      frame = 0;
      if (!alive || preview) return;
      const showing = viewportEntries(); visible = new Set(showing.map(entry => entry.number));
      if (!navigationTarget && showing.length) {
        const bounds = viewport.getBoundingClientRect();
        const focus = entryAt(bounds.top + Math.min(80, viewport.clientHeight / 3));
        if (focus) setCurrent(focus.number);
      }
      desired = new Set(visible);
      if (navigationTarget) desired.add(navigationTarget);
      cancelUnwanted();
      if (navigationTarget) void render(entryFor(navigationTarget), -10);
      showing.sort((a, b) => Math.abs(a.number - current) - Math.abs(b.number - current));
      for (const entry of showing) {
        entry.lastUsed = performance.now();
        if (!entry.error) void render(entry, entry.number === current ? 0 : 1 + Math.abs(entry.number - current));
      }
      trimCache();
      global.clearTimeout(prefetchTimer);
      prefetchTimer = global.setTimeout(() => {
        if (!alive || preview || navigationTarget || mode === 'single') return;
        const neighbor = entryFor(current + direction);
        if (neighbor && !desired.has(neighbor.number)) {
          desired.add(neighbor.number);
          if (!neighbor.error) void render(neighbor, 100);
        }
      }, 180);
      scheduleText();
    }
    function requestViewport() { if (!frame && alive) frame = global.requestAnimationFrame(updateViewport); }
    function handleScroll() {
      if (!alive || preview) return;
      const delta = viewport.scrollTop - previousTop;
      if (Math.abs(delta) > 1) direction = delta > 0 ? 1 : -1;
      previousTop = viewport.scrollTop;
      requestViewport();
    }
    function userIntent(event) {
      if (event?.type === 'wheel' && event.ctrlKey) return;
      interactionRevision++;
      if (navigationTarget) { navigationTarget = null; navigationRevision++; }
    }
    async function goToPage(value) {
      if (!alive) return false;
      if (preview) await endZoomPreview({ commit: false });
      const target = number(value), ticket = ++navigationRevision, mountTicket = epoch;
      navigationTarget = target;
      const old = current; setCurrent(target, 'navigation');
      if (mode === 'single') { if (entries[old - 1]) dimensions(entries[old - 1]); dimensions(entryFor(target)); }
      desired = new Set([target]); cancelUnwanted();
      const entry = entryFor(target); entry.error = null;
      scrollToEntry(entry);
      const ready = await render(entry, -10);
      if (!valid(mountTicket) || ticket !== navigationRevision) return false;
      if (ready) scrollToEntry(entry);
      navigationTarget = null; previousTop = viewport.scrollTop;
      requestViewport(); scheduleText(); trimCache();
      return ready;
    }
    async function resolveDestination(destination) {
      let resolved = destination;
      if (typeof resolved === 'string') resolved = await pdf?.getDestination?.(resolved);
      if (typeof resolved === 'number') return { page: number(resolved), destination: resolved };
      if (resolved && !Array.isArray(resolved) && Number.isFinite(resolved.page)) return { page: number(resolved.page), destination: resolved };
      if (!Array.isArray(resolved) || !resolved.length) return null;
      const index = typeof resolved[0] === 'number' ? resolved[0] : await pdf?.getPageIndex?.(resolved[0]);
      return Number.isFinite(index) && index >= 0 && index < pdf.numPages ? { page: index + 1, destination: resolved } : null;
    }
    async function goToDestination(destination) {
      const ticket = epoch;
      try {
        const result = await resolveDestination(destination);
        if (!valid(ticket) || !result) return false;
        return goToPage(result.page);
      } catch (error) { if (valid(ticket) && !cancelled(error)) emit('onError', error); return false; }
    }
    async function setMode(value) {
      const next = value === 'single' ? 'single' : 'continuous';
      if (!alive || next === mode) return alive;
      mode = next; container.dataset.pdfMode = mode;
      entries.forEach(dimensions);
      return goToPage(current);
    }
    async function relayout(anchor = captureAnchor()) {
      if (!alive) return false;
      const ticket = epoch, interaction = interactionRevision;
      const revision = ++layoutRevision; layoutWidth = availableWidth();
      for (const job of [...queue]) cancelJob(job);
      cancelJob(activeJob);
      if (activeThumbnail) cancelThumbnail(activeThumbnail.canvas);
      entries.forEach(dimensions); restoreAnchor(anchor);
      const primary = anchor ? entryFor(anchor.page) : entryFor();
      if (primary) setCurrent(primary.number, 'layout');
      desired = new Set(primary ? [primary.number] : []);
      const ready = primary ? await render(primary, -10) : false;
      if (!valid(ticket) || revision !== layoutRevision) return false;
      if (interaction === interactionRevision) restoreAnchor(anchor);
      requestViewport();
      return ready;
    }
    async function setZoom(value, point) {
      if (!alive) return false;
      if (preview) await endZoomPreview({ commit: false });
      const next = value === 'fit' ? 'fit' : clamp(Number(value) || 1, .25, 4);
      if (next === zoom) return true;
      const anchor = captureAnchor(point);
      zoom = next;
      const ready = await relayout(anchor);
      if (alive) emit('onZoomChange', currentScale());
      return ready;
    }
    function beginZoomPreview(point = {}) {
      if (!alive || !viewport || !entries.length) return false;
      if (preview) return true;
      navigationTarget = null; navigationRevision++;
      const anchor = captureAnchor(point), bounds = viewport.getBoundingClientRect();
      if (!anchor) return false;
      const x = bounds.left + anchor.screenX, y = bounds.top + anchor.screenY;
      const showing = viewportEntries(), first = showing[0]?.number || current, last = showing.at(-1)?.number || current;
      const hosts = [];
      for (let value = Math.max(1, first - 2); value <= Math.min(entries.length, last + 2); value++) {
        const entry = entryFor(value);
        if (entry.host.hidden) continue;
        hosts.push({ entry, rect: entry.host.getBoundingClientRect(), transform: entry.host.style.transform, origin: entry.host.style.transformOrigin, willChange: entry.host.style.willChange, zIndex: entry.host.style.zIndex });
        Object.assign(entry.host.style, { transformOrigin: '0 0', willChange: 'transform', zIndex: '1' });
      }
      const factor = scale(entryFor(anchor.page));
      preview = { anchor, x, y, point: { x, y }, scale: factor, target: factor, hosts, input: point.input || 'gesture' };
      global.clearTimeout(prefetchTimer); global.clearTimeout(textTimer);
      for (const job of [...queue]) cancelJob(job);
      cancelJob(activeJob);
      if (activeThumbnail) cancelThumbnail(activeThumbnail.canvas);
      return true;
    }
    function paintPreview() {
      previewFrame = 0;
      if (!preview) return;
      const ratio = preview.target / preview.scale;
      for (const item of preview.hosts) {
        const x = preview.point.x - preview.x + (item.rect.left - preview.x) * (ratio - 1);
        const y = preview.point.y - preview.y + (item.rect.top - preview.y) * (ratio - 1);
        item.entry.host.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + ratio + ')';
      }
    }
    function updateZoomPreview(value, point = {}) {
      if (!preview) return false;
      preview.target = clamp(Number(value) || preview.scale, .25, 4);
      preview.point = { x: Number.isFinite(point.x) ? point.x : preview.point.x, y: Number.isFinite(point.y) ? point.y : preview.point.y };
      const bounds = viewport.getBoundingClientRect();
      preview.anchor.screenX = preview.point.x - bounds.left; preview.anchor.screenY = preview.point.y - bounds.top;
      if (!previewFrame) previewFrame = global.requestAnimationFrame(paintPreview);
      return preview.target;
    }
    function clearPreview(value) {
      global.cancelAnimationFrame(previewFrame); previewFrame = 0;
      global.clearTimeout(wheelTimer);
      for (const item of value.hosts) Object.assign(item.entry.host.style, { transform: item.transform, transformOrigin: item.origin, willChange: item.willChange, zIndex: item.zIndex });
    }
    async function endZoomPreview({ commit = true } = {}) {
      if (!preview) return false;
      const value = preview; preview = null; clearPreview(value);
      if (!commit) { requestViewport(); pump(); return currentScale(); }
      zoom = value.target;
      const ready = await relayout(value.anchor);
      if (!alive) return false;
      emit('onZoomChange', currentScale()); emit('onZoomCommit', currentScale());
      return ready ? currentScale() : false;
    }
    function handleWheel(event) {
      if (!event.ctrlKey || !alive) return;
      event.preventDefault();
      if (preview && preview.input !== 'wheel') return;
      if (!preview && !beginZoomPreview({ x: event.clientX, y: event.clientY, input: 'wheel' })) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      updateZoomPreview(preview.target * Math.exp(-clamp(event.deltaY * unit, -240, 240) * .002), { x: event.clientX, y: event.clientY });
      global.clearTimeout(wheelTimer);
      wheelTimer = global.setTimeout(() => { void endZoomPreview({ commit: true }); }, 160);
    }
    function updateTouchPoints(event) {
      if (!touchGesture) return;
      for (const point of [...event.touches, ...event.changedTouches]) {
        if (touchGesture.points.has(point.identifier)) touchGesture.points.set(point.identifier, { x: point.clientX, y: point.clientY });
      }
      const [a, b] = [...touchGesture.points.values()];
      updateZoomPreview(touchGesture.scale * Math.hypot(b.x - a.x, b.y - a.y) / touchGesture.distance, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    function finishTouchZoom(commit) {
      if (!touchGesture) return;
      touchGesture = null;
      suppressTouchClickUntil = performance.now() + 450;
      void endZoomPreview({ commit }).catch(error => { if (alive && !cancelled(error)) emit('onError', error); });
    }
    function touchStart(event) {
      if (!alive || event.target.closest('button,input,textarea,select,dialog,[contenteditable]')) return;
      if (event.touches.length < 2) return;
      multiTouch = true;
      if (event.cancelable) event.preventDefault();
      if (event.touches.length !== 2) { finishTouchZoom(false); return; }
      if (touchGesture || preview) return;
      const [a, b] = event.touches, point = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, input: 'touch' };
      if (!beginZoomPreview(point)) return;
      const selection = global.getSelection?.();
      if (selection && viewport.contains(selection.anchorNode)) selection.removeAllRanges();
      touchGesture = { scale: preview.scale, distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), points: new Map([[a.identifier, { x: a.clientX, y: a.clientY }], [b.identifier, { x: b.clientX, y: b.clientY }]]) };
    }
    function touchMove(event) {
      if (!multiTouch) return;
      if (event.cancelable) event.preventDefault();
      if (touchGesture && event.touches.length === 2) updateTouchPoints(event);
    }
    function touchEnd(event) {
      if (!multiTouch) return;
      if (event.cancelable) event.preventDefault();
      if (touchGesture && event.touches.length < 2) {
        updateTouchPoints(event);
        finishTouchZoom(event.type !== 'touchcancel');
      }
      if (!event.touches.length) { multiTouch = false; suppressTouchClickUntil = performance.now() + 450; }
    }
    function touchClick(event) {
      if (!multiTouch && performance.now() >= suppressTouchClickUntil) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }
    function installTouchZoom() {
      // Native Android supplies its own gesture controller. Web touch uses
      // browser panning and text handles; only a two-finger gesture is captured.
      if (!global.NotejectWebApp || global.NotejectAndroid) return;
      touchViewport = viewport; previousTouchAction = viewport.style.touchAction;
      viewport.style.touchAction = 'pan-x pan-y';
      viewport.addEventListener('touchstart', touchStart, { passive: false });
      viewport.addEventListener('touchmove', touchMove, { passive: false });
      viewport.addEventListener('touchend', touchEnd, { passive: false });
      viewport.addEventListener('touchcancel', touchEnd, { passive: false });
      viewport.addEventListener('click', touchClick, true);
    }
    function removeTouchZoom() {
      if (touchViewport) {
        touchViewport.removeEventListener('touchstart', touchStart);
        touchViewport.removeEventListener('touchmove', touchMove);
        touchViewport.removeEventListener('touchend', touchEnd);
        touchViewport.removeEventListener('touchcancel', touchEnd);
        touchViewport.removeEventListener('click', touchClick, true);
        touchViewport.style.touchAction = previousTouchAction;
      }
      touchViewport = null; touchGesture = null; multiTouch = false; suppressTouchClickUntil = 0;
    }
    function handleResize() {
      global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(() => {
        if (alive && !preview && Math.abs(availableWidth() - layoutWidth) > 2) void relayout().then(() => { if (alive) emit('onZoomChange', currentScale()); });
      }, 100);
    }
    function cancelThumbnail(canvas) {
      const record = thumbnails.get(canvas);
      if (!record) return;
      record.cancelled = true; record.task?.cancel?.(); record.resolve(false);
      thumbnails.delete(canvas); thumbnailQueue = thumbnailQueue.filter(item => item !== record);
    }
    function renderThumbnail(value, canvas) {
      if (!alive || !canvas) return Promise.resolve(false);
      cancelThumbnail(canvas);
      const record = { number: number(value), canvas, epoch, cancelled: false, task: null, resolve: null, promise: null };
      record.promise = new Promise(resolve => { record.resolve = resolve; });
      thumbnails.set(canvas, record); thumbnailQueue.push(record); scheduleThumbnails();
      return record.promise;
    }
    function scheduleThumbnails() {
      global.clearTimeout(thumbTimer);
      if (!alive || preview || activeJob || queue.length || activeThumbnail || !thumbnailQueue.length) return;
      thumbTimer = global.setTimeout(() => { thumbTimer = 0; void pumpThumbnail(); }, 80);
    }
    async function pumpThumbnail() {
      if (!alive || preview || activeJob || queue.length || activeThumbnail) return;
      let record;
      while (thumbnailQueue.length && !record) { const next = thumbnailQueue.shift(); if (!next.cancelled) record = next; }
      if (!record) return;
      activeThumbnail = record;
      let result = null, completed = null;
      try {
        const entry = entryFor(record.number), page = await loadPage(entry, record.epoch);
        if (!valid(record.epoch) || record.cancelled) return;
        const box = page.getViewport({ scale: 1 });
        const size = outputSize({ width: box.width, size: { width: box.width, height: box.height } }, 200000, 240);
        record.task = rasterizer.renderPage({ page: record.number, ...size });
        result = await record.task.promise;
        if (!valid(record.epoch) || record.cancelled) return;
        completed = completedCanvas(result, size);
        record.canvas.width = completed.width; record.canvas.height = completed.height;
        record.canvas.getContext('2d', { alpha: false }).drawImage(completed, 0, 0);
        record.resolve(true);
      } catch (error) { if (!record.cancelled && valid(record.epoch) && !cancelled(error)) console.warn('Page preview could not render.', error); }
      finally {
        result?.bitmap?.close?.(); freeCanvas(completed);
        record.resolve(false);
        if (thumbnails.get(record.canvas) === record) thumbnails.delete(record.canvas);
        if (activeThumbnail === record) activeThumbnail = null;
        const entry = entryFor(record.number);
        if (entry && !entry.canvas && !entry.job && !entry.textPromise) { entry.page?.cleanup?.(); entry.page = null; }
        pump(); scheduleThumbnails();
      }
    }
    function releaseIndexedPage(value, page) {
      const entry = entryFor(value);
      if (!entry || (entry.page !== page && !entry.pagePromise) || (!entry.canvas && !entry.job && !entry.textPromise)) {
        page?.cleanup?.(); if (entry?.page === page) entry.page = null;
      }
    }
    function dispose() {
      alive = false; epoch++; navigationRevision++; navigationTarget = null;
      removeTouchZoom();
      signal?.removeEventListener('abort', onAbort); signal = onAbort = null;
      intersection?.disconnect(); resizeObserver?.disconnect(); intersection = resizeObserver = null;
      viewport?.removeEventListener('scroll', handleScroll); viewport?.removeEventListener('wheel', userIntent); viewport?.removeEventListener('wheel', handleWheel); viewport?.removeEventListener('touchstart', userIntent);
      global.removeEventListener('resize', handleResize);
      if (viewport) viewport.style.overflowAnchor = previousOverflowAnchor;
      global.cancelAnimationFrame(frame); global.cancelAnimationFrame(previewFrame); frame = previewFrame = 0;
      for (const timer of [resizeTimer, prefetchTimer, textTimer, thumbTimer, wheelTimer]) global.clearTimeout(timer);
      resizeTimer = prefetchTimer = textTimer = thumbTimer = wheelTimer = 0;
      if (preview) { clearPreview(preview); preview = null; }
      for (const job of [...queue]) cancelJob(job);
      cancelJob(activeJob); queue = []; activeJob = null;
      for (const canvas of [...thumbnails.keys()]) cancelThumbnail(canvas);
      activeThumbnail = null; thumbnailQueue = [];
      for (const entry of entries) {
        freeCanvas(entry.canvas); entry.layer?.remove(); entry.links?.remove(); entry.page?.cleanup?.();
      }
      entries = []; desired.clear(); visible.clear(); container?.replaceChildren();
      container = viewport = pdf = rasterizer = null; outlinePromise = pageLabelsPromise = null;
    }
    async function mount(settings = {}) {
      dispose();
      container = settings.container; pdf = settings.pdf; rasterizer = settings.rasterizer;
      if (!container || !pdf?.getPage || !(pdf.numPages > 0) || !rasterizer?.renderPage) throw new Error('The Reader needs a valid document and page renderer.');
      viewport = options.getViewport?.() || container.closest('.reader-content') || container.parentElement;
      if (!viewport) throw new Error('The Reader viewport is unavailable.');
      documentId = String(settings.documentId || ''); current = number(settings.page);
      mode = settings.mode === 'single' ? 'single' : 'continuous';
      zoom = settings.zoom === 'fit' || settings.zoom == null ? 'fit' : clamp(Number(settings.zoom) || 1, .25, 4);
      layoutRevision = 0; alive = true; const ticket = epoch;
      signal = settings.signal; onAbort = dispose; signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { dispose(); throw aborted(); }
      let first;
      try { first = await pdf.getPage(current); }
      catch (error) { if (valid(ticket)) dispose(); throw error; }
      if (!valid(ticket)) { first.cleanup?.(); return false; }
      const base = first.getViewport({ scale: 1 });
      if (!(base.width > 0 && base.height > 0)) { first.cleanup?.(); dispose(); throw new Error('This document has invalid page dimensions.'); }
      layoutWidth = availableWidth(); previousOverflowAnchor = viewport.style.overflowAnchor; viewport.style.overflowAnchor = 'none';
      container.classList.add('reader-pdf-pages'); container.dataset.pdfMode = mode;
      Object.assign(container.style, { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '24px', width: 'max-content', minWidth: '100%', overflowAnchor: 'none' });
      const fragment = document.createDocumentFragment();
      for (let index = 1; index <= pdf.numPages; index++) {
        const host = document.createElement('section'); host.className = 'reader-pdf-page';
        host.dataset.readerPage = String(index); host.dataset.readerDocument = documentId; host.dataset.placeholder = 'Page ' + index;
        host.setAttribute('aria-label', 'Page ' + index + ' of ' + pdf.numPages);
        Object.assign(host.style, { position: 'relative', margin: '0 auto', background: '#fff', flex: '0 0 auto', overflow: 'hidden', contain: 'layout paint style' });
        const entry = { number: index, host, size: { width: base.width, height: base.height }, width: 0, height: 0, page: index === current ? first : null, pagePromise: null, canvas: null, layer: null, links: null, textContent: null, textReady: false, textPromise: null, job: null, visualRevision: -1, lastUsed: 0, error: null };
        entries.push(entry); dimensions(entry); fragment.append(host);
      }
      container.replaceChildren(fragment);
      viewport.addEventListener('scroll', handleScroll, { passive: true }); viewport.addEventListener('wheel', userIntent, { passive: true }); viewport.addEventListener('wheel', handleWheel, { passive: false }); viewport.addEventListener('touchstart', userIntent, { passive: true }); global.addEventListener('resize', handleResize);
      installTouchZoom();
      if (global.IntersectionObserver) { intersection = new IntersectionObserver(requestViewport, { root: viewport, threshold: 0 }); entries.forEach(entry => intersection.observe(entry.host)); }
      if (global.ResizeObserver) { resizeObserver = new ResizeObserver(handleResize); resizeObserver.observe(viewport); }
      const ready = await goToPage(current);
      if (!valid(ticket)) return false;
      if (!ready) throw new Error('The starting page could not render.');
      emit('onPageChange', current, { numPages: pdf.numPages, source: 'mount' });
      emit('onReady', { numPages: pdf.numPages, page: current, mode, zoom });
      requestViewport(); return true;
    }
    async function captureCurrentPage() {
      if (!alive || !pdf || !rasterizer) throw Error('Open a document first.');
      const ticket=epoch, pageNumber=current, page=await pdf.getPage(pageNumber);
      const size=page.getViewport({scale:1}), factor=Math.min(4,2400/Math.max(size.width,size.height),Math.sqrt(4000000/(size.width*size.height)));
      const width=Math.max(1,Math.floor(size.width*factor)),height=Math.max(1,Math.floor(size.height*factor));
      const task=rasterizer.renderPage({page:pageNumber,width,height});
      const result=await task.promise;
      try {
        if(!valid(ticket))throw aborted();
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#fff';context.fillRect(0,0,width,height);
        if(result.bitmap)context.drawImage(result.bitmap,0,0,width,height);
        else if(result.pixels)context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels),result.width,result.height),0,0);
        else throw Error('The page capture could not render.');
        return {canvas,page:pageNumber};
      } finally { result.bitmap?.close?.(); }
    }
    return {
      captureCurrentPage,
      mount, dispose, goToPage, goToDestination, resolveDestination, setMode, setZoom, beginZoomPreview, updateZoomPreview, endZoomPreview,
      refreshLayout: relayout, renderThumbnail, cancelThumbnail, releaseIndexedPage,
      getPage: () => current, getPageElement: value => entryFor(value == null ? current : value)?.host || null,
      getTextLayer: value => { const entry = entryFor(value == null ? current : value); return entry?.textReady ? entry.layer : null; },
      getZoom: currentScale, getZoomValue: () => zoom,
      getOutline: () => outlinePromise ||= pdf?.getOutline?.() || Promise.resolve([]),
      getPageLabels: () => pageLabelsPromise ||= pdf?.getPageLabels?.() || Promise.resolve(null),
      getRasterStats: () => rasterizer?.getStats?.() || { engine: 'document renderer' },
    };
  }
  global.NotejectPageReader = Object.freeze({ create });
})(window);
