/* Project management belongs to Projects, including actions in the workspace menu. */
(() => {
  'use strict';
  if (!window.NotejectAndroid) return;
  const model = window.NotejectWorkspaceOrganizer.model;
  const colors = { violet: 'Violet', blue: 'Blue', teal: 'Teal', amber: 'Amber', rose: 'Rose', gray: 'Gray' };
  const node = (tag, className, text) => { const result = document.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = text; return result; };
  const button = (text, run, className = '') => { const result = node('button', className, text); result.type = 'button'; result.onclick = run; return result; };
  const field = (title, control) => { const result = node('label', 'ap-field'); result.append(node('span', '', title), control); return result; };
  let returnFocus = null, activeFolder = '';
  const dialog = node('dialog', 'ap-dialog'); dialog.id = 'android-project-dialog';
  dialog.setAttribute('aria-labelledby', 'ap-dialog-title'); document.body.append(dialog);
  const allProjects = () => model.projects(data);
  const findProject = folder => allProjects().find(project => project.folder === folder);
  const commit = message => { save(); render(); sync(); if (message) notify(message); };
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => {
    activeFolder = '';
    if ((document.activeElement === document.body || document.activeElement === dialog) && returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); });
  function shell(title, description) {
    returnFocus = dialog.open ? returnFocus : document.activeElement;
    window.NotejectMobile?.closeMenu?.();
    dialog.replaceChildren();
    const heading = node('header', 'ap-dialog-head'), copy = node('div');
    const h2 = node('h2', '', title); h2.id = 'ap-dialog-title';
    copy.append(node('small', '', 'PROJECTS'), h2);
    const dismiss = button('×', close, 'ap-close'); dismiss.setAttribute('aria-label', 'Close project menu');
    heading.append(copy, dismiss); dialog.append(heading);
    if (description) dialog.append(node('p', 'ap-description', description));
    if (!dialog.open) dialog.showModal();
  }
  function openProject(folder) { close(); openWorkspaceView('projects', { folder }); }
  function metadata(folder) {
    const project = findProject(folder); if (!project) return null;
    const workspace = model.ensureWorkspace(data);
    let meta = workspace.projects.find(item => item.folder === folder);
    if (!meta) { meta = { id: id(), folder, name: project.name, description: project.description, color: project.color, boardIds: [...project.boardIds] }; workspace.projects.push(meta); }
    return meta;
  }
  function editProject(folder) {
    const project = findProject(folder); if (!project) return;
    activeFolder = folder;
    shell('Edit project', 'Rename your project, choose a color, and manage its linked boards.');
    const form = node('form', 'ap-project-form');
    const name = node('input'); name.name = 'name'; name.value = project.folder; name.maxLength = 80; name.required = true; name.autocomplete = 'off';
    const description = node('textarea'); description.name = 'description'; description.value = project.description; description.maxLength = 1000; description.rows = 3;
    const color = node('select'); color.name = 'color';
    for (const [value, title] of Object.entries(colors)) { const option = node('option', '', title); option.value = value; color.append(option); } color.value = project.color;
    const boards = node('fieldset', 'ap-linked-boards'); boards.append(node('legend', '', 'Linked boards'));
    if (!data.boards.length) boards.append(node('p', '', 'Create a board to link it to this project.'));
    for (const board of data.boards) {
      const row = node('label'), check = node('input'); check.type = 'checkbox'; check.name = 'board'; check.value = board.id;
      check.checked = project.boardIds.includes(board.id) || board.folder === folder;
      check.disabled = board.folder === folder;
      row.append(check, node('span', '', board.name + (check.disabled ? ' · belongs to this project' : ''))); boards.append(row);
    }
    const error = node('p', 'ap-form-error'); error.hidden = true; error.setAttribute('role', 'alert');
    const actions = node('footer', 'ap-form-actions'), submit = node('button', 'primary', 'Save project'); submit.type = 'submit';
    actions.append(button('Cancel', close, 'secondary'), submit);
    form.append(field('Project name', name), field('Description', description), field('Color', color), boards, error, actions);
    name.oninput = () => name.setCustomValidity('');
    form.onsubmit = event => {
      event.preventDefault();
      if (!findProject(folder)) { error.textContent = 'This project no longer exists.'; error.hidden = false; return; }
      const next = name.value.trim(), duplicate = allProjects().find(item => item.folder !== folder && item.folder.toLocaleLowerCase() === next.toLocaleLowerCase());
      if (!next || next.toLocaleLowerCase() === 'inbox' || duplicate) {
        name.setCustomValidity(!next ? 'Enter a project name.' : duplicate ? 'A project with this name already exists.' : 'Inbox is reserved. Choose another name.'); name.reportValidity(); return;
      }
      const meta = metadata(folder);
      meta.name = next; meta.description = description.value.trim(); meta.color = color.value;
      meta.boardIds = [...boards.querySelectorAll('input:checked')].map(input => input.value);
      if (next !== folder) {
        window.NotejectWorkspaceNavigation.renameFolder(data, folder, next);
        if (noteFolder === folder) noteFolder = next;
        if (libraryFolder === folder) libraryFolder = next;
        workspaceOrganizer.openProject(next);
      }
      close(); commit('Project saved');
    };
    dialog.append(form); name.focus({ preventScroll: true });
  }
  function deleteProject(folder) {
    const project = findProject(folder); if (!project) return;
    activeFolder = folder;
    shell('Delete “' + project.name + '”?', 'Notes and documents move to Inbox. Boards and original files are kept. Restore the project from Trash if needed.');
    const actions = node('footer', 'ap-form-actions');
    actions.append(button('Cancel', close, 'secondary'), button('Delete project', () => {
      const result = model.deleteProject(data, folder); if (!result) { close(); return; }
      workspacePageApp.trashProject?.(result.snapshot);
      if (noteFolder === folder) noteFolder = 'All notes';
      if (libraryFolder === folder) libraryFolder = 'All documents';
      workspaceOrganizer.openProject(''); close(); commit('Project moved to Trash; its content is kept');
    }, 'ap-danger'));
    dialog.append(actions);
  }
  function showMenu(folder) {
    const project = findProject(folder); if (!project) return;
    activeFolder = folder;
    shell(project.name, [project.noteCount + ' notes', project.documentCount + ' documents', project.boardCount + ' boards'].join(' · '));
    const actions = node('div', 'ap-menu-actions');
    actions.append(
      button('▣ Open project', () => openProject(folder)),
      button('✎ Edit name, color & boards', () => editProject(folder)),
      button('＋ New note in this project', () => { close(); window.NotejectAndroidNotesUI.newNote({ folder }); }),
      button('＋ Import files into this project', () => { close(); openWorkspaceView('library', { folder }); void action('import'); }),
      button('▤ Project notes', () => { close(); openWorkspaceView('notes', { folder }); }),
      button('▣ Project documents', () => { close(); openWorkspaceView('library', { folder }); }),
      button('⇩ Export project', () => { close(); exportProject(folder); }),
      button('Delete project', () => deleteProject(folder), 'ap-danger')
    );
    dialog.append(actions);
  }
  async function exportProject(folder) {
    // Existing portable board export includes the project sources and linked notes.
    const project = findProject(folder); if (!project) return;
    const items = model.projectItems(data, project);
    const temporaryBoard = {
      id: 'project-export-' + id(), name: project.name, description: project.description,
      items: items.filter(item => item.kind !== 'board').map((item, index) => ({ type: item.kind === 'document' ? 'doc' : 'note', id: item.id, x: (index % 3) * 300, y: Math.floor(index / 3) * 240 })), edges: []
    };
    try { await exportBoardReadingPage(temporaryBoard); } catch (error) { notify(error.message || 'Could not export this project'); }
  }
  function syncPage() {
    if (view !== 'projects') return;
    const page = document.querySelector('.workspace-organizer[data-wo-view="projects"]'); if (!page) return;
    // The mobile project creator keeps details and board links together.
    for (const card of page.querySelectorAll('.wo-project-card')) {
      if (card.dataset.apPrepared) continue; card.dataset.apPrepared = 'true';
      const folder = card.querySelector('[data-wo-folder]')?.dataset.woFolder; if (!folder) continue;
      const actions = card.querySelector('.workspace-actions');
      actions?.replaceChildren(button('Open project →', () => openProject(folder), 'workspace-small-button'), button('⋯ Manage', () => showMenu(folder), 'workspace-small-button'));
    }
    const details = page.querySelector('.wo-project-details'), actions = page.querySelector('.wo-project-actions');
    if (actions && !actions.dataset.apPrepared) {
      const folder = actions.querySelector('[data-wo-folder]')?.dataset.woFolder;
      if (folder) {
        actions.dataset.apPrepared = 'true';
        actions.replaceChildren(button('＋ New note', () => window.NotejectAndroidNotesUI.newNote({ folder }), 'primary'), button('⋯ Manage project', () => showMenu(folder), 'secondary'));
        if (details) details.hidden = true;
      }
    }
    const grid = page.querySelector('.workspace-card-grid');
    if (grid && !page.querySelector('[data-ap-sort]')) {
      const select = node('select'); select.dataset.apSort = 'true'; select.setAttribute('aria-label', 'Sort projects');
      for (const [value, title] of [['name', 'Name A–Z'], ['notes', 'Most notes'], ['files', 'Most documents']]) { const option = node('option', '', title); option.value = value; select.append(option); }
      select.onchange = () => {
        const projects = allProjects();
        const byCard = card => projects.find(item => item.folder === card.querySelector('[data-wo-folder]')?.dataset.woFolder);
        const cards = [...grid.children];
        cards.sort((a, b) => { const left = byCard(a), right = byCard(b); return (select.value === 'notes' ? (right?.noteCount || 0) - (left?.noteCount || 0) : select.value === 'files' ? (right?.documentCount || 0) - (left?.documentCount || 0) : 0) || (left?.name || '').localeCompare(right?.name || ''); });
        grid.append(...cards);
      };
      page.querySelector('.workspace-filterbar')?.append(select);
    }
  }
  function sync() { syncPage(); }
  document.addEventListener('click', event => {
    const rename = event.target.closest('.workspace-organizer [data-wo-action="rename-project-folder"]');
    const remove = event.target.closest('.workspace-organizer [data-wo-action="delete-project"]');
    const control = rename || remove; if (!control) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (rename) editProject(control.dataset.woFolder); else deleteProject(control.dataset.woFolder);
  }, true);
  window.NotejectAndroidProjectsUI = Object.freeze({ sync, showMenu, getModal: () => dialog.open ? dialog : null, handleBack() { if (!dialog.open) return false; close(); return true; } });
})();
