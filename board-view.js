/* Board camera, view options and mini map. These updates keep card DOM in place. */
(() => {
  'use strict';
  function create(app) {
    const scene = window.NotejectBoardScene;
    let canvas, world, space, board, map, frame, observer, frameRequest, geometryRequest, scrollSave;
    let mapModel, sizeCache = new Map(), focused = false, autoLayout = false, automaticZoom = null;
    let labelById = new Map();
    let cameraSnapshot = null;
    let enteredBoardId = null, fitOnEntry = false;
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    function measurements() {
      const result = new Map();
      world.querySelectorAll('[data-item]').forEach(card => result.set(card.dataset.item, { width: card.offsetWidth, height: card.offsetHeight }));
      return result;
    }
    function remember(force = false) {
      if (!canvas?.isConnected || app.getBoard()?.id !== board.id) return;
      const width = canvas.clientWidth, height = canvas.clientHeight;
      // Browser scroll events can arrive during rotation, before ResizeObserver.
      // Retain the last stable center until the new geometry has been applied.
      if (!force && cameraSnapshot && (cameraSnapshot.width !== width || cameraSnapshot.height !== height)) return;
      cameraSnapshot = { left: canvas.scrollLeft, top: canvas.scrollTop, width, height, zoom: Number(board.zoom) || 1 };
      board.viewport = { ...cameraSnapshot };
      app.saveViewport();
    }
    function viewport() { return { width: canvas.clientWidth, height: canvas.clientHeight, left: canvas.scrollLeft, top: canvas.scrollTop, zoom: Number(board.zoom) || 1, worldFrame: board.worldFrame }; }
    function updateMap(rebuild = false) {
      if (!canvas?.isConnected || !map || map.hidden) return;
      if (rebuild || !mapModel) mapModel = scene.minimap(board.items, viewport(), sizeCache);
      else {
        const current = viewport(), zoom = Math.max(.01, current.zoom);
        const width = Math.min(100, current.width / zoom / mapModel.worldWidth * 100);
        const height = Math.min(100, current.height / zoom / mapModel.worldHeight * 100);
        mapModel.viewport = { width, height, left: Math.max(0, Math.min(100 - width, current.left / zoom / mapModel.worldWidth * 100)), top: Math.max(0, Math.min(100 - height, current.top / zoom / mapModel.worldHeight * 100)) };
      }
      map.style.width = mapModel.width + 'px';
      map.style.height = mapModel.height + 'px';
      if (rebuild || !map.querySelector('.board-map-viewport')) {
        const fragment = document.createDocumentFragment();
        for (const item of mapModel.nodes) {
          const dot = element('button', 'board-map-node ' + (item.type === 'note' ? 'note-dot' : 'doc-dot'));
          dot.type = 'button'; dot.dataset.boardMapId = item.id;
          dot.title = labelById.get(item.id) || 'Go to card';
          dot.setAttribute('aria-label', 'Go to ' + dot.title);
          Object.assign(dot.style, { left: item.left + '%', top: item.top + '%', width: item.width + '%', height: item.height + '%' });
          fragment.append(dot);
        }
        fragment.append(element('span', 'board-map-viewport'));
        map.replaceChildren(fragment);
      }
      const box = map.querySelector('.board-map-viewport');
      if (box) Object.assign(box.style, { left: mapModel.viewport.left + '%', top: mapModel.viewport.top + '%', width: mapModel.viewport.width + '%', height: mapModel.viewport.height + '%' });
    }
    function scheduleMap() {
      if (frameRequest) return;
      frameRequest = requestAnimationFrame(() => { frameRequest = null; updateMap(); });
    }
    function scheduleGeometry() {
      if (geometryRequest) return;
      geometryRequest = requestAnimationFrame(() => {
        geometryRequest = null;
        if (canvas?.isConnected && app.isBoard() && canvas.clientWidth && canvas.clientHeight) {
          const previous = cameraSnapshot;
          if (previous && (previous.width !== canvas.clientWidth || previous.height !== canvas.clientHeight)) {
            const scale = Number(board.zoom) || 1;
            refreshBoard({ left: Math.max(0, (previous.left + previous.width / 2) / previous.zoom * scale - canvas.clientWidth / 2), top: Math.max(0, (previous.top + previous.height / 2) / previous.zoom * scale - canvas.clientHeight / 2) });
          } else refreshBoard();
          if (fitOnEntry) fit();
        }
      });
    }
    function applyOptions() {
      if (!canvas?.isConnected) return;
      const root = document.getElementById('view');
      root.classList.toggle('board-compact-cards', !!board.compactCards);
      root.classList.toggle('board-hide-links', !!board.hideConnections);
      root.classList.toggle('board-hide-grid', !!board.hideGrid);
      map.hidden = board.showMinimap === false;
      root.querySelectorAll('[data-board-option]').forEach(input => {
        const option = input.dataset.boardOption;
        const checked = option === 'connections' ? !board.hideConnections : option === 'grid' ? !board.hideGrid : option === 'map' ? board.showMinimap !== false : !!board.compactCards;
        if (input.tagName === 'OPTION') input.textContent = input.dataset.label + ': ' + (checked ? 'On' : 'Off');
        else input.checked = checked;
      });
      const toggle = root.querySelector('[data-action="toggle-minimap"]');
      if (toggle) { toggle.textContent = map.hidden ? 'Mini map' : 'Hide map'; toggle.setAttribute('aria-pressed', String(!map.hidden)); }
      const links = world.querySelector('.mindmap-links');
      links?.classList.toggle('board-links-distant', (Number(board.zoom) || 1) < .45);
    }
    function applyFocus() {
      const active = focused && app.isBoard();
      document.querySelector('.app').classList.toggle('board-focus-mode', active);
      const control = document.querySelector('[data-board-focus]');
      if (control) { control.textContent = active ? '↙ Exit focus' : '⛶ Focus'; control.setAttribute('aria-pressed', String(active)); }
      requestAnimationFrame(() => { if (canvas?.isConnected) updateMap(); });
    }
    function refreshBoard(position) {
      if (!canvas?.isConnected || !world?.isConnected || board.id !== app.getBoard().id) return false;
      const cardNodes = new Map([...world.querySelectorAll('[data-item]')].map(card => [card.dataset.item, card]));
      if (cardNodes.size !== board.items.length || board.items.some(item => !cardNodes.has(item.id))) return false;
      applyOptions();
      for (const item of board.items) Object.assign(cardNodes.get(item.id).style, { left: item.x + 'px', top: item.y + 'px' });
      sizeCache = measurements();
      const area = scene.worldSize(board.items, sizeCache, board.worldFrame);
      world.style.width = area.width + 'px'; world.style.height = area.height + 'px';
      world.style.transform = 'scale(' + (Number(board.zoom) || 1) + ')';
      world.style.setProperty('--board-control-scale',String(1 / (Number(board.zoom) || 1)));world.classList.toggle('board-controls-distant',(Number(board.zoom)||1)<.45);
      space.style.width = area.width * (Number(board.zoom) || 1) + 'px'; space.style.height = area.height * (Number(board.zoom) || 1) + 'px';
      const label = document.querySelector('.canvas-controls [data-board-zoom-label]');
      if (label) label.textContent = (Math.round((Number(board.zoom) || 1) * 1000) / 10) + '%';
      if (position) { canvas.scrollLeft = position.left; canvas.scrollTop = position.top; }
      if (!board.hideConnections) app.redrawLinks();
      const stats = document.querySelector('.board-head-stats');
      if (stats) stats.textContent = board.items.filter(item => item.type === 'note').length + ' notes · ' + board.items.filter(item => item.type !== 'note').length + ' files · ' + (board.edges || []).length + ' connections';
      const count = frame.querySelector('.board-statusbar>span');
      if (count) count.textContent = board.items.length + ' cards · ' + (board.edges || []).length + ' connections';
      updateMap(true);
      app.refreshSelection();
      remember(true);
      return true;
    }
    function zoom(value, anchor) {
      if (!canvas?.isConnected || app.getBoard().id !== board.id) return;
      cancelInitialFit();
      const oldZoom = Number(board.zoom) || 1, nextZoom = Math.max(.01, Math.min(2.5, Number(value) || 1));
      if (oldZoom === nextZoom) return;
      const target = scene.anchorZoom(oldZoom, nextZoom, { left: canvas.scrollLeft, top: canvas.scrollTop }, anchor || { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
      board.zoom = nextZoom;
      world.style.transform = 'scale(' + nextZoom + ')';
      world.style.setProperty('--board-control-scale',String(1 / nextZoom));world.classList.toggle('board-controls-distant',nextZoom<.45);
      const area = scene.worldSize(board.items, sizeCache, board.worldFrame);
      space.style.width = area.width * nextZoom + 'px'; space.style.height = area.height * nextZoom + 'px';
      document.querySelector('.canvas-controls [data-board-zoom-label]').textContent = (Math.round(nextZoom * 1000) / 10) + '%';
      canvas.scrollLeft = target.left; canvas.scrollTop = target.top;
      world.querySelector('.mindmap-links')?.classList.toggle('board-links-distant', nextZoom < .45);
      updateMap(); remember(true);
      window.NotejectNoteMedia?.refreshBoardPreviews();
    }
    function fit() {
      if (!canvas?.isConnected || app.getBoard()?.id !== board.id) return;
      cancelInitialFit();
      sizeCache = measurements();
      const area = scene.worldSize(board.items, sizeCache, board.worldFrame);
      const target = board.items.length ? window.NotejectBoardLayout.fit(board.items, { width: canvas.clientWidth, height: canvas.clientHeight }, sizeCache) :
        window.NotejectBoardLayout.fit([{ id: 'empty-board', x: 0, y: 0 }], { width: canvas.clientWidth, height: canvas.clientHeight }, new Map([['empty-board', area]]));
      board.zoom = target.zoom;
      refreshBoard({ left: target.left, top: target.top });
    }
    function organizeAndFit() {
      if (!canvas?.isConnected || app.getBoard() !== board || !canvas.clientWidth || !canvas.clientHeight) return;
      cancelInitialFit();
      sizeCache = measurements();
      const result = window.NotejectBoardLayout.centeredGrid(board.items, { width: canvas.clientWidth, height: canvas.clientHeight }, sizeCache);
      delete board.organizeNewAssets; delete board.focusNewAssets;
      autoLayout = false; fit();
      if (result.changed) app.saveLayout?.();
    }
    function cancelInitialFit() {
      autoLayout = false;
      fitOnEntry = false;
      if (canvas) delete canvas.dataset.fitOnOpen;
    }
    function organizeAtStart(preferredZoom = null, coalesceHistory = false) {
      if (!canvas?.isConnected || app.getBoard() !== board || !canvas.clientWidth || !canvas.clientHeight) return;
      cancelInitialFit();
      sizeCache = measurements();
      const result = window.NotejectBoardLayout.centeredGrid(board.items, { width: canvas.clientWidth, height: canvas.clientHeight, screenWidth: window.screen?.width, screenHeight: window.screen?.height }, sizeCache, { overview: true, worldFrame: board.worldFrame, centerAssetId: board.centerAssetId });
      const frameChanged = board.worldFrame?.width !== result.worldFrame.width || board.worldFrame?.height !== result.worldFrame.height;
      const migrationChanged = board.overviewVersion !== 3 || (board.centerAssetId || null) !== result.anchorId;
      board.worldFrame = result.worldFrame;
      board.overviewVersion = 3;
      board.centerAssetId = result.anchorId;
      delete board.organizeNewAssets; delete board.focusNewAssets;
      autoLayout = true;
      automaticZoom = preferredZoom;
      board.zoom = preferredZoom === null ? result.zoom : Math.min(result.zoom, Math.max(.01, Math.min(2.5, Number(preferredZoom) || result.zoom)));
      refreshBoard({ left: Math.max(0, result.center.x * board.zoom - canvas.clientWidth / 2), top: Math.max(0, result.center.y * board.zoom - canvas.clientHeight / 2) });
      if (result.changed || frameChanged || migrationChanged) app.saveLayout?.({ coalesceHistory });
    }
    function centerAtCurrentZoom() {
      if (!canvas?.isConnected || app.getBoard() !== board) return;
      cancelInitialFit();
      const area = scene.worldSize(board.items, sizeCache, board.worldFrame), scale = Number(board.zoom) || 1;
      refreshBoard({ left: Math.max(0, area.width * scale / 2 - canvas.clientWidth / 2), top: Math.max(0, area.height * scale / 2 - canvas.clientHeight / 2) });
    }
    function toggleMap() {
      if (!board || !app.isBoard()) return;
      board.showMinimap = board.showMinimap === false;
      applyOptions(); updateMap(true); app.saveViewport();
    }
    function revealItems(ids) {
      if (!canvas?.isConnected || !board || app.getBoard() !== board) return;
      const chosen = board.items.filter(item => ids.includes(item.id)); if (!chosen.length) return;
      const bounds = chosen.map(item => ({ x: item.x, y: item.y, width: sizeCache.get(item.id)?.width || 207, height: sizeCache.get(item.id)?.height || 160 }));
      const left = Math.min(...bounds.map(item => item.x)), right = Math.max(...bounds.map(item => item.x + item.width));
      const top = Math.min(...bounds.map(item => item.y)), bottom = Math.max(...bounds.map(item => item.y + item.height)), scale = Number(board.zoom) || 1;
      canvas.scrollLeft = Math.max(0, (left + right) * scale / 2 - canvas.clientWidth / 2);
      canvas.scrollTop = Math.max(0, (top + bottom) * scale / 2 - canvas.clientHeight / 2);
      remember(true); updateMap();
    }
    function mount() {
      observer?.disconnect(); clearTimeout(scrollSave);
      if (frameRequest) cancelAnimationFrame(frameRequest);
      if (geometryRequest) cancelAnimationFrame(geometryRequest);
      geometryRequest = null;
      frameRequest = null;
      const root = document.getElementById('view');
      root.classList.toggle('is-board-view', app.isBoard());
      if (!app.isBoard()) { canvas = world = null; enteredBoardId = null; fitOnEntry = false; applyFocus(); return; }
      canvas = root.querySelector('.canvas'); world = root.querySelector('.canvas-world'); board = app.getBoard();
      const entering = enteredBoardId !== board.id;
      if (entering) { enteredBoardId = board.id; fitOnEntry = true;canvas.dataset.fitOnOpen='true'; }
      cameraSnapshot = board?.viewport?.width && board.viewport.height ? { ...board.viewport, zoom: Number(board.viewport.zoom) || Number(board.zoom) || 1 } : null;
      const repairZoom = board.overviewVersion === 2 && board.viewport && !board.organizeNewAssets && !board.focusNewAssets ? Number(board.zoom) || .1 : null;
      const requestedZoom = repairZoom ?? (board.viewport && Number(board.zoom) < .1 ? Number(board.zoom) : null);
      // 1.8.2 saved the misunderstood 1000% magnification. Repair those cameras
      // on entry, including Boards restored by Android's last-screen session.
      // Keep this migration marker outside undo snapshots: undoing a migration
      // must not immediately migrate again and erase the redo branch.
      if (Number(board.zoom) > 2.5 || board.overviewVersion === 1 || board.overviewVersion === 2 || (!board.worldFrame && !board.overviewVersion && Number(board.zoom) <= .1)) board.organizeNewAssets = true;
      const firstVisit = !board.viewport || !!board.focusNewAssets || !!board.organizeNewAssets;
      autoLayout = firstVisit;
      if (!canvas || !world) return;
      frame = root.querySelector('.board-canvas-frame'); map = frame.querySelector('.board-minimap'); mapModel = null;
      const welcome = canvas.querySelector('.welcome');
      if (welcome && !board.items.length) {
        const empty = element('section', 'board-empty-overlay');
        empty.setAttribute('aria-label', 'Start this Board');
        const copy = welcome.querySelector('p');
        if (copy) copy.textContent = 'Add a note or file. Your first asset starts at the center of the entire Board.';
        empty.append(welcome); frame.append(empty);
      }
      space = element('div', 'board-world-space'); world.replaceWith(space); space.append(world);
      const data = app.getData();
      labelById = new Map([...data.notes.map(note => [note.id, note.title]), ...data.docs.map(doc => [doc.id, doc.name])]);
      const head = root.querySelector('.page-head'); head.classList.add('board-page-head');
      const toolbar = root.querySelector('.board-toolstrip'), navigation = frame.querySelector('.board-navigation-strip');
      const assets = element('button', 'secondary board-asset-browser', 'Assets'); assets.type = 'button'; assets.dataset.boardAssetBrowser = 'true';
      assets.setAttribute('aria-label', 'Browse Board assets'); assets.onclick = () => window.NotejectWorkspaceUX.openBoardItems();
      toolbar?.append(assets);
      const center = root.querySelector('[data-action="zoom-center"]');
      if (center) { center.prepend(element('span', 'board-center-label', 'Center Board')); center.title = 'Center the entire Board without changing zoom'; }
      root.querySelectorAll('[data-action="zoom-fit"]').forEach(control => { control.textContent = 'Fit assets'; });
      const organize = root.querySelector('[data-action="zoom-overview"]'); if (organize) { organize.textContent = 'Organize all'; toolbar?.append(organize); }
      if (toolbar && navigation) {
        const search = navigation.querySelector('.board-search-tools'), zoom = navigation.querySelector('.canvas-controls');
        if (search) toolbar.insertBefore(search, toolbar.querySelector('[data-board-select-all]'));
        if (zoom) toolbar.append(zoom);
        navigation.remove();
      }
      const stats = element('p', 'board-head-stats', board.items.filter(item => item.type === 'note').length + ' notes · ' + board.items.filter(item => item.type !== 'note').length + ' files · ' + (board.edges || []).length + ' connections');
      head.querySelector('p')?.replaceWith(stats);
      const back = element('button', 'board-back', '← Boards'); back.type = 'button'; back.onclick = () => app.showBoards(); head.querySelector('.eyebrow').replaceWith(back);
      const actions = head.querySelector('.buttons');
      const viewOptions = element('select', 'board-view-menu');
      viewOptions.dataset.boardViewMenu = 'true'; viewOptions.setAttribute('aria-label', 'Board view options');
      const placeholder = element('option', '', 'View…'); placeholder.value = ''; viewOptions.append(placeholder);
      for (const [key, text] of [['compact', 'Compact cards'], ['connections', 'Show connections'], ['grid', 'Show grid'], ['map', 'Show mini map']]) {
        const option = element('option', '', text); option.value = key; option.dataset.boardOption = key; option.dataset.label = text; viewOptions.append(option);
      }
      viewOptions.onchange = () => {
        const key = viewOptions.value; viewOptions.value = '';
        if (key === 'compact') board.compactCards = !board.compactCards;
        if (key === 'connections') board.hideConnections = !board.hideConnections;
        if (key === 'grid') board.hideGrid = !board.hideGrid;
        if (key === 'map') board.showMinimap = board.showMinimap === false;
        applyOptions(); refreshBoard(); app.saveViewport();
      };
      const focus = element('button', 'secondary', '⛶ Focus'); focus.type = 'button'; focus.dataset.boardFocus = 'true'; focus.title = 'Expand the canvas; press Escape to leave focus view'; focus.onclick = () => { focused = !focused; applyFocus(); };
      actions.append(viewOptions, focus);
      const status = element('footer', 'board-statusbar');
      status.append(element('span', '', board.items.length + ' cards · ' + (board.edges || []).length + ' connections'), element('span', '', 'Space + drag to pan · Ctrl + wheel to zoom · F to fit'));
      frame.append(status);
      canvas.addEventListener('scroll', () => { remember(); scheduleMap(); }, { passive: true });
      canvas.addEventListener('wheel', () => { autoLayout = false; fitOnEntry = false; }, { passive: true });
      map.onclick = event => {
        const target = event.target.closest('[data-board-map-id]');
        const item = target && board.items.find(item => item.id === target.dataset.boardMapId);
        const box = map.getBoundingClientRect();
        const x = item ? item.x + 103 : (event.clientX - box.left) / box.width * mapModel.worldWidth;
        const y = item ? item.y + 80 : (event.clientY - box.top) / box.height * mapModel.worldHeight;
        const scale = Number(board.zoom) || 1;
        canvas.scrollTo({ left: Math.max(0, x * scale - canvas.clientWidth / 2), top: Math.max(0, y * scale - canvas.clientHeight / 2) });
        remember();
      };
      canvas.addEventListener('keydown', event => {
        autoLayout = false; fitOnEntry = false;
        const card = event.target.closest('[data-item]');
        if (event.key === 'Enter' && card === event.target) { event.preventDefault(); card.click(); }
        if (event.target !== canvas || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom((Number(board.zoom) || 1) * 1.2); }
        else if (event.key === '-') { event.preventDefault(); zoom((Number(board.zoom) || 1) / 1.2); }
        else if (event.key === '0') { event.preventDefault(); zoom(1); }
        else if (event.key.toLowerCase() === 'f') { event.preventDefault(); fit(); }
      });
      applyOptions();
      if (firstVisit) {
        board.organizeNewAssets = true;
        organizeAtStart(requestedZoom, true);
      } else {
        const saved = cameraSnapshot;
        // Older releases stored scroll offsets without viewport dimensions. A
        // landscape offset cannot be restored meaningfully on a portrait phone.
        // Migrate once by revealing the existing assets, retaining their zoom
        // and positions; subsequent opens preserve the saved world center.
        sizeCache = measurements();
        const legacy = !saved && window.NotejectBoardLayout.bounds(board.items, sizeCache), scale = Number(board.zoom) || 1;
        refreshBoard(saved ? { left: Math.max(0, saved.left + (saved.width - canvas.clientWidth) / 2), top: Math.max(0, saved.top + (saved.height - canvas.clientHeight) / 2) } : legacy ? { left: Math.max(0, (legacy.left + legacy.right) / 2 * scale - canvas.clientWidth / 2), top: Math.max(0, (legacy.top + legacy.bottom) / 2 * scale - canvas.clientHeight / 2) } : board.viewport || { left: 0, top: 0 });
      }
      applyFocus();
      if (entering) {
        const entered = board, enteredCanvas = canvas;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (app.getBoard() === entered && canvas === enteredCanvas && canvas?.isConnected && canvas.clientWidth && canvas.clientHeight && fitOnEntry) fit();
        }));
      }
      // Mobile chrome re-parents the canvas after mount; fonts and thumbnails can
      // also change card geometry after the first connection render.
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(scheduleGeometry); observer.observe(canvas); observer.observe(world);
        world.querySelectorAll('.canvas-card').forEach(card => observer.observe(card));
      }
      scheduleGeometry();
      if (firstVisit) {
        const entered = board, enteredCanvas = canvas; delete entered.focusNewAssets;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (app.getBoard() === entered && canvas === enteredCanvas && autoLayout) organizeAtStart(automaticZoom, true);
        }));
      }
      document.fonts?.ready.then(() => { if (canvas?.isConnected) scheduleGeometry(); });
    }
    // Initial placement follows font/chrome geometry, but the first user
    // interaction anywhere in the Board (including its menus) owns the camera.
      document.addEventListener('pointerdown', () => { if (app.isBoard()) cancelInitialFit(); }, { capture: true, passive: true });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !app.isBoard()) return;
      const options = document.querySelector('.board-view-options[open]');
      if (options?.contains(event.target)) { options.open = false; options.querySelector('summary').focus(); event.preventDefault(); event.stopPropagation(); return; }
      if (!focused || document.querySelector('[role=dialog], #edit-body, .connect-hint') || event.target.closest('input,textarea,select,[contenteditable=true]')) return;
      focused = false; applyFocus();
    });
    document.addEventListener('click', event => {
      document.querySelectorAll('.board-view-options[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
    });
    return { mount, refreshBoard, zoom, fit, organizeAndFit, organizeAtStart, centerAtCurrentZoom, toggleMap, revealItems, cancelInitialFit };
  }
  window.NotejectBoardView = { create };
})();
