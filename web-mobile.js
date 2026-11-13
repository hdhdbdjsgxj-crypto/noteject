(() => {
  'use strict';
  if (!window.NotejectWebApp) return;

  const view = document.getElementById('view');
  if (!view) return;
  let activePage = view.classList.contains('is-board-view') ? 'board' : '';
  let queued = false;
  let readerViewportFrame = 0;

  function syncReaderViewportHeight() {
    readerViewportFrame = 0;
    if (!view.classList.contains('reader-workspace')) {
      document.documentElement.style.removeProperty('--noteject-reader-viewport-height');
      return;
    }
    const height = window.visualViewport?.height || window.innerHeight;
    if (Number.isFinite(height) && height > 0) {
      document.documentElement.style.setProperty('--noteject-reader-viewport-height', `${Math.round(height)}px`);
    }
  }

  function scheduleReaderViewportHeight() {
    if (readerViewportFrame) return;
    readerViewportFrame = requestAnimationFrame(() => {
      syncReaderViewportHeight();
      requestAnimationFrame(syncReaderViewportHeight);
    });
  }

  function refreshAfterOrientationChange() {
    scheduleReaderViewportHeight();
    setTimeout(scheduleReaderViewportHeight, 120);
    setTimeout(scheduleReaderViewportHeight, 360);
  }

  window.addEventListener('resize', scheduleReaderViewportHeight, { passive: true });
  window.addEventListener('orientationchange', refreshAfterOrientationChange, { passive: true });
  window.addEventListener('pageshow', refreshAfterOrientationChange, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleReaderViewportHeight, { passive: true });
  window.screen?.orientation?.addEventListener?.('change', refreshAfterOrientationChange);

  function syncMobileCanvas() {
    queued = false;
    scheduleReaderViewportHeight();
    const page = view.classList.contains('is-board-view') ? 'board' : '';
    if (page === 'board' && activePage !== 'board' && matchMedia('(max-width:959px)').matches) {
      view.querySelector('.board-document-panel:not([hidden]) .board-document-close')?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const actions = view.querySelector('.board-page-head .buttons');
        const tools = view.querySelector('.board-toolstrip');
        if (actions) actions.scrollLeft = 0;
        if (tools) tools.scrollLeft = 0;
      }));
    }
    activePage = page;
  }

  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(syncMobileCanvas);
  };

  new MutationObserver(schedule).observe(view, {
    childList: true,
    attributes: true,
    attributeFilter: ['class']
  });
})();
