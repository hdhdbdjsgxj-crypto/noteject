/* Android canvas screens use the actual visible viewport in either orientation. */
(() => {
  'use strict';
  const body = document.body;
  let pending = false, activePage = '', detailsOpen = false, lastFocus = '', detailsScroll = 0;
  let currentDetails = null, currentCanvas = null, graphBox = null, graphFilterKey = '', focusRequested = false;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function button(text, label, handler) {
    const node = element('button', '', text); node.type = 'button';
    node.setAttribute('aria-label', label); node.title = label; node.onclick = handler;
    return node;
  }
  function graphActionLabel(control, label, pathData) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', pathData); icon.append(path);
    control.replaceChildren(icon, element('span', '', label));
  }
  function move(node, parent) { if (node && node.parentElement !== parent) parent.append(node); }
  function property(name, value) {
    if (body.style.getPropertyValue(name) !== value) body.style.setProperty(name, value);
  }
  function measure() {
    const viewport = window.visualViewport;
    property('--am-canvas-height', Math.max(120, Math.round(viewport?.height || innerHeight)) + 'px');
    property('--am-canvas-top', Math.round(viewport?.offsetTop || 0) + 'px');
    property('--am-canvas-left', Math.round(viewport?.offsetLeft || 0) + 'px');
    property('--am-canvas-width', Math.round(viewport?.width || innerWidth) + 'px');
    body.classList.toggle('am-canvas-landscape', (viewport?.width || innerWidth) > (viewport?.height || innerHeight));
  }
  function closeOptions() {
    const options = document.querySelector('#view .am-canvas-options[open]');
    if (!options) return false;
    options.open = false; options.querySelector('summary')?.focus(); return true;
  }
  function toolbar(root, title) {
    let bar = root.querySelector('.am-canvas-bar');
    if (!bar) {
      bar = element('header', 'am-canvas-bar');
      bar.append(button('‹', 'Return to previous page', () => window.NotejectMobile?.handleBack()));
      const heading = element('strong', 'am-canvas-title', title); bar.append(heading);
      const menu = button('☰', 'Open main menu', () => {
        closeOptions();
        if (window.NotejectMobile?.openMenu) window.NotejectMobile.openMenu();
        else document.querySelector('.am-header [data-am-menu]')?.click();
      });
      menu.className = 'am-canvas-menu'; bar.append(menu);
      root.prepend(bar);
    }
    const heading = bar.querySelector('.am-canvas-title');
    if (heading.textContent !== title) heading.textContent = title;
    return bar;
  }
  function options(bar, label, title) {
    let details = bar.querySelector('.am-canvas-options');
    if (details) return details.querySelector('.am-canvas-options-panel');
    details = element('details', 'am-canvas-options');
    const summary = element('summary', '', label); summary.setAttribute('aria-label', title);
    const panel = element('section', 'am-canvas-options-panel'); panel.setAttribute('aria-label', title);
    const heading = element('header'); heading.append(element('strong', '', title), button('×', 'Close ' + title.toLowerCase(), () => { details.open = false; summary.focus(); }));
    panel.append(heading); details.append(summary, panel); bar.append(details);
    details.addEventListener('toggle', () => {
      if (details.open) {
        window.NotejectMobile?.closeOptions(details);
      }
    });
    return panel;
  }
  function prepareBoard(root) {
    const canvas = root.querySelector('.canvas'), workspace = root.querySelector('.board-workspace');
    if (!canvas || !workspace) return;
    const title = typeof activeBoard === 'function' ? activeBoard()?.name || 'Board' : 'Board';
    const bar = toolbar(root, title);
    const head = root.querySelector('.board-page-head');
    move(head, bar);
    const boardMenu = root.querySelector('.am-board-action-menu:not(.am-board-add-menu) .am-options-menu');
    const popup = boardMenu?.querySelector('[data-am-board-section="navigate"]') || boardMenu || options(bar, '☷', 'Board controls');
    const modes = root.querySelector('.am-board-tools'), search = root.querySelector('.board-search-tools');
    move(modes, popup); move(search, popup);
    const zoom = root.querySelector('.canvas-controls');
    if (zoom) { if (!zoom.classList.contains('am-canvas-zoom')) zoom.classList.add('am-canvas-zoom'); move(zoom, root); }
    const camera = root.querySelector('.board-toolstrip');
    if (camera && !camera.hidden) camera.hidden = true;
    // Override the shared desktop sizing chain all the way down to the scroll surface.
    for (const node of [workspace, root.querySelector('.board-canvas-frame'), canvas]) {
      if (node && !node.classList.contains('am-canvas-sized')) node.classList.add('am-canvas-sized');
    }
    canvas.setAttribute('aria-label', 'Board. Tap to select, double tap to open, or hold then drag to move cards. Drag empty space to browse, pinch to zoom, and double tap empty space for a new note.');
    if (currentCanvas !== canvas) {
      currentCanvas = canvas;
      requestAnimationFrame(() => {
        // Shared Board geometry fits once on entry, after this mobile layout settles.
        if (canvas.isConnected) { if(canvas.dataset.fitOnOpen==='true'){delete canvas.dataset.fitOnOpen;boardView.fit();}canvas.dispatchEvent(new Event('scroll')); }
      });
    }
  }
  function setDetails(open, focusClose = false) {
    const wasOpen = body.classList.contains('am-graph-details-open');
    detailsOpen = open;
    body.classList.toggle('am-graph-details-open', open);
    const root = document.getElementById('view'), pane = root?.querySelector('.graph-details');
    const control = root?.querySelector('.am-graph-details-toggle');
    if (control) {
      for (const name of ['aria-expanded', 'aria-pressed']) {
        if (control.getAttribute(name) !== String(open)) control.setAttribute(name, String(open));
      }
    }
    // display:none hides the closed pane. Leave inert ownership to the shared
    // modal manager so opening another menu cannot accidentally unlock it.
    if (pane) pane.setAttribute('aria-hidden', String(!open));
    if (open && focusClose) pane?.querySelector('.am-graph-details-close')?.focus();
    if (wasOpen !== open) window.dispatchEvent(new Event('noteject:canvas-panel'));
  }
  function prepareGraph(root, fitOnEntry = false) {
    const wrap = root.querySelector('.graph-canvas-wrap'), layout = root.querySelector('.graph-layout');
    if (!wrap || !layout) return;
    const bar = toolbar(root, 'Graph View');
    let actions = bar.querySelector('.am-graph-actions');
    if (!actions) {
      actions = element('div', 'am-graph-actions');
      actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Graph tools');
      bar.append(actions);
    }
    if (!actions.querySelector('.ux-graph-browse')) {
      const items = button('Items', 'Browse graph items and connections', () => { closeOptions(); window.NotejectWorkspaceUX.openGraphItems(); });
      items.className = 'ux-graph-browse';
      graphActionLabel(items, 'Items', 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01');
      actions.append(items);
    }
    const popup = options(actions, 'Graph filters', 'Graph filters');
    const filter = popup.parentElement.querySelector('summary');
    if (!filter.querySelector('svg')) {
      graphActionLabel(filter, 'Graph filters', 'M4 6h16M7 12h10M10 18h4');
      popup.parentElement.addEventListener('toggle', () => { if (popup.parentElement.open) setDetails(false); });
    }
    move(root.querySelector('.graph-tools'), popup);
    popup.querySelector('.graph-tools > .ux-graph-browse')?.remove();
    const stats = root.querySelector('.graph-stats'); move(stats, popup);
    let toggle = actions.querySelector('.am-graph-details-toggle');
    if (!toggle) {
      toggle = button('Details', 'Show selected item and connections', () => { closeOptions(); setDetails(!detailsOpen, !detailsOpen); });
      toggle.className = 'am-graph-details-toggle'; toggle.setAttribute('aria-controls', 'am-graph-details');
      graphActionLabel(toggle, 'Details', 'M14 4v16M4 4h16v16H4zM7 8h4M7 12h4');
      actions.append(toggle);
    }
    const pane = root.querySelector('.graph-details');
    if (pane && pane !== currentDetails) {
      currentDetails = pane; pane.id = 'am-graph-details';
      pane.setAttribute('aria-label', 'Selected graph item and connections');
      const heading = element('header', 'am-graph-details-heading');
      const close = button('×', 'Close graph details', () => { setDetails(false); toggle.focus(); }); close.className = 'am-graph-details-close';
      heading.append(element('strong', '', 'Item & connections'), close); pane.prepend(heading);
      const focus = typeof graphFocus === 'string' ? graphFocus : '';
      if (focus && focus !== lastFocus) { detailsOpen = true; detailsScroll = 0; }
      lastFocus = focus;
      pane.scrollTop = detailsScroll;
      pane.addEventListener('scroll', () => { detailsScroll = pane.scrollTop; }, { passive: true });
    }
    setDetails(detailsOpen);
    wrap.setAttribute('aria-label', 'Knowledge graph. Drag to move, pinch to zoom. Tap a node for its details.');
    const svg=root.querySelector('.graph-canvas'), world=root.querySelector('.graph-world');
    const width=Math.max(1,Math.round(wrap.clientWidth)),height=Math.max(1,Math.round(wrap.clientHeight));
    const key=JSON.stringify([graphQuery,graphType,graphLayout,graphConnectedOnly]);
    if(svg&&world&&width&&height){
      const old=graphBox;const changed=!old||old.width!==width||old.height!==height;
      const box='0 0 '+width+' '+height;if(svg.getAttribute('viewBox')!==box)svg.setAttribute('viewBox',box);
      if(fitOnEntry||key!==graphFilterKey||!old)graphFitView();
      else if(changed){graphPan={x:graphPan.x+(width-old.width)/2,y:graphPan.y+(height-old.height)/2};}
      if(detailsOpen&&focusRequested){const node=[...svg.querySelectorAll('[data-graph-node]')].find(node=>node.dataset.graphNode===graphFocus),point=node?.getAttribute('transform')?.match(/translate\(([-\d.]+)\s+([-\d.]+)\)/);if(point)graphPan={x:width/2-Number(point[1])*graphZoom,y:height/2-Number(point[2])*graphZoom};}
      graphBox={width,height};graphFilterKey=key;focusRequested=false;world.setAttribute('transform',graphTransform());
      const zoom=root.querySelector('.graph-zoom-tools span');if(zoom)zoom.textContent=Math.round(graphZoom*100)+'%';
    }

  }
  function sync() {
    const root = document.getElementById('view');
    const page = typeof view === 'string' ? view : body.dataset.amPage;
    const active = (page === 'board' && !!root?.querySelector('.canvas')) || (page === 'graph' && !!root?.querySelector('.graph-canvas-wrap'));
    body.classList.toggle('am-canvas-screen', active);
    body.classList.toggle('am-canvas-board', active && page === 'board');
    body.classList.toggle('am-canvas-graph', active && page === 'graph');
    document.documentElement.classList.toggle('am-canvas-locked', active);
    if (!active) {
      if (activePage) { currentDetails = null; currentCanvas = null; detailsOpen = false; lastFocus = ''; detailsScroll = 0;graphBox=null;graphFilterKey='';focusRequested=false; body.classList.remove('am-graph-details-open'); }
      activePage = ''; return;
    }
    const entering = activePage !== page;
    if (entering) { currentDetails = null; currentCanvas = null; detailsOpen = false; lastFocus = ''; detailsScroll = 0; }
    activePage = page; measure();
    if (entering && page === 'board') root.querySelector('.board-document-panel:not([hidden]) .board-document-close')?.click();
    if (page === 'board') prepareBoard(root); else prepareGraph(root, entering);
  }
  function schedule() {
    if (pending) return; pending = true;
    requestAnimationFrame(() => { pending = false; sync(); });
  }
  function handleBack() {
    if (!body.classList.contains('am-canvas-screen')) return false;
    if (closeOptions()) return true;
    if (activePage === 'graph' && detailsOpen) { setDetails(false); document.querySelector('.am-graph-details-toggle')?.focus(); return true; }
    const picker = document.querySelector('#view .board-document-panel:not([hidden]) .board-document-close, #view .board-note-tray [data-action="toggle-note-tray"]');
    if (picker) { picker.click(); return true; }
    return false;
  }
  function getModal() {
    if (!body.classList.contains('am-canvas-screen')) return null;
    return document.querySelector('#view .detail-panel') || document.querySelector('#view .am-canvas-options[open] .am-canvas-options-panel') ||
      
      document.querySelector('#view .board-document-panel:not([hidden]), #view .board-note-tray');
  }
  document.addEventListener('pointerdown', event => {
    if (!body.classList.contains('am-canvas-screen') || event.target.closest('.am-canvas-options')) return;
    const open = document.querySelector('#view .am-canvas-options[open]'); if (open) open.open = false;
  }, { passive: true });
  window.addEventListener('noteject:canvas-panel',schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  window.addEventListener('noteject:android-insets', schedule);
  window.NotejectAndroidCanvasUI = Object.freeze({selectItem:()=>{detailsOpen=true;detailsScroll=0;focusRequested=true;}, sync, handleBack, getModal });
  schedule();
})();
