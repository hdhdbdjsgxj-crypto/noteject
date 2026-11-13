/* Windows reading and canvas chrome. Shared content and actions stay in their original controllers. */
(() => {
  'use strict';
  const desktop = () => !!window.NotejectDesktop && !window.NotejectAndroid;
  const key = 'noteject-windows-reading-panes';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let sizes = { navigation: 250, annotations: 320 }, graphDetailsHidden = false;
  try { sizes = { ...sizes, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch {}
  sizes.navigation = clamp(Number(sizes.navigation) || 250, 180, 420);
  sizes.annotations = clamp(Number(sizes.annotations) || 320, 240, 480);
  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function text(element, value) { if (element && element.textContent !== value) element.textContent = value; }
  function setClass(element, name, active) { if (element.classList.contains(name) !== !!active) element.classList.toggle(name, !!active); }
  function attribute(element, name, value) { if (element?.getAttribute(name) !== String(value)) element?.setAttribute(name, String(value)); }
  function property(element, name, value) { if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value); }
  function saveSizes() { try { localStorage.setItem(key, JSON.stringify(sizes)); } catch {} }
  function paneGrip(shell, panel, side, sizeName, minimum, maximum) {
    if (!panel || panel.querySelector(':scope > .nw-reader-pane-grip')) return;
    const grip = node('div', 'nw-reader-pane-grip nw-reader-pane-grip-' + side);
    grip.tabIndex = 0;
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', 'Resize ' + (sizeName === 'navigation' ? 'chapter navigation' : 'reading notes'));
    grip.setAttribute('aria-valuemin', minimum);
    grip.setAttribute('aria-valuemax', maximum);
    grip.setAttribute('aria-valuenow', sizes[sizeName]);
    grip.title = 'Drag to resize. Use Left / Right when focused; Home resets the width.';
    const change = next => {
      sizes[sizeName] = clamp(Math.round(next), minimum, maximum);
      property(shell, '--nw-reader-' + sizeName, sizes[sizeName] + 'px');
      attribute(grip, 'aria-valuenow', sizes[sizeName]);
    };
    let drag;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      drag = { id: event.pointerId, x: event.clientX, start: sizes[sizeName] };
      grip.setPointerCapture(event.pointerId);
      document.body.classList.add('nw-reading-resizing');
    });
    grip.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      change(drag.start + (side === 'right' ? 1 : -1) * (event.clientX - drag.x));
    });
    const finish = event => {
      if (!drag || drag.id !== event.pointerId) return;
      drag = null;
      document.body.classList.remove('nw-reading-resizing');
      saveSizes();
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('lostpointercapture', finish);
    grip.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 32 : 16;
      change(event.key === 'Home' ? sizeName === 'navigation' ? 250 : 320 : sizes[sizeName] + (event.key === 'ArrowRight' ? 1 : -1) * (side === 'right' ? 1 : -1) * step);
      saveSizes();
    });
    panel.append(grip);
  }
  function reader(view) {
    const shell = view.querySelector('.reader-shell');
    if (!shell) return;
    if (!shell.dataset.nwBookmarkEditing) {
      shell.dataset.nwBookmarkEditing = 'true';
      shell.addEventListener('click', event => {
        const rename = event.target.closest('[data-reader-bookmark-rename]');
        if (!rename) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void renameBookmark(rename.dataset.readerBookmarkRename);
      }, true);
    }
    const epub = !!shell.querySelector('#epub-text'), pdf = !!shell.querySelector('#reader-pdf-pages');
    attribute(shell, 'data-nw-reader-type', epub ? 'epub' : pdf ? 'pdf' : 'other');
    property(shell, '--nw-reader-navigation', sizes.navigation + 'px');
    property(shell, '--nw-reader-annotations', sizes.annotations + 'px');
    const commands = shell.querySelector('.reader-commandbar');
    if (commands) { attribute(commands, 'role', 'toolbar'); attribute(commands, 'aria-label', 'Reading and navigation'); }
    const navigation = shell.querySelector('[data-reader-command="navigation"]');
    text(navigation, '☷ ' + (window.NotejectI18n?.t?.('Chapters') || 'Chapters'));
    attribute(navigation, 'aria-label', 'Show chapters and bookmarks');
    attribute(navigation, 'title', 'Show chapters, pages and bookmarks');
    const contentsLabel = epub ? 'Chapters' : 'Contents';
    text(shell.querySelector('[data-reader-tab="contents"]'), window.NotejectI18n?.t?.(contentsLabel) || contentsLabel);
    const viewControls = shell.querySelector('.reader-view-controls');
    if (viewControls && !viewControls.querySelector('.nw-reader-font-group') && epub) {
      const source = shell.querySelector('.reader-appearance-panel .reader-font-controls');
      if (source) {
        const original = source.parentElement, group = node('div', 'nw-reader-font-group');
        group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Book text size');
        group.append(node('span', 'nw-reader-control-caption', 'Text size'), source);
        viewControls.prepend(group); original.remove();
      }
    }
    const zoom = viewControls?.querySelector('.reader-zoom');
    if (zoom && !zoom.querySelector('.nw-reader-control-caption')) zoom.prepend(node('span', 'nw-reader-control-caption', pdf ? 'Page zoom' : 'Zoom'));
    const page = shell.querySelector('.reader-page-input-label');
    if (page && !page.querySelector('.nw-reader-page-caption')) page.prepend(node('span', 'nw-reader-page-caption', 'Page'));
    paneGrip(shell, shell.querySelector('.reader-navigation'), 'right', 'navigation', 180, 420);
    paneGrip(shell, shell.querySelector('.reader-side'), 'left', 'annotations', 240, 480);
    const status = shell.querySelector('.reader-statusbar');
    if (status && !status.querySelector('.nw-reader-shortcuts')) {
      const shortcuts = node('span', 'nw-reader-shortcuts', '← → Navigate · Ctrl+F Find · F Focus');
      status.insertBefore(shortcuts, status.querySelector('.reader-saved-status'));
    }
  }
  async function renameBookmark(bookmarkId) {
    const api = window.NotejectWindows;
    if (!api?.requestText) return;
    const workspace = api.getData(), file = workspace.docs.find(item => item.id === workspace.selected?.id);
    const bookmark = file?.bookmarks?.find(item => item.id === bookmarkId);
    if (!bookmark) return;
    const title = await api.requestText({ title: 'Rename bookmark', label: 'Bookmark name', value: bookmark.title || 'Bookmark', accept: 'Save name', maxLength: 150 });
    if (!title) return;
    const current = api.getData().docs.find(item => item.id === file.id)?.bookmarks?.find(item => item.id === bookmarkId);
    if (!current) return;
    current.title = title.trim().slice(0, 150);
    current.updated = Date.now();
    if (typeof save === 'function') save();
    // Refresh just the navigation so the open document and its scroll position stay intact.
    if (api.getData().selected?.id === file.id && typeof readerWorkspace !== 'undefined') readerWorkspace.renderNavigation();
    api.sync();
  }
  function board(view) {
    const workspace = view.querySelector('.board-workspace');
    if (!workspace) return;
    attribute(view.querySelector('.board-page-head'), 'aria-label', 'Current board and actions');
    const toolbar = view.querySelector('.board-toolstrip');
    attribute(toolbar, 'role', 'toolbar'); attribute(toolbar, 'aria-label', 'Board editing and view controls');
    const controls = toolbar?.querySelector('.canvas-controls');
    if (controls) { attribute(controls, 'role', 'group'); attribute(controls, 'aria-label', 'Board zoom'); }
    // Notes and documents are docked beside the canvas in a Windows window.
    // Existing node listeners and native drag data remain attached when moved.
    let dock = workspace.querySelector(':scope > .nw-board-add-dock');
    const panel = workspace.querySelector('.board-document-panel');
    const tray = workspace.querySelector('.board-note-tray');
    if (!dock && (panel || tray)) { dock = node('aside', 'nw-board-add-dock'); dock.setAttribute('aria-label', 'Add existing content to this board'); workspace.append(dock); }
    if (dock && panel && panel.parentElement !== dock) dock.append(panel);
    if (dock && tray && tray.parentElement !== dock) dock.prepend(tray);
    const status = view.querySelector('.board-statusbar');
    if (status) text(status.querySelector('span:last-child'), 'Click to select · Double-click to open · Space + drag to pan · Ctrl + wheel to zoom');
    view.querySelectorAll('.canvas-card[data-item]').forEach(card => {
      attribute(card, 'aria-keyshortcuts', 'Enter');
      if (!card.dataset.nwCardHelp) { card.dataset.nwCardHelp = 'true'; card.title = (card.title ? card.title + '\n' : '') + 'Click to select. Double-click to open. Ctrl+click to select several.'; }
    });
  }
  function graph(view) {
    const layout = view.querySelector('.graph-layout');
    if (!layout) return;
    const toolbar = view.querySelector('.graph-tools'), details = layout.querySelector('.graph-details');
    attribute(toolbar, 'role', 'toolbar'); attribute(toolbar, 'aria-label', 'Graph search, layout and connections');
    if (details) attribute(details, 'id', 'nw-graph-details');
    let toggle = toolbar?.querySelector('.nw-graph-details-toggle');
    if (toolbar && !toggle) {
      toggle = node('button', 'secondary nw-graph-details-toggle', 'Details'); toggle.type = 'button';
      toggle.setAttribute('aria-controls', 'nw-graph-details');
      toggle.addEventListener('click', () => { graphDetailsHidden = !graphDetailsHidden; sync(); });
      toolbar.append(toggle);
    }
    setClass(layout, 'nw-graph-details-hidden', graphDetailsHidden);
    attribute(toggle, 'aria-expanded', !graphDetailsHidden);
    text(toggle, graphDetailsHidden ? 'Show details' : 'Hide details');
    if (!view.querySelector('.nw-graph-status')) {
      const status = node('footer', 'nw-graph-status');
      status.append(node('span', '', 'Click an item to explore its connections'), node('span', '', 'Drag to pan · Wheel to zoom · Fit to show all items'));
      view.append(status);
    }
    layout.querySelectorAll('[data-graph-node]').forEach(item => {
      if (item.dataset.nwDetailsBound) return;
      item.dataset.nwDetailsBound = 'true';
      item.addEventListener('click', () => { graphDetailsHidden = false; }, true);
      item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') graphDetailsHidden = false; }, true);
    });
  }
  function sync() {
    if (!desktop()) return;
    const view = document.getElementById('view');
    if (!view) return;
    const hasReader = !!view.querySelector('.reader-shell'), hasBoard = view.classList.contains('is-board-view'), hasGraph = !!view.querySelector('.graph-layout');
    setClass(document.body, 'nw-reader-view', hasReader);
    setClass(document.body, 'nw-board-view', hasBoard);
    setClass(document.body, 'nw-graph-view', hasGraph);
    if (!hasReader) setClass(document.body, 'nw-reading-resizing', false);
    if (hasReader) reader(view);
    if (hasBoard) board(view);
    if (hasGraph) graph(view);
  }
  window.NotejectWindowsReaderBoard = { sync };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true }); else sync();
})();
