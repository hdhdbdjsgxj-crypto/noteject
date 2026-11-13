/* Android navigation and touch controls. Loaded only by the Android asset build. */
(() => {
  'use strict';
  if (!window.NotejectAndroid) return;
  const body = document.body;
  const appElement = document.querySelector('.app');
  const main = document.querySelector('.main');
  const sidebar = document.querySelector('.sidebar');
  const content = document.getElementById('view');
  if (!appElement || !sidebar || !content) return;
  const sharedOpenWorkspaceView = window.openWorkspaceView;
  window.openWorkspaceView = function(target, options) {
    target = target === 'tasks' || target === 'templates' ? 'home' : target;
    if (target === 'recordings' && window.NotejectAndroidAudioUI?.open) return window.NotejectAndroidAudioUI.open();
    return sharedOpenWorkspaceView(target, options);
  };
  if (typeof settingsSection !== 'undefined' && !localStorage.getItem('noteject-settings-section')) {
    settingsSection = 'ai';
    localStorage.setItem('noteject-settings-section', 'ai');
  }
  const compact = matchMedia('(max-width: 959px)');
  let startupSession = null, startupRestored = false, lastSavedSession = '';
  try { startupSession = JSON.parse(localStorage.getItem('noteject-android-session-v1') || 'null'); } catch {}
  const icons = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    home: '<path d="m3 10 9-7 9 7v10H8V10h8v10"/>',
    notes: '<rect x="5" y="3" width="15" height="18" rx="3"/><path d="M3 7h4M3 12h4M3 17h4M11 8h5M11 12h5M11 16h3"/>',
    library: '<path d="M4 4v16M9 4v16M14 4v16m3-15 4 14M3 20h19"/>',
    boards: '<rect x="3" y="3" width="7" height="10" rx="2"/><rect x="14" y="3" width="7" height="6" rx="2"/><rect x="3" y="17" width="7" height="4" rx="1"/><rect x="14" y="13" width="7" height="8" rx="2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 17v-5m-3 3 3-3 3 3"/>',
    project: '<path d="M3 7h6l2-3h9a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 9h18"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  const header = document.createElement('header');
  header.className = 'am-header';
  header.innerHTML = `<div class="am-header-row"><button type="button" class="am-icon-button" data-am-menu aria-label="Open workspace menu" aria-controls="am-workspace-menu" aria-expanded="false">${icon('menu')}</button><button type="button" class="am-icon-button" data-am-back aria-label="Back" hidden>←</button><button type="button" class="am-heading" data-am-home aria-label="Go to Home"><span>noteject</span><strong id="am-page-title">Home</strong></button><button type="button" class="am-icon-button" data-am-search aria-label="Search workspace" aria-expanded="false">${icon('search')}</button></div><div class="am-search-row" hidden><label>${icon('search')}<input type="search" aria-label="Search notes, documents, and boards" placeholder="Search notes, documents, and boards…" autocomplete="off" enterkeyhint="search"></label><button type="button" class="am-icon-button" data-am-close-search aria-label="Close search">${icon('close')}</button></div>`;
  const bottom = document.createElement('nav');
  const heading = header.querySelector('.am-heading');
  const headingCopy = document.createElement('span'); headingCopy.className = 'am-heading-copy';
  headingCopy.append(...heading.childNodes);
  const brandLogo = document.createElement('img'); brandLogo.className = 'am-app-logo'; brandLogo.src = 'noteject-logo.png'; brandLogo.alt = ''; brandLogo.width = 38; brandLogo.height = 38;
  heading.append(brandLogo, headingCopy);
  const sidebarBrand = sidebar.querySelector('.brand-icon');
  if (sidebarBrand) { const logo = document.createElement('img'); logo.src = 'noteject-logo.png'; logo.alt = ''; logo.width = 30; logo.height = 30; sidebarBrand.replaceChildren(logo); }
  bottom.className = 'am-bottom-nav';
  bottom.setAttribute('aria-label', 'Main navigation');
  bottom.innerHTML = [['home', 'Home', 'home'], ['notes', 'All notes', 'notes'], ['recordings', 'Record', 'record'], ['boardIndex', 'Boards', 'boards'], ['more', 'Menu', 'menu']].map(([target, label, glyph]) => `<button type="button" data-am-view="${target}"><span class="am-nav-icon">${glyph === 'record' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>' : icon(glyph)}</span><span>${label}</span></button>`).join('');
  const scrim = document.createElement('button');
  scrim.type = 'button';
  scrim.className = 'am-drawer-scrim';
  scrim.setAttribute('aria-label', 'Close workspace menu');
  scrim.hidden = true;
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'am-fab';
  fab.setAttribute('aria-label', 'Create a note, project, board, or import files');
  fab.innerHTML = `${icon('plus')}<span>Create</span>`;
  const sheet = document.createElement('dialog');
  sheet.className = 'am-create-sheet';
  sheet.setAttribute('aria-labelledby', 'am-create-title');
  sheet.innerHTML = `<div class="am-sheet-handle" aria-hidden="true"></div><header><div><small>YOUR WORKSPACE</small><h2 id="am-create-title">What would you like to add?</h2></div><button type="button" class="am-icon-button" data-am-dismiss aria-label="Close Create menu">${icon('close')}</button></header>${[['new-note', 'notes', 'New note', 'Write an idea, list, or reading note'], ['import', 'file', 'Import files', 'Choose PDFs, books, photos, and more'], ['create-board', 'boards', 'New board', 'Connect notes and documents visually'], ['project', 'project', 'New project', 'Keep your notes and files together']].map(([action, glyph, title, description]) => `<button type="button" class="am-create-option" data-am-create="${action}"><span>${icon(glyph)}</span><span><strong>${title}</strong><small>${description}</small></span><b aria-hidden="true">›</b></button>`).join('')}`;
  body.prepend(header);
  const boardScrim = document.createElement('button');
  boardScrim.type = 'button'; boardScrim.className = 'am-board-scrim'; boardScrim.hidden = true;
  boardScrim.setAttribute('aria-label', 'Close board panel');
  boardScrim.onclick = () => {
    const close = content.querySelector('.board-document-panel:not([hidden]) .board-document-close');
    if (close) close.click(); else if (content.querySelector('.board-note-tray')) void action('toggle-note-tray');
  };
  body.append(bottom, scrim, fab, sheet);
  // The fullscreen canvas makes main a stacking context. Keep these backdrops
  // beside its panels so they cannot cover the controls they belong behind.
  main.append(boardScrim);
  const optionsScrim = document.createElement('button');
  optionsScrim.type = 'button'; optionsScrim.className = 'am-options-scrim'; optionsScrim.hidden = true;
  optionsScrim.setAttribute('aria-label', 'Close actions');
  optionsScrim.onclick = () => closeOptions(); main.append(optionsScrim);
  body.classList.add('android-app');
  sidebar.id = 'am-workspace-menu';
  sidebar.setAttribute('aria-label', 'Workspace menu');
  const drawerClose = document.createElement('button');
  drawerClose.type = 'button';
  drawerClose.className = 'am-drawer-close am-icon-button';
  drawerClose.setAttribute('aria-label', 'Close workspace menu');
  drawerClose.innerHTML = icon('close');
  sidebar.prepend(drawerClose);
  let drawerOpen = false, scheduled = false, moveCards = false, selectCards = false, fileSelectionMode = false, cardDrag = null, boardPanelInitialized = false;
  let suppressBoardClickUntil = 0;
  const cameraPointers = new Map();
  let cameraGesture = null, boardPanGesture = null;
  let boardTap = null, lastBoardTap = null, boardContextDialog = null;
  let boardGestureClickUntil = 0;
  const boardTouchPointers = new Set();
  let gestureSurface = null;
  let viewportBaseline = window.visualViewport?.height || innerHeight;
  let nativeKeyboardVisible = null;
  let activeModal = null, modalFocus = null, inertNodes = [], lastLocation = null;
  const navigationHistory = [];
  let restoringLocation = false;
  const toggleClass = (node, name, enabled) => { if (node.classList.contains(name) !== !!enabled) node.classList.toggle(name, !!enabled); };

  function setDrawer(open) {
    const drawerLayout = compact.matches;
    drawerOpen = !!open && drawerLayout;
    body.classList.toggle('am-menu-open', drawerOpen);
    scrim.hidden = !drawerOpen;
    sidebar.inert = drawerLayout && !drawerOpen;
    header.querySelector('[data-am-menu]').setAttribute('aria-expanded', String(drawerOpen));
    sidebar.setAttribute('aria-hidden', String(drawerLayout && !drawerOpen));
    if (drawerOpen) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
    }
    scheduleSync();
  }

  function navigate(target) {
    if (target === 'tasks' || target === 'templates') target = 'home';
    if (typeof view !== 'undefined' && view === 'recordings' && target !== 'recordings') {
      const retry = () => navigate(target);
      if (window.NotejectAndroidAudioUI?.beforeNavigate?.(retry)) return;
    }
    setDrawer(false);
    hideSearch(true);
    if (typeof openWorkspaceView === 'function') openWorkspaceView(target);
    else document.querySelector(`.nav-item[data-view="${target}"]`)?.click();
    window.scrollTo({ top: 0, behavior: 'instant' });
    sync();
  }

  function createNote(options = {}) {
    // The Notes helper preserves the old draft before it clears filters and renders.
    setDrawer(false); hideSearch(false);
    return window.NotejectAndroidNotesUI?.newNote(options);
  }

  function prepareNavigation() {
    const nav = sidebar.querySelector('.workspace-nav-scroll'), home = nav?.querySelector('[data-view="home"]'), notes = nav?.querySelector('[data-view="notes"]');
    if (!home || !notes) return;
    nav.querySelectorAll('[data-view="tasks"],[data-view="templates"]').forEach(entry => entry.remove());
    // Keep shared renderer targets outside the menu; project and board lists open
    // on their own pages instead of expanding inside workspace navigation.
    const boardList = document.getElementById('boards');
    if (boardList && nav.contains(boardList)) {
      let targets = document.getElementById('am-render-targets');
      if (!targets) { targets = document.createElement('div'); targets.id = 'am-render-targets'; targets.hidden = true; targets.inert = true; body.append(targets); }
      targets.append(boardList);
      const oldHeading = nav.querySelector('.nav-label.row'), add = oldHeading?.querySelector('#new-board');
      if (add) targets.append(add);
      oldHeading?.remove();
    }
    const ordered = [
      home,
      nav.querySelector('[data-aa-open]'),
      notes,
      nav.querySelector('[data-view="reading"]'),
      nav.querySelector('[data-view="projects"]'),
      nav.querySelector('[data-view="favorites"]'),
      nav.querySelector('[data-view="history"]'),
      nav.querySelector('[data-view="collections"]'),
      nav.querySelector('[data-view="boardIndex"]'),
      nav.querySelector('[data-view="graph"]'),
      nav.querySelector('[data-view="smart"]'),
      nav.querySelector('[data-view="inbox"]'),
      nav.querySelector('[data-view="library"]'),
      nav.querySelector('[data-view="trash"]')
    ].filter(Boolean);
    nav.querySelectorAll('.nav-label').forEach(label => label.remove());
    const smartCollection = nav.querySelector('[data-view="collections"]');
    if (smartCollection) {
      const label = [...smartCollection.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
      if (label) label.textContent = ' Smart collections';
    }
    nav.replaceChildren(...ordered);
    window.NotejectAndroidProjectsUI?.sync();
  }

  function hideSearch(clear) {
    const row = header.querySelector('.am-search-row');
    row.hidden = true;
    header.querySelector('[data-am-search]').setAttribute('aria-expanded', 'false');
    if (clear) {
      header.querySelector('input').value = '';
      const original = document.getElementById('search');
      if (original) { original.value = ''; original.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    header.querySelector('input').blur();
  }

  header.querySelector('[data-am-menu]').onclick = () => setDrawer(true);
  header.querySelector('[data-am-back]').onclick = () => handleBack();
  header.querySelector('[data-am-home]').onclick = () => navigate('home');
  header.querySelector('[data-am-search]').onclick = () => {
    header.querySelector('.am-search-row').hidden = false;
    header.querySelector('[data-am-search]').setAttribute('aria-expanded', 'true');
    header.querySelector('input').focus();
  };
  header.querySelector('[data-am-close-search]').onclick = () => hideSearch(true);
  header.querySelector('input').oninput = event => {
    const original = document.getElementById('search');
    if (original) { original.value = event.target.value; original.dispatchEvent(new Event('input', { bubbles: true })); }
  };
  header.querySelector('input').onkeydown = event => {
    if (event.key === 'Enter') event.target.blur();
  };
  bottom.onclick = event => {
    const button = event.target.closest('[data-am-view]');
    if (!button) return;
    if (button.dataset.amView === 'more') setDrawer(true);
    else navigate(button.dataset.amView);
  };
  scrim.onclick = drawerClose.onclick = () => setDrawer(false);
  sidebar.addEventListener('click', event => {
    if (event.target.closest('[data-view], [data-board], #open-settings, #brand-home')) { setDrawer(false); hideSearch(true); }
  });
  fab.onclick = () => { sheet.showModal(); scheduleSync(); };
  sheet.querySelector('[data-am-dismiss]').onclick = () => sheet.close();
  sheet.addEventListener('click', event => {
    if (event.target === sheet) { const rect = sheet.getBoundingClientRect(); if (event.clientY < rect.top || event.clientY > rect.bottom) sheet.close(); return; }
    const button = event.target.closest('[data-am-create]');
    if (!button) return;
    sheet.close();
    const task = button.dataset.amCreate;
    if (task === 'project') beginProjectSetup();
    else if (task === 'new-note') createNote();
    else void action(task);
  });

  function editorHasChanges() {
    const title = document.getElementById('edit-title'), editor = document.getElementById('edit-body');
    if (!editor || !title || typeof data === 'undefined') return false;
    const note = data.notes.find(item => item.id === data.selected?.id);
    if (!note) return false;
    const tags = document.getElementById('edit-note-tags')?.value.split(',').map(value => value.trim().replace(/^#/, '')).filter(Boolean) || [];
    return editor.value !== note.content || title.value !== note.title || document.getElementById('edit-note-color')?.value !== (note.color || 'violet') || document.getElementById('edit-note-folder')?.value !== (note.folder || 'Inbox') || tags.join(',') !== (note.tags || []).join(',');
  }

  // Keep interrupted edits recoverable without changing the explicit Save note action.
  function draftKey() { return data.selected?.type === 'note' ? 'noteject-android-note-draft-v1:' + data.selected.id : null; }
  function removeNoteDraft() { const key = draftKey(); if (key) { try { localStorage.removeItem(key); } catch {} } }
  let draftStorageWarning = false;
  function storeNoteDraft() {
    const editor = document.getElementById('edit-body'), key = draftKey();
    if (!editor || !key) return;
    if (!editorHasChanges()) {
      if (!content.querySelector('.am-draft-status button')) removeNoteDraft();
      return;
    }
    try {
      const values = {};
      for (const id of ['edit-title', 'edit-body', 'edit-note-color', 'edit-note-folder', 'edit-note-tags']) values[id] = document.getElementById(id)?.value || '';
      localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: Date.now(), values }));
      const status = content.querySelector('.am-draft-status');
      if (status && !status.querySelector('button')) status.textContent = 'Draft kept on this device · Save note to apply';
    } catch {
      if (!draftStorageWarning) { draftStorageWarning = true; notify('Draft storage is full. Save your note before closing it.'); }
    }
  }
  function prepareEditor() {
    const editor = document.getElementById('edit-body');
    if (!editor || editor.dataset.amDraftReady) return;
    editor.dataset.amDraftReady = 'true';
    const status = document.createElement('div'); status.className = 'am-draft-status'; status.setAttribute('role', 'status');
    status.textContent = 'Changes are kept as a draft until you save';
    content.querySelector('.edit-actions')?.before(status);
    let cached;
    try { cached = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch {}
    if (cached?.version === 1 && cached.values && Object.keys(cached.values).some(id => document.getElementById(id)?.value !== cached.values[id])) {
      status.textContent = 'An unfinished draft is available';
      const restore = document.createElement('button'), discard = document.createElement('button');
      restore.type = discard.type = 'button'; restore.textContent = 'Restore draft'; discard.textContent = 'Discard';
      discard.className = 'destructive-action';
      restore.onclick = () => {
        for (const [id, value] of Object.entries(cached.values)) {
          if (!['edit-title', 'edit-body', 'edit-note-color', 'edit-note-folder', 'edit-note-tags'].includes(id) || typeof value !== 'string') continue;
          const field = document.getElementById(id); if (!field) continue;
          if (field.tagName === 'SELECT' && ![...field.options].some(option => option.value === value)) continue;
          field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        status.replaceChildren(document.createTextNode('Draft restored · Save note to apply')); editor.focus();
      };
      discard.onclick = () => { removeNoteDraft(); status.replaceChildren(document.createTextNode('Changes are kept as a draft until you save')); };
      status.append(restore, discard);
    }
  }
  let noteDraftTimer = 0;
  document.addEventListener('input', event => {
    if (!event.target.closest('.detail-panel')) return;
    clearTimeout(noteDraftTimer); noteDraftTimer = setTimeout(storeNoteDraft, 250);
  });
  document.addEventListener('change', event => { if (event.target.closest('.detail-panel')) storeNoteDraft(); });
  window.addEventListener('pagehide', storeNoteDraft);
  document.addEventListener('visibilitychange', () => { if (document.hidden) storeNoteDraft(); });

  let replayNoteNavigation = false;
  document.addEventListener('click', async event => {
    if (replayNoteNavigation) { replayNoteNavigation = false; return; }
    storeNoteDraft();
    const fileRow = event.target.closest('.document-library.am-file-selecting [data-library-doc]');
    if (fileRow && !event.target.closest('button,input,select,label,a,details,summary')) {
      event.preventDefault(); event.stopImmediatePropagation(); fileRow.querySelector('[data-library-select]')?.click(); return;
    }
    if (event.target.closest('[data-action="connect"]')) { moveCards = false; selectCards = false; }
    if (performance.now() < suppressBoardClickUntil && event.target.closest('.canvas-card')) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const card = event.target.closest('.canvas-card[data-item]');
    if (selectCards && !connectMode && card && !event.target.closest('button,a,input,select')) {
      boardSelection.has(card.dataset.item) ? boardSelection.delete(card.dataset.item) : boardSelection.add(card.dataset.item);
      workspaceTools.refreshSelection(); scheduleSync(); event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const leavesEditor = event.target.closest('.detail-panel [data-action="close"], .detail-panel [data-action="cancel-edit"], [data-am-view]:not([data-am-view="more"]), [data-am-home], [data-view], [data-board], [data-open-board], #brand-home, #open-settings');
    if (leavesEditor && editorHasChanges()) {
      storeNoteDraft();
      event.preventDefault(); event.stopImmediatePropagation();
      const proceed = await window.NotejectDialogs.confirm('Close this note without saving? Your draft will be available when you edit it again.', { title: 'Leave note editor', confirmLabel: 'Leave without saving' });
      if (proceed) {
        replayNoteNavigation = true;
        event.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      return;
    }
    if (event.target.closest('.detail-panel [data-action="save-note"]')) {
      const key = draftKey(); clearTimeout(noteDraftTimer);
      // The shared Save handler runs after this capture listener. Keep the recovery
      // copy until the workspace metadata has actually reached persistent storage.
      queueMicrotask(() => {
        if (!key || (document.getElementById('edit-body') && editorHasChanges()) || !workspaceStore.flush()) return;
        try { localStorage.removeItem(key); } catch {}
      });
    }
  }, true);

  function closeReaderPanels(shell) {
    for (const [state, command] of [['assistant-open', 'assistant'], ['tools-open', 'tools'], ['nav-open', 'navigation']]) {
      const button = shell.querySelector(`[data-reader-command="${command}"]`);
      if (shell.classList.contains(state) && button) { button.click(); return !shell.classList.contains(state); }
    }
    return false;
  }

  function handleBack() {
    const inboxPicker = document.querySelector('dialog.ib-picker[open]');
    if (inboxPicker) { inboxPicker.close(); return true; }
    const inboxMenu = document.querySelector('[data-inbox-root] details[open]');
    if (inboxMenu) { inboxMenu.open = false; return true; }
    const uxDialog = document.querySelector('dialog.ux-dialog[open], dialog.note-picker[open]');
    if (uxDialog) { uxDialog.close(); return true; }
    if (boardContextDialog?.open) { boardContextDialog.close(); return true; }
    const confirmation = document.querySelector('.noteject-dialog-overlay .noteject-dialog-cancel');
    if (confirmation) { confirmation.click(); return true; }
    if (window.NotejectAndroidAudioUI?.handleBack()) return true;
    if (window.NotejectAndroidProjectsUI?.handleBack()) return true;
    if (sheet.open) { sheet.close(); return true; }
    if (drawerOpen) { setDrawer(false); return true; }
    const modalClose = document.querySelector('#connection-editor-overlay .connection-editor-close, #storage-folder-overlay [data-folder-cancel], #move-notes-overlay [data-note-move-cancel], #move-documents-overlay [data-move-cancel], #reader-note-overlay [data-reader-note-close], #command-menu-overlay .command-menu-close');
    if (modalClose) { modalClose.click(); return true; }
    if (closeOptions()) return true;
    if (view === 'board' && connectMode) { clearBoardConnectionMode(); render(); notify('Connection mode closed'); return true; }
    if (view === 'board' && (moveCards || selectCards)) { moveCards = false; selectCards = false; resetBoardTap(); sync(); return true; }
    if (window.NotejectAndroidCanvasUI?.handleBack()) return true;
    if (window.NotejectAndroidTouchSelection?.handleBack()) return true;
    if (window.NotejectAndroidNotesUI?.closeTransient()) return true;
    const panel = content.querySelector('.detail-panel');
    if (panel) { panel.querySelector('[data-action="close"]')?.click(); return true; }
    const boardFiles = content.querySelector('.board-document-panel:not([hidden])');
    if (boardFiles) { boardFiles.querySelector('.board-document-close')?.click(); return true; }
    if (content.querySelector('.board-note-tray')) { void action('toggle-note-tray'); return true; }
    const shell = content.querySelector('.reader-shell');
    if (shell) {
      if (shell.classList.contains('tools-open') && shell.querySelector('.reader-backlinks')) { shell.querySelector('[data-reader-command="tools"]')?.click(); return true; }
      if (window.NotejectAndroidReaderUI?.handleBack()) return true;
      const popover = shell.querySelector('details[open]');
      if (popover) { popover.open = false; return true; }
      const find = shell.querySelector('.reader-findbar:not([hidden])');
      if (find) { find.querySelector('[data-reader-command="close-find"]')?.click(); return true; }
      if (closeReaderPanels(shell)) return true;
      shell.querySelector('[data-reader-command="back"]')?.click(); return true;
    }
    if (!header.querySelector('.am-search-row').hidden) { hideSearch(true); return true; }
    if (typeof view !== 'undefined' && view !== 'home') {
      let previous = navigationHistory.pop();
      while (previous && (previous.view === 'reader' || (previous.view === view && (view !== 'board' || previous.boardId === activeBoard()?.id)))) previous = navigationHistory.pop();
      restoringLocation = true;
      if (previous?.boardId) data.activeBoard = previous.boardId;
      navigate(previous?.view || 'home'); return true;
    }
    return false;
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && handleBack()) { event.preventDefault(); event.stopImmediatePropagation(); }
    if (event.key === 'Tab' && activeModal) {
      const controls = [...activeModal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]')].filter(element => element.getClientRects().length && !element.closest('[hidden]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); activeModal.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !activeModal.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !activeModal.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  }, true);

  function prepareReader(shell) {
    if (window.NotejectAndroidReaderUI) return;
    if (!shell || shell.dataset.amReady) return;
    shell.dataset.amReady = 'true';
    const saveSelection = shell.querySelector('.reader-save-selection');
    if (saveSelection && compact.matches) {
      saveSelection.textContent = '✎ Save';
      saveSelection.setAttribute('aria-label', 'Save current text selection as a note');
    }
    shell.querySelector('.reader-appearance-panel')?.closest('details')?.querySelector('summary')?.setAttribute('aria-label', 'Reading appearance');
    if (compact.matches) {
      // Bound the work: an unavailable shared handler must not freeze the app.
      for (let i = 0; i < 3 && closeReaderPanels(shell); i++) { /* Show the document first. */ }
    }
    const navigation = shell.querySelector('.reader-navigation');
    if (navigation) {
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'am-reader-nav-close';
      close.innerHTML = `${icon('close')}<span>Close contents</span>`;
      close.onclick = () => shell.querySelector('[data-reader-command="navigation"]')?.click();
      navigation.prepend(close);
    }
    const backdrop = document.createElement('button');
    backdrop.type = 'button'; backdrop.className = 'am-reader-scrim';
    backdrop.setAttribute('aria-label', 'Close reader panel');
    backdrop.onclick = () => closeReaderPanels(shell);
    shell.querySelector('.reader-workspace-body')?.append(backdrop);
  }

  document.addEventListener('click', event => {
    if (!compact.matches || window.NotejectAndroidReaderUI) return;
    const shell = content.querySelector('.reader-shell');
    if (!shell) return;
    const command = event.target.closest('[data-reader-command]')?.dataset.readerCommand;
    if (command === 'navigation' && shell.classList.contains('nav-open')) {
      if (shell.classList.contains('tools-open')) shell.querySelector('[data-reader-command="tools"]')?.click();
      if (shell.classList.contains('assistant-open')) shell.querySelector('[data-reader-command="assistant"]')?.click();
    } else if (['tools', 'assistant', 'save-selection'].includes(command) && (shell.classList.contains('tools-open') || shell.classList.contains('assistant-open')) && shell.classList.contains('nav-open')) {
      shell.querySelector('[data-reader-command="navigation"]')?.click();
    }
    if (event.target.closest('.reader-nav-panel [data-reader-chapter], .reader-nav-panel [data-reader-page-jump], .reader-nav-panel [data-reader-outline], .reader-nav-panel [data-reader-bookmark]') && shell.classList.contains('nav-open')) {
      shell.querySelector('[data-reader-command="navigation"]')?.click();
    }
  });

  function prepareBoard() {
    const canvas = content.querySelector('.canvas');
    if (!canvas || typeof view === 'undefined' || view !== 'board') return;
    canvas.style.touchAction = 'none';
    // The isolated canvas traps a fixed tray below the panel backdrop and also
    // lets canvas gestures capture touches intended for the note picker.
    const tray = canvas.querySelector('.board-note-tray'), workspace = content.querySelector('.board-workspace');
    if (tray && workspace) workspace.append(tray);
    if (compact.matches && !boardPanelInitialized) {
      boardPanelInitialized = true;
      content.querySelector('.board-document-panel:not([hidden]) .board-document-close')?.click();
      document.getElementById('toggle-board-documents')?.blur();
      const actions = content.querySelector('.board-page-head .buttons');
      if (actions) actions.scrollLeft = 0;
    }
    prepareBoardMenus();
    const firstIdea = canvas.querySelector('.welcome [data-action="new-idea"]');
    if (firstIdea && !firstIdea.dataset.amPrepared) {
      firstIdea.dataset.amPrepared = 'true';
      firstIdea.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        const add = content.querySelector('.am-board-add-menu');
        if (add) {
          closeOptions(add);
          add.setAttribute('open', ''); add.querySelector('.am-options-trigger')?.setAttribute('aria-expanded', 'true'); scheduleSync();
        }
      };
    }
    let tools = content.querySelector('.am-board-tools');
    if (!tools) {
      tools = document.createElement('div'); tools.className = 'am-board-tools';
      tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Touch board controls');
      tools.innerHTML = '<button type="button" data-am-board="pan" aria-pressed="true">Browse</button><button type="button" data-am-board="select" aria-pressed="false">Select</button><button type="button" data-am-board="move" aria-pressed="false">Move cards</button><span class="am-board-count" aria-live="polite"></span><button type="button" data-am-board="open" disabled>Open ↗</button>';
      (content.querySelector('.board-workspace') || canvas).before(tools);
      tools.onclick = event => {
        const command = event.target.closest('[data-am-board]')?.dataset.amBoard;
        if (command === 'open') { const selected = [...boardSelection][0]; if (selected) openBoardItem(selected); }
        else if (command) {
          moveCards = command === 'move'; selectCards = command === 'select';
          if (connectMode) { connectMode = false; connectFrom = null; render(); }
          sync();
        }
      };
    }
    tools.querySelector('[data-am-board="pan"]').setAttribute('aria-pressed', String(!moveCards && !selectCards));
    tools.querySelector('[data-am-board="select"]').setAttribute('aria-pressed', String(selectCards));
    tools.querySelector('[data-am-board="move"]').setAttribute('aria-pressed', String(moveCards));
    tools.querySelector('[data-am-board="open"]').disabled = boardSelection.size !== 1;
    const count = tools.querySelector('.am-board-count'), text = boardSelection.size ? boardSelection.size + ' selected' : '';
    if (count.textContent !== text) count.textContent = text;
    content.querySelectorAll('.canvas-card').forEach(card => { card.draggable = false; });
    canvas.setAttribute('aria-label', 'Board. Tap a card to select, double tap to open, or hold then drag to move cards. Drag empty space to browse and pinch to zoom. Double tap empty space to create a note.');
  }

  const boardGestureControls = 'button,a,input,select,textarea,label,summary,details,[contenteditable="true"],.mindmap-edge,[data-edit-edge],.canvas-controls,.board-minimap,.board-search-tools,.board-selection-tools,.board-document-panel,.board-note-tray';
  function boardPoint(canvas, x, y) {
    const rect = canvas.getBoundingClientRect(), zoom = Number(activeBoard()?.zoom) || 1;
    return { x: Math.max(40, (x - rect.left + canvas.scrollLeft) / zoom), y: Math.max(40, (y - rect.top + canvas.scrollTop) / zoom) };
  }
  function resetBoardTap(clearPrevious = true) {
    if (boardTap) clearTimeout(boardTap.timer);
    boardTap = null;
    if (clearPrevious) lastBoardTap = null;
  }
  function selectBoardCards(ids, mode = 'browse') {
    const previousSuppression = suppressBoardClickUntil;
    window.NotejectAndroidTouchSelection?.exit();
    suppressBoardClickUntil = previousSuppression;
    boardSelection = new Set(ids); selectCards = mode === 'select'; moveCards = mode === 'move';
    workspaceTools.refreshSelection(); scheduleSync();
  }
  function setBoardSelectionMode(mode) {
    if (view !== 'board' || !boardSelection.size) return;
    moveCards = mode === 'move'; selectCards = mode === 'select';
    connectMode = false; connectFrom = null;
    body.classList.toggle('am-board-moving', moveCards);
    workspaceTools.refreshSelection(); scheduleSync();
    window.NotejectAndroidTouchSelection?.sync();
  }
  function startCardDrag(card, pointer) {
    const board = activeBoard(), item = board?.items.find(entry => entry.id === card?.dataset.item);
    if (view !== 'board' || !item || !card.isConnected || cameraGesture || cardDrag) return false;
    if (!boardSelection.has(item.id)) boardSelection = new Set([item.id]);
    const ids = new Set(window.NotejectBoardScene.groupSelection(board, boardSelection));
    boardSelection = ids; workspaceTools.refreshSelection();
    const nodes = new Map([...content.querySelectorAll('.canvas-card')].map(node => [node.dataset.item, node]));
    const items = board.items.filter(entry => ids.has(entry.id)).map(entry => ({ item: entry, left: entry.x, top: entry.y, node: nodes.get(entry.id) }));
    // Capture before committing the handoff. An expired pointer must never leave
    // a drag active after the user's finger has lifted.
    try { card.setPointerCapture(pointer.pointerId); } catch { return false; }
    boardPanGesture = null; resetBoardTap();
    cardDrag = { pointerId: pointer.pointerId, card, board, items, x: pointer.clientX, y: pointer.clientY, moved: false, zoom: Number(board.zoom) || 1 };
    return true;
  }
  function startBoardHoldMove(itemId, pointer) {
    const card = content.querySelector('.canvas-card[data-item="' + CSS.escape(itemId) + '"]');
    if (!card || !cameraPointers.has(pointer.pointerId) || boardTouchPointers.size !== 1) return false;
    setBoardSelectionMode('move');
    return startCardDrag(card, pointer);
  }
  function openTouchBoardItem(itemId) {
    const item = activeBoard()?.items.find(entry => entry.id === itemId);
    if (item?.type === 'note') window.NotejectAndroidNotesUI?.editNote(item.id, { keepContext: true });
    else if (item) openBoardItem(item.id);
  }
  async function copyBoardText(text) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } } catch {}
    const previous = document.activeElement, field = document.createElement('textarea');
    field.value = text; field.readOnly = true; field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0'; document.body.append(field);
    let copied = false;
    try { field.focus({ preventScroll: true }); field.select(); copied = document.execCommand('copy'); }
    finally { field.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }
    if (!copied) throw Error('Clipboard is unavailable. Open the note to copy its text.');
  }
  function createTouchBoardNote(point) {
    const board = activeBoard(); if (view !== 'board' || !board) return;
    const folder = board.folder || data.workspace?.projects?.find(project => project.boardIds?.includes(board.id))?.folder || 'Inbox';
    const note = { id: id(), title: 'Untitled note', content: '', folder, tags: [], color: 'violet', favorite: false, archived: false, created: Date.now(), updated: Date.now() };
    data.notes.unshift(note);
    for (const key of ['folders', 'noteFolders']) { data[key] ||= ['Inbox']; if (!data[key].includes(folder)) data[key].push(folder); }
    board.items.push({ type: 'note', id: note.id, ...boardAssetPosition(board, boardAssetOrigin(board, point)) });
    boardSelection = new Set([note.id]); selectCards = false; moveCards = false; save(); render();
    window.NotejectAndroidNotesUI?.editNote(note.id, { keepContext: true });
    void persistWorkspaceNote(note).catch(error => notify('Note kept in Noteject; project file could not be written: ' + error.message));
  }
  function showBoardGroups() {
    if (view !== 'board' || document.querySelector('dialog[open],.noteject-dialog-overlay,.detail-panel')) return;
    const board = activeBoard(), workspace = data, chosen = [...boardSelection]; closeOptions();
    const dialog = document.createElement('dialog'); dialog.className = 'am-board-context am-board-groups';
    dialog.setAttribute('aria-label', 'Board groups');
    const groups = board.groups || [];
    dialog.innerHTML = '<header><h2>Groups</h2><button type="button" data-group-action="close" aria-label="Close Groups">×</button></header><p>Select a group to choose all its cards, or move the group together.</p>' + groups.map(group => '<section class="am-group-row"><button type="button" data-group-action="select" data-group-id="' + esc(group.id) + '"><strong>' + esc(group.name) + '</strong><small>' + board.items.filter(item => item.groupId === group.id || group.itemIds?.includes(item.id)).length + ' cards · Select group</small></button><div>' + ['move','add','rename','ungroup'].map(action => '<button type="button" data-group-action="' + action + '" data-group-id="' + esc(group.id) + '"' + (action === 'add' && !chosen.length ? ' disabled' : '') + '>' + ({move:'Move group',add:'Add selected',rename:'Rename',ungroup:'Ungroup'}[action]) + '</button>').join('') + '</div></section>').join('') + (!groups.length ? '<p>No groups yet. Select two or more cards to create one.</p>' : '') + '<button type="button" data-group-action="create"' + (chosen.length < 2 ? ' disabled' : '') + '>Create group from selection</button>';
    dialog.addEventListener('click', async event => {
      const button = event.target.closest('[data-group-action]'); if (!button) return;
      const command = button.dataset.groupAction; dialog.close();
      if (command === 'close' || data !== workspace || activeBoard() !== board) return;
      if (command === 'create') { selectBoardCards(chosen, 'select'); await action('board-group-selection'); return; }
      const group = board.groups?.find(item => item.id === button.dataset.groupId); if (!group) return;
      const ids = board.items.filter(item => item.groupId === group.id || group.itemIds?.includes(item.id)).map(item => item.id);
      if (command === 'select' || command === 'move') { selectBoardCards(ids, command === 'move' ? 'move' : 'select'); boardView.revealItems(ids); notify(command === 'move' ? 'Drag any selected card to move this group' : ids.length + ' group cards selected'); return; }
      if (command === 'rename') {
        const name = await window.NotejectDialogs.prompt('Group name', group.name, { title: 'Rename group', input: { maxLength: 100 } });
        if (!name?.trim() || data !== workspace || activeBoard() !== board || !board.groups.includes(group)) return;
        group.name = name.trim().slice(0,100);
      } else if (command === 'ungroup') {
        board.items.forEach(item => { if (item.groupId === group.id) delete item.groupId; });
        board.groups = board.groups.filter(item => item !== group);
      } else if (command === 'add') {
        const selected = new Set(chosen.filter(id => board.items.some(item => item.id === id)));
        board.groups = board.groups.map(item => item === group ? item : { ...item, itemIds: (item.itemIds || []).filter(id => !selected.has(id)) }).filter(item => item === group || item.itemIds.length);
        board.items.forEach(item => { if (selected.has(item.id)) item.groupId = group.id; });
        group.itemIds = [...new Set([...ids, ...selected])];
      }
      save(); render();
    });
    dialog.addEventListener('close', () => { if (boardContextDialog === dialog) boardContextDialog = null; dialog.remove(); scheduleSync(); }, { once: true });
    document.body.append(dialog); boardContextDialog = dialog; dialog.showModal(); dialog.querySelector('button')?.focus();
  }
  function organizeBoardMenu(menu) {
    if (menu.dataset.amOrganized) return;
    menu.dataset.amOrganized = 'true';
    const sections = new Map();
    for (const [key, title] of [['selection','Selected cards & groups'],['navigate','Camera & browse'],['layout','Arrange assets'],['history','Undo & redo'],['board','Board settings']]) {
      const section = document.createElement('section'); section.className = 'am-board-menu-section'; section.dataset.amBoardSection = key;
      const heading = document.createElement('h3'); heading.textContent = title; section.append(heading); sections.set(key, section);
    }
    for (const control of [...menu.children]) {
      if (control.matches('header')) continue;
      const action = control.dataset.action;
      const key = control.matches('[data-board-undo],[data-board-redo],.am-history-status') ? 'history' : control.matches('[data-am-groups],[data-am-selection-actions],[data-am-edit-connections],[data-board-select-all]') || action === 'connect' ? 'selection' : control.matches('[data-board-view-menu]') ? 'navigate' : control.matches('select,[data-am-organize]') ? 'layout' : control.matches('.board-view-options,[data-board-asset-browser],[data-action="zoom-fit"]') || /Fit assets/i.test(control.textContent) ? 'navigate' : 'board';
      sections.get(key).append(control);
    }
    menu.append(...sections.values());
  }
  function showBoardContext(itemId, point = null) {
    if (view !== 'board' || !activeBoard() || document.querySelector('.noteject-dialog-overlay,dialog[open],.detail-panel')) return;
    const board = activeBoard(), item = board.items.find(entry => entry.id === itemId);
    if (itemId && !item) return;
    if (item && !boardSelection.has(item.id)) { boardSelection = new Set([item.id]); workspaceTools.refreshSelection(); }
    const ids = [...boardSelection], single = ids.length === 1 ? board.items.find(entry => entry.id === ids[0]) : null;
    const record = single && (single.type === 'note' ? data.notes : data.docs).find(entry => entry.id === single.id);
    if (item) selectBoardCards(ids);
    closeOptions();
    const dialog = document.createElement('dialog'); dialog.className = 'am-board-context'; dialog.setAttribute('aria-labelledby', 'am-board-context-title');
    const heading = document.createElement('header'), title = document.createElement('h2'), dismiss = document.createElement('button');
    title.id = 'am-board-context-title'; title.textContent = item ? (ids.length > 1 ? ids.length + ' cards selected' : record?.title || record?.name || 'Card actions') : 'Add to this Board';
    dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Close Board actions'); dismiss.onclick = () => dialog.close();
    heading.append(title, dismiss); dialog.append(heading);
    let actions;
    const section = label => {
      const group = document.createElement('section'); group.className = 'am-card-action-section';
      const heading = document.createElement('h3'); heading.textContent = label;
      actions = document.createElement('div'); actions.className = 'am-board-context-actions';
      group.append(heading, actions); dialog.append(group);
    };
    const command = (label, run, disabled = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = disabled;
      button.onclick = async () => {
        dialog.close();
        if (view !== 'board' || activeBoard()?.id !== board.id) return;
        try { await run(); } catch (error) { notify(error.message || 'Could not perform this Board action'); }
      };
      actions.append(button); return button;
    };
    if (item) {
      const selectedCards = board.items.filter(entry => ids.includes(entry.id));
      const records = selectedCards.map(entry => (entry.type === 'note' ? data.notes : data.docs).find(record => record.id === entry.id)).filter(Boolean);
      const allFavorite = records.length > 0 && records.every(record => record.favorite);
      const hasConnections = (board.edges || []).some(edge => ids.includes(edge.from) || ids.includes(edge.to));
      const hasGroups = selectedCards.some(entry => entry.groupId || (board.groups || []).some(group => group.itemIds?.includes(entry.id)));
      section('Open & selection');
      command(single?.type === 'note' ? 'Edit note' : 'Open file', () => openTouchBoardItem(single.id), !single);
      command('Select more cards', () => { window.NotejectAndroidTouchSelection?.selectBoard(item.id); scheduleSync(); notify('Tap cards to add or remove them from the selection'); });
      command('Move selected cards', () => { selectBoardCards(ids, 'move'); notify('Drag a selected card to move the selection'); });
      section('Connections');
      command(ids.length > 1 ? 'Connect selected cards' : 'Connect to another card', () => { selectBoardCards(ids); return beginBoardConnection(true); });
      command('Edit connections', () => connectionEditor.openList(ids), !hasConnections);
      section('Groups & layout');
      command('Move group', () => { selectBoardCards(window.NotejectBoardScene.groupSelection(board, ids), 'move'); notify('Drag any selected card to move its whole group'); }, !hasGroups);
      command('Group selected cards', () => action('board-group-selection'), ids.length < 2);
      command('Choose a group', showBoardGroups);
      command('Ungroup cards', () => action('board-ungroup-selection'), !hasGroups);
      command('Arrange selected in grid', () => workspaceTools.arrangeSelection('grid'), ids.length < 2);
      section('Notes & files');
      command(allFavorite ? 'Remove from Favorites' : 'Add to Favorites', () => {
        records.forEach(record => { record.favorite = !allFavorite; }); save();
        notify(allFavorite ? 'Removed from Favorites' : 'Added to Favorites');
      }, !records.length);
      command('Rename', async () => {
        const workspace = data;
        const value = await window.NotejectDialogs.prompt(single.type === 'note' ? 'Rename note' : 'Rename file', record.title || record.name, { title: 'Rename selected object' });
        if (data !== workspace || activeBoard() !== board || !board.items.some(entry => entry.id === single.id) || !value?.trim()) return;
        if (single.type === 'note') { record.title = value.trim().slice(0,160); record.updated = Date.now(); save(); render(); await persistWorkspaceNote(record); notify('Note renamed'); }
        else await renameDocument(single.id, value.trim());
      }, !single || !record);
      command('Copy names', async () => { await copyBoardText(records.map(record => record.title || record.name || 'Untitled').join('\n')); notify('Names copied'); }, !records.length);
      command('Copy note text', async () => {
        const notes = selectedCards.filter(entry => entry.type === 'note').map(entry => data.notes.find(note => note.id === entry.id)).filter(Boolean);
        await copyBoardText(notes.map(note => note.content || '').join('\n\n')); notify('Note text copied');
      }, !selectedCards.some(entry => entry.type === 'note'));
      command('Duplicate notes', () => workspaceTools.duplicateNotes(), !board.items.some(entry => ids.includes(entry.id) && entry.type === 'note'));
      section('Remove cards');
      command('Remove from Board', () => action('board-delete-selection')).classList.add('am-board-context-remove');
      const palette = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = 'Card color'; palette.append(legend);
      for (const tint of nodeTints) {
        const color = document.createElement('button'); color.type = 'button'; color.dataset.tint = tint; color.textContent = tint[0].toUpperCase() + tint.slice(1);
        color.onclick = () => { dialog.close(); if (view === 'board' && activeBoard() === board) colorSelectedBoardNotes(tint, ids); }; palette.append(color);
      }
      dialog.append(palette);
      const help = document.createElement('p'); help.textContent = 'Removing cards keeps their original notes and files in your library.'; dialog.append(help);
    } else {
      section('Add to Board');
      command('New note here', () => createTouchBoardNote(point));
      command('Add existing notes', () => action('toggle-note-tray'));
      command('Add existing files', () => content.querySelector('#toggle-board-documents')?.click());
      command('Fit Board', () => boardView.fit());
    }
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { if (boardContextDialog === dialog) boardContextDialog = null; suppressBoardClickUntil = 0; boardGestureClickUntil = performance.now() + 250; resetBoardTap(); dialog.remove(); scheduleSync(); }, { once: true });
    document.body.append(dialog); boardContextDialog = dialog; dialog.showModal(); dismiss.focus({ preventScroll: true });
  }
  // Track complete touch sequences at window capture, before camera/drag handlers.
  window.addEventListener('pointerdown', event => {
    if (!['touch', 'pen'].includes(event.pointerType)) { resetBoardTap(); return; }
    boardTouchPointers.add(event.pointerId);
    if (boardTouchPointers.size !== 1) { resetBoardTap(); return; }
    const canvas = event.target.closest('.canvas');
    if (view !== 'board' || !canvas || !event.isPrimary || event.target.closest(boardGestureControls) || document.querySelector('dialog[open],.detail-panel')) { resetBoardTap(); return; }
    const card = event.target.closest('.canvas-card[data-item]');
    resetBoardTap(false);
    boardTap = { pointerId: event.pointerId, canvas, boardId: activeBoard().id, itemId: card?.dataset.item || '', x: event.clientX, y: event.clientY, started: performance.now(), point: boardPoint(canvas, event.clientX, event.clientY), held: false, timer: 0 };
    if (!card) {
      const pending = boardTap;
      pending.timer = setTimeout(() => { if (boardTap === pending && boardTouchPointers.size === 1) { pending.held = true; lastBoardTap = null; try { navigator.vibrate?.(18); } catch {} } }, 520);
    }
  }, { capture: true, passive: true });
  window.addEventListener('pointermove', event => {
    if (boardTap?.pointerId === event.pointerId && Math.hypot(event.clientX - boardTap.x, event.clientY - boardTap.y) >= 8) resetBoardTap();
  }, { capture: true, passive: true });
  function finishBoardTap(event) {
    boardTouchPointers.delete(event.pointerId);
    if (boardTap?.pointerId !== event.pointerId) return;
    const tap = boardTap; resetBoardTap(false);
    const now = performance.now();
    if (event.type === 'pointercancel' || !tap.canvas.isConnected || view !== 'board' || activeBoard()?.id !== tap.boardId || cameraGesture || boardTouchPointers.size) { lastBoardTap = null; return; }
    if (tap.held) { suppressBoardClickUntil = now + 600; requestAnimationFrame(() => { if (view === 'board' && activeBoard()?.id === tap.boardId) showBoardContext(null, tap.point); }); return; }
    if (now - tap.started >= 520 || performance.now() < suppressBoardClickUntil || cardDrag?.moved || boardPanGesture?.moved) { lastBoardTap = null; return; }
    const double = lastBoardTap && lastBoardTap.boardId === tap.boardId && lastBoardTap.itemId === tap.itemId && now - lastBoardTap.at < 360 && Math.hypot(tap.x - lastBoardTap.x, tap.y - lastBoardTap.y) < 24;
    lastBoardTap = { boardId: tap.boardId, itemId: tap.itemId, x: tap.x, y: tap.y, at: now };
    boardGestureClickUntil = now + 650;
    if (tap.itemId) {
      if (connectMode) { lastBoardTap = null; void connectCards(tap.itemId); }
      else if (double && !moveCards && !selectCards) { lastBoardTap = null; suppressBoardClickUntil = now + 600; openTouchBoardItem(tap.itemId); }
      else {
        if (selectCards) boardSelection.has(tap.itemId) ? boardSelection.delete(tap.itemId) : boardSelection.add(tap.itemId);
        else if (!moveCards || !boardSelection.has(tap.itemId)) boardSelection = new Set([tap.itemId]);
        workspaceTools.refreshSelection(); scheduleSync();
      }
    } else if (double && !connectMode && !moveCards && !selectCards) {
      lastBoardTap = null; suppressBoardClickUntil = now + 600; createTouchBoardNote(tap.point);
    } else if (!connectMode) { const leavingMode = moveCards || selectCards; selectBoardCards([]); if (leavingMode) lastBoardTap = null; }
  }
  window.addEventListener('pointerup', finishBoardTap, { capture: true, passive: true });
  window.addEventListener('pointercancel', finishBoardTap, { capture: true, passive: true });
  window.addEventListener('click', event => {
    if (event.isTrusted && performance.now() < Math.max(suppressBoardClickUntil, boardGestureClickUntil) && event.target.closest('.canvas') && !event.target.closest(boardGestureControls)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('dblclick', event => {
    if (event.isTrusted && performance.now() < Math.max(suppressBoardClickUntil, boardGestureClickUntil) && event.target.closest('.canvas') && !event.target.closest(boardGestureControls)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);

  function graphZoomAt(next, centerX, centerY, deltaX = 0, deltaY = 0) {
    const svg = content.querySelector('.graph-canvas'), world = content.querySelector('.graph-world');
    if (!svg || !world || typeof graphZoom !== 'number' || typeof graphClientPoint !== 'function') return;
    const rect = svg.getBoundingClientRect(), box = graphViewSize(svg), scale = Math.min(rect.width / box.width, rect.height / box.height);
    if (!scale) return;
    const point = graphClientPoint({ clientX: centerX, clientY: centerY }, svg);
    const zoom = Math.max(.05, Math.min(4, next)), ratio = zoom / graphZoom;
    graphPan = { x: point.x - (point.x - graphPan.x) * ratio + deltaX / scale, y: point.y - (point.y - graphPan.y) * ratio + deltaY / scale };
    graphZoom = zoom; world.setAttribute('transform', graphTransform());
    const label = content.querySelector('.graph-zoom-tools span');
    if (label) label.textContent = Math.round(graphZoom * 100) + '%';
  }
  document.addEventListener('click', event => {
    if (performance.now() < suppressBoardClickUntil && event.target.closest('.canvas-card')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  function cameraPointerDown(event) {
    if (event.pointerType === 'mouse') return;
    const board = event.target.closest('.canvas'), graph = event.target.closest('.graph-canvas-wrap');
    const target = board ? 'board' : graph ? 'graph' : '';
    if (!target || event.target.closest('.canvas-controls,.board-search-tools,.board-selection-tools,.board-minimap,.graph-zoom-tools,.graph-legend,.mindmap-edge,[data-edit-edge],button,a,input,select,textarea,[contenteditable="true"]')) return;
    const point = { id: event.pointerId, target, x: event.clientX, y: event.clientY };
    cameraPointers.set(event.pointerId, point);
    const active = [...cameraPointers.values()].filter(item => item.target === target);
    if (cameraGesture?.target === target || active.length >= 2) {
      if (!cameraGesture) {
        const [first, second] = active;
        const centerX = (first.x + second.x) / 2, centerY = (first.y + second.y) / 2;
        cameraGesture = { target, ids: [first.id, second.id], distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)), x: centerX, y: centerY };
        if (target === 'board') {
          boardPanGesture = null; suppressBoardClickUntil = performance.now() + 600;
          if (cardDrag) endCardDrag({ pointerId: cardDrag.pointerId, type: 'pointercancel' });
        } else {
          const svg = content.querySelector('.graph-canvas');
          svg?.onpointercancel?.({ pointerId: first.id });
        }
      }
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    if (target === 'board' && (!event.target.closest('.canvas-card') || !moveCards)) {
      const canvas = board;
      boardPanGesture = { id: event.pointerId, canvas, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop, moved: false };
      if (!event.target.closest('.canvas-card')) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
  }
  document.addEventListener('pointerdown', cameraPointerDown, true);
  function cameraPointerMove(event) {
    const point = cameraPointers.get(event.pointerId);
    if (point) { point.x = event.clientX; point.y = event.clientY; }
    if (cameraGesture?.ids.includes(event.pointerId)) {
      const [first, second] = cameraGesture.ids.map(id => cameraPointers.get(id));
      if (first && second) {
        const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
        const centerX = (first.x + second.x) / 2, centerY = (first.y + second.y) / 2;
        if (cameraGesture.target === 'board') {
          const canvas = content.querySelector('.canvas'), rect = canvas?.getBoundingClientRect();
          if (canvas && rect) {
            const zoom = Number(activeBoard()?.zoom) || 1;
            boardView.zoom(zoom * distance / cameraGesture.distance, { x: centerX - rect.left, y: centerY - rect.top });
            canvas.scrollLeft -= centerX - cameraGesture.x; canvas.scrollTop -= centerY - cameraGesture.y;
          }
        } else graphZoomAt(graphZoom * distance / cameraGesture.distance, centerX, centerY, centerX - cameraGesture.x, centerY - cameraGesture.y);
        cameraGesture.distance = distance; cameraGesture.x = centerX; cameraGesture.y = centerY;
      }
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    if (boardPanGesture?.id === event.pointerId) {
      if (!boardPanGesture.moved && Math.hypot(event.clientX - boardPanGesture.x, event.clientY - boardPanGesture.y) < 8) return;
      boardPanGesture.moved = true; suppressBoardClickUntil = performance.now() + 350;
      try { if (!boardPanGesture.canvas.hasPointerCapture(event.pointerId)) boardPanGesture.canvas.setPointerCapture(event.pointerId); } catch {}
      boardPanGesture.canvas.scrollLeft = boardPanGesture.left - (event.clientX - boardPanGesture.x);
      boardPanGesture.canvas.scrollTop = boardPanGesture.top - (event.clientY - boardPanGesture.y);
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  document.addEventListener('pointermove', cameraPointerMove, true);
  function cameraPointerEnd(event) {
    const pointer = cameraPointers.get(event.pointerId);
    if (cameraGesture?.ids.includes(event.pointerId)) {
      if (cameraGesture.target === 'graph') {
        const svg = content.querySelector('.graph-canvas');
        cameraGesture.ids.forEach(id => svg?.onpointercancel?.({ pointerId: id }));
      } else if (cardDrag) endCardDrag({ pointerId: cardDrag.pointerId, type: 'pointercancel' });
      cameraPointers.delete(event.pointerId);
      if (cameraGesture.ids.every(id => !cameraPointers.has(id))) cameraGesture = null;
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    if (boardPanGesture?.id === event.pointerId) {
      const moved = boardPanGesture.moved;
      boardPanGesture = null;
      if (moved) { suppressBoardClickUntil = performance.now() + 350; event.preventDefault(); event.stopImmediatePropagation(); }
    }
    if (pointer) cameraPointers.delete(event.pointerId);
  }
  document.addEventListener('pointerup', cameraPointerEnd, true);
  document.addEventListener('pointercancel', cameraPointerEnd, true);

  document.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') {
      const card = event.target.closest('.canvas-card[data-item]'); if (card) card.draggable = true;
      return;
    }
    if (event.pointerType === 'mouse' || !event.target.closest('.canvas-world') || event.target.closest('button,a,input,select,textarea,[data-edit-edge]')) return;
    // Preserve native two-axis scrolling. The shared desktop marquee handler captures
    // empty-canvas touches and prevents Android from starting a scroll gesture.
    event.stopImmediatePropagation();
    const card = event.target.closest('.canvas-card[data-item]');
    if (!moveCards || !card || !event.isPrimary) return;
    startCardDrag(card, event);
  }, true);
  document.addEventListener('pointermove', event => {
    if (!cardDrag || cardDrag.pointerId !== event.pointerId) return;
    const drag = cardDrag, dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    const offsetX = Math.max(dx / drag.zoom, -Math.min(...drag.items.map(entry => entry.left)));
    const offsetY = Math.max(dy / drag.zoom, -Math.min(...drag.items.map(entry => entry.top)));
    for (const entry of drag.items) {
      entry.item.x = entry.left + offsetX; entry.item.y = entry.top + offsetY;
      if (entry.node) { entry.node.style.left = entry.item.x + 'px'; entry.node.style.top = entry.item.y + 'px'; }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  function endCardDrag(event) {
    if (!cardDrag || cardDrag.pointerId !== event.pointerId) return;
    const drag = cardDrag; cardDrag = null;
    try { if (drag.card.hasPointerCapture(drag.pointerId)) drag.card.releasePointerCapture(drag.pointerId); } catch {}
    if (event.type === 'pointercancel' || !drag.card.isConnected || activeBoard()?.id !== drag.board.id) {
      for (const entry of drag.items) {
        entry.item.x = entry.left; entry.item.y = entry.top;
        if (entry.node) { entry.node.style.left = entry.left + 'px'; entry.node.style.top = entry.top + 'px'; }
      }
    } else if (drag.moved) {
      suppressBoardClickUntil = performance.now() + 350;
      const boardId = activeBoard().id;
      save();
      // Let Android finish the touch sequence before replacing its captured card.
      requestAnimationFrame(() => { if (view === 'board' && activeBoard().id === boardId) render(); });
    }
  }
  document.addEventListener('pointerup', endCardDrag, true);
  document.addEventListener('pointercancel', endCardDrag, true);

  function resetTouchGestures() {
    resetBoardTap(); boardTouchPointers.clear();
    if (boardContextDialog?.open) boardContextDialog.close();
    const pan = boardPanGesture, moving = cardDrag;
    const hadGesture = !!(pan || moving || cameraGesture || cameraPointers.size);
    if (moving) endCardDrag({ pointerId: moving.pointerId, type: 'pointercancel' });
    if (pan) { try { if (pan.canvas.hasPointerCapture(pan.id)) pan.canvas.releasePointerCapture(pan.id); } catch {} }
    if (moving) { try { if (moving.card.hasPointerCapture(moving.pointerId)) moving.card.releasePointerCapture(moving.pointerId); } catch {} }
    const graph = gestureSurface?.matches('.graph-canvas-wrap') ? gestureSurface.querySelector('.graph-canvas') : null;
    for (const point of cameraPointers.values()) if (point.target === 'graph') graph?.onpointercancel?.({ pointerId: point.id });
    cameraPointers.clear(); cameraGesture = null; boardPanGesture = null;
    if (hadGesture) suppressBoardClickUntil = performance.now() + 350;
  }
  window.addEventListener('blur', resetTouchGestures);
  window.addEventListener('orientationchange', resetTouchGestures);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetTouchGestures(); });

  function closeOptions(except = null) {
    const open = [...content.querySelectorAll('.am-options[open], .am-canvas-options[open]')].filter(menu => menu !== except);
    for (const details of open) {
      // Removing the attribute works for both native details and button menus.
      details.removeAttribute('open');
      details.querySelector(':scope > summary, :scope > .am-options-trigger')?.setAttribute('aria-expanded', 'false');
    }
    if (open.length) scheduleSync();
    return open.length > 0;
  }
  function makeOptions(label, title, controls) {
    const details = document.createElement('details'); details.className = 'am-options';
    const summary = document.createElement('summary'); summary.textContent = label; summary.setAttribute('aria-label', title);
    summary.onclick = event => {
      // Explicitly toggle disclosure menus on Android touch. Some WebView builds
      // miss the native <summary> activation after canvas pointer handling.
      event.preventDefault(); event.stopPropagation();
      const next = !details.open;
      if (next) closeOptions(details);
      details.open = next;
      summary.setAttribute('aria-expanded', String(next));
      scheduleSync();
    };
    const menu = document.createElement('section'); menu.className = 'am-options-menu'; menu.setAttribute('aria-label', title);
    const heading = document.createElement('header'), name = document.createElement('h2'), close = document.createElement('button');
    name.textContent = title; close.type = 'button'; close.textContent = '×'; close.className = 'am-icon-button'; close.setAttribute('aria-label', 'Close ' + title);
    close.onclick = event => { event.stopPropagation(); details.open = false; summary.focus({ preventScroll: true }); };
    heading.append(name, close); menu.append(heading, ...controls); details.append(summary, menu);
    menu.addEventListener('click', event => {
      const control = event.target.closest('button,input,select,label,a,summary');
      if (!control) { event.stopPropagation(); return; }
      if (control.matches('button') && control !== close) requestAnimationFrame(() => { if (details.isConnected) details.open = false; });
    });
    details.addEventListener('toggle', () => {
      if (details.open) {
        summary.setAttribute('aria-expanded', 'true');
        closeOptions(details);
      } else summary.setAttribute('aria-expanded', 'false');
      scheduleSync();
    });
    return details;
  }
  function makeBoardActionMenu(label, title, controls) {
    const menuRoot = document.createElement('div'); menuRoot.className = 'am-options am-board-action-menu';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'am-options-trigger';
    trigger.textContent = label; trigger.setAttribute('aria-label', title); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('section'); menu.className = 'am-options-menu'; menu.setAttribute('aria-label', title);
    const heading = document.createElement('header'), name = document.createElement('h2'), close = document.createElement('button');
    name.textContent = title; close.type = 'button'; close.textContent = '×'; close.className = 'am-icon-button'; close.setAttribute('aria-label', 'Close ' + title);
    heading.append(name, close); menu.append(heading, ...controls); menuRoot.append(trigger, menu);
    const closeMenu = (restoreFocus = false) => {
      menuRoot.removeAttribute('open'); trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus({ preventScroll: true });
      scheduleSync();
    };
    trigger.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      const next = !menuRoot.hasAttribute('open');
      closeOptions(menuRoot);
      menuRoot.toggleAttribute('open', next); trigger.setAttribute('aria-expanded', String(next));
      scheduleSync();
    };
    close.onclick = event => { event.preventDefault(); event.stopPropagation(); closeMenu(true); };
    menu.addEventListener('click', event => {
      const control = event.target.closest('button,input,select,label,a,summary');
      if (!control) { event.stopPropagation(); return; }
      // Close before the action opens another panel or the native file picker.
      if (control !== close && control.matches('button')) closeMenu();
    }, true);
    return menuRoot;
  }
  function prepareBoardMenus() {
    const actions = content.querySelector('.board-page-head .buttons'), toolbar = content.querySelector('.board-toolstrip');
    const gallery = content.querySelector('.board-gallery');
    if (gallery && !gallery.dataset.amBoardManageReady) {
      gallery.dataset.amBoardManageReady = 'true';
      gallery.addEventListener('click', async event => {
        const rename = event.target.closest('[data-am-board-rename]');
        if (rename) {
          event.preventDefault(); event.stopImmediatePropagation();
          const board = data.boards.find(item => item.id === rename.dataset.amBoardRename); if (!board) return;
          const name = await window.NotejectDialogs.prompt('Choose a name for this board.', board.name, { title: 'Rename board', input: { label: 'Board name', maxLength: 100 } });
          if (!name?.trim()) return;
          board.name = name.trim(); save(); render(); return;
        }
        const remove = event.target.closest('[data-am-board-delete]'); if (!remove) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const boardId = remove.dataset.amBoardDelete, board = data.boards.find(item => item.id === boardId);
        if (!board) return;
        deleteBoard(boardId);
      }, true);
    }
    const manageGalleryCard = card => {
      const boardId = card?.querySelector('[data-gallery-open]')?.dataset.galleryOpen;
      if (boardId && !card.querySelector('.am-gallery-manage')) {
        const menu = document.createElement('details'); menu.className = 'am-gallery-manage';
        const summary = document.createElement('summary'); summary.textContent = '⋯'; summary.setAttribute('aria-label', 'Board actions');
        const actions = document.createElement('div'); actions.className = 'am-gallery-board-actions';
        const rename = document.createElement('button'); rename.type = 'button'; rename.dataset.amBoardRename = boardId; rename.textContent = 'Rename board';
        const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.amBoardDelete = boardId; remove.textContent = 'Delete board'; remove.className = 'am-danger-action';
        actions.append(rename, remove); menu.append(summary, actions);
        menu.setAttribute('aria-label', 'Actions for ' + (card.querySelector('.board-gallery-card-heading b')?.textContent || 'board'));
        card.append(menu);
      }
    };
    gallery?.querySelectorAll('.board-gallery-card').forEach(card => {
      manageGalleryCard(card);
    });
    if (gallery && !gallery.dataset.amBoardCardObserver) {
      gallery.dataset.amBoardCardObserver = 'true';
      new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => { if (node instanceof Element) { if (node.matches('.board-gallery-card')) manageGalleryCard(node); node.querySelectorAll?.('.board-gallery-card').forEach(manageGalleryCard); } }))).observe(gallery, { childList: true, subtree: true });
    }
    if (!actions) return;
    const add = [], manage = [];
    if (!actions.dataset.amPrepared) for (const control of [...actions.children]) {
      const name = control.dataset.action;
      if (['new-note', 'import', 'toggle-note-tray'].includes(name) || control.id === 'toggle-board-documents') add.push(control);
      else if (name === 'export-board') manage.push(control);
      else if (!control.hasAttribute('data-board-focus')) manage.push(control);
      else control.hidden = true;
    }
    if (!actions.dataset.amPrepared && toolbar) for (const control of [...toolbar.children]) {
      if (control.matches('.board-search-tools,.canvas-controls')) continue;
      if (control.matches('.board-toolstrip-count')) { control.hidden = true; continue; }
      manage.push(control);
    }
    if (!actions.dataset.amPrepared) {
      const addMenu = makeBoardActionMenu('＋ Add', 'Add to this board', add), toolsMenu = makeBoardActionMenu('⋯ Board', 'Board tools', manage);
      addMenu.classList.add('am-board-add-menu'); actions.append(addMenu, toolsMenu); actions.dataset.amPrepared = 'true';
    }
    const toolsMenu = actions.querySelector('.am-board-action-menu:not(.am-board-add-menu)');
    if (toolsMenu) {
      const menu = toolsMenu.querySelector('.am-options-menu');
      if (menu && !menu.querySelector('[data-am-groups]')) {
        const groups = document.createElement('button'); groups.type = 'button'; groups.dataset.amGroups = 'true'; groups.onclick = showBoardGroups;
        const selected = document.createElement('button'); selected.type = 'button'; selected.dataset.amSelectionActions = 'true'; selected.textContent = 'Actions for selected cards'; selected.onclick = () => { const id = [...boardSelection][0]; if (id) showBoardContext(id); };
        const connections = document.createElement('button'); connections.type = 'button'; connections.dataset.amEditConnections = 'true'; connections.textContent = 'Edit connections'; connections.onclick = () => connectionEditor.openList();
        const organize = menu.querySelector('[data-action="zoom-overview"]') || document.createElement('button'); organize.type = 'button'; organize.dataset.amOrganize = 'true'; organize.textContent = 'Organize all'; organize.onclick = () => { boardView.organizeAtStart(); notify('All cards organized in a centered, zoomed-out overview'); };
        menu.append(selected, groups, connections, organize);
      }
      if (menu) {
        const groups = menu.querySelector('[data-am-groups]'), selected = menu.querySelector('[data-am-selection-actions]'), connections = menu.querySelector('[data-am-edit-connections]');
        const label = 'Groups · ' + (activeBoard().groups || []).length;
        if (groups.textContent !== label) groups.textContent = label;
        if (selected.disabled !== !boardSelection.size) selected.disabled = !boardSelection.size;
        if (connections.disabled !== !activeBoard().edges?.length) connections.disabled = !activeBoard().edges?.length;
      }
      // These shared controls retain WorkspaceTools' history across renders.
      // A second history and DOM observer here reset undo and observed their own
      // button updates repeatedly, preventing the WebView from handling taps.
      const undo = toolsMenu.querySelector('[data-board-undo]'), redo = toolsMenu.querySelector('[data-board-redo]');
      if (undo && !undo.dataset.amUndo) undo.dataset.amUndo = 'true';
      if (redo && !redo.dataset.amRedo) redo.dataset.amRedo = 'true';
      let status = toolsMenu.querySelector('.am-history-status');
      if (!status) {
        status = document.createElement('small'); status.className = 'am-history-status';
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'am-danger-action'; remove.dataset.amDeleteBoard = 'true'; remove.textContent = 'Delete board';
        remove.onclick = async () => { const board = activeBoard(); if (board) await deleteBoard(board.id); };
        toolsMenu.querySelector('.am-options-menu')?.append(status, remove);
      }
      const historyLabel = (!undo || undo.disabled) && (!redo || redo.disabled) ? 'No board changes to undo' : 'Board history';
      if (status.textContent !== historyLabel) status.textContent = historyLabel;
      if (menu) organizeBoardMenu(menu);
    }
    if (toolbar) toolbar.classList.add('am-board-camera');
  }
  function prepareLibrary() {
    const library = content.querySelector('.document-library'); if (!library) return;
    const headActions = library.querySelector('.document-library-head .buttons');
    const importButton = headActions?.querySelector('[data-library-action="import"]');
    if (importButton) {
      const label = window.NotejectI18n?.t?.('＋ Import files') || '＋ Import files';
      if (importButton.textContent !== label) importButton.textContent = label;
    }
    if (headActions && !headActions.querySelector('[data-am-select-files]')) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'secondary'; toggle.dataset.amSelectFiles = 'true';
      toggle.onclick = () => {
        fileSelectionMode = !fileSelectionMode;
        if (!fileSelectionMode) library.querySelector('[data-library-clear-selection]')?.click();
        sync();
      };
      headActions.append(toggle);
      const newProject = headActions.querySelector('[data-library-action="new-folder"]');
      if (newProject) library.querySelector('.document-library-controls')?.append(newProject);
    }
    if (selectedDocs.size) fileSelectionMode = true;
    toggleClass(library, 'am-file-selecting', fileSelectionMode);
    const selectionToggle = headActions?.querySelector('[data-am-select-files]');
    if (selectionToggle) { const text = fileSelectionMode ? 'Done' : 'Select'; if (selectionToggle.textContent !== text) selectionToggle.textContent = text; selectionToggle.setAttribute('aria-pressed', String(fileSelectionMode)); }
    const reset = library.querySelector('[data-library-reset]');
    if (reset) {
      const clean = libraryFolder === 'All documents' && libraryType === 'all' && !libraryFavorites && (!librarySmart || librarySmart === 'all') && !libraryTag && !library.querySelector('.document-library-search')?.value;
      if (reset.hidden !== clean) reset.hidden = clean;
    }
    for (const row of library.querySelectorAll('[data-library-doc]:not([data-am-file])')) {
      row.dataset.amFile = 'true'; row.draggable = false;
      const actions = row.querySelector('.document-card-actions'), info = row.querySelector('.document-card-info');
      if (info) {
        info.tabIndex = 0; info.setAttribute('role', 'button'); info.setAttribute('aria-label', 'Open ' + (row.querySelector('.document-name')?.textContent || 'file'));
        info.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); row.querySelector(fileSelectionMode ? '[data-library-select]' : '[data-library-open]')?.click(); } };
      }
      if (!actions) continue;
      const rest = [...actions.children].filter(node => !node.hasAttribute('data-library-open'));
      const move = row.querySelector('[data-library-move]');
      if (move) { move.textContent = 'Move to project'; rest.push(move); }
      const favorite = row.querySelector('.doc-favorite');
      if (favorite) { favorite.textContent = favorite.getAttribute('aria-pressed') === 'true' ? 'Remove from favorites' : 'Add to favorites'; rest.push(favorite); }
      for (const control of rest) {
        if (control.hasAttribute('data-library-rename')) control.textContent = 'Rename file';
        if (control.hasAttribute('data-library-tags')) control.textContent = 'Edit tags';
        if (control.hasAttribute('data-library-delete')) control.textContent = 'Move to Trash';
        if (control.hasAttribute('data-library-read-toggle')) control.textContent = control.title.includes('unread') ? 'Mark unread' : 'Mark read';
      }
      const options = makeOptions('⋯', row.querySelector('.document-name')?.textContent || 'File actions', rest);
      actions.append(options);
    }
    const bulk = library.querySelector('.document-selection-bar');
    if (bulk && !bulk.dataset.amPrepared) {
      bulk.dataset.amPrepared = 'true';
      const controls = [...bulk.children].filter(node => !node.matches('label,[data-library-selection-count]'));
      const menu = makeOptions('Actions', 'Organize selected files', controls); menu.classList.add('am-bulk-options'); bulk.append(menu);
    }
  }
  function prepareHome() {
    if (view !== 'home' || content.querySelector('.am-home-dashboard')) return;
    const section = document.createElement('section'); section.className = 'am-home-dashboard';
    const recentDocs = [...data.docs].sort((a, b) => (b.lastOpened || b.added || 0) - (a.lastOpened || a.added || 0)).slice(0, 3);
    const recentNotes = [...data.notes].filter(note => !note.archived).sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 3);
    const favorites = window.NotejectWorkspaceOrganizer.model.favorites(data).slice(0, 4);
    const lastProjects = window.NotejectWorkspaceOrganizer.model.recentProjects(data, 4);
    const item = (kind, id, title, subtitle, glyph) => `<button type="button" class="am-recent-item" data-am-item="${esc(id)}" data-am-kind="${kind}"><span class="am-item-glyph am-kind-${kind}">${icon(glyph)}</span><span><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span><b aria-hidden="true">›</b></button>`;
    section.innerHTML = `<div class="am-home-intro"><p class="am-kicker">YOUR SPACE, ON THIS DEVICE</p><h1>A place for<br>your next idea.</h1><p>Read, write, and connect what matters.</p></div><div class="am-quick-actions"><button type="button" data-am-do="new-note">${icon('notes')}<strong>Write a note</strong><small>Capture a thought</small></button><button type="button" data-am-do="import">${icon('file')}<strong>Import files</strong><small>Books, PDFs & more</small></button></div><div class="am-home-counts"><button type="button" data-am-go="notes"><b>${data.notes.length}</b><span>Notes</span></button><button type="button" data-am-go="library"><b>${data.docs.length}</b><span>Files</span></button><button type="button" data-am-go="projects"><b>${new Set([...(data.folders || []), ...(data.noteFolders || [])].filter(name => name !== 'Inbox')).size}</b><span>Projects</span></button></div><section class="am-home-section"><header><h2>Continue reading</h2><button type="button" data-am-go="library">All files →</button></header><div class="am-recent-list">${recentDocs.length ? recentDocs.map(doc => item('document', doc.id, doc.name, (doc.type || 'file').toUpperCase() + ' · ' + (doc.folder || 'Inbox') + (Number(doc.readerProgress) > 0 ? ' · ' + Math.round(doc.readerProgress * 100) + '% read' : ''), 'file')).join('') : '<p class="am-empty-copy">Import a book or PDF to begin. Your reading position is kept automatically.</p>'}</div></section><section class="am-home-section"><header><h2>Recent notes</h2><button type="button" data-am-go="notes">All notes →</button></header><div class="am-recent-list">${recentNotes.length ? recentNotes.map(note => item('note', note.id, note.title || 'Untitled note', note.folder || 'Inbox', 'notes')).join('') : '<p class="am-empty-copy">Start with an idea, a checklist, or a passage from your reading.</p>'}</div></section><section class="am-home-section"><header><h2>Your boards</h2><button type="button" data-am-go="boardIndex">See all →</button></header><div class="am-home-boards">${data.boards.slice(0, 4).map(board => `<button type="button" data-am-item="${esc(board.id)}" data-am-kind="board">${icon('boards')}<strong>${esc(board.name)}</strong><small>${board.items.length} cards</small></button>`).join('') || '<button type="button" data-am-do="create-board">＋ Create your first board</button>'}</div></section>`;
    const homeSections = [...section.querySelectorAll('.am-home-section')];
    const favoritesSection = document.createElement('section'); favoritesSection.className = 'am-home-section am-home-favorites';
    favoritesSection.innerHTML = `<header><h2>Favorites</h2><button type="button" data-am-go="favorites">All favorites →</button></header><div class="am-recent-list">${favorites.length ? favorites.map(entry => item(entry.kind, entry.id, entry.title, (entry.kind === 'highlight' ? 'Passage' : entry.kind === 'board' ? 'Board' : entry.kind === 'document' ? (entry.fileType || 'File').toUpperCase() : 'Note') + (entry.folder ? ' · ' + entry.folder : ''), entry.kind === 'board' ? 'boards' : entry.kind === 'document' ? 'file' : 'notes')).join('') : '<p class="am-empty-copy">Star notes, passages, files, or Boards to keep them close.</p>'}</div>`;
    homeSections[0].after(favoritesSection);
    const projectsSection = document.createElement('section'); projectsSection.className = 'am-home-section am-home-last-projects';
    projectsSection.innerHTML = `<header><h2>Last Projects</h2><button type="button" data-am-go="projects">All projects →</button></header><div class="am-recent-list">${lastProjects.length ? lastProjects.map(project => `<button type="button" class="am-recent-item" data-am-project="${esc(project.folder)}"><span class="am-item-glyph am-kind-project">${icon('boards')}</span><span><strong>${esc(project.name)}</strong><small>${project.noteCount} notes · ${project.documentCount} files · ${project.boardCount} Boards</small></span><b aria-hidden="true">›</b></button>`).join('') : '<p class="am-empty-copy">Create a project to group your notes, sources, and Boards.</p>'}</div>`;
    homeSections[1].after(projectsSection);
    section.onclick = event => {
      const go = event.target.closest('[data-am-go]'), task = event.target.closest('[data-am-do]'), record = event.target.closest('[data-am-item]');
      const project = event.target.closest('[data-am-project]');
      if (project) openWorkspaceView('projects', { folder: project.dataset.amProject });
      else if (go) navigate(go.dataset.amGo);
      else if (task?.dataset.amDo === 'new-note') createNote();
      else if (task) void action(task.dataset.amDo);
      else if (record) openWorkspaceItem({ kind: record.dataset.amKind, id: record.dataset.amItem });
    };
    const record = document.createElement('button'); record.type = 'button'; record.className = 'am-home-record'; record.dataset.aaOpen = 'true';
    record.innerHTML = '<span class="am-record-orb" aria-hidden="true">●</span><span><strong>Record a new idea</strong><small>Audio → text → note · up to 120 minutes</small></span><b aria-hidden="true">›</b>';
    section.querySelector('.am-home-intro').after(record);
    section.querySelector('[data-am-do="new-note"] strong').textContent = 'New note';
    const setupKey = 'noteject-android-install-ready-v1';
    let setupDone = false;
    try { setupDone = localStorage.getItem(setupKey) === '1'; } catch {}
    const hasWorkspace = data.notes.length > 0 || data.docs.length > 0 || data.boards.some(board => board.items?.length);
    if (hasWorkspace && !setupDone) { try { localStorage.setItem(setupKey, '1'); setupDone = true; } catch {} }
    if (!setupDone) {
      const setup = document.createElement('section'); setup.className = 'am-install-setup';
      setup.innerHTML = '<div><span class="am-kicker">GETTING STARTED</span><h2>Set up Noteject</h2><p>Bring a workspace from Noteject on desktop or another phone, or start with a fresh workspace.</p></div><div class="am-install-actions"><button type="button" data-am-setup-import>Import workspace</button><button type="button" data-am-setup-start>Start fresh</button></div>';
      setup.querySelector('[data-am-setup-import]').onclick = () => chooseWorkspaceBackup();
      setup.querySelector('[data-am-setup-start]').onclick = () => { try { localStorage.setItem(setupKey, '1'); } catch {} setup.remove(); notify('Noteject is ready'); };
      section.prepend(setup);
    }
    content.prepend(section);
  }

  const overlaySelector = '#connection-editor-overlay, #storage-folder-overlay, #move-notes-overlay, #move-documents-overlay, #reader-note-overlay, #command-menu-overlay';
  function syncModal() {
    const overlays = [...document.querySelectorAll(overlaySelector)].filter(node => node.getClientRects().length);
    const shell = content.querySelector('.reader-shell');
    const optionModal = content.querySelector('.am-options[open] > .am-options-menu');
    // Native HTML dialogs already own focus and background inertness. Applying
    // our panel trap would leave the next Reader command inert until a frame later.
    const modal = document.querySelector('.noteject-dialog-overlay .noteject-dialog') || ((document.querySelector('dialog.ux-dialog[open], dialog.note-picker[open]') || shell?.querySelector('dialog.ar-reader-sheet[open]')) ? null : window.NotejectAndroidNotesUI?.getModal?.() || window.NotejectAndroidProjectsUI?.getModal() || (sheet.open ? sheet : overlays.at(-1)?.querySelector('[role="dialog"]') || overlays.at(-1) || (drawerOpen ? sidebar : optionModal || window.NotejectAndroidCanvasUI?.getModal() || window.NotejectAndroidReaderUI?.getModal() || (compact.matches ? content.querySelector('.detail-panel') || (shell?.classList.contains('nav-open') ? shell.querySelector('.reader-navigation') : shell?.matches('.tools-open,.assistant-open') ? shell.querySelector('.reader-side') : null) || content.querySelector('.board-document-panel:not([hidden]), .board-note-tray') : null))));
    if (modal === activeModal) return;
    for (const [node, previous] of inertNodes) node.inert = previous;
    inertNodes = [];
    const previousModal = activeModal; activeModal = modal;
    if (previousModal?.dataset.amModal === 'true') { previousModal.removeAttribute('aria-modal'); previousModal.removeAttribute('role'); delete previousModal.dataset.amModal; }
    if (!modal) {
      if (modalFocus?.isConnected && !modalFocus.closest('[hidden],[inert]')) modalFocus.focus({ preventScroll: true });
      modalFocus = null; return;
    }
    if (!previousModal) modalFocus = document.activeElement;
    if (!modal.hasAttribute('role') || modal.matches('.reader-navigation')) { modal.dataset.amModal = 'true'; modal.setAttribute('role', 'dialog'); }
    modal.setAttribute('aria-modal', 'true');
    if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
    if (!modal.hasAttribute('aria-label') && !modal.hasAttribute('aria-labelledby')) modal.setAttribute('aria-label', modal.matches('.board-note-tray') ? 'Add notes to board' : modal.matches('.board-document-panel') ? 'Add documents to board' : 'Note');
    let node = modal;
    while (node && node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.matches('script,style,link,.am-drawer-scrim,.am-reader-scrim,.am-board-scrim,.am-options-scrim')) continue;
        // Shared dialogs also manage inert. Restore only nodes changed here.
        if (!sibling.inert) { inertNodes.push([sibling, false]); sibling.inert = true; }
      }
      node = node.parentElement; if (node === body) break;
    }
    if (!modal.contains(document.activeElement) && modal !== sheet) {
      const focus = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].find(element => element.getClientRects().length && !element.closest('[hidden]'));
      (focus || modal).focus({ preventScroll: true });
    }
  }

  const labels = { home: 'Home', notes: 'All notes', recordings: 'Record', library: 'Documents', boardIndex: 'Boards', projects: 'Projects', reading: 'Reading queue', inbox: 'Inbox', settings: 'Settings', favorites: 'Favorites', collections: 'Smart collections', history: 'History', graph: 'Graph View', smart: 'Smart Engine', trash: 'Trash', search: 'Search' };
  function prepareSettings() {
    const tabs = content.querySelector('.settings-menu-nav');
    const shortcuts = content.querySelector('.shortcut-groups');
    if (shortcuts) {
      const card = shortcuts.closest('.settings-card');
      if (card) {
        card.classList.add('am-touch-guide');
        const title = card.querySelector('h2');
        const intro = card.querySelector('p');
        if (title) title.textContent = 'Using noteject on Android';
        if (intro) intro.textContent = 'A quick guide to touch controls and reading on your device.';
        let help = card.querySelector('.am-touch-help');
        if (!help) {
          help = document.createElement('div'); help.className = 'am-touch-help';
          shortcuts.before(help);
        }
        help.innerHTML = window.NotejectWorkspaceUX.androidHelp();
        // Desktop key combinations do not apply to the Android touch interface.
        shortcuts.remove();
        card.querySelector('.am-keyboard-help')?.remove();
      }
    }
    content.querySelectorAll('.settings-card p, .model-faq p, .settings-note span').forEach(paragraph => {
      if (paragraph.textContent.includes('beside Noteject.exe')) paragraph.textContent = 'Project notes and imported files stay in this app’s private storage. Export a portable backup before moving to another device.';
      else if (paragraph.textContent.includes('this browser on this device')) paragraph.textContent = 'Notes, boards, and files stay in Noteject on this Android device. Export a portable backup to move your workspace.';
      
    });
    const path = content.querySelector('#storage-path');
    if (path && path.textContent !== 'App storage on this Android device') path.textContent = 'App storage on this Android device';
    for (const control of content.querySelectorAll('#choose-storage-path, [data-action="copy-storage-path"]')) if (!control.hidden) control.hidden = true;
    const projectStorageCard = path?.closest('.settings-card');
    if (projectStorageCard) {
      let saveCard = content.querySelector('.am-save-folder-card');
      if (!saveCard) {
        saveCard = document.createElement('section'); saveCard.className = 'settings-card am-save-folder-card';
        saveCard.innerHTML = '<div class="settings-icon">⇩</div><div><h2>Default save folder</h2><p>Saved files and backups will open Android’s Save dialog in this folder first. You can still change the filename or destination each time.</p></div><div class="am-save-folder-status" role="status" aria-live="polite"></div><div class="settings-actions"><button class="primary" type="button" data-am-choose-save-folder>Choose folder…</button><button class="secondary" type="button" data-am-clear-save-folder>Ask every time</button></div>';
        projectStorageCard.after(saveCard);
      }
      const saveStatus = saveCard.querySelector('.am-save-folder-status');
      const chooseSave = saveCard.querySelector('[data-am-choose-save-folder]');
      const clearSave = saveCard.querySelector('[data-am-clear-save-folder]');
      const currentFolder = window.NotejectAndroidFiles?.getSaveFolderName?.() || '';
      if (saveStatus) saveStatus.textContent = currentFolder ? 'Default folder: ' + currentFolder : 'No default folder selected. Android will ask where to save each file.';
      if (clearSave) clearSave.hidden = !currentFolder;
      if (chooseSave) chooseSave.onclick = async () => {
        chooseSave.disabled = true;
        if (saveStatus) saveStatus.textContent = 'Opening Android folder picker…';
        try {
          const result = await window.NotejectAndroidFiles.chooseSaveFolder();
          if (result.status === 'selected' && saveStatus) saveStatus.textContent = 'Default folder: ' + result.name;
          if (result.status === 'selected' && clearSave) clearSave.hidden = false;
          if (result.status === 'selected') notify('Default save folder updated');
          else if (saveStatus) saveStatus.textContent = currentFolder ? 'Default folder: ' + currentFolder : 'No default folder selected. Android will ask where to save each file.';
        } catch (error) {
          if (saveStatus) saveStatus.textContent = error.message || 'Could not choose a save folder.';
          notify(error.message || 'Could not choose a save folder.');
        } finally { chooseSave.disabled = false; }
      };
      if (clearSave) clearSave.onclick = () => {
        if (!window.NotejectAndroidFiles?.clearSaveFolder?.()) { notify('Could not reset the save folder.'); return; }
        clearSave.hidden = true;
        if (saveStatus) saveStatus.textContent = 'No default folder selected. Android will ask where to save each file.';
        notify('Default save folder reset');
      };
    }
    const backupHint = content.querySelector('.workspace-backup-hint');
    if (backupHint && !backupHint.dataset.amReady) { backupHint.dataset.amReady = 'true'; backupHint.textContent = 'Export opens Android’s Save dialog and creates a portable .zip backup with project names and original files. Import accepts Noteject .zip backups and older .json backups, and replaces this workspace.'; }
    const settingsContent = content.querySelector('.settings-menu-content');
    const storageSettings = !!tabs?.querySelector('[data-settings-tab="storage"].active');
    if (settingsContent && storageSettings && !settingsContent.querySelector('.am-import-recovery')) {
      const recovery = document.createElement('section'); recovery.className = 'settings-card am-import-recovery';
      recovery.innerHTML = '<div class="settings-icon">↶</div><div><h2>Import recovery</h2><p>Imported files are staged safely. An interrupted import keeps your current workspace. After a completed import you can recover the previous workspace and its original files.</p></div><div class="settings-actions"><button type="button" class="secondary" disabled>Checking recovery snapshot…</button></div>';
      settingsContent.append(recovery);
      const button = recovery.querySelector('button');
      attachmentImports.previous().then(snapshot => { if (!recovery.isConnected) return; button.disabled = !snapshot; button.textContent = snapshot ? 'Recover previous workspace' : 'No previous import to recover'; button.onclick = () => void restorePreviousWorkspace(); }).catch(() => { button.textContent = 'Recovery storage unavailable'; });
    }
    if (!storageSettings) settingsContent?.querySelector('.am-project-migration')?.remove();
    settingsContent?.querySelector('.am-project-migration')?.remove();
    const version = content.querySelector('.about-details b');
    if (version && version.textContent !== '1.10.22 · Android') version.textContent = (window.NotejectAndroid.getAppVersion?.() || '1.10.27') + ' · Android';
    const settingsLayout = content.querySelector('.settings-menu-layout');
    if (settingsLayout && !settingsLayout.querySelector('.am-settings-current')) {
      const current = document.createElement('div'); current.className = 'am-settings-current';
      const heading = settingsLayout.querySelector('.settings-section-title');
      if (heading) { const label = document.createElement('span'); label.textContent = 'Current section'; current.append(label, heading); settingsLayout.querySelector('.settings-menu-content')?.prepend(current); }
    }
  }
  function sync() {
    if (view === 'tasks' || view === 'templates') { openWorkspaceView('home'); return; }
    const current = typeof view === 'string' ? view : 'home';
    const surface = content.querySelector('.canvas,.graph-canvas-wrap');
    if (surface !== gestureSurface) { resetTouchGestures(); gestureSurface = surface; }
    if (body.dataset.amPage !== current) body.dataset.amPage = current;
    const drawerLayout = compact.matches;
    sidebar.inert = drawerLayout && !drawerOpen;
    sidebar.setAttribute('aria-hidden', String(drawerLayout && !drawerOpen));
    const title = current === 'board' ? activeBoard()?.name || 'Board' : labels[current] || document.getElementById('crumb')?.textContent || 'noteject';
    const label = header.querySelector('#am-page-title');
    if (label.textContent !== title) label.textContent = title;
    const subpage = !['home', 'notes', 'recordings', 'library', 'boardIndex', 'reader'].includes(current);
    header.querySelector('[data-am-back]').hidden = !subpage;
    header.querySelector('[data-am-menu]').hidden = subpage;
    const active = current === 'board' ? 'boardIndex' : ['home', 'notes', 'recordings', 'library', 'boardIndex'].includes(current) ? current : 'more';
    bottom.querySelectorAll('[data-am-view]').forEach(button => {
      const selected = button.dataset.amView === active;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    const location = { view: current, boardId: current === 'board' ? activeBoard()?.id : null };
    if (lastLocation && (lastLocation.view !== current || lastLocation.boardId !== location.boardId)) {
      if (!restoringLocation && lastLocation.view !== 'reader') { navigationHistory.push(lastLocation); if (navigationHistory.length > 40) navigationHistory.shift(); }
      restoringLocation = false;
    }
    lastLocation = location;
    toggleClass(body, 'am-reading', current === 'reader');
    toggleClass(body, 'am-note-open', !!content.querySelector('.detail-panel'));
    toggleClass(body, 'am-board-moving', moveCards && current === 'board');
    toggleClass(body, 'am-board-selecting', selectCards && current === 'board');
    fab.classList.add('ux-header-create');
    const headerRow = header.querySelector('.am-header-row'); if (fab.parentElement !== headerRow) headerRow.append(fab);
    fab.hidden = drawerOpen || !!document.querySelector('dialog[open],.an-note-card-menu[open],.am-options[open]') || ['home', 'recordings', 'library', 'board', 'reader', 'settings', 'trash', 'search'].includes(current) || !!content.querySelector('.detail-panel, [data-ps-form], .am-gallery-manage[open]');
    const searchButton = header.querySelector('[data-am-search]');
    searchButton.hidden = current === 'recordings';
    if (current === 'recordings') header.querySelector('.am-search-row').hidden = true;
    prepareReader(content.querySelector('.reader-shell'));
    prepareBoard();
    if (current === 'boardIndex') prepareBoardMenus();
    prepareEditor();
    prepareHome();
    prepareLibrary();
    prepareNavigation();
    boardScrim.hidden = current !== 'board' || !content.querySelector('.board-document-panel:not([hidden]), .board-note-tray');
    if (current === 'settings') prepareSettings();
    const projectManager = content.querySelector('.notes-folder-manager');
    if (projectManager && !projectManager.closest('.am-note-projects')) {
      const details = document.createElement('details'); details.className = 'am-note-projects';
      details.open = !compact.matches;
      const summary = document.createElement('summary');
      const title = document.createElement('strong'); title.textContent = 'Projects & filters';
      const selection = document.createElement('span'); selection.textContent = typeof noteFolder === 'string' ? noteFolder : 'All notes';
      summary.append(title, selection); details.append(summary); projectManager.before(details); details.append(projectManager);
    }
    const filters = content.querySelector('.document-library-controls');
    if (filters && !filters.closest('.am-library-filters')) {
      const details = document.createElement('details'); details.className = 'am-library-filters'; details.open = !compact.matches;
      const summary = document.createElement('summary'); summary.textContent = 'Filters & sort';
      const search = filters.querySelector('.document-search-field');
      if (search) { search.classList.add('am-library-search'); filters.before(search); }
      filters.before(details); details.append(summary, filters);
    }
    const hint = content.querySelector('.library-summary');
    if (hint?.textContent.includes('Drag notes onto a board')) hint.textContent = hint.textContent.replace('Drag notes onto a board in the sidebar to add them.', 'Open a board and use + Notes to add your ideas.');
    const folderHint = content.querySelector('.note-folder-drop-hint');
    if (folderHint?.textContent.includes('Drop notes')) folderHint.textContent = 'Select notes, then choose Move to project.';
    const meta = content.querySelector('.detail-panel .note-meta-edit');
    if (meta && !meta.closest('.am-note-details')) {
      const details = document.createElement('details'); details.className = 'am-note-details';
      const summary = document.createElement('summary'); summary.textContent = 'Project, color & tags';
      meta.before(details); details.append(summary, meta);
    }
    window.NotejectAndroidNotesUI?.sync();
    window.NotejectAndroidReaderUI?.sync();
    window.NotejectAndroidTouchSelection?.sync();
    window.NotejectAndroidCanvasUI?.sync();
    optionsScrim.hidden = !content.querySelector('.am-options[open]');
    const originalSearch = document.getElementById('search');
    const mobileSearch = header.querySelector('input');
    if (originalSearch && document.activeElement !== mobileSearch && mobileSearch.value !== originalSearch.value) mobileSearch.value = originalSearch.value;
    syncModal();
    persistSession();
  }
  function persistSession() {
    if (!startupRestored || typeof view !== 'string') return;
    const record = { version: 1, view, boardId: data.activeBoard, noteId: data.selected?.type === 'note' ? data.selected.id : null, documentId: view === 'reader' ? data.selected?.id : null, editing: !!document.getElementById('edit-body'), origin: typeof readerReturnView === 'string' ? readerReturnView : 'library' };
    const serialized = JSON.stringify(record);
    if (serialized !== lastSavedSession) { try { localStorage.setItem('noteject-android-session-v1', serialized); lastSavedSession = serialized; } catch {} }
  }
  function restoreSession() {
    if (startupRestored) return;
    startupRestored = true;
    if (typeof storageRecovery !== 'undefined' && storageRecovery) { sync(); return; }
    const saved = startupSession; startupSession = null;
    if (saved?.version !== 1 || !saved.view || !['reader', 'board', ...Object.keys(labels)].includes(saved.view)) { sync(); return; }
    try {
      if (saved.boardId && data.boards.some(board => board.id === saved.boardId)) data.activeBoard = saved.boardId;
      if (saved.view === 'reader' && data.docs.some(doc => doc.id === saved.documentId)) {
        view = saved.origin === 'board' && data.boards.some(board => board.id === saved.boardId) ? 'board' : 'library';
        data.selected = null; render(); openDocument(saved.documentId);
      } else if (saved.noteId && data.notes.some(note => note.id === saved.noteId)) {
        if (saved.view === 'board') { view = 'board'; data.selected = { type: 'note', id: saved.noteId }; render(); }
        else openWorkspaceItem({ kind: 'note', id: saved.noteId });
        if (saved.editing) edit(data.notes.find(note => note.id === saved.noteId));
      } else if (saved.view !== 'reader') openWorkspaceView(saved.view);
    } catch { openWorkspaceView('home'); }
    navigationHistory.length = 0; lastLocation = null; sync();
  }
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  }
  new MutationObserver(records => {
    // Page paints, selectable glyphs, previews and progress labels do not change
    // the mobile shell. Large PDFs can add thousands of these nodes at once.
    if (records.some(record => !record.target.closest?.('#reader-pdf-pages,#reader-page-grid,.reader-statusbar,#pdf-page-total,[data-reader-command="zoom-reset"]'))) scheduleSync();
  }).observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
  new MutationObserver(scheduleSync).observe(body, { childList: true });
  sheet.addEventListener('close', scheduleSync);
  sheet.addEventListener('cancel', scheduleSync);
  sheet.addEventListener('toggle', scheduleSync);
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--am-header-height', header.offsetHeight + 'px');
  }).observe(header);
  function updateKeyboard() {
    if (nativeKeyboardVisible !== null) { toggleClass(body, 'am-keyboard-open', nativeKeyboardVisible); return; }
    const height = window.visualViewport?.height || innerHeight;
    const typing = !!document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]');
    if (!typing) viewportBaseline = Math.max(viewportBaseline, height);
    body.classList.toggle('am-keyboard-open', typing && viewportBaseline - height > 140);
  }
  window.visualViewport?.addEventListener('resize', updateKeyboard);
  window.addEventListener('noteject:android-insets', event => {
    nativeKeyboardVisible = !!event.detail?.keyboardVisible;
    toggleClass(body, 'am-keyboard-open', nativeKeyboardVisible);
    if (!event.detail?.keyboardVisible) viewportBaseline = window.visualViewport?.height || innerHeight;
  });
  document.addEventListener('focusin', updateKeyboard);
  document.addEventListener('focusout', () => setTimeout(updateKeyboard, 120));
  window.addEventListener('orientationchange', () => { resetTouchGestures(); setTimeout(() => { viewportBaseline = window.visualViewport?.height || innerHeight; updateKeyboard(); scheduleSync(); }, 400); });
  compact.addEventListener('change', () => {
    setDrawer(false);
    content.querySelectorAll('.am-note-projects, .am-library-filters').forEach(details => { details.open = !compact.matches; });
    scheduleSync();
  });
  window.NotejectMobile = Object.freeze({ handleBack, closeOptions, openMenu: () => setDrawer(true), closeMenu: () => setDrawer(false), sync: scheduleSync,
    startBoardHoldMove, setBoardSelectionMode,
    boardSelectionMode: () => moveCards ? 'move' : selectCards ? 'select' : 'browse',
    connectBoardSelection: () => { if (view === 'board' && boardSelection.size) { selectBoardCards([...boardSelection]); return beginBoardConnection(true); } },
    prepareBoardConnection: () => selectBoardCards([...boardSelection]),
    openBoardSelectionMenu: () => { const itemId = [...boardSelection][0]; if (itemId) showBoardContext(itemId); },
    persistDraft: () => { storeNoteDraft(); persistSession(); }
  });
  window.addEventListener('noteject:canvas-panel', scheduleSync);
  window.addEventListener('noteject:touch-selection', event => {
    if (event.detail?.kind === 'document') { fileSelectionMode = !!event.detail.active; scheduleSync(); return; }
    if (event.detail?.kind !== 'board') return;
    selectCards = !!event.detail.active; moveCards = false;
    connectMode = false; connectFrom = null;
    suppressBoardClickUntil = performance.now() + 1200;
    scheduleSync();
  });
  let processingQuickAction = false;
  const handledQuickActions = new Set();
  async function handleQuickAction(request) {
    if (!request?.id || !['new-note', 'new-recording'].includes(request.action) || processingQuickAction) return;
    if (handledQuickActions.has(request.id)) { window.NotejectAndroid.acknowledgeQuickAction?.(request.id); return; }
    if (typeof storageRecovery !== 'undefined' && storageRecovery) { notify('Recover or reset your workspace before creating new items.'); return; }
    processingQuickAction = true;
    try {
      storeNoteDraft();
      sheet.close(); closeOptions(); setDrawer(false);
      if (request.action === 'new-note') {
        if (window.NotejectAndroidAudioUI?.isOpen?.() && window.NotejectAndroidAudioUI.beforeNavigate?.(() => void handleQuickAction(request))) return;
        if (window.NotejectAndroidProjectsUI?.getModal()) window.NotejectAndroidProjectsUI.handleBack();
        const result = await createNote({ folder: 'Inbox' });
        if (!result?.id || data.selected?.id !== result.id || !document.getElementById('edit-body')) return;
      } else {
        if (!window.NotejectAndroidAudioUI?.open) return;
        if (window.NotejectAndroidProjectsUI?.getModal()) window.NotejectAndroidProjectsUI.handleBack();
        await window.NotejectAndroidAudioUI.open();
        if (!window.NotejectAndroidAudioUI.isOpen?.()) return;
        document.querySelector('#android-audio-dialog [data-audio-action="record"]')?.focus({ preventScroll: true });
      }
      handledQuickActions.add(request.id);
      if (handledQuickActions.size > 32) handledQuickActions.delete(handledQuickActions.values().next().value);
      window.NotejectAndroid.acknowledgeQuickAction?.(request.id);
      scheduleSync();
    } catch (error) { notify(error.message || 'Could not open this quick action. Open noteject and try again.'); }
    finally {
      processingQuickAction = false;
      // Acknowledging one request can deliver the next before this handler finishes.
      setTimeout(() => { try { const next = window.NotejectAndroid.getPendingQuickAction?.(); if (next) { const queued = JSON.parse(next); if (queued.id !== request.id) void handleQuickAction(queued); } } catch {} }, 0);
    }
  }
  window.addEventListener('noteject:quick-action', event => { void handleQuickAction(event.detail); });
  function enableQuickActions() {
    try {
      window.NotejectAndroid.setQuickActionsReady?.(true);
      const pending = window.NotejectAndroid.getPendingQuickAction?.();
      if (pending) void handleQuickAction(JSON.parse(pending));
    } catch {}
  }
  setDrawer(false);
  sync();
  try { if (typeof window.NotejectAndroid.isKeyboardVisible === 'function') { nativeKeyboardVisible = !!window.NotejectAndroid.isKeyboardVisible(); updateKeyboard(); } } catch {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restoreSession, { once: true });
  else restoreSession();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(enableQuickActions, 0), { once: true });
  else setTimeout(enableQuickActions, 0);
})();
