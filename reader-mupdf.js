/* MuPDF document client. Parsing, text, navigation and raster work share one worker. */
(function (global) {
  'use strict';
  const abortError = message => new DOMException(message || 'PDF rendering was canceled.', 'AbortError');

  async function open(options = {}) {
    if (!options.blob && !options.url) throw new Error('The original PDF file is unavailable.');
    const worker = new Worker(new URL('./reader-mupdf-worker.js', document.baseURI), { type: 'module' });
    const mobile = options.mobile ?? !!global.NotejectAndroid;
    const maxPixels = mobile ? 4000000 : 12000000;
    let closed = false, active = null, nextId = 0;
    let stats = { engine: 'MuPDF', bytesRead: 0, readCount: 0, nativeRenders: 0, cacheHits: 0 };
    const queue = [];

    function settle(job, error, result) {
      if (job.settled) return;
      job.settled = true;
      if (error) job.reject(error); else job.resolve(result);
    }

    function pump() {
      if (closed || active) return;
      while (queue.length) {
        const job = queue.shift();
        if (job.settled) continue;
        active = job;
        try { worker.postMessage({ id: job.id, type: job.type, ...job.payload }); }
        catch (error) { active = null; settle(job, error); continue; }
        return;
      }
    }

    function request(type, payload = {}) {
      if (closed) return { promise: Promise.reject(abortError('The PDF document is closed.')), cancel() {} };
      const job = { id: ++nextId, type, payload, settled: false, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      const cancel = () => {
        settle(job, abortError());
        const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
        // Native drawing is synchronous inside the worker. A canceled result
        // is discarded; only the latest queued page can start after it returns.
        pump();
      };
      // Page work stays ahead of optional document-wide navigation metadata.
      const priority = value => ({ render: 0, bounds: 0, text: 1, links: 1, destination: 1, metadata: 2, labels: 3, outline: 3 })[value] ?? 0;
      const insert = queue.findIndex(other => priority(other.type) > priority(type));
      if (insert < 0) queue.push(job); else queue.splice(insert, 0, job);
      pump();
      return { promise, cancel };
    }

    function destroy(error = abortError('The PDF document is closed.')) {
      if (closed) return;
      closed = true; worker.terminate();
      options.signal?.removeEventListener('abort', onAbort);
      if (active) settle(active, error);
      active = null; for (const job of queue.splice(0)) settle(job, error);
    }
    const onAbort = () => destroy();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = event => {
      const message = event.data, job = active;
      if (closed || !job || message?.id !== job.id) return;
      active = null;
      if (message.error) {
        const error = new Error(typeof message.error === 'string' ? message.error : message.error.message || 'MuPDF could not render the document.');
        if (message.error.name) error.name = message.error.name;
        if (message.error.code) error.code = message.error.code;
        settle(job, error);
      } else {
        const result = message.result;
        if (result?.stats) stats = { ...stats, ...result.stats };
        if (result?.engine) stats.engine = result.engine;
        if (result?.version) stats.version = result.version;
        settle(job, null, result);
      }
      pump();
    };
    worker.onerror = event => {
      event.preventDefault();
      destroy(new Error(event.message || 'The MuPDF worker could not start.'));
    };
    worker.onmessageerror = () => destroy(new Error('The MuPDF worker returned unreadable data.'));

    try {
      if (options.signal?.aborted) throw abortError();
      const metadata = await request('open', { blob: options.blob, url: options.url, size: options.size,
        password: options.password, mobile, cacheKey: options.cacheKey || options.documentId || '' }).promise;
      const pagePromises = new Map();
      let outlinePromise = null, labelsPromise = null, metadataPromise = null;
      const validPage = number => Number.isInteger(number) && number >= 1 && number <= metadata.pages;
      function renderPage({ page, width, height }) {
        if (!validPage(page) || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
            width > 16384 || height > 16384 || width * height > maxPixels) {
          return { promise: Promise.reject(new Error('The requested PDF bitmap exceeds the Reader memory budget.')), cancel() {} };
        }
        return request('render', { page, width, height });
      }
      function viewport(bounds, settings = {}) {
        const scale = Number(settings.scale ?? 1);
        if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid PDF viewport scale.');
        const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
        const offsetX = Number(settings.offsetX) || 0, offsetY = Number(settings.offsetY) || 0;
        return {
          width: width * scale, height: height * scale, scale, rotation: 0,
          viewBox: [0, 0, width, height], transform: [scale, 0, 0, scale, offsetX, offsetY],
          rawDims: { pageWidth: width, pageHeight: height, pageX: 0, pageY: 0 },
          clone: changes => viewport(bounds, { ...settings, ...changes }),
          convertToViewportPoint: (x, y) => [x * scale + offsetX, y * scale + offsetY],
          convertToViewportRectangle: rect => [rect[0] * scale + offsetX, rect[1] * scale + offsetY,
            rect[2] * scale + offsetX, rect[3] * scale + offsetY],
          convertToPdfPoint: (x, y) => [(x - offsetX) / scale, (y - offsetY) / scale],
        };
      }
      const documentAdapter = {
        numPages: metadata.pages,
        fingerprints: metadata.fingerprints || [],
        isMuPdf: true,
        async getPage(number) {
          if (!validPage(number)) throw new RangeError('PDF page is outside this document.');
          if (closed) throw abortError('The PDF document is closed.');
          if (!pagePromises.has(number)) {
            const pending = request('bounds', { page: number }).promise.then(({ bounds }) => ({
              pageNumber: number, rotate: 0, userUnit: 1,
              view: [0, 0, bounds[2] - bounds[0], bounds[3] - bounds[1]],
              getViewport: settings => viewport(bounds, settings),
              getTextContent: () => request('text', { page: number }).promise.then(result => result.content),
              getAnnotations: () => request('links', { page: number }).promise.then(result => result.links),
              render({ canvasContext, canvas, viewport: target } = {}) {
                const context = canvasContext || canvas?.getContext('2d');
                const width = Math.ceil(target?.width || canvas?.width || context?.canvas?.width || 0);
                const height = Math.ceil(target?.height || canvas?.height || context?.canvas?.height || 0);
                const task = renderPage({ page: number, width, height });
                let canceled = false;
                return {
                  promise: task.promise.then(result => {
                    if (canceled || closed) throw abortError();
                    if (!context) throw new Error('A canvas context is required to draw the PDF page.');
                    // Publish the complete image in one operation so background
                    // OCR never observes a partially painted canvas.
                    context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
                  }),
                  cancel() { canceled = true; task.cancel(); },
                };
              },
              cleanup() {},
            }));
            pagePromises.set(number, pending);
            pending.catch(() => pagePromises.delete(number));
          }
          return pagePromises.get(number);
        },
        getOutline() {
          return outlinePromise ||= request('outline').promise.then(result => result.outline).catch(error => { outlinePromise = null; throw error; });
        },
        getPageLabels() {
          return labelsPromise ||= request('labels').promise.then(result => result.labels).catch(error => { labelsPromise = null; throw error; });
        },
        getMetadata() {
          return metadataPromise ||= request('metadata').promise.then(result => result.metadata).catch(error => { metadataPromise = null; throw error; });
        },
        getDestination(name) {
          if (Array.isArray(name)) return Promise.resolve(name);
          return request('destination', { name }).promise.then(result => result.destination);
        },
        getPageIndex(reference) {
          const index = Number.isInteger(reference) ? reference : reference?.pageIndex;
          return Number.isInteger(index) && index >= 0 && index < metadata.pages
            ? Promise.resolve(index) : Promise.reject(new RangeError('Unknown MuPDF page reference.'));
        },
        cleanup() { return Promise.resolve(); },
        destroy() { destroy(); pagePromises.clear(); return Promise.resolve(); },
      };
      return {
        ...metadata,
        document: documentAdapter,
        renderPage,
        getStats: () => ({ ...stats, queued: queue.filter(job => !job.settled).length, active: !!active, closed }),
        destroy,
      };
    } catch (error) { destroy(error); throw error; }
  }

  global.NotejectMuPdf = Object.freeze({ open });
})(window);
