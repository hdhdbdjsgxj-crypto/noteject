/* Android reader presentation. Commands continue to use the shared reader. */
(() => {
  'use strict';
  if (!window.NotejectAndroid) return;
  const compact = matchMedia('(max-width: 959px)');
  const paths = {
    contents: '<path d="M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01"/>',
    find: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    save: '<path d="m4 16-1 5 5-1L21 7l-4-4L4 16ZM15 5l4 4M4 16l4 4"/>',
    notes: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
    view: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
    back: '<path d="m14 5-7 7 7 7"/>',
    previous: '<path d="m15 5-7 7 7 7"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
    menu: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    fullscreen: '<path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  let current = null, viewportFrame = 0, currentCleanup = null;
  let tapToTurn = true;
  try { tapToTurn = localStorage.getItem('noteject-android-reader-tap-turn') !== 'off'; } catch {}
  const setClass = (node, name, active) => { if (node.classList.contains(name) !== !!active) node.classList.toggle(name, !!active); };
  const setAttribute = (node, name, value) => { if (node && node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value)); };
  const command = (shell, name) => shell.querySelector(`[data-reader-command="${name}"]`);
  const activate = (shell, name) => command(shell, name)?.click();

  function browse(shell, tab) {
    if (shell.classList.contains('is-focused')) activate(shell, 'focus');
    if (!shell.classList.contains('nav-open')) activate(shell, 'navigation');
    shell.querySelector(`[data-reader-tab="${tab}"]`)?.click();
    if (compact.matches) closePanels(shell, 'navigation');
    setDisplay(shell, false);
  }

  function selectionIn(viewport) {
    const selection = window.getSelection?.();
    return !!selection && !selection.isCollapsed && (viewport.contains(selection.anchorNode) || viewport.contains(selection.focusNode));
  }

  function setupPageTaps(shell) {
    const viewport = shell.querySelector('.reader-content');
    if (!viewport || shell.dataset.arKind === 'epub') return () => {};
    const ignored = 'a,button,input,textarea,select,label,summary,[contenteditable],[role="button"],[role="link"],audio,video,iframe,object,embed,img,svg,canvas:not(.reader-pdf-canvas),pre,code,table,.reader-error,.reader-loading,.clip-composer';
    let touch = null, pending = 0, releaseTimer = 0, turning = false, chapterObserver = null, pinch = null, pinchFrame = 0, pinchDirty = false, multiTouchSession = false;
    const pointers = new Set();
    const positions = new Map();
    const cancel = () => { clearTimeout(pending); pending = 0; touch = null; };
    const blocked = target => target?.closest?.(ignored);
    const location = () => shell.dataset.arKind === 'epub' ? shell.querySelector('#epub-text')?.dataset.readerChapter : ['pdf','djvu'].includes(shell.dataset.arKind) ? shell.querySelector('#pdf-page-input')?.value : 'text';
    const pdfScale = point => {
      const exact = window.NotejectReaderGestures?.getScale?.(point);
      if (Number.isFinite(exact)) return Math.max(.25, Math.min(4, exact));
      const percent = Number.parseFloat(command(shell, 'zoom-reset')?.textContent || '');
      return Number.isFinite(percent) ? Math.max(.25, Math.min(4, percent / 100)) : 1;
    };
    function finishPinch(commit) {
      if (!pinch) return;
      // The last pointer sample can arrive before the scheduled frame. Apply it
      // before committing so a quick pinch ends at the fingers' final position.
      if (commit) flushPinchZoom();
      if (pinchFrame) cancelAnimationFrame(pinchFrame);
      pinchFrame = 0; pinchDirty = false;
      pinch = null; cancel();
      Promise.resolve(window.NotejectReaderGestures?.end({ commit })).catch(error => console.warn('PDF zoom could not finish', error));
    }
    function flushPinchZoom() {
      if (pinchFrame) cancelAnimationFrame(pinchFrame);
      pinchFrame = 0;
      if (!pinch || !pinchDirty) return;
      pinchDirty = false;
      const points = pinch.ids.map(id => positions.get(id)); if (points.some(point => !point)) return;
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const target = Math.max(.25, Math.min(4, pinch.scale * distance / pinch.distance));
      // Reuse the displayed bitmap under the fingers. Decode and render at the
      // new resolution once, after the gesture ends.
      window.NotejectReaderGestures?.update(target, { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
    }
    function schedulePinchZoom() {
      pinchDirty = true;
      if (!pinchFrame) pinchFrame = requestAnimationFrame(flushPinchZoom);
    }
    function releasePointer(event) {
      if (pinch?.ids.includes(event.pointerId)) {
        const previous = positions.get(event.pointerId);
        if (previous && (previous.x !== event.clientX || previous.y !== event.clientY)) {
          positions.set(event.pointerId, { x: event.clientX, y: event.clientY });
          pinchDirty = true;
        }
        finishPinch(event.type === 'pointerup');
      }
      pointers.delete(event.pointerId); positions.delete(event.pointerId);
      if (!pointers.size) multiTouchSession = false;
    }
    const release = () => { clearTimeout(releaseTimer); turning = false; chapterObserver?.disconnect(); chapterObserver = null; };
    function turn(direction) {
      if (turning || !shell.isConnected || !tapToTurn || document.hidden || !viewport.getClientRects().length || viewport.closest('[inert],[hidden]') || selectionIn(viewport) || shell.matches('.nav-open,.tools-open,.assistant-open,.ar-display-open') || shell.querySelector('details[open],.reader-findbar:not([hidden])')) return;
      // A horizontally enlarged page should be panned before an edge tap can turn it.
      if (viewport.scrollWidth > viewport.clientWidth + 28) return;
      const isPaged = ['pdf','djvu'].includes(shell.dataset.arKind);
      const room = direction > 0 ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop : viewport.scrollTop;
      if (!isPaged && room > 8) {
        viewport.scrollBy({ top: direction * Math.min(room, Math.max(100, viewport.clientHeight * .86)), behavior: 'smooth' });
        return;
      }
      const button = command(shell, direction > 0 ? 'next' : 'previous');
      if (!button || button.disabled || button.hidden) return;
      turning = true;
      if (!isPaged) {
        const page = shell.querySelector('#epub-text'), chapter = page?.dataset.readerChapter;
        chapterObserver?.disconnect();
        if (page) {
          chapterObserver = new MutationObserver(() => {
            if (!shell.isConnected || !page.isConnected) { release(); return; }
            if (page.dataset.readerChapter === chapter) return;
            release();
            if (direction < 0) requestAnimationFrame(() => { if (shell.isConnected && page.isConnected) viewport.scrollTop = viewport.scrollHeight; });
          });
          chapterObserver.observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-reader-chapter'] });
        }
      }
      releaseTimer = setTimeout(release, isPaged ? 600 : 30000);
      button.click();
    }
    const pointerDown = event => {
      const secondTap = !!pending;
      clearTimeout(pending); pending = 0;
      if (event.pointerType !== 'touch') return;
      pointers.add(event.pointerId);
      positions.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (['pdf','djvu'].includes(shell.dataset.arKind) && pointers.size === 2 && !multiTouchSession) {
        multiTouchSession = true;
        const ids = [...pointers], points = ids.map(id => positions.get(id));
        const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const scale = pdfScale(center);
        if (window.NotejectReaderGestures?.begin(center)) pinch = { ids, distance: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)), scale };
        cancel(); return;
      }
      if (pinch) { cancel(); return; }
      if (secondTap || pointers.size !== 1 || !event.isPrimary || !tapToTurn || blocked(event.target) || selectionIn(viewport)) { touch = null; return; }
      touch = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), scroll: viewport.scrollTop, left: viewport.scrollLeft, location: location() };
    };
    const pointerMove = event => {
      if (positions.has(event.pointerId)) positions.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch) {
        event.preventDefault(); touch = null;
        if (pinch.ids.includes(event.pointerId)) schedulePinchZoom();
        return;
      }
      if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 9) touch = null;
    };
    const pointerCancel = event => { releasePointer(event); cancel(); };
    const pointerUp = event => {
      const wasMultiTouch = multiTouchSession;
      releasePointer(event);
      if (wasMultiTouch) { cancel(); return; }
      const candidate = touch; touch = null;
      if (!candidate || candidate.id !== event.pointerId || performance.now() - candidate.time > 260 || Math.abs(viewport.scrollTop - candidate.scroll) > 3 || Math.abs(viewport.scrollLeft - candidate.left) > 3 || candidate.location !== location() || blocked(event.target) || selectionIn(viewport)) return;
      const bounds = viewport.getBoundingClientRect(), x = event.clientX - bounds.left;
      const edge = Math.min(76, bounds.width * .2), direction = x < edge ? -1 : x > bounds.width - edge ? 1 : 0;
      if (!direction || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      // Wait for a second tap or Android's selection handles before navigating.
      pending = setTimeout(() => { pending = 0; if (candidate.location === location()) turn(direction); }, 320);
    };
    // Keep the browser's one-finger scrolling and momentum. Capturing every
    // pointer or setting touch-action:none would also take over text selection.
    viewport.addEventListener('pointerdown', pointerDown, { passive: true });
    viewport.addEventListener('pointermove', pointerMove, { passive: false });
    viewport.addEventListener('pointercancel', pointerCancel, { passive: true });
    viewport.addEventListener('pointerup', pointerUp, { passive: true });
    viewport.addEventListener('scroll', cancel, { passive: true });
    const selectionChanged = () => { if (selectionIn(viewport)) cancel(); };
    const outsideTouch = event => { if (!viewport.contains(event.target)) cancel(); };
    const pointerReleased = event => { if (!viewport.contains(event.target)) { releasePointer(event); cancel(); } };
    const suspend = () => { cancel(); finishPinch(false); pointers.clear(); positions.clear(); multiTouchSession = false; };
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('pointerdown', outsideTouch, true);
    document.addEventListener('pointerup', pointerReleased, true);
    document.addEventListener('pointercancel', pointerReleased, true);
    document.addEventListener('visibilitychange', suspend);
    document.addEventListener('keydown', cancel, true);
    window.addEventListener('blur', suspend);
    return () => {
      suspend(); release();
      viewport.removeEventListener('pointerdown', pointerDown);
      viewport.removeEventListener('pointermove', pointerMove);
      viewport.removeEventListener('pointercancel', pointerCancel);
      viewport.removeEventListener('pointerup', pointerUp);
      viewport.removeEventListener('scroll', cancel);
      document.removeEventListener('selectionchange', selectionChanged);
      document.removeEventListener('pointerdown', outsideTouch, true);
      document.removeEventListener('pointerup', pointerReleased, true);
      document.removeEventListener('pointercancel', pointerReleased, true);
      document.removeEventListener('visibilitychange', suspend);
      document.removeEventListener('keydown', cancel, true);
      window.removeEventListener('blur', suspend);
    };
  }

  function setDisplay(shell, open) {
    const panel = shell.querySelector('.ar-display-panel');
    if (!panel) return;
    if (open && !panel.open) { closeMenu(shell); panel.showModal(); }
    if (!open && panel.open) panel.close();
    setClass(shell, 'ar-display-open', open);
    shell.querySelectorAll('[data-ar-action="display"]').forEach(button => setAttribute(button, 'aria-expanded', open));
    if (!open) panel.querySelectorAll('details[open]').forEach(details => { details.open = false; });
  }

  function closeMenu(shell) { shell.querySelector('.ar-menu-sheet[open]')?.close(); }

  function makeSheet(shell, title, className) {
    const sheet = document.createElement('dialog');
    sheet.className = 'ar-reader-sheet ' + className;
    sheet.setAttribute('aria-label', title);
    sheet.innerHTML = '<div class="ar-sheet-heading"><div><small>NOTEJECT / READER</small><h2></h2></div><button type="button" class="ar-sheet-close" aria-label="Close ' + title + '">' + icon('close') + '</button></div><p class="ar-sheet-document"></p>';
    sheet.querySelector('h2').textContent = title;
    sheet.querySelector('.ar-sheet-document').textContent = shell.querySelector('.reader-document-identity h1')?.textContent || 'Document';
    sheet.querySelector('.ar-sheet-close').onclick = () => sheet.close();
    // The platform dialog owns focus and Escape. A gesture must start and end
    // on its backdrop, so scrolling from the sheet cannot dismiss it by accident.
    let backdropDown = false;
    const outside = event => { const rect = sheet.getBoundingClientRect(); return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom; };
    sheet.addEventListener('pointerdown', event => { backdropDown = outside(event); });
    sheet.addEventListener('pointerup', event => { if (backdropDown && outside(event)) sheet.close(); backdropDown = false; });
    sheet.addEventListener('pointercancel', () => { backdropDown = false; });
    shell.append(sheet);
    return sheet;
  }

  function closePanels(shell, except = '') {
    if (except !== 'navigation' && shell.classList.contains('nav-open')) activate(shell, 'navigation');
    if (except !== 'tools' && shell.classList.contains('tools-open')) activate(shell, 'tools');
    if (except !== 'assistant' && shell.classList.contains('assistant-open')) activate(shell, 'assistant');
  }

  function decorate(button, name, label) {
    if (!button) return null;
    button.innerHTML = `${icon(name)}<span class="ar-dock-label">${label}</span>`;
    button.setAttribute('aria-label', label === 'Save' ? 'Save selected text as a note' : label === 'Notes' ? 'Notes & Passages' : label === 'Contents' ? 'Contents, pages and bookmarks' : label);
    button.removeAttribute('title');
    return button;
  }

  function setup(shell) {
    shell.classList.add('ar-reader');
    shell.dataset.arReaderReady = 'true';
    const header = shell.querySelector('.reader-header');
    const headerActions = shell.querySelector('.reader-header-actions');
    const menu = shell.querySelector('.reader-document-menu');
    const menuOptions = shell.querySelector('.reader-document-options');
    const navigation = shell.querySelector('.reader-navigation');
    const side = shell.querySelector('.reader-side');
    const status = shell.querySelector('.reader-statusbar');
    const reading = !!shell.querySelector('.reader-commandbar');
    const documentType = shell.querySelector('.reader-document-identity small')?.textContent.toLowerCase() || '';
    shell.dataset.arKind = shell.dataset.readerType || (shell.querySelector('#pdf-page-input') ? documentType.includes('djvu') ? 'djvu' : 'pdf' : shell.querySelector('#epub-toc') ? 'epub' : reading ? 'txt' : 'attachment');
    const identity = shell.querySelector('.reader-document-identity small');
    if (identity?.firstChild?.nodeType === Node.TEXT_NODE) identity.firstChild.textContent = 'NOTEJECT / READER';
    const back = command(shell, 'back');
    if (back) back.innerHTML = icon('back');

    if (menu) {
      header.append(menu);
      const trigger = menu.querySelector('summary');
      trigger.innerHTML = icon('menu');
      setAttribute(trigger, 'aria-label', 'Reader menu');
      // Ask already has a complete, labelled command in the document menu.
      headerActions?.querySelector('[data-reader-command="assistant"]')?.remove();
      const sheet = makeSheet(shell, 'Reader menu', 'ar-menu-sheet');
      menuOptions.querySelector('.reader-menu-label')?.remove();
      sheet.append(menuOptions);
      menuOptions.classList.add('ar-sheet-actions');
      const shortcuts = document.createElement('div'); shortcuts.className = 'ar-reader-menu-shortcuts';
      const routes={contents:'chapters',find:'reader-find',saved:'reader-notes','add-to-board':'passage-board',bookmark:'add-bookmark','save-passage':'reader-save','extend-passage':'extend-passage','save-image':'reader-image',comment:'reader-comment',view:'display',help:'reader-help'};
      const entries=reading?window.NotejectReaderMenu.forType(shell.dataset.arKind):window.NotejectReaderMenu.forType('txt').filter(item=>item.id==='help');
      for(const entry of entries){const item=document.createElement('button');item.type='button';item.dataset.arAction=routes[entry.id];item.dataset.readerMenuId=entry.id;if(['contents','find','saved','bookmark','save-passage','extend-passage','save-image','comment','add-to-board','view'].includes(entry.id))item.dataset.readerRequiresReady='true';item.innerHTML=icon(entry.icon)+'<span>'+entry.label+'</span>';shortcuts.append(item);}
      menuOptions.querySelector('[data-reader-command="capture-image"]')?.remove();menuOptions.prepend(shortcuts);
      const extras = [['previous-file','previous','Previous file'],['next-file','next','Next file'],['assistant','notes','Ask this document'],['download','download','Download original']];
      for (const [name, glyph, label] of extras) { const button = menuOptions.querySelector('[data-reader-command="' + name + '"]'); if (button) button.innerHTML = icon(glyph) + '<span>' + label + '</span>'; }
      trigger.addEventListener('click', event => { event.preventDefault(); setDisplay(shell, false); closePanels(shell); if (!sheet.open) sheet.showModal(); });
    }

    const bookmark = command(shell, 'bookmark');
    if (bookmark) {
      bookmark.innerHTML = icon('bookmark');
      bookmark.className = 'ar-bookmark';
      setAttribute(bookmark, 'aria-label', 'Bookmark this reading position');
      header.insertBefore(bookmark, menu);
    }

    if (reading) {
      const dock = document.createElement('nav');
      dock.className = 'ar-reader-dock'; dock.setAttribute('aria-label', 'Reading actions');
      const contents = decorate(command(shell, 'navigation'), 'contents', 'Contents');
      const find = decorate(command(shell, 'find'), 'find', 'Find');
      const save = decorate(command(shell, 'save-selection'), 'save', 'Save');
      const notes = decorate(headerActions?.querySelector('[data-reader-command="saved"]'), 'notes', 'Notes');
      for (const button of [contents, find, save, notes]) if (button) dock.append(button);
      const headerFind = document.createElement('button');
      headerFind.type = 'button'; headerFind.className = 'ar-header-find'; headerFind.dataset.arAction = 'reader-find';
      headerFind.setAttribute('aria-label', 'Find in document'); headerFind.innerHTML = icon('find');
      header.insertBefore(headerFind, bookmark || menu);
      const display = document.createElement('button');
      display.type = 'button'; display.dataset.arAction = 'display';
      display.setAttribute('aria-expanded', 'false');
      const isPaged = ['pdf','djvu'].includes(shell.dataset.arKind);
      decorate(display, 'view', 'View');
      setAttribute(display, 'aria-label', isPaged ? 'Page zoom and reading settings' : 'Text size, zoom and reading settings'); dock.append(display);
      shell.append(dock);

      const viewControls = shell.querySelector('.reader-view-controls');
      if (viewControls) {
        const panel = makeSheet(shell, 'View & reading', 'ar-display-panel');
        panel.append(viewControls);
        panel.addEventListener('close', () => {
          if (panel.open) return;
          setClass(shell, 'ar-display-open', false);
          shell.querySelectorAll('[data-ar-action="display"]').forEach(button => setAttribute(button, 'aria-expanded', false));
          panel.querySelectorAll('details[open]').forEach(details => { details.open = false; });
        });
        const modeLabel = panel.querySelector('.reader-control-label');
        if (modeLabel?.firstChild?.nodeType === Node.TEXT_NODE) modeLabel.firstChild.textContent = 'Page layout';
        const appearance = panel.querySelector('.reader-appearance-panel')?.closest('details');
        if (appearance) {
          appearance.classList.add('ar-appearance');
          appearance.querySelector('summary').textContent = 'Page appearance';
          setAttribute(appearance.querySelector('summary'), 'aria-label', 'Font, spacing and page appearance');
          const fontControls = appearance.querySelector('.reader-font-controls');
          if (fontControls) {
            const previousLabel = fontControls.closest('label');
            const fontRow = document.createElement('div'); fontRow.className = 'ar-text-size-row';
            fontRow.innerHTML = '<span>Text size</span>'; fontRow.append(fontControls);
            viewControls.prepend(fontRow); previousLabel?.remove();
          }
        }
        const zoom = viewControls.querySelector('.reader-zoom');
        if (zoom) {
          const row = document.createElement('div'); row.className = 'ar-zoom-row';
          const label = isPaged ? 'Page zoom' : shell.dataset.arKind === 'txt' ? 'Text size' : 'Page zoom';
          row.innerHTML = '<span>' + label + '</span>'; zoom.before(row); row.append(zoom);
          setAttribute(zoom, 'aria-label', label);
        }
        const tapSetting = document.createElement('label'); tapSetting.className = 'ar-tap-setting';
        tapSetting.innerHTML = '<input type="checkbox" data-ar-setting="tap-turn"><span><b>Tap edges to turn pages</b><small>Left edge: back · Right edge: next. Hold text to select.</small></span>';
        tapSetting.querySelector('input').checked = tapToTurn;
        tapSetting.querySelector('input').onchange = event => { tapToTurn = event.target.checked; try { localStorage.setItem('noteject-android-reader-tap-turn', tapToTurn ? 'on' : 'off'); } catch {} };
        if(shell.dataset.arKind!=='epub')panel.append(tapSetting);
        const help = document.createElement('p'); help.className = 'ar-reading-help';
        help.textContent = isPaged ? (shell.dataset.arKind === 'djvu' ? 'DjVu pages have a fixed layout. Use page zoom to enlarge them; use Contents or Pages to navigate.' : 'PDF text has a fixed layout. Use page zoom to enlarge it; use Contents or Pages to navigate.') : 'Text size changes the letters. Page zoom enlarges the whole page. Swipe to scroll or tap a page edge to move one screen.';
        if(shell.dataset.arKind!=='epub')panel.append(help);
      }
      currentCleanup = setupPageTaps(shell);
      setAttribute(shell.querySelector('#pdf-page-input'), 'inputmode', 'numeric');
      const navRow = shell.querySelector('.reader-nav-controls');
      for (const name of ['previous','next']) { const button = command(shell, name); if (button) button.innerHTML = icon(name); }
      // Keep the same bottom navigation / action dock order as PDF and DjVu.
      status?.before(shell.querySelector('.reader-commandbar'));
      const landscape = document.createElement('div'); landscape.className = 'ar-landscape-actions';
      landscape.innerHTML = [['chapters','contents','Contents'],['reader-notes','notes','Notes & Passages'],['display','view','View & reading']].map(([action, glyph, label]) => '<button type="button" data-ar-action="' + action + '" aria-label="' + label + '">' + icon(glyph) + '</button>').join('');
      navRow?.append(landscape);
      if (shell.dataset.arKind === 'txt') {
        command(shell, 'previous').hidden = true;
        command(shell, 'next').hidden = true;
        const textLabel = navRow?.querySelector('span');
        if (textLabel) textLabel.textContent = 'Text document · scroll to read';
        const progress = status?.querySelector('#reader-progress-label');
        if (progress && navRow) navRow.insertBefore(progress, landscape);
      }
    }
    // The container is now empty; leaving it in the header creates an extra row.
    if (headerActions && !headerActions.children.length) headerActions.remove();

    if (navigation) {
      navigation.querySelector('.am-reader-nav-close')?.remove();
      const heading = document.createElement('div'); heading.className = 'ar-panel-heading';
      heading.innerHTML = '<h2>' + (shell.dataset.arKind === 'txt' ? 'Browse document' : 'Chapters & bookmarks') + '</h2><button type="button" data-reader-command="navigation" aria-label="Close document navigation">' + icon('close') + '</button>';
      // Both the dock and this close button use the shared navigation command.
      navigation.prepend(heading);
      const chapterTab = navigation.querySelector('[data-reader-tab="contents"]');
      if (chapterTab) { chapterTab.textContent = shell.dataset.arKind === 'txt' ? 'Contents' : 'Chapters'; setAttribute(chapterTab, 'aria-label', shell.dataset.arKind === 'pdf' ? 'PDF chapter outline' : shell.dataset.arKind === 'djvu' ? 'DjVu chapter outline' : 'Book chapters'); }
      const bookmarkHelp = document.createElement('section'); bookmarkHelp.className = 'ar-bookmark-help'; bookmarkHelp.hidden = true;
      bookmarkHelp.innerHTML = '<button type="button" data-ar-action="add-bookmark">Bookmark this position</button><p>Tap the bookmark beside the title to save your place. Tap a saved bookmark to return. Use ✎ to rename or × to remove it.</p>';
      navigation.querySelector('.reader-nav-tabs')?.after(bookmarkHelp);
    }
    const scrim = document.createElement('button');
    scrim.type = 'button'; scrim.className = 'ar-panel-scrim am-reader-scrim';
    scrim.setAttribute('aria-label', 'Close reader panel');
    scrim.onclick = () => closePanels(shell);
    shell.querySelector('.reader-workspace-body')?.append(scrim);

    shell.addEventListener('click', event => {
      const returnToPassage = event.target.closest('[data-source-passage]');
      if (returnToPassage) {
        closePanels(shell);
        const sourceId = returnToPassage.dataset.sourcePassage;
        event.preventDefault(); event.stopImmediatePropagation();
        // Use the shared locator: it switches to the saved page/chapter, waits
        // for text to mount, normalizes the quote, and applies the source mark.
        if (typeof jumpToSavedSelection === 'function') void jumpToSavedSelection(sourceId);
        else notify('Passage navigation is unavailable. Reopen the source document.');
        return;
      }
      const ownAction = event.target.closest('[data-ar-action]')?.dataset.arAction;
      if(['reader-help','reader-comment','passage-board','extend-passage','reader-image'].includes(ownAction)){
        closeMenu(shell);
        if(ownAction==='reader-help')window.NotejectReaderMenu.showHelp();
        if(ownAction==='reader-comment'){readerWorkspace.openTools();readerSelections.captureComment();}
        if(ownAction==='passage-board'){readerWorkspace.openTools();readerSelections.showBoardTools();}
        if(ownAction==='extend-passage'){readerWorkspace.openTools();readerSelections.extendCurrentSelection();}
        if(ownAction==='reader-image')void readerWorkspace.run('capture-image');
        sync();return;
      }
      if (ownAction === 'chapters' || ownAction === 'bookmarks') { closeMenu(shell); browse(shell, ownAction === 'bookmarks' ? 'bookmarks' : 'contents'); sync(); return; }
      if (ownAction === 'add-bookmark') { closeMenu(shell); activate(shell, 'bookmark'); sync(); return; }
      if(ownAction==='reader-notes'){closeMenu(shell);readerSelections.showList();sync();return;}
      if (['reader-find','reader-save'].includes(ownAction)) { closeMenu(shell); activate(shell, { 'reader-find': 'find', 'reader-notes': 'tools', 'reader-save': 'save-selection' }[ownAction]); sync(); return; }
      if (ownAction === 'display') {
        closeMenu(shell);
        const open = !shell.classList.contains('ar-display-open');
        if (compact.matches && open) closePanels(shell);
        setDisplay(shell, open); return;
      }
      if (ownAction === 'close-display') { setDisplay(shell, false); return; }
      const name = event.target.closest('[data-reader-command]')?.dataset.readerCommand;
      if (name === 'navigation' && event.target.closest('.ar-reader-dock') && shell.classList.contains('nav-open')) shell.querySelector('[data-reader-tab="contents"]')?.click();
      if (name && !['zoom-down', 'zoom-up', 'zoom-reset', 'font-down', 'font-up', 'appearance-reset'].includes(name)) {
        if (name !== 'navigation' || shell.classList.contains('nav-open')) setDisplay(shell, false);
        if (!event.target.closest('summary')) closeMenu(shell);
      }
      if (compact.matches) {
        if ((name === 'navigation' || name === 'bookmark') && shell.classList.contains('nav-open')) closePanels(shell, 'navigation');
        if ((name === 'tools' || name === 'save-selection') && shell.classList.contains('tools-open')) closePanels(shell, 'tools');
        if (name === 'assistant' && shell.classList.contains('assistant-open')) closePanels(shell, 'assistant');
        if (event.target.closest('.reader-nav-panel [data-reader-chapter], .reader-nav-panel [data-reader-page-jump], .reader-nav-panel [data-reader-outline], .reader-nav-panel [data-reader-bookmark]')) {
          if (shell.classList.contains('nav-open')) activate(shell, 'navigation');
        }
      }
      sync();
    });

    // Start a phone on the page. A recovered passage draft remains open.
    if (compact.matches) {
      if (shell.classList.contains('nav-open')) activate(shell, 'navigation');
      if (!shell.querySelector('.clip-composer:not([hidden])')) closePanels(shell);
    }
    status?.querySelector('.reader-saved-status')?.setAttribute('aria-hidden', 'true');
    side?.setAttribute('tabindex', '-1');
  }

  function sync() {
    const shell = document.querySelector('#view .reader-shell');
    if (current !== shell) { currentCleanup?.(); currentCleanup = null; }
    if (!shell) { current = null; return; }
    current = shell;
    if (!shell.dataset.arReaderReady) setup(shell);
    const composing = !!shell.querySelector('.clip-composer:not([hidden])');
    setClass(shell, 'ar-composing', composing);
    const find = shell.querySelector('.reader-findbar');
    setAttribute(shell.querySelector('.ar-reader-dock [data-reader-command="find"]'), 'aria-pressed', find && !find.hidden);
    setAttribute(shell.querySelector('.ar-reader-dock [data-reader-command="navigation"]'), 'aria-pressed', shell.classList.contains('nav-open'));
    setAttribute(shell.querySelector('.ar-reader-dock [data-reader-command="tools"]'), 'aria-pressed', shell.classList.contains('tools-open'));
    if (composing && shell.classList.contains('tools-open') && compact.matches && shell.classList.contains('nav-open')) activate(shell, 'navigation');
    const controls = shell.querySelector('.reader-view-controls');
    if (controls && controls.children.length === 0) controls.hidden = true;
    const bookmarksOpen = shell.querySelector('[data-reader-tab="bookmarks"]')?.getAttribute('aria-selected') === 'true';
    const bookmarkHelp = shell.querySelector('.ar-bookmark-help');
    if (bookmarkHelp) bookmarkHelp.hidden = !bookmarksOpen;
    const filter = shell.querySelector('#reader-navigation-filter');
    if (filter && !bookmarksOpen && shell.querySelector('[data-reader-tab="contents"][aria-selected="true"]') && shell.dataset.arKind !== 'txt') {
      if (filter.placeholder !== 'Find a chapter…') filter.placeholder = 'Find a chapter…';
      setAttribute(filter, 'aria-label', 'Find a chapter');
    } else if (filter) setAttribute(filter, 'aria-label', bookmarksOpen ? 'Filter bookmarks' : 'Find a page');
    const bookmarked = shell.querySelector('.ar-bookmark')?.getAttribute('aria-pressed') === 'true';
    for (const button of shell.querySelectorAll('[data-ar-action="add-bookmark"]')) {
      setAttribute(button, 'aria-pressed', String(bookmarked));
      const label = bookmarked ? 'Remove bookmark' : 'Bookmark';
      const text = button.querySelector('span');
      if (text) { if (text.textContent !== label) text.textContent = label; }
      else if (button.textContent !== label) button.textContent = label;
    }
    const focused = shell.classList.contains('is-focused');
    if (focused) setDisplay(shell, false);
  }

  function handleBack() {
    const shell = current?.isConnected ? current : document.querySelector('#view .reader-shell');
    if (!shell) return false;
    const sheet = shell.querySelector('.ar-reader-sheet[open]');
    if (sheet) { sheet.close(); return true; }
    if (shell.classList.contains('is-focused')) { activate(shell, 'focus'); return true; }
    const popover = shell.querySelector('details[open]');
    if (popover) { popover.open = false; return true; }
    if (shell.classList.contains('ar-display-open')) { setDisplay(shell, false); return true; }
    const find = shell.querySelector('.reader-findbar:not([hidden])');
    if (find) { activate(shell, 'close-find'); return true; }
    if (shell.classList.contains('assistant-open')) { activate(shell, 'assistant'); return true; }
    if (shell.classList.contains('tools-open')) { activate(shell, 'tools'); return true; }
    if (shell.classList.contains('nav-open')) { activate(shell, 'navigation'); return true; }
    return false;
  }

  function getModal() {
    const shell = current?.isConnected ? current : null;
    if (!shell) return null;
    const sheet = shell.querySelector('.ar-reader-sheet[open]');
    if (sheet) return sheet;
    if (!compact.matches || shell.classList.contains('is-focused')) return null;
    if (shell.classList.contains('tools-open') || shell.classList.contains('assistant-open')) return shell.querySelector('.reader-side');
    if (shell.classList.contains('nav-open')) return shell.querySelector('.reader-navigation');
    return null;
  }

  document.addEventListener('click', event => {
    const shell = current?.isConnected ? current : null;
    if (!shell) return;
    for (const popover of shell.querySelectorAll('details[open]')) {
      if (!popover.contains(event.target)) popover.open = false;
    }
  });
  const resize = () => {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      if (current?.isConnected && compact.matches && current.classList.contains('nav-open') && current.matches('.tools-open,.assistant-open')) closePanels(current, current.classList.contains('tools-open') ? 'tools' : 'assistant');
      sync();
    });
  };
  compact.addEventListener('change', resize);
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('noteject:reader-focus', sync);
  window.NotejectAndroidReaderUI = Object.freeze({ sync, handleBack, getModal });
  sync();
})();
