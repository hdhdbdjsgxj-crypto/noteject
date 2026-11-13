/* In-app page history for the hosted workspace. */
(() => {
  'use strict';
  if (!window.NotejectWebApp || window.NotejectDesktop || window.NotejectAndroid) return;
  const topbar = document.querySelector('.main > .topbar'), content = document.getElementById('view');
  if (!topbar || !content) return;
  const controls = document.createElement('div');
  controls.className = 'web-history';
  const makeButton = (direction, label, symbol, shortcut) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'web-history-button'; button.dataset.webHistory = direction;
    button.textContent = symbol; button.setAttribute('aria-label', label); button.title = label + ' (' + shortcut + ')';
    button.setAttribute('aria-keyshortcuts', direction === 'back' ? 'Alt+ArrowLeft' : 'Alt+ArrowRight');
    button.disabled = true; button.onclick = () => void go(direction === 'back' ? -1 : 1);
    controls.append(button); return button;
  };
  const back = makeButton('back', 'Back', '←', 'Alt+Left');
  const forward = makeButton('forward', 'Forward', '→', 'Alt+Right');
  const menu = topbar.querySelector('.web-nav-toggle');
  if (menu) menu.after(controls); else topbar.prepend(controls);
  document.getElementById('crumb')?.parentElement.classList.add('web-location');

  const previous = [], next = [], limit = 50;
  let current = null, restoring = false, pending = false, scheduled = false;
  function placeControls() {
    const reader = content.matches('.reader-workspace') ? content : content.querySelector('.reader-workspace');
    const desktopReader = reader?.querySelector('.reader-desktop-unified');
    if (desktopReader && window.matchMedia('(min-width: 960px)').matches) {
      const header = desktopReader.querySelector('.reader-header');
      if (header && (controls.parentElement !== header || header.firstElementChild !== controls)) header.prepend(controls);
      controls.classList.remove('web-history-reader-row');
      return;
    }
    if (window.matchMedia('(max-width: 959px)').matches && reader) {
      const shell = reader.querySelector('.reader-shell');
      const header = shell?.querySelector('.reader-header');
      const commandbar = shell?.querySelector('.reader-commandbar');
      if (!shell || !header) return;
      if (shell.classList.contains('is-focused') || !commandbar) {
        if (controls.parentElement !== shell || header.nextElementSibling !== controls) header.after(controls);
        controls.classList.add('web-history-reader-row');
      } else {
        if (controls.parentElement !== header || header.firstElementChild !== controls) header.prepend(controls);
        controls.classList.remove('web-history-reader-row');
      }
      return;
    }
    controls.classList.remove('web-history-reader-row');
    const mobileMenu = topbar.querySelector('.web-nav-toggle');
    if (mobileMenu) {
      if (controls.parentElement !== topbar || mobileMenu.nextElementSibling !== controls) mobileMenu.after(controls);
    } else if (controls.parentElement !== topbar || topbar.firstElementChild !== controls) topbar.prepend(controls);
  }
  function snapshot() {
    const organizer = workspaceOrganizer.getLocation();
    return {
      view, noteId: view === 'notes' && data.selected?.type === 'note' ? data.selected.id : null,
      documentId: view === 'reader' ? data.selected?.id : null, boardId: view === 'board' ? data.activeBoard : null,
      folder: view === 'notes' ? noteFolder : view === 'library' ? libraryFolder : '',
      project: view === 'projects' ? organizer.project : '', collection: view === 'collections' ? organizer.collection : '',
      section: view === 'settings' ? settingsSection : '',
      notes: { favorites: noteFavorites, recent: noteRecent, archived: noteArchived },
      library: { type: libraryType, favorites: libraryFavorites, smart: librarySmart, tag: libraryTag },
      search: { query, kind: searchKind, folder: searchFolder, fileType: searchFileType },
      editing: !!document.getElementById('edit-body'), scroll: window.scrollY
    };
  }
  function key(location) {
    return JSON.stringify([location.view, location.noteId, location.documentId, location.boardId, location.folder, location.project, location.collection, location.section]);
  }
  function updateButtons() { back.disabled = pending || !previous.length; forward.disabled = pending || !next.length; }
  function sync() {
    const location = snapshot();
    if (current && key(current) !== key(location) && !restoring) {
      previous.push(current); if (previous.length > limit) previous.shift(); next.length = 0;
    }
    current = location; updateButtons();
  }
  function schedule() {
    if (scheduled) return; scheduled = true;
    requestAnimationFrame(() => { scheduled = false; placeControls(); sync(); });
  }
  function valid(location) {
    if (location.noteId && !data.notes.some(note => note.id === location.noteId)) return false;
    if (location.documentId && !data.docs.some(doc => doc.id === location.documentId)) return false;
    if (location.boardId && !data.boards.some(board => board.id === location.boardId)) return false;
    if (location.project && !window.NotejectWorkspaceOrganizer.model.projects(data).some(project => project.folder === location.project || project.id === location.project)) return false;
    if (location.collection && !data.workspace?.collections?.some(collection => collection.id === location.collection)) return false;
    return true;
  }
  function hasUnsavedChanges() {
    const body = document.getElementById('edit-body'), note = data.notes.find(item => item.id === data.selected?.id);
    if (body && note) {
      const value = id => document.getElementById(id)?.value || '';
      const tags = value('edit-note-tags').split(',').map(tag => tag.trim().replace(/^#/, '')).filter(Boolean);
      if (value('edit-title') !== (note.title || '') || body.value !== (note.content || '') ||
        value('edit-note-color') !== (note.color || 'violet') || value('edit-note-folder') !== (note.folder || 'Inbox') ||
        JSON.stringify(tags) !== JSON.stringify(note.tags || [])) return true;
    }
    return !!content.querySelector('[data-ps-form]');
  }
  function restore(location) {
    if (view === 'reader') saveReaderProgress();
    if (location.view === 'reader' && location.documentId) {
      void openDocument(location.documentId); return;
    }
    if (location.view === 'board' && location.boardId) {
      openWorkspaceItem({ kind: 'board', id: location.boardId }); return;
    }
    if (location.view === 'projects') workspaceOrganizer.openProject(location.project || '');
    if (location.view === 'collections') workspaceOrganizer.openCollection(location.collection || '');
    if (location.view === 'settings') { settingsSection = location.section || 'general'; localStorage.setItem('noteject-settings-section', settingsSection); }
    openWorkspaceView(location.view, { folder: location.folder });
    if (location.view === 'notes') {
      noteFavorites = location.notes.favorites; noteRecent = location.notes.recent; noteArchived = location.notes.archived;
      if (location.noteId) data.selected = { type: 'note', id: location.noteId };
    }
    if (location.view === 'library') {
      libraryType = location.library.type; libraryFavorites = location.library.favorites; librarySmart = location.library.smart; libraryTag = location.library.tag;
    }
    if (location.view === 'search') {
      query = location.search.query; searchKind = location.search.kind; searchFolder = location.search.folder; searchFileType = location.search.fileType;
      document.getElementById('search').value = query;
    }
    render();
    if (location.editing && location.noteId) edit(data.notes.find(note => note.id === location.noteId));
  }
  async function go(direction) {
    if (pending || document.querySelector('dialog[open],.command-menu-overlay')) return;
    sync();
    const source = direction < 0 ? previous : next, destination = direction < 0 ? next : previous;
    while (source.length && !valid(source[source.length - 1])) source.pop();
    if (!source.length) { updateButtons(); return; }
    pending = true; updateButtons();
    try {
      if (hasUnsavedChanges() && !await window.NotejectDialogs.confirm('Discard changes?', { title: 'Unsaved changes', confirmLabel: 'Continue', cancelLabel: 'Keep editing', danger: true })) return;
      const target = source[source.length - 1], leaving = snapshot();
      restoring = true; restore(target);
      source.pop(); destination.push(leaving); if (destination.length > limit) destination.shift();
      sync();
      requestAnimationFrame(() => { if (key(snapshot()) === key(target)) window.scrollTo(0, target.scroll || 0); });
    } finally { restoring = false; pending = false; updateButtons(); }
  }
  new MutationObserver(schedule).observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', () => { if (current) current.scroll = window.scrollY; }, { passive: true });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); void go(event.key === 'ArrowLeft' ? -1 : 1);
  });
  placeControls(); sync();
})();
