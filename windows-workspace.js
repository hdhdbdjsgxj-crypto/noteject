/* Workspace management shared by Windows and hosted Web; desktop layouts stay in Windows. */
(function () {
  'use strict';
  const hostedWeb = !!window.NotejectWebApp;
  if ((!window.NotejectDesktop && !hostedWeb) || window.NotejectAndroid) return;

  const COLORS = ['violet', 'blue', 'teal', 'amber', 'rose', 'gray'];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const webAdapter = hostedWeb ? {
    getData: () => data, getView: () => view, preserveDraft: () => true,
    navigate: (target, options) => openWorkspaceView(target, options),
    newNote: (options = {}) => { openWorkspaceView('notes', { folder: options.folder || 'Inbox' }); return action('new-note'); },
    editNote: noteId => { const note = data.notes.find(item => item.id === noteId); if (note) { openWorkspaceItem({ kind: 'note', id: noteId }); edit(note); } }
  } : null;
  const desktop = () => window.NotejectWindows || webAdapter;
  const model = () => window.NotejectWorkspaceOrganizer?.model;
  const getData = () => desktop()?.getData?.() || (typeof data === 'object' ? data : null);
  const getView = () => desktop()?.getView?.() || (typeof view === 'string' ? view : '');
  const inform = message => { if (typeof notify === 'function') notify(message); };
  const navigate = (target, options) => desktop()?.navigate ? desktop().navigate(target, options || {}) : typeof openWorkspaceView === 'function' && openWorkspaceView(target, options || {});
  const preserve = () => desktop()?.preserveDraft?.();
  let popup = null, popupAnchor = null, popupRefresh = null, dialog = null;
  const noteClicks = new WeakMap();
  const setClass = (element, name, active) => { if (element.classList.contains(name) !== !!active) element.classList.toggle(name, !!active); };

  function button(label, className, title) {
    const element = document.createElement('button');
    element.type = 'button'; element.className = className; element.textContent = label;
    if (title) { element.title = title; element.setAttribute('aria-label', title); }
    return element;
  }

  function closeMenu(restoreFocus = true) {
    const anchor = popupAnchor;
    popup?.remove(); popup = null; popupAnchor = null; popupRefresh = null;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }

  function showMenu(anchor, items, point, refresh) {
    closeMenu(false);
    popup = document.createElement('div'); popup.className = 'nw-workspace-menu'; popup.setAttribute('role', 'menu');
    popup.setAttribute('aria-label', 'Item actions'); popupAnchor = anchor; popupRefresh = refresh || null;
    anchor?.setAttribute('aria-expanded', 'true');
    for (const item of items) {
      if (!item) { const divider = document.createElement('hr'); popup.append(divider); continue; }
      const control = button(item.label, item.danger ? 'is-danger' : '', item.title);
      control.setAttribute('role', 'menuitem'); control.disabled = !!item.disabled;
      if (item.shortcut) { const keys = document.createElement('kbd'); keys.textContent = item.shortcut; control.append(keys); }
      control.onclick = () => { closeMenu(false); Promise.resolve().then(item.run).catch(error => inform(error?.message || 'The action could not be completed.')); };
      popup.append(control);
    }
    document.body.append(popup);
    const rect = anchor?.getBoundingClientRect(), x = point?.x ?? rect?.left ?? innerWidth / 2, y = point?.y ?? rect?.bottom ?? innerHeight / 2;
    popup.style.left = Math.max(8, Math.min(x, innerWidth - popup.offsetWidth - 8)) + 'px';
    popup.style.top = Math.max(8, Math.min(y + 4, innerHeight - popup.offsetHeight - 8)) + 'px';
    popup.onkeydown = event => {
      const controls = $$('button:not(:disabled)', popup), index = controls.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeMenu(); }
      else if (event.key === 'Tab') closeMenu(false);
    };
    $('button:not(:disabled)', popup)?.focus();
  }

  function closeDialog() {
    if (!dialog) return;
    const current = dialog; dialog = null;
    if (current.open) current.close(); current.remove();
  }

  function openDialog(title, body, submitLabel, onSubmit, danger = false) {
    closeMenu(false); closeDialog();
    const current = document.createElement('dialog'); current.className = 'nw-workspace-dialog';
    current.innerHTML = '<form><header><h2 id="nw-workspace-dialog-title">' + escape(title) + '</h2><button type="button" class="nw-dialog-close" aria-label="Close">×</button></header><div class="nw-dialog-body">' + body + '<p class="nw-dialog-error" role="alert" hidden></p></div><footer><button type="button" class="secondary" data-nw-cancel>Cancel</button><button type="submit" class="' + (danger ? 'danger-button' : 'primary') + '">' + escape(submitLabel) + '</button></footer></form>';
    current.setAttribute('aria-labelledby', 'nw-workspace-dialog-title');
    document.body.append(current); dialog = current;
    $$('[data-nw-cancel],.nw-dialog-close', current).forEach(control => { control.onclick = closeDialog; });
    current.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    current.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeDialog(); } });
    $('form', current).onsubmit = async event => {
      event.preventDefault();
      const submit = $('button[type="submit"]', current), error = $('.nw-dialog-error', current);
      error.hidden = true; submit.disabled = true;
      try {
        const result = await onSubmit(new FormData(event.target));
        if (result !== false && dialog === current) closeDialog();
      } catch (failure) { error.textContent = failure?.message || 'The changes could not be saved.'; error.hidden = false; }
      finally { submit.disabled = false; }
    };
    current.showModal();
    const first = $('input:not([type="checkbox"]),textarea,select', current);
    first?.focus(); if (first?.tagName === 'INPUT') first.select();
    return current;
  }

  function commit() { if (typeof save === 'function') save(); if (typeof render === 'function') render(); }
  function currentProject(folder) { return model()?.projects(getData())?.find(project => project.folder === folder); }

  function editProject(folder) {
    const state = getData(), project = currentProject(folder);
    if (!project) return;
    const linked = new Set(project.boardIds || []);
    const boards = (state.boards || []).map(board => '<label class="nw-project-board-option"><input name="boardIds" type="checkbox" value="' + escape(board.id) + '"' + (linked.has(board.id) || board.folder === folder ? ' checked' : '') + (board.folder === folder ? ' disabled' : '') + '><span>' + escape(board.name || 'Untitled board') + '</span>' + (board.folder === folder ? '<small>In this project</small>' : '') + '</label>').join('');
    openDialog('Edit project', '<label>Project name<input name="name" required maxlength="100" autocomplete="off" value="' + escape(project.name || folder) + '"></label><label>Description<textarea name="description" rows="3" maxlength="1000" placeholder="A goal or a short description">' + escape(project.description) + '</textarea></label><label>Project color<select name="color">' + COLORS.map(color => '<option value="' + color + '"' + (color === project.color ? ' selected' : '') + '>' + color[0].toUpperCase() + color.slice(1) + '</option>').join('') + '</select></label><fieldset><legend>Linked boards</legend><div class="nw-project-board-options">' + (boards || '<p>Create a board to link it to this project.</p>') + '</div></fieldset>', 'Save project', values => {
      const nextName = String(values.get('name') || '').trim();
      if (!nextName) throw Error('Enter a project name.');
      if (nextName.toLocaleLowerCase() === 'inbox') throw Error('Inbox is reserved. Choose another project name.');
      if (model().projects(state).some(item => item.folder !== folder && item.folder.toLocaleLowerCase() === nextName.toLocaleLowerCase())) throw Error('A project with this name already exists.');
      if (preserve() === false) return false;
      if (nextName !== folder) {
        window.NotejectWorkspaceNavigation.renameFolder(state, folder, nextName);
        if (typeof noteFolder !== 'undefined' && noteFolder === folder) noteFolder = nextName;
        if (typeof libraryFolder !== 'undefined' && libraryFolder === folder) libraryFolder = nextName;
      }
      model().setProjectBoards(state, nextName, values.getAll('boardIds'), typeof id === 'function' ? id : undefined);
      const metadata = state.workspace.projects.find(item => item.folder === nextName);
      metadata.name = nextName; metadata.description = String(values.get('description') || '').trim(); metadata.color = String(values.get('color') || 'violet');
      if (typeof workspaceOrganizer !== 'undefined') workspaceOrganizer.openProject(nextName);
      commit(); inform('Project saved');
    });
  }

  function deleteProject(folder) {
    const state = getData(), project = currentProject(folder);
    if (!project) return;
    openDialog('Delete project?', '<p>Delete <strong>' + escape(project.name) + '</strong>?</p><p>Its notes and documents will move to Inbox. Your boards and original files stay on this device. You can restore the project from Trash.</p><div class="nw-delete-summary">' + project.noteCount + ' notes · ' + project.documentCount + ' documents · ' + project.boardCount + ' boards</div>', 'Delete project', () => {
      if (preserve() === false) return false;
      const result = model().deleteProject(state, folder);
      if (!result) throw Error('This project is no longer available.');
      if (typeof workspacePageApp !== 'undefined' && workspacePageApp.trashProject) workspacePageApp.trashProject(result.snapshot);
      else if (typeof stash === 'function') stash('project', result.snapshot);
      window.NotejectWorkspaceNavigation.removeFolder(state, folder);
      if (typeof workspaceOrganizer !== 'undefined') workspaceOrganizer.openProject('');
      if (typeof noteFolder !== 'undefined' && noteFolder === folder) noteFolder = 'Inbox';
      if (typeof libraryFolder !== 'undefined' && libraryFolder === folder) libraryFolder = 'Inbox';
      if (typeof save === 'function') save();
      navigate('projects'); inform('Project deleted. Notes and files moved to Inbox.');
    }, true);
  }

  async function exportProject(folder) {
    const state = getData(), project = currentProject(folder);
    if (!project || typeof exportBoardReadingPage !== 'function') return;
    const items = model().projectItems(state, project), seen = new Set();
    const cards = items.filter(item => item.kind !== 'board').map((item, index) => ({ type: item.kind === 'document' ? 'doc' : 'note', id: item.id, x: 60 + index % 4 * 250, y: 60 + Math.floor(index / 4) * 220 }));
    cards.forEach(card => seen.add(card.id));
    const linkedBoards = items.filter(item => item.kind === 'board').map(item => item.record);
    for (const board of linkedBoards) for (const card of board.items || []) if (!seen.has(card.id)) { seen.add(card.id); cards.push({ ...card }); }
    const edges = linkedBoards.flatMap(board => board.edges || []).filter(edge => seen.has(edge.from) && seen.has(edge.to));
    inform('Preparing project export…');
    await exportBoardReadingPage({ id: 'windows-project-export', name: project.name, items: cards, edges });
  }

  function manageProject(folder, anchor, point) {
    const project = currentProject(folder); if (!project) return;
    showMenu(anchor, [
      { label: 'Open project', run: () => navigate('projects', { folder }) },
      { label: 'Edit project…', run: () => editProject(folder) },
      null,
      { label: 'New note in project', run: () => desktop()?.newNote?.({ folder }) },
      { label: 'Import files…', run: () => { navigate('library', { folder }); typeof action === 'function' && action('import'); } },
      { label: 'Open project notes', run: () => navigate('notes', { folder }) },
      { label: 'Open project documents', run: () => navigate('library', { folder }) },
      { label: 'Export reading page…', run: () => exportProject(folder) },
      null,
      { label: 'Delete project…', danger: true, run: () => deleteProject(folder) }
    ], point);
  }

  function editNote(noteId) { preserve(); desktop()?.editNote?.(noteId, { keepContext: true }); }
  function selectNoteAction(noteId, command) {
    if (preserve() === false) return;
    selectedNotes.clear(); selectedNotes.add(noteId);
    updateNoteSelectionUI();
    return action(command);
  }
  function deleteNote(card) {
    return selectNoteAction(card.dataset.note, 'bulk-delete-notes');
  }

  function noteMenu(card, anchor, point) {
    const noteId = card.dataset.note, state = getData(), note = state?.notes?.find(item => item.id === noteId);
    if (!note) return;
    showMenu(anchor || card, [
      { label: 'Edit note', shortcut: 'Enter', run: () => editNote(noteId) },
      { label: note.favorite ? 'Remove from favorites' : 'Add to favorites', run: () => $('[data-note-favorite]', card)?.click() },
      { label: 'Move to project…', run: () => selectNoteAction(noteId, 'bulk-move-notes') },
      { label: note.archived ? 'Restore from archive' : 'Archive note', run: () => $('[data-note-archive]', card)?.click() },
      null,
      { label: 'Delete note…', shortcut: 'Del', danger: true, run: () => deleteNote(card) }
    ], point, () => {
      const current = $$('.note-list-card', $('#view')).find(item => item.dataset.note === noteId);
      if (!current) return false;
      noteMenu(current, $('.nw-note-more,.web-management-trigger', current) || current, point);
      return true;
    });
  }

  function enhanceNotes(root) {
    if (getView() !== 'notes') { setClass(root, 'nw-notes-view', false); setClass(root, 'nw-has-note', false); return; }
    setClass(root, 'nw-notes-view', true);
    let master = $('.nw-notes-master', root);
    if (!master) {
      master = document.createElement('section'); master.className = 'nw-notes-master'; master.setAttribute('aria-label', 'Notes list');
      const nodes = [...root.children].filter(element => !element.classList.contains('detail-panel'));
      root.prepend(master); nodes.forEach(element => master.append(element));
      const filters = $('.notes-folder-manager', master);
      if (filters) {
        const projectFilter = document.createElement('div'); projectFilter.className = 'nw-note-project-filter';
        const open = $$('[data-note-folder-open]', filters), selected = open.find(control => control.classList.contains('active'));
        projectFilter.innerHTML = '<label>Project<select aria-label="Filter notes by project"><option value="">All projects</option>' + open.map(control => '<option value="' + escape(control.dataset.noteFolderOpen) + '"' + (control === selected ? ' selected' : '') + '>' + escape(control.dataset.noteFolderOpen) + '</option>').join('') + '</select></label>';
        $('select', projectFilter).onchange = event => { preserve(); const control = open.find(item => item.dataset.noteFolderOpen === event.target.value) || $('[data-note-smart="all"]', filters); control?.click(); };
        const manage = button('Manage projects', 'nw-projects-link'); manage.onclick = () => navigate('projects'); projectFilter.append(manage);
        filters.append(projectFilter);
      }
    }
    const panel = $('.detail-panel', root);
    setClass(root, 'nw-has-note', !!panel);
    let empty = $('.nw-notes-empty', root);
    if (panel) { empty?.remove(); enhanceNotePanel(panel); }
    else if (!empty) {
      empty = document.createElement('section'); empty.className = 'nw-notes-empty';
      empty.innerHTML = '<span aria-hidden="true">✎</span><h2>Your notes, with room to think</h2><p>Select a note to read it here.<br>Double click a note or press Enter to edit.</p>';
      const create = button('＋ New note', 'primary'); create.onclick = () => desktop()?.newNote?.(); empty.append(create); root.append(empty);
    }
    const selectedId = getData()?.selected?.type === 'note' ? getData().selected.id : '';
    $$('.note-list-card', master).forEach(card => {
      setClass(card, 'nw-note-current', card.dataset.note === selectedId);
      if (card.dataset.nwNotesReady) return;
      card.dataset.nwNotesReady = 'true'; card.tabIndex = 0;
      card.setAttribute('role', 'group'); card.setAttribute('aria-label', $('h3', card)?.textContent || 'Note');
      card.title = 'Click to read · Double click or Enter to edit · Drag to a board';
      const actions = $('.note-card-actions', card);
      if (actions) {
        const more = button('⋯', 'nw-note-more', 'More note actions'); more.setAttribute('aria-haspopup', 'menu'); more.onclick = event => { event.stopPropagation(); noteMenu(card, more); }; actions.append(more);
        const remove = button('×', 'nw-note-delete', 'Delete note'); remove.onclick = event => { event.stopPropagation(); deleteNote(card); }; actions.append(remove);
      }
      const original = card.onclick;
      card.onclick = event => {
        if (event.target.closest('button,input,label,a,select,details,summary')) return;
        clearTimeout(noteClicks.get(card));
        if (event.detail > 1) { editNote(card.dataset.note); return; }
        noteClicks.set(card, setTimeout(() => { if (card.isConnected) { preserve(); original?.call(card, event); } }, 220));
      };
      card.ondblclick = event => { if (event.target.closest('button,input,label,a,select,details,summary')) return; event.preventDefault(); clearTimeout(noteClicks.get(card)); if (!$('#edit-body')) editNote(card.dataset.note); };
      card.oncontextmenu = event => { if (event.target.closest('input,select')) return; event.preventDefault(); noteMenu(card, card, { x: event.clientX, y: event.clientY }); };
      card.addEventListener('keydown', event => {
        if (event.target !== card) return;
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); editNote(card.dataset.note); }
        else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); noteMenu(card, card); }
        else if (event.key === 'Delete') { event.preventDefault(); event.stopImmediatePropagation(); deleteNote(card); }
        else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const cards = $$('.note-list-card', master); cards[(cards.indexOf(card) + (event.key === 'ArrowDown' ? 1 : -1) + cards.length) % cards.length]?.focus(); }
      });
    });
  }

  function enhanceNotePanel(panel) {
    // Project management has a dedicated desktop page; avoid browser prompt fields.
    panel.querySelector('#edit-note-folder option[value="__create_note_folder__"]')?.remove();
    const editing = !!$('#edit-body', panel);
    setClass(panel, 'nw-note-editing', editing);
    if (!$('.nw-note-pane-bar', panel)) {
      const bar = document.createElement('header'); bar.className = 'nw-note-pane-bar';
      const back = button('← Notes', 'nw-note-return', 'Return to notes list'); back.onclick = () => { preserve(); $('[data-action="close"]', panel)?.click(); };
      const label = document.createElement('span'); label.textContent = editing ? 'Editing note' : 'Note';
      bar.append(back, label);
      if (editing) { const hint = document.createElement('kbd'); hint.textContent = 'Ctrl+S to save'; bar.append(hint); }
      panel.prepend(bar);
    }
    const close = $('[data-action="close"]', panel); if (close) { close.title = 'Close note'; close.setAttribute('aria-label', 'Close note'); }
    const display = $('#note-display', panel);
    if (display && !display.dataset.nwEditReady) {
      display.dataset.nwEditReady = 'true';
      display.ondblclick = event => { if (!event.target.closest('button,a,input,select')) { event.preventDefault(); const selected = getData()?.selected; if (selected?.type === 'note') editNote(selected.id); } };
    }
  }

  function renameFile(doc) {
    openDialog('Rename file', '<label>File name<input name="name" required maxlength="240" autocomplete="off" value="' + escape(doc.name) + '"></label><p class="nw-dialog-hint">Keep the file extension so the file opens correctly.</p>', 'Rename', async values => {
      const name = String(values.get('name') || '').trim();
      if (!name || /[\\/:*?"<>|]/.test(name)) throw Error('Enter a valid file name.');
      const oldExt = doc.name.lastIndexOf('.') > 0 ? doc.name.slice(doc.name.lastIndexOf('.')) : '';
      if (oldExt && !name.toLocaleLowerCase().endsWith(oldExt.toLocaleLowerCase())) throw Error('Keep the original file extension ' + oldExt + '.');
      if (typeof renameDocument === 'function') await renameDocument(doc.id, name);
    });
  }

  function fileMenu(card, anchor, point) {
    const doc = getData()?.docs?.find(item => item.id === card.dataset.libraryDoc); if (!doc) return;
    showMenu(anchor || card, [
      { label: 'Open file', shortcut: 'Enter', run: () => $('[data-library-open]', card)?.click() },
      { label: 'Move to project…', run: () => $('[data-library-move]', card)?.click() },
      { label: doc.favorite ? 'Remove from favorites' : 'Add to favorites', run: () => $('[data-library-favorite]', card)?.click() },
      { label: 'Rename…', shortcut: 'F2', run: () => renameFile(doc) },
      { label: 'Edit tags…', run: () => openDialog('File tags', '<label>Tags<input name="tags" value="' + escape((doc.tags || []).join(', ')) + '" placeholder="research, reference"></label><p class="nw-dialog-hint">Separate tags with commas.</p>', 'Save tags', values => { doc.tags = [...new Set(String(values.get('tags') || '').split(',').map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))]; doc.updated = Date.now(); commit(); }) },
      { label: $('[data-library-read-toggle]', card)?.title || 'Change reading status', run: () => $('[data-library-read-toggle]', card)?.click() },
      null,
      { label: 'Delete file…', danger: true, run: () => $('[data-library-delete]', card)?.click() }
    ], point, () => {
      const current = $$('[data-library-doc]', $('#view')).find(item => item.dataset.libraryDoc === doc.id);
      if (!current) return false;
      fileMenu(current, $('.nw-file-more,.web-management-trigger', current) || current, point);
      return true;
    });
  }

  function enhanceDocuments(root) {
    const library = $('.document-library', root); if (!library) return;
    const results = $('.document-results', library);
    if (results && !$('.nw-document-columns', library)) {
      const columns = document.createElement('div'); columns.className = 'nw-document-columns'; columns.setAttribute('aria-hidden', 'true');
      columns.innerHTML = '<span></span><span>Name</span><span>Project</span><span>Type</span><span>Size</span><span>Actions</span>'; results.before(columns);
    }
    setClass(library, 'nw-details-mode', !!results?.classList.contains('document-table-mode'));
    const docs = new Map((getData()?.docs || []).map(doc => [doc.id, doc]));
    $$('[data-library-doc]', library).forEach(card => {
      if (card.dataset.nwFileReady) return; card.dataset.nwFileReady = 'true'; card.tabIndex = 0;
      const doc = docs.get(card.dataset.libraryDoc); if (!doc) return;
      const metadata = document.createElement('div'); metadata.className = 'nw-file-details';
      const bytes = Number(doc.size) || 0, formatted = bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B';
      metadata.innerHTML = '<span title="' + escape(doc.folder || 'Inbox') + '">' + escape(doc.folder || 'Inbox') + '</span><span>' + escape(String(doc.type || 'file').toUpperCase()) + '</span><span>' + formatted + '</span>'; card.append(metadata);
      const actions = $('.document-card-actions', card);
      if (actions) { const more = button('⋯', 'nw-file-more', 'More file actions'); more.setAttribute('aria-haspopup', 'menu'); more.onclick = event => { event.stopPropagation(); fileMenu(card, more); }; actions.append(more); }
      card.oncontextmenu = event => { if (event.target.closest('input,select')) return; event.preventDefault(); fileMenu(card, card, { x: event.clientX, y: event.clientY }); };
      card.addEventListener('keydown', event => {
        if (event.target !== card) return;
        if (event.key === 'Enter') { event.preventDefault(); $('[data-library-open]', card)?.click(); }
        if (event.key === 'F2') { event.preventDefault(); renameFile(doc); }
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); fileMenu(card, card); }
      });
    });
  }

  function enhanceProjects(root) {
    const page = $('.workspace-organizer[data-wo-view="projects"]', root); if (!page) return;
    $$('.wo-project-card', page).forEach(card => {
      if (card.dataset.nwProjectReady) return; card.dataset.nwProjectReady = 'true';
      const control = $('[data-wo-action="project"]', card), folder = control?.dataset.woFolder; if (!folder) return;
      const more = button(hostedWeb ? 'Manage ⋯' : '⋯', 'nw-project-more', 'Manage project ' + ($('h2', card)?.textContent || folder)); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.onclick = () => manageProject(folder, more); card.prepend(more);
      card.oncontextmenu = event => { if (event.target.closest('input,select')) return; event.preventDefault(); manageProject(folder, card, { x: event.clientX, y: event.clientY }); };
      const edit = button('Edit project', 'workspace-small-button nw-project-edit'); edit.onclick = () => editProject(folder); $('.workspace-actions', card)?.append(edit);
    });
    const details = $('.wo-project-details', page);
    if (details && !details.dataset.nwProjectReady) {
      details.dataset.nwProjectReady = 'true';
      const projectFolder = $('[data-wo-action="project-notes"]', page)?.dataset.woFolder;
      if (projectFolder) {
        const toolbar = $('.wo-project-actions', page), edit = button('Edit project…', 'secondary'); edit.onclick = () => editProject(projectFolder); toolbar?.prepend(edit);
        const more = button(hostedWeb ? 'Manage project ⋯' : 'More actions ⋯', 'secondary'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.onclick = () => manageProject(projectFolder, more); toolbar?.append(more);
      }
    }
  }

  function enhanceWebMenus(root) {
    function mountCard(card, kind, run) {
      if (card.dataset.webManagementReady) return;
      const actions = $(kind === 'note' ? '.note-card-actions' : '.document-card-actions', card);
      if (!actions) return;
      card.dataset.webManagementReady = 'true'; card.tabIndex = 0;
      const more = button('⋯', 'web-management-trigger', kind === 'note' ? 'More note actions' : 'More file actions');
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      more.onclick = event => { event.stopPropagation(); run(card, more); }; actions.append(more);
      card.addEventListener('contextmenu', event => {
        if (event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
        event.preventDefault(); run(card, more, { x: event.clientX, y: event.clientY });
      });
      card.addEventListener('keydown', event => {
        if (event.target === card && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); run(card, more); }
      });
    }
    $$('.note-list-card', root).forEach(card => mountCard(card, 'note', noteMenu));
    $$('[data-library-doc]', root).forEach(card => mountCard(card, 'document', fileMenu));
    enhanceProjects(root);
    // Reuse the existing Board/collection actions in the same floating menu.
    // Portaling the popup keeps it clear of clipped cards and narrow layouts.
    $$('.board-gallery-management,.wo-collection-management', root).forEach(menu => {
      if (menu.dataset.webManagementReady) return;
      const anchor = $('summary', menu); if (!anchor) return;
      menu.dataset.webManagementReady = 'true';
      anchor.textContent = 'Manage ⋯'; anchor.setAttribute('aria-haspopup', 'menu'); anchor.setAttribute('aria-expanded', 'false');
      const open = point => {
        menu.open = false;
        showMenu(anchor, $$('button[role="menuitem"]', menu).map(control => ({ label: control.textContent.trim(), disabled: control.disabled, danger: control.classList.contains('is-destructive'), run: () => control.click() })), point);
      };
      anchor.addEventListener('click', event => { event.preventDefault(); open(); });
      anchor.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(); } });
      const card = menu.closest('.board-gallery-card,.wo-collection-card');
      card?.addEventListener('contextmenu', event => { if (event.target.closest('input,select')) return; event.preventDefault(); open({ x: event.clientX, y: event.clientY }); });
    });
  }

  function enhanceSettings(root) {
    const page = $('.settings-menu-page', root); if (!page) return;
    page.setAttribute('aria-label', 'Windows settings');
    $$('.settings-tab', page).forEach(tab => { tab.setAttribute('aria-current', tab.classList.contains('active') ? 'page' : 'false'); });
    const local = $$('.settings-note', page).find(note => $('b', note)?.textContent === 'Local workspace');
    if (local && !local.dataset.nwAdjusted) { local.dataset.nwAdjusted = 'true'; const text = $('span', local); if (text) text.textContent = 'Notes, boards, and settings are saved in your Windows app on this device. Export a portable backup to keep a copy of your workspace and original files.'; }
    const version = getData(); void version;
    const aboutVersion = window.NotejectDesktop?.version;
    if (aboutVersion) { const fields = $$('.about-details > span', page), label = fields.find(field => field.textContent === 'Version'); if (label?.nextElementSibling && label.nextElementSibling.textContent !== aboutVersion) label.nextElementSibling.textContent = aboutVersion; }
    const shortcuts = $('.shortcut-groups', page);
    if (shortcuts && !$('.nw-windows-shortcuts', shortcuts)) {
      const section = document.createElement('section'); section.className = 'shortcut-group nw-windows-shortcuts';
      const bindings = [['New note','Ctrl + N'],['New project','Ctrl + Shift + N'],['New board','Ctrl + Alt + N'],['Import files','Ctrl + O'],['Settings','Ctrl + ,'],['Home / Notes / Documents','Alt + 1 / 2 / 3'],['Projects / Boards / Graph','Alt + 4 / 5 / 6'],['Back / Forward','Alt + ← / →'],['Show / hide sidebar','Ctrl + Alt + B'],['Full screen window','F11'],['Interface scale','Ctrl + Alt + = / −'],['Reset interface scale','Ctrl + Alt + 0'],['Keyboard shortcuts','F1']];
      section.innerHTML = '<h3>Windows desktop</h3><div class="shortcut-list">' + bindings.map(([title, keys]) => '<span>' + escape(title) + '</span><kbd>' + escape(keys) + '</kbd>').join('') + '</div>';
      shortcuts.prepend(section);
    }
  }

  document.addEventListener('pointerdown', event => { if (popup && !popup.contains(event.target) && !popupAnchor?.contains(event.target)) closeMenu(false); }, true);
  window.addEventListener('resize', () => closeMenu(false));
  document.addEventListener('click', event => {
    const control = event.target?.closest?.('[data-wo-action="rename-project-folder"],[data-wo-action="delete-project"]');
    if (!control || (!document.body.classList.contains('windows-app') && !hostedWeb)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const folder = control.dataset.woFolder;
    if (control.dataset.woAction === 'delete-project') deleteProject(folder); else editProject(folder);
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (dialog || popup)) { event.preventDefault(); event.stopImmediatePropagation(); if (dialog) closeDialog(); else closeMenu(); }
  }, true);

  window.NotejectWindowsWorkspace = {
    sync() {
      if (!document.body.classList.contains('windows-app') && !hostedWeb) return;
      const root = $('#view'); if (!root) return;
      if (hostedWeb) enhanceWebMenus(root);
      else { enhanceNotes(root); enhanceDocuments(root); enhanceProjects(root); enhanceSettings(root); }
      if (popup && popupAnchor && !popupAnchor.isConnected) {
        const focusedIndex = $$('[role="menuitem"]', popup).indexOf(document.activeElement);
        const refresh = popupRefresh;
        if (!refresh || refresh() !== true) closeMenu(false);
        else if (focusedIndex >= 0) $$('[role="menuitem"]', popup)[focusedIndex]?.focus();
      }
    },
    manageProject, editProject, deleteProject,
    getModal: () => dialog || popup,
    handleBack() { if (dialog) { closeDialog(); return true; } if (popup) { closeMenu(); return true; } return false; }
  };
  window.NotejectWorkspaceManagement = window.NotejectWindowsWorkspace;
  if (hostedWeb) {
    let queued = false;
    const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; window.NotejectWorkspaceManagement.sync(); }); };
    new MutationObserver(schedule).observe($('#view'), { childList: true, subtree: true });
    schedule();
  }
})();
