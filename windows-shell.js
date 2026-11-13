/* Windows workspace shell. Loaded by all builds; active only in the desktop app. */
(() => {
  'use strict';
  if (!window.NotejectDesktop || window.NotejectAndroid) return;
  const body = document.body, app = document.querySelector('.app'), sidebar = app?.querySelector('.sidebar'), main = app?.querySelector('.main'), content = document.getElementById('view');
  if (!app || !sidebar || !main || !content) return;
  body.classList.add('windows-app');
  const labels = { home: 'Home', notes: 'All notes', library: 'Documents', projects: 'Projects', boardIndex: 'Boards', board: 'Board', reader: 'Reader', graph: 'Graph View', settings: 'Settings', reading: 'Reading queue', favorites: 'Favorites', inbox: 'Inbox', trash: 'Trash', history: 'History', collections: 'Smart collections', smart: 'Smart Engine', search: 'Search' };
  const paths = {
    home: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>',
    note: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
    file: '<path d="M5 3h9l5 5v13H5zM14 3v5h5M8 12h8M8 16h6"/>',
    board: '<rect x="3" y="3" width="7" height="11" rx="1"/><rect x="14" y="3" width="7" height="6" rx="1"/><rect x="3" y="18" width="7" height="3" rx="1"/><rect x="14" y="13" width="7" height="8" rx="1"/>',
    project: '<path d="M3 7h7l2-3h9v17H3zM3 9h18"/>',
    graph: '<circle cx="5" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8 10 7-4M8 14l7 4M18 8v8"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16"/>',
    import: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>'
  };
  const icon = key => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[key] || paths.file) + '</svg>';
  const node = (tag, cls, text) => { const result = document.createElement(tag); if (cls) result.className = cls; if (text !== undefined) result.textContent = text; return result; };
  const button = (text, run, cls = '') => { const result = node('button', cls, text); result.type = 'button'; result.onclick = run; return result; };
  const storePreference = (key, value) => { try { localStorage.setItem('noteject-windows-' + key, String(value)); } catch {} };
  const readPreference = (key, fallback) => { try { return localStorage.getItem('noteject-windows-' + key) ?? fallback; } catch { return fallback; } };
  let scheduled = false, currentLocation = null, historyRestoring = false, navigationSignature = '';
  const backStack = [], forwardStack = [];
  let draftTimer = 0, activeTextDialog = null, resizing = null;
  const draftPrefix = 'noteject-windows-draft-v1:';
  if (!localStorage.getItem('noteject-settings-section')) settingsSection = 'general';

  function preserveDraft() {
    const editor = document.getElementById('edit-body'), title = document.getElementById('edit-title'), note = data.notes.find(item => item.id === data.selected?.id);
    if (!editor || !title || !note) return true;
    const fields = {};
    for (const field of ['edit-title', 'edit-body', 'edit-note-folder', 'edit-note-color', 'edit-note-tags']) fields[field] = document.getElementById(field)?.value || '';
    const changed = fields['edit-body'] !== note.content || fields['edit-title'] !== note.title || fields['edit-note-folder'] !== (note.folder || 'Inbox') || fields['edit-note-color'] !== (note.color || 'violet') || fields['edit-note-tags'] !== (note.tags || []).join(', ');
    if (!changed) return true;
    try { localStorage.setItem(draftPrefix + note.id, JSON.stringify({ version: 1, at: Date.now(), fields })); return true; }
    catch { notify('Draft storage is full. Save this note before leaving it.'); return false; }
  }
  function navigate(target, options = {}) {
    if (!preserveDraft()) return false;
    openWorkspaceView(target, options); scheduleSync(); return true;
  }
  function openItem(kind, itemId) {
    if (!preserveDraft()) return false;
    openWorkspaceItem({ kind, id: itemId }); scheduleSync(); return true;
  }
  function editNote(noteId, options = {}) {
    const note = data.notes.find(item => item.id === noteId); if (!note || !preserveDraft()) return false;
    if (data.selected?.id === note.id && document.getElementById('edit-body')) return true;
    if (!(options.keepContext && view === 'board')) {
      view = 'notes'; noteFolder = 'All notes'; noteFavorites = false; noteRecent = false; noteArchived = !!note.archived; query = ''; document.getElementById('search').value = '';
    }
    if (data.selected?.id !== note.id || !document.querySelector('.detail-panel')) { data.selected = { type: 'note', id: note.id }; render(); }
    edit(note); body.dataset.nwPage = view; sync(); document.getElementById('edit-body')?.focus({ preventScroll: true }); return true;
  }
  async function newNote(options = {}) {
    if (!preserveDraft()) return null;
    const boardId = options.board ? activeBoard()?.id : null;
    const folder = options.folder || (view === 'notes' && noteFolder !== 'All notes' ? noteFolder : 'Inbox');
    view = 'notes'; noteFolder = folder; noteFavorites = false; noteRecent = false; noteArchived = false; query = ''; document.getElementById('search').value = '';
    await action('new-note');
    const note = data.notes.find(item => item.id === data.selected?.id); if (!note) return null;
    if (boardId) { placeNotesOnBoard([note.id], boardId); data.selected = { type: 'note', id: note.id }; render(); edit(note); }
    body.dataset.nwPage = view; sync(); const title = document.getElementById('edit-title'); title?.focus({ preventScroll: true }); title?.select(); return note;
  }

  function requestText({ title, label = 'Name', value = '', description = '', accept = 'Save', maxLength = 120, validate, allowEmpty = false, type = 'text' }) {
    if (activeTextDialog) return Promise.resolve(null);
    return new Promise(resolve => {
      const previous = document.activeElement, dialog = node('dialog', 'nw-text-dialog'); activeTextDialog = dialog;
      dialog.setAttribute('aria-labelledby', 'nw-text-title');
      const heading = node('h2', '', title); heading.id = 'nw-text-title';
      const field = node('label', 'nw-dialog-field'), input = node('input'); input.type = type === 'password' ? 'password' : 'text'; input.value = value; input.maxLength = maxLength; input.required = !allowEmpty; input.autocomplete = 'off'; field.append(node('span', '', label), input);
      const form = node('form'), error = node('p', 'nw-dialog-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const footer = node('footer'), cancel = button('Cancel', () => dialog.close(), 'secondary'), submit = node('button', 'primary', accept); submit.type = 'submit'; footer.append(cancel, submit);
      dialog.append(heading); if (description) dialog.append(node('p', 'nw-dialog-description', description));
      form.append(field, error, footer); dialog.append(form); document.body.append(dialog);
      let result = null;
      form.onsubmit = async event => {
        event.preventDefault(); const next = input.value.trim();
        const problem = !next && !allowEmpty ? 'Enter a name.' : validate ? await validate(next) : '';
        if (problem) { error.textContent = problem; error.hidden = false; input.focus(); return; }
        result = next; dialog.close();
      };
      input.oninput = () => { error.hidden = true; };
      dialog.addEventListener('close', () => { activeTextDialog = null; dialog.remove(); if (previous?.isConnected && document.activeElement === document.body) previous.focus({ preventScroll: true }); resolve(result); }, { once: true });
      dialog.showModal(); input.focus(); input.select();
    });
  }
  async function createBoard() {
    if (!preserveDraft()) return;
    const name = await requestText({ title: 'New board', label: 'Board name', description: 'A canvas for related notes, documents, and ideas.', accept: 'Create board', maxLength: 100 });
    if (!name) return;
    const board = { id: id(), name, items: [], edges: [] }; data.boards.push(board); data.activeBoard = board.id; data.selected = null; boardSelection.clear(); view = 'board'; save(); render(); scheduleSync();
  }
  async function renameFile(fileId) {
    const file = data.docs.find(item => item.id === fileId); if (!file) return;
    const next = await requestText({ title: 'Rename file', label: 'File name', value: file.name, maxLength: 220, validate: value => /[\\/:*?"<>|]/.test(value) ? 'Use a valid Windows file name.' : '' });
    if (next) await renameDocument(file.id, next);
  }
  async function chooseStorage() {
    if (!window.NotejectDesktop.chooseDirectory) { await chooseStoragePath(); return; }
    const path = await window.NotejectDesktop.chooseDirectory(); if (!path) return;
    const status = document.getElementById('storage-status'); if (status) status.textContent = 'Updating project storage…';
    const response = await fetch(diskApiBase + '/api/storage-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: path }) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw Error(result.error || 'Could not update project storage.');
    await refreshStorageStatus(); notify('Project storage location updated');
  }
  function focusSearch() {
    if (document.querySelector('.reader-shell.is-focused')) document.querySelector('[data-reader-command="focus"]')?.click();
    const input = document.getElementById('search'); input?.focus(); input?.select();
  }
  function toggleSidebar() { body.classList.toggle('nw-sidebar-hidden'); storePreference('sidebar-hidden', body.classList.contains('nw-sidebar-hidden')); updateSidebarButton(); }
  function updateSidebarButton() { const control = main.querySelector('[data-nw-command="toggle-sidebar"]'); control?.setAttribute('aria-pressed', String(!body.classList.contains('nw-sidebar-hidden'))); }
  function triggerReader(command) {
    if (view !== 'reader') { notify('Open a document to use this command'); return; }
    const control = content.querySelector('[data-reader-command="' + command + '"]'); if (control && !control.disabled) control.click();
  }
  function undo(redo) {
    const focused = document.activeElement;
    if (focused?.id === 'edit-body' || (!focused?.matches('input,textarea,[contenteditable=true]') && view === 'board')) {
      (focused?.id === 'edit-body' ? focused : content.querySelector('.canvas') || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: !!redo, bubbles: true, cancelable: true }));
    } else document.execCommand(redo ? 'redo' : 'undo');
  }
  function commandPalette() {
    if (window.NotejectCommandMenu.isOpen()) { window.NotejectCommandMenu.close(); return; }
    const commands = [
      ['new-note', 'New note', 'Write an idea in your workspace', 'Ctrl+N'],
      ['new-project', 'New project', 'Set up a project and choose a starting workflow', 'Ctrl+Shift+N'],
      ['new-board', 'New board', 'Create a visual canvas', 'Ctrl+Alt+N'],
      ['import', 'Import files', 'PDFs, EPUBs, images, audio, and other files', 'Ctrl+O'],
      ...['home','notes','reading','projects','favorites','history','collections','boards','graph','smart','inbox','library','trash'].map(key => [key, 'Go to ' + (labels[key === 'boards' ? 'boardIndex' : key] || key), '', '']),
      ['settings', 'Settings', 'Workspace, storage, appearance and AI connection', 'Ctrl+,'],
      ['export-backup', 'Export portable backup', 'Save your workspace and original files', ''],
      ['load-backup', 'Load backup', 'Restore a saved workspace backup', ''],
      ['toggle-sidebar', 'Show or hide workspace sidebar', '', 'Ctrl+Alt+B'],
      ['help-shortcuts', 'Keyboard shortcuts', 'All Windows workspace shortcuts', '']
    ].map(([command, label, description, shortcut]) => ({ id: command, label, description, shortcut, run: () => runCommand(command) }));
    if (view === 'board') commands.push({ id: 'board-tools', label: 'Board actions and layout', run: () => workspaceTools.openCommands(true) });
    if (view === 'reader') commands.push({ id: 'bookmark-reader', label: 'Bookmark this reading position', run: () => triggerReader('bookmark') });
    window.NotejectCommandMenu.open({ commands });
  }
  async function runCommand(command) {
    if (document.querySelector('dialog[open]') && !['undo','redo','select-all'].includes(command)) return;
    try {
      if (command === 'new-note') return await newNote();
      if (command === 'new-project') { if (preserveDraft()) beginProjectSetup(); return; }
      if (command === 'new-board') return await createBoard();
      if (command === 'search') { focusSearch(); return; }
      if (command === 'command-palette') { commandPalette(); return; }
      if (command === 'toggle-sidebar') { toggleSidebar(); return; }
      if (command === 'undo' || command === 'redo') { undo(command === 'redo'); return; }
      if (command === 'select-all') {
        if (document.activeElement?.matches('input,textarea,[contenteditable=true]')) { document.execCommand('selectAll'); return; }
        if (view === 'board') (content.querySelector('.canvas')||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',ctrlKey:true,bubbles:true,cancelable:true}));
        else if (view === 'notes') { const select=document.getElementById('select-visible-notes');if(select&&!select.checked)select.click(); }
        else if (view === 'library') { const select=content.querySelector('[data-library-select-results]');if(select&&!select.checked)select.click(); }
        else document.execCommand('selectAll');
        return;
      }
      if (command === 'save-note') { const saveButton = document.querySelector('.detail-panel [data-action="save-note"]'); if (saveButton) saveButton.click(); else { saveReaderProgress(); workspaceStore.flush(); notify('Workspace saved'); } return; }
      if (command === 'import') { if (!preserveDraft()) return; if (view !== 'board' && view !== 'library') navigate('library'); await action('import'); return; }
      if (command === 'export-backup') { if (preserveDraft()) await exportWorkspaceBackup(); return; }
      if (command === 'load-backup') { if (!preserveDraft()) return; const picker = document.getElementById('backup-picker'); picker.value = ''; try { picker.showPicker(); } catch { picker.click(); } return; }
      if (command === 'settings' || command === 'help-shortcuts') { if (!preserveDraft()) return; if (command === 'help-shortcuts') { settingsSection = 'general'; localStorage.setItem('noteject-settings-section', 'general'); } navigate('settings'); if (command === 'help-shortcuts') requestAnimationFrame(() => document.querySelector('.shortcut-groups')?.scrollIntoView({ block: 'start' })); return; }
      const reader = { 'find-reader': 'find', 'bookmark-reader': 'bookmark', 'focus-reader': 'focus', 'reader-zoom-in': 'zoom-up', 'reader-zoom-out': 'zoom-down' };
      if (command === 'find-reader' && view !== 'reader') { focusSearch(); return; }
      if (reader[command]) { triggerReader(reader[command]); return; }
      if (['fit-board','board-zoom-in','board-zoom-out'].includes(command)) { if (view !== 'board') { notify('Open a board to use this command'); return; } if (command === 'fit-board') boardView.fit(); else boardView.zoom((Number(activeBoard().zoom) || 1) + (command === 'board-zoom-in' ? .1 : -.1)); return; }
      const target = command === 'boards' ? 'boardIndex' : command;
      if (labels[target]) navigate(target);
    } catch (error) { notify(error.message || 'This action could not finish'); }
  }

  const nav = sidebar.querySelector('.workspace-nav-scroll');
  const brand = sidebar.querySelector('.brand-icon'); if (brand) brand.innerHTML = '<img src="noteject-logo.png" alt="" width="34" height="34" decoding="async">';
  const oldWorkspaceLabel = nav.querySelector('.nav-label:not(.row)'); oldWorkspaceLabel?.remove();
  const navOrder = ['home','notes','reading','projects','favorites','history','collections','boardIndex','graph','smart','inbox','library','trash'];
  const glyphs = { home: 'home', notes: 'note', library: 'file', projects: 'project', boardIndex: 'board', graph: 'graph' };
  const boardList = sidebar.querySelector('#boards'), boardLabel = sidebar.querySelector('.nav-label.row');
  for (const key of navOrder) {
    const entry = nav.querySelector('[data-view="' + key + '"]'); if (!entry) continue;
    if (glyphs[key]) { const span = entry.querySelector(':scope > span'); if (span) span.innerHTML = icon(glyphs[key]); }
    nav.append(entry);
    if (key === 'projects') { const list = node('div', 'nw-project-list'); list.id = 'nw-project-list'; nav.append(list); }
    if (key === 'boardIndex' && boardList) nav.append(boardList);
  }
  const addBoard = boardLabel?.querySelector('#new-board'); if (addBoard) { addBoard.textContent = '＋ New board'; addBoard.className = 'nw-new-board'; boardList?.after(addBoard); } boardLabel?.remove();
  const newButton = button('New note', () => void runCommand('new-note'), 'primary nw-sidebar-new'); newButton.innerHTML = icon('plus') + '<span>New note</span><kbd>Ctrl N</kbd>'; nav.before(newButton);
  sidebar.querySelector('.profile')?.remove();
  const settingsButton = sidebar.querySelector('#open-settings'); if (settingsButton) { settingsButton.title = 'Settings'; settingsButton.setAttribute('aria-label', 'Settings'); }

  const topbar = main.querySelector('.topbar'), topRight = topbar.querySelector('.top-right');
  const navigation = node('div', 'nw-location-controls');
  const backButton = button('←', () => goHistory(-1), 'nw-icon-button'), forwardButton = button('→', () => goHistory(1), 'nw-icon-button'); backButton.title = 'Back (Alt+Left)'; backButton.setAttribute('aria-label','Back'); forwardButton.title = 'Forward (Alt+Right)'; forwardButton.setAttribute('aria-label','Forward');
  const sidebarToggle = button('', toggleSidebar, 'nw-icon-button'); sidebarToggle.innerHTML = icon('panel'); sidebarToggle.dataset.nwCommand = 'toggle-sidebar'; sidebarToggle.title = 'Toggle sidebar (Ctrl+Alt+B)'; sidebarToggle.setAttribute('aria-label','Show or hide sidebar');
  navigation.append(sidebarToggle, backButton, forwardButton); topbar.prepend(navigation);
  const search = topRight.querySelector('.search'); if (search) { search.classList.add('nw-global-search'); search.querySelector('input').placeholder = 'Search'; search.querySelector('input').setAttribute('aria-label', 'Search notes, documents, and boards'); search.querySelector('input').title = 'Search notes, documents, and boards'; }
  topRight.querySelector('.avatar')?.remove();
  const toolbarNew = button('＋ New', commandPalette, 'primary nw-toolbar-new'); toolbarNew.title = 'Create or find an action'; topRight.append(toolbarNew);
  const density = button('', () => { body.classList.toggle('nw-compact'); storePreference('density', body.classList.contains('nw-compact') ? 'compact' : 'comfortable'); syncDensity(); }, 'nw-icon-button nw-density-toggle'); density.title = 'Switch between comfortable and compact layout'; density.setAttribute('aria-label', 'Toggle interface density'); density.textContent = '≡'; topRight.append(density);

  const statusbar = node('footer', 'nw-statusbar'), statusLeft = node('div', 'nw-status-left'), statusRight = node('div', 'nw-status-right');
  statusLeft.append(node('span','nw-ready-dot'),node('span','nw-save-state','Saved on this device'));
  const counts = node('span','nw-status-counts'); statusRight.append(counts, button('Keyboard shortcuts', () => void runCommand('help-shortcuts'))); statusbar.append(statusLeft,statusRight); body.append(statusbar);
  const resizer = node('div', 'nw-sidebar-resizer'); resizer.tabIndex = 0; resizer.setAttribute('role','separator'); resizer.setAttribute('aria-orientation','vertical'); resizer.setAttribute('aria-label','Resize workspace sidebar'); resizer.setAttribute('aria-valuemin','180'); resizer.setAttribute('aria-valuemax','360'); app.append(resizer);
  function setSidebarWidth(value, persist = false) { const width = Math.max(180,Math.min(360,Number(value)||248)); body.style.setProperty('--nw-sidebar-width',width+'px'); resizer.setAttribute('aria-valuenow',String(Math.round(width))); if (persist) storePreference('sidebar-width',width); }
  setSidebarWidth(readPreference('sidebar-width',248));
  body.classList.toggle('nw-sidebar-hidden', readPreference('sidebar-hidden','false') === 'true');
  body.classList.toggle('nw-compact', readPreference('density','comfortable') === 'compact');
  function syncDensity() { density.setAttribute('aria-pressed',String(body.classList.contains('nw-compact'))); }
  resizer.onpointerdown = event => { if (event.button !== 0) return; resizing = { id:event.pointerId }; resizer.setPointerCapture(event.pointerId); body.classList.add('nw-resizing'); event.preventDefault(); };
  resizer.onpointermove = event => { if (resizing?.id === event.pointerId) setSidebarWidth(event.clientX); };
  function endResize() { if (!resizing) return; resizing = null; body.classList.remove('nw-resizing'); storePreference('sidebar-width',parseFloat(body.style.getPropertyValue('--nw-sidebar-width'))); }
  resizer.onpointerup = endResize; resizer.onpointercancel = endResize; resizer.onlostpointercapture = endResize;
  resizer.onkeydown = event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const current = parseFloat(body.style.getPropertyValue('--nw-sidebar-width')); setSidebarWidth(event.key==='Home'?180:event.key==='End'?360:current+(event.key==='ArrowRight'?10:-10),true); };

  function locationSnapshot() { return { view, boardId: view === 'board' ? data.activeBoard : null, documentId: view === 'reader' ? data.selected?.id : null }; }
  function goHistory(direction) {
    if (!preserveDraft()) return;
    const source = direction < 0 ? backStack : forwardStack, destination = direction < 0 ? forwardStack : backStack;
    const target = source.pop(); if (!target) return;
    destination.push(locationSnapshot()); historyRestoring = true;
    if (target.view === 'board' && data.boards.some(board => board.id === target.boardId)) openItem('board',target.boardId);
    else if (target.view === 'reader' && data.docs.some(file => file.id === target.documentId)) openItem('document',target.documentId);
    else navigate(target.view === 'reader' || target.view === 'board' ? 'home' : target.view);
    scheduleSync();
  }
  function prepareProjects() {
    const projects = window.NotejectWorkspaceOrganizer.model.projects(data), signature = JSON.stringify(projects.map(project => [project.folder,project.name,project.color,project.noteCount,project.documentCount]));
    if (signature === navigationSignature) return; navigationSignature = signature;
    const list = sidebar.querySelector('#nw-project-list'); list.replaceChildren();
    for (const project of projects.slice(0,50)) {
      const row = node('div','nw-project-row'); row.dataset.color = project.color;
      const entry = button('', () => navigate('projects',{folder:project.folder}), 'nw-project-open'); entry.append(node('i'),node('span','',project.name)); entry.title = project.name;
      const manage = button('⋯', () => window.NotejectWindowsWorkspace?.manageProject?.(project.folder,manage), 'nw-project-manage'); manage.setAttribute('aria-label','Manage project '+project.name); row.append(entry,manage); list.append(row);
    }
    if (projects.length > 50) list.append(button('Show all '+projects.length+' projects', () => navigate('projects'),'nw-project-open'));
    list.append(button('＋ New project',() => void runCommand('new-project'),'nw-project-new'));
  }
  // The app renderer already builds the shared Web Home. Keep that exact
  // content in Windows instead of inserting a second desktop-only dashboard.
  function prepareHome() { content.querySelector('.nw-home')?.remove(); }
  function prepareDraft() {
    document.querySelector('#edit-note-folder option[value="__create_note_folder__"]')?.remove();
    const editor = document.getElementById('edit-body'); if (!editor || editor.dataset.nwDraftReady) return; editor.dataset.nwDraftReady = 'true';
    const note = data.notes.find(item=>item.id===data.selected?.id); if (!note) return;
    const banner = node('div','nw-note-draft'), text = node('span','','Changes are kept as a draft until you save.'); banner.setAttribute('role','status'); banner.append(text);
    let draft; try { draft = JSON.parse(localStorage.getItem(draftPrefix+note.id)||'null'); } catch {}
    if (draft?.version===1 && draft.fields && Object.entries(draft.fields).some(([key,value])=>document.getElementById(key)?.value!==value)) {
      text.textContent='An unfinished draft is available.';
      banner.append(button('Restore draft',()=>{ for(const [key,value]of Object.entries(draft.fields)){if(!['edit-title','edit-body','edit-note-folder','edit-note-color','edit-note-tags'].includes(key)||typeof value!=='string')continue;const control=document.getElementById(key);if(control&&(!control.matches('select')||[...control.options].some(option=>option.value===value))){control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));}}banner.replaceChildren(node('span','','Draft restored. Save note to apply it.'));editor.focus();}),button('Discard draft',()=>{localStorage.removeItem(draftPrefix+note.id);banner.replaceChildren(node('span','','Draft discarded.'));},'destructive-action'));
    }
    editor.closest('.detail-panel')?.querySelector('.edit-actions')?.before(banner);
  }
  function sync() {
    body.dataset.nwPage = view;
    const current = locationSnapshot();
    if (currentLocation && JSON.stringify(current)!==JSON.stringify(currentLocation)) { if (!historyRestoring) { backStack.push(currentLocation);if(backStack.length>50)backStack.shift();forwardStack.length=0;} historyRestoring=false; }
    currentLocation=current;backButton.disabled=!backStack.length;forwardButton.disabled=!forwardStack.length;
    prepareProjects(); prepareHome(); prepareDraft(); updateSidebarButton(); syncDensity();
    for(const entry of nav.querySelectorAll('[data-view]')){const selected=entry.dataset.view===view||(entry.dataset.view==='boardIndex'&&view==='board');if(selected)entry.setAttribute('aria-current','page');else entry.removeAttribute('aria-current');}
    const countText=data.notes.length+' notes · '+data.docs.length+' documents';if(counts.textContent!==countText)counts.textContent=countText;
    const saved=sidebar.querySelector('.saved'); const message=saved?.textContent.trim()||'Saved on this device'; const state=statusLeft.querySelector('.nw-save-state');if(state.textContent!==message)state.textContent=message;
    window.NotejectWindowsWorkspace?.sync(); window.NotejectWindowsReaderBoard?.sync();
  }
  function scheduleSync() { if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;sync();}); }

  document.addEventListener('click',event=>{
    const target=event.target;
    if(target.closest('[data-action="save-note"]')){const noteId=data.selected?.id;queueMicrotask(()=>{if(noteId&&workspaceStore.flush())try{localStorage.removeItem(draftPrefix+noteId);}catch{}});return;}
    const create=target.closest('[data-action="new-note"]');if(create){event.preventDefault();event.stopImmediatePropagation();void newNote({board:view==='board'});return;}
    if(target.closest('#new-board,[data-action="create-board"]')){event.preventDefault();event.stopImmediatePropagation();void createBoard();return;}
    const rename=target.closest('[data-library-rename],[data-rename-doc]');if(rename){event.preventDefault();event.stopImmediatePropagation();void renameFile(rename.dataset.libraryRename||rename.dataset.renameDoc);return;}
    const tags=target.closest('[data-library-tags]');if(tags){event.preventDefault();event.stopImmediatePropagation();const file=data.docs.find(item=>item.id===tags.dataset.libraryTags);if(file)void requestText({title:'Edit file tags',label:'Tags, separated by commas',value:(file.tags||[]).join(', '),allowEmpty:true,maxLength:500}).then(value=>{if(value===null)return;file.tags=[...new Set(value.split(',').map(tag=>tag.trim().replace(/^#/, '')).filter(Boolean))];save();render();});return;}
    if(target.closest('#choose-storage-path')){event.preventDefault();event.stopImmediatePropagation();void chooseStorage().catch(error=>notify(error.message));return;}
    if(target.closest('#workspace-commands')){event.preventDefault();event.stopImmediatePropagation();commandPalette();return;}
    const go=target.closest('.nav-item[data-view]');if(go){event.preventDefault();event.stopImmediatePropagation();navigate(go.dataset.view);return;}
    const board=target.closest('[data-board]');if(board){event.preventDefault();event.stopImmediatePropagation();openItem('board',board.dataset.board);return;}
    if(target.closest('#brand-home')){event.preventDefault();event.stopImmediatePropagation();navigate('home');return;}
    if(target.closest('#open-settings')){event.preventDefault();event.stopImmediatePropagation();void runCommand('settings');return;}
    preserveDraft();
  },true);
  document.addEventListener('input',event=>{if(event.target.closest('.detail-panel')){clearTimeout(draftTimer);draftTimer=setTimeout(preserveDraft,180);}});
  document.addEventListener('change',event=>{if(event.target.closest('.detail-panel'))preserveDraft();});
  document.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(event.ctrlKey&&event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='p'){event.preventDefault();event.stopImmediatePropagation();commandPalette();return;}
    if(event.altKey&&!event.ctrlKey&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();goHistory(event.key==='ArrowLeft'?-1:1);}
  },true);
  const observer=new MutationObserver(scheduleSync);observer.observe(content,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','open']});
  observer.observe(sidebar.querySelector('.saved'),{subtree:true,childList:true,characterData:true});
  window.addEventListener('blur',()=>{preserveDraft();endResize();});
  window.addEventListener('beforeunload',()=>{preserveDraft();workspaceStore.flush();window.NotejectDesktop.setCommandReady?.(false);});
  window.NotejectWindows=Object.freeze({getData:()=>data,getView:()=>view,runCommand,navigate,newNote,editNote,preserveDraft,requestText,openItem,sync:scheduleSync,getModal:()=>activeTextDialog});
  // Shared gallery/command handlers resolve these globals when invoked. Replace
  // the desktop entry points so naming never relies on unsupported browser prompts.
  window.createBoard=createBoard;
  const sharedAction=window.action;
  window.action=async function(command){
    if(command==='new-idea')return newNote({board:view==='board'});
    if(command==='rename-folder'||command==='rename-note-folder'){window.NotejectWindowsWorkspace?.editProject?.(command==='rename-folder'?libraryFolder:noteFolder);return;}
    if(command==='new-note-folder'){if(preserveDraft())beginProjectSetup('notes');return;}
    if(command==='bulk-rename-docs'){
      const ids=[...selectedDocs].filter(fileId=>data.docs.some(file=>file.id===fileId));if(!ids.length)return;
      const prefix=await requestText({title:'Rename '+ids.length+' files',label:'Shared name prefix',description:'Original file extensions are kept. A number is added to each name.',accept:'Rename files',validate:value=>/[\\/:*?"<>|]/.test(value)?'Use a valid Windows file name.':''});if(!prefix)return;
      for(let index=0;index<ids.length;index++){const file=data.docs.find(item=>item.id===ids[index]);if(!file)continue;const dot=file.name.lastIndexOf('.'),extension=dot>0?file.name.slice(dot):'';await renameDocument(file.id,prefix+(ids.length>1?' '+String(index+1).padStart(2,'0'):'')+extension);}selectedDocs.clear();render();return;
    }
    if(command==='bulk-tag'){
      const ids=[...selectedDocs];if(!ids.length)return;
      const value=await requestText({title:'Tag selected files',label:'Tags, separated by commas',allowEmpty:true,maxLength:500});if(value===null)return;
      const tags=value.split(',').map(tag=>tag.trim().replace(/^#/,'')).filter(Boolean);
      for(const file of data.docs)if(ids.includes(file.id))file.tags=[...new Set([...(file.tags||[]),...tags])];save();render();return;
    }
    return sharedAction(command);
  };
  window.connectCards=async function(itemId){
    if(activeTextDialog)return;
    const board=activeBoard();if(!board)return;
    if(!connectFrom){connectFrom=itemId;content.querySelector('[data-item="'+CSS.escape(itemId)+'"]')?.classList.add('connect-source');notify('Select another card to connect');return;}
    if(connectFrom===itemId){connectFrom=null;content.querySelectorAll('.connect-source').forEach(card=>card.classList.remove('connect-source'));return;}
    board.edges||=[];
    const from=connectFrom;
    if(board.edges.some(edge=>(edge.from===from&&edge.to===itemId)||(edge.from===itemId&&edge.to===from))){connectFrom=null;connectMode=false;render();notify('These cards are already connected');return;}
    const label=await requestText({title:'Connect board cards',label:'Relationship name',value:'related to',accept:'Add connection'});
    connectFrom=null;connectMode=false;
    if(label!==null&&data.boards.includes(board)&&board.items.some(item=>item.id===from)&&board.items.some(item=>item.id===itemId))board.edges.push({id:id(),from,to:itemId,label});
    save();render();
  };
  window.createGraphEdge=async function(from,to){
    if(activeTextDialog)return;
    const board=activeBoard();if(!board)return;board.edges||=[];
    if(board.edges.some(edge=>(edge.from===from&&edge.to===to)||(edge.from===to&&edge.to===from))){graphConnect=null;notify('These items are already connected');return;}
    const label=await requestText({title:'Connect graph items',label:'Relationship name',value:'related to',accept:'Add connection'});
    graphConnect=null;
    if(label!==null&&data.boards.includes(board)){board.edges.push({id:id(),from,to,label});graphFocus=to;save();}
    render();
  };
  window.NotejectDesktop.onCommand?.(message=>void runCommand(message.command));
  const ready=()=>{try{sync()}finally{document.documentElement.classList.remove('nw-desktop-pending');window.NotejectDesktop.setCommandReady?.(true)}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();
