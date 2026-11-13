/* DjVu page adapter for the shared, virtualized Reader page workspace. */
(function (global) {
  'use strict';

  const cancelledError = () => new DOMException('DjVu rendering was cancelled.', 'AbortError');

  async function open(blob, { signal, name = 'DjVu document' } = {}) {
    if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('The complete DjVu file is unavailable.');
    if (!global.DjVu?.Worker) throw new Error('The bundled DjVu Reader engine is missing. Update Noteject and try again.');
    if (signal?.aborted) throw cancelledError();

    // DjVu.js expects a complete bundled DjVu ArrayBuffer. Transfer it to its
    // worker so the decoder and page rasterization do not block the UI thread.
    const bytes = await blob.arrayBuffer();
    if (signal?.aborted) throw cancelledError();
    const worker = new global.DjVu.Worker();
    let closed = false, rejectClosed;
    const closedPromise = new Promise((_, reject) => { rejectClosed = reject; });
    void closedPromise.catch(() => {});
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', close);
      try { worker.terminate(); } catch {}
      rejectClosed(cancelledError());
    };
    const assertOpen = () => {
      if (closed || signal?.aborted) throw cancelledError();
    };
    const run = (...tasks) => {
      assertOpen();
      return Promise.race([worker.run(...tasks), closedPromise]);
    };
    signal?.addEventListener('abort', close, { once: true });

    try {
      await Promise.race([worker.createDocument(bytes), closedPromise]);
      assertOpen();
      const [sizes, contents] = await run(
        worker.doc.getPagesSizes(),
        worker.doc.getContents()
      );
      assertOpen();
      if (!Array.isArray(sizes) || !sizes.length) throw new Error('This DjVu file has no readable pages.');

      const pages = sizes.map((size, index) => {
        const width = Number(size?.width), height = Number(size?.height);
        if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
          throw new Error(`DjVu page ${index + 1} has invalid dimensions.`);
        }
        return { width, height };
      });

      const buildOutline = async entries => {
        const result = [];
        for (const entry of entries || []) {
          const page = entry?.url ? await run(worker.doc.getPageNumberByUrl(entry.url)).catch(() => null) : null;
          const children = await buildOutline(entry?.children);
          if (!Number.isFinite(page) && !children.length) continue;
          result.push({
            title: String(entry.description || 'Section'),
            dest: Number.isFinite(page) ? [Math.max(0, page - 1)] : null,
            items: children
          });
        }
        return result;
      };
      const outline = await buildOutline(contents);
      const document = {
        numPages: pages.length,
        fingerprints: [name, blob.size],
        async getPage(number) {
          const index = Math.max(0, Math.min(pages.length - 1, Math.trunc(Number(number) || 1) - 1));
          const size = pages[index];
          return {
            pageNumber: index + 1,
            getViewport({ scale = 1 } = {}) {
              const factor = Number(scale) > 0 ? Number(scale) : 1;
              return {
                width: size.width * factor,
                height: size.height * factor,
                scale: factor,
                rotation: 0,
                userUnit: 1,
                viewBox: [0, 0, size.width, size.height]
              };
            },
            async getTextContent() {
              assertOpen();
              const text = await run(worker.doc.getPage(index + 1).getText());
              assertOpen();
              return { items: text ? [{ str: String(text) }] : [], styles: Object.create(null), lang: null };
            },
            async getAnnotations() { return []; },
            cleanup() {}
          };
        },
        getOutline: async () => outline,
        getPageLabels: async () => null,
        getMetadata: async () => ({ info: { Title: name, Author: '' }, metadata: null }),
        destroy: async () => close()
      };

      const rasterizer = {
        engine: 'DjVu.js worker',
        renderPage({ page, width, height }) {
          let cancelled = false;
          const promise = (async () => {
            assertOpen();
            const image = await run(worker.doc.getPage(page).createPngObjectUrl());
            let bitmap;
            try {
              assertOpen();
              if (cancelled) throw cancelledError();
              const response = await fetch(image.url);
              if (!response.ok) throw new Error(`Could not read the DjVu page image (HTTP ${response.status}).`);
              const blob = await response.blob();
              const resize = Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
                ? { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' } : undefined;
              bitmap = resize ? await createImageBitmap(blob, resize) : await createImageBitmap(blob);
              assertOpen();
              if (cancelled) { bitmap.close?.(); throw cancelledError(); }
              return { bitmap };
            } catch (error) {
              bitmap?.close?.();
              throw error;
            } finally {
              if (image?.url) {
                try { worker.revokeObjectURL(image.url); } catch { URL.revokeObjectURL(image.url); }
              }
            }
          })();
          return { promise, cancel: () => { cancelled = true; } };
        },
        getStats: () => ({ engine: 'DjVu.js worker', pages: pages.length }),
        destroy: close
      };

      return { document, rasterizer, outline: Array.isArray(contents) ? contents : [], destroy: close };
    } catch (error) {
      close();
      throw error;
    }
  }

  global.NotejectDjVuReader = Object.freeze({ open });
})(window);
