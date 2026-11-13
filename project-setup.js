/* Guided project creation, reusable workflows, and local setup preferences. */
(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./project-workflow.js') : root.NotejectProjectWorkflow);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectProjectSetup = api;
})(typeof window === 'object' ? window : null, function (workflow) {
  'use strict';
  const mobile = typeof window === 'object' && !!window.NotejectAndroid;
  const array = value => Array.isArray(value) ? value : [];
  const text = value => String(value == null ? '' : value);
  const escape = value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const label = value => text(value).charAt(0).toUpperCase() + text(value).slice(1);
  const checked = value => value ? ' checked' : '';
  const disabled = value => value ? ' disabled' : '';
  const option = (value, name, current, inactive = false) => '<option value="' + escape(value) + '"' + (value === current ? ' selected' : '') + disabled(inactive) + '>' + escape(name) + '</option>';
  const action = (id, name, extra = '') => '<button type="button" class="workspace-small-button" data-ps-action="' + id + '" ' + extra + '>' + escape(name) + '</button>';
  const STEPS = ['Details', 'Starter content', 'Board & links', 'Review & defaults'];

  function create(app, callbacks = {}) {
    let draft = null, step = 0, error = '', saving = false, saveAsDefault = false;
    let profileName = '', selectedProfile = '', activeForm = null, pageRoot = null;
    const data = () => app.getData();
    const workspace = () => {
      const value = data();
      if (!value.workspace || typeof value.workspace !== 'object' || Array.isArray(value.workspace)) value.workspace = {};
      return value.workspace;
    };
    const profiles = () => array(workspace().projectCreationPresets).filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.settings && typeof item.settings === 'object');
    const boards = () => array(data().boards).filter(board => board && board.id).slice().sort((a, b) => text(a.name).localeCompare(text(b.name)));
    function open(options = {}) {
      const defaults = workspace().projectCreationDefaults || workflow.defaultConfig();
      draft = workflow.normalizeConfig({ ...defaults, ...(options.openAfter ? { openAfter: options.openAfter } : {}) });
      step = 0; error = ''; saving = false; saveAsDefault = false; profileName = ''; selectedProfile = '';
    }
    function capture(form) {
      const values = new FormData(form);
      draft = workflow.normalizeConfig({
        ...draft, name: values.get('name'), description: values.get('description'),
        color: values.get('color'), noteColor: values.get('noteColor'), tags: values.get('tags'),
        starterNotes: values.getAll('starterNotes'), tasks: values.get('tasks'), dueDate: values.get('dueDate'),
        createBoard: values.has('createBoard'), boardName: values.has('boardName') ? values.get('boardName') : draft.boardName,
        boardLayout: values.has('boardLayout') ? values.get('boardLayout') : draft.boardLayout,
        linkBoardIds: values.getAll('linkBoardIds'), pinOverview: values.has('pinOverview'),
        openAfter: values.get('openAfter') || draft.openAfter
      });
      saveAsDefault = values.has('saveAsDefault');
      profileName = text(values.get('profileName')).trim().slice(0, 80);
    }
    function summary() {
      const info = workflow.preview(draft), preset = workflow.presets.find(item => item.id === draft.workflow);
      const destination = workflow.destinations.find(item => item.id === draft.openAfter);
      return '<div class="ps-review-title"><small>PROJECT PREVIEW</small><strong>' + escape(draft.name || 'Your new project') + '</strong></div>' +
        '<p>' + escape(preset.name) + ' workflow · ' + escape(label(draft.color)) + '</p>' +
        (draft.description ? '<p>' + escape(draft.description.slice(0, 180)) + (draft.description.length > 180 ? '…' : '') + '</p>' : '') +
        '<div class="ps-metrics">' + (mobile ? [[info.notes, 'Starter notes'], [info.boards, 'New boards']] : [[info.notes, 'Starter notes'], [info.boards, 'New boards'], [info.tasks, 'Tasks']]).map(([count, name]) => '<div><strong>' + count + '</strong><span>' + name + '</span></div>').join('') + '</div>' +
        '<ul class="ps-summary-list"><li><strong>Notes:</strong> ' + escape(info.noteTitles.join(', ') || 'Start with an empty project') + '</li>' +
        (draft.createBoard ? '<li><strong>Board:</strong> ' + escape(draft.boardName || (draft.name || 'Project') + ' · Board') + ' · ' + escape(draft.boardLayout === 'columns' ? 'Columns' : 'Grid') + '</li>' : '') +
        (info.linkedBoards ? '<li><strong>Linked boards:</strong> ' + info.linkedBoards + '</li>' : '') +
        (draft.tags.length ? '<li><strong>Tags:</strong> ' + escape(draft.tags.map(tag => '#' + tag).join(' ')) + '</li>' : '') +
        (info.notes ? '<li><strong>Note color:</strong> ' + escape(draft.noteColor === 'project' ? label(draft.color) : label(draft.noteColor)) + (draft.pinOverview ? ' · First note favorited' : '') + '</li>' : '') +
        (draft.dueDate && info.tasks ? '<li><strong>Task deadline:</strong> ' + escape(draft.dueDate) + '</li>' : '') +
        '<li><strong>Then open:</strong> ' + escape(destination.name) + '</li></ul><p>Everything is created on this device.</p>';
    }
    function detailsPanel() {
      const saved = profiles();
      return '<h3 tabindex="-1">Make space for your next project</h3><div class="ps-default-actions">' +
        action('load-defaults', 'Use saved defaults', disabled(!workspace().projectCreationDefaults)) + action('reset', 'Use recommended settings') + '</div>' +
        (saved.length ? '<label>Saved workflow<select data-ps-profile>' + option('', 'Choose a saved workflow…', selectedProfile) + saved.map(item => option(item.id, item.name, selectedProfile)).join('') + '</select></label>' : '') +
        '<div class="ps-grid"><label class="ps-wide">Project name<input name="name" maxlength="80" value="' + escape(draft.name) + '" placeholder="For example: Space research" autocomplete="off" aria-describedby="ps-error"></label>' +
        '<label class="ps-wide">Goal or description<textarea name="description" maxlength="3000" rows="3" placeholder="What do you want to accomplish?">' + escape(draft.description) + '</textarea></label>' +
        '<label class="ps-wide">Project tags<input name="tags" value="' + escape(draft.tags.join(', ')) + '" placeholder="research, physics, ideas"><small class="ps-hint">Added to the project, its starter notes, and its new board.</small></label>' +
        '<fieldset class="ps-wide"><legend>Project color</legend><div class="ps-colors">' + workflow.colors.map(color => '<label class="ps-color-label"><input type="radio" name="color" value="' + color + '"' + checked(draft.color === color) + '><i data-color="' + color + '" aria-hidden="true"></i><span>' + label(color) + '</span></label>').join('') + '</div></fieldset>' +
        '<label>Starter note color<select name="noteColor">' + option('project', 'Match project color', draft.noteColor) + workflow.colors.map(color => option(color, label(color), draft.noteColor)).join('') + '</select></label></div>';
    }
    function starterPanel() {
      return '<h3 tabindex="-1">Choose a workflow, then make it yours</h3><p class="ps-hint">' + (mobile ? 'Choose starter notes and a board layout for this project.' : 'Choosing a starting workflow fills in recommended notes, tasks, and board settings.') + '</p>' +
        '<div class="ps-workflow-grid">' + workflow.presets.map(preset => '<label class="ps-preset"><input type="radio" name="workflow" value="' + preset.id + '"' + checked(draft.workflow === preset.id) + '><span><strong>' + escape(preset.icon + ' ' + preset.name) + '</strong><small>' + escape(preset.description) + '</small></span></label>').join('') + '</div>' +
        '<fieldset><legend>Starter notes</legend><div class="ps-check-list">' + workflow.starterNotes.map(starter => '<label class="ps-check"><input type="checkbox" name="starterNotes" value="' + starter.id + '"' + checked(draft.starterNotes.includes(starter.id)) + '><span><strong>' + escape(starter.name) + '</strong><small>' + escape(starter.description) + '</small></span></label>').join('') + '</div></fieldset>' +
        (mobile ? '' : '<label>Starter tasks · one per line<textarea name="tasks" rows="5" maxlength="50000" placeholder="Define the first milestone&#10;Collect source material&#10;Review the result">' + escape(draft.tasks) + '</textarea><small class="ps-hint">Adding tasks creates a Tasks note and makes the checklist available in Tasks.</small></label>' +
        '<label>Starter task deadline · optional<input name="dueDate" type="date" value="' + escape(draft.dueDate) + '"><small class="ps-hint">Applies to the checklist tasks created by this setup.</small></label>') +
        '<label class="ps-check"><input type="checkbox" name="pinOverview"' + checked(draft.pinOverview) + '><span><strong>Favorite the first starter note</strong><small>Keep the project’s starting point close in Favorites.</small></span></label>';
    }
    function boardPanel() {
      const available = boards();
      return '<h3 tabindex="-1">Connect the project on a board</h3><label class="ps-check"><input type="checkbox" name="createBoard"' + checked(draft.createBoard) + '><span><strong>Create a project board</strong><small>Add the starter notes as connected cards.</small></span></label>' +
        '<div class="ps-board-options"' + (draft.createBoard ? '' : ' hidden') + '><label>Board name<input name="boardName" maxlength="180" value="' + escape(draft.boardName) + '" placeholder="' + escape((draft.name || 'Project') + ' · Board') + '"' + disabled(!draft.createBoard) + '></label>' +
        '<label>Starting layout<select name="boardLayout"' + disabled(!draft.createBoard) + '>' + workflow.layouts.map(item => option(item.id, item.name, draft.boardLayout)).join('') + '</select></label></div>' +
        '<fieldset><legend>Link existing boards · optional</legend><p class="ps-hint">See these boards alongside this project.</p>' +
        (available.length ? '<input type="search" data-ps-board-search aria-label="Find an existing board" placeholder="Find a board…"><div class="ps-check-list ps-linked-boards">' + available.map(board => '<label class="ps-check" data-ps-board-name="' + escape(text(board.name).toLocaleLowerCase()) + '"><input type="checkbox" name="linkBoardIds" value="' + escape(board.id) + '"' + checked(draft.linkBoardIds.includes(board.id)) + '><span><strong>' + escape(board.name || 'Untitled board') + '</strong><small>' + array(board.items).length + ' cards' + (board.folder ? ' · ' + escape(board.folder) : '') + '</small></span></label>').join('') + '</div><p class="ps-hint" data-ps-no-boards hidden>No boards match this search.</p>' : '<p class="ps-empty">Create a board with this setup, or link one later in Project details.</p>') + '</fieldset>' +
        '<div class="ps-storage-info"><strong>Project storage</strong><p>New project files use your storage location in Settings. Your setup stays here while you check it.</p>' + action('storage-settings', 'Storage settings ↗') + '</div>';
    }
    function reviewPanel() {
      const hasBoard = draft.createBoard || draft.linkBoardIds.some(id => boards().some(board => board.id === id));
      return '<h3 tabindex="-1">' + (mobile ? 'Review your project' : 'Review your automation') + '</h3><p class="ps-hint">' + (mobile ? 'Check the starter notes, board links, and where Noteject opens after setup.' : 'Creating the project adds your selected notes, checklist, and board in one step. Check the preview before you create it.') + '</p>' +
        '<label>After creating the project, open<select name="openAfter">' + workflow.destinations.map(item => option(item.id, item.name, draft.openAfter, item.id === 'board' && !hasBoard)).join('') + '</select><small class="ps-hint">Choose a new board or link an existing board to open directly on a board.</small></label>' +
        '<fieldset><legend>Reuse this setup</legend><label>Save workflow as · optional<input name="profileName" maxlength="80" value="' + escape(profileName) + '" placeholder="For example: My research workflow"></label><p class="ps-hint">Save these choices for your next project. Each project gets its own name, goal, deadline, and board links.</p>' +
        '<label class="ps-check"><input type="checkbox" name="saveAsDefault"' + checked(saveAsDefault) + '><span><strong>Use these settings for future projects</strong><small>Start New project with these choices filled in.</small></span></label>' +
        '<div class="ps-default-actions">' + action('save-workflow', 'Save workflow') + (selectedProfile ? action('delete-workflow', 'Remove saved workflow') : '') + (workspace().projectCreationDefaults ? action('clear-defaults', 'Clear saved defaults') : '') + '</div></fieldset>';
    }
    function render() {
      if (!draft) open();
      const validBoards = new Set(boards().map(board => board.id));
      draft.linkBoardIds = draft.linkBoardIds.filter(id => validBoards.has(id));
      if (draft.openAfter === 'board' && !draft.createBoard && !draft.linkBoardIds.length) draft.openAfter = 'project';
      const panels = [detailsPanel(), starterPanel(), boardPanel(), reviewPanel()];
      return '<form class="project-setup" data-ps-form novalidate aria-label="New project setup"><header class="ps-header"><div><h2>New project</h2><p>' + (mobile ? 'Name your project and choose its boards.' : 'Choose what gets created, connect your boards, and save a workflow for next time.') + '</p></div><span class="ps-badge">✧ Smart setup · On this device</span></header>' +
        '<nav class="ps-step-tabs" aria-label="Project setup steps">' + STEPS.map((name, index) => '<button type="button" data-ps-step="' + index + '"' + (index === step ? ' aria-current="step"' : '') + ' aria-controls="ps-panel-' + index + '"><span>' + (index + 1) + '</span> ' + escape(name) + '</button>').join('') + '</nav>' +
        '<div class="ps-layout"><div class="ps-main">' + panels.map((html, index) => '<section class="ps-panel" id="ps-panel-' + index + '" data-ps-panel="' + index + '"' + (index === step ? '' : ' hidden') + '>' + html + '</section>').join('') + '</div>' +
        '<aside class="ps-review" data-ps-review aria-label="Project creation preview">' + summary() + '</aside></div>' +
        '<div class="ps-error" id="ps-error" role="alert" tabindex="-1"' + (error ? '' : ' hidden') + '>' + escape(error) + '</div>' +
        '<footer class="ps-footer">' + action('cancel', 'Cancel') + (step ? action('back', '← Back') : '') +
        '<button type="submit" class="primary"' + disabled(saving) + '>' + (saving ? 'Creating…' : step === STEPS.length - 1 ? 'Create project' : 'Next →') + '</button></footer></form>';
    }
    function redraw(selector) {
      if (!activeForm?.isConnected) { app.render(); return; }
      activeForm.outerHTML = render();
      mount(pageRoot);
      const focus = activeForm.querySelector(selector || '[data-ps-panel="' + step + '"] h3');
      focus?.focus({ preventScroll: true });
    }
    function updatePreview(form) {
      const preview = form.querySelector('[data-ps-review]');
      if (preview) preview.innerHTML = summary();
    }
    function showError(message, field) {
      error = message;
      const notice = activeForm.querySelector('#ps-error');
      notice.textContent = message; notice.hidden = !message;
      activeForm.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
      if (field) { const input = activeForm.querySelector('[name="' + field + '"]'); input?.setAttribute('aria-invalid', 'true'); input?.focus(); }
      else if (message) notice.focus();
    }
    function applySettings(settings) {
      draft = workflow.normalizeConfig({ ...settings, name: draft.name, description: draft.description });
      error = ''; redraw('[name="name"]');
    }
    function savePreferences(requireName = false) {
      const store = workspace(), reusable = workflow.reusableDefaults(draft);
      if (requireName && !profileName) { showError('Give this workflow a name before saving it.', 'profileName'); return false; }
      if (profileName) {
        if (!Array.isArray(store.projectCreationPresets)) store.projectCreationPresets = [];
        const existing = store.projectCreationPresets.find(item => item && text(item.name).toLocaleLowerCase() === profileName.toLocaleLowerCase());
        const preset = { id: existing?.id || app.makeId(), name: profileName, settings: reusable };
        if (existing) Object.assign(existing, preset); else store.projectCreationPresets.push(preset);
        selectedProfile = preset.id;
      }
      if (saveAsDefault) store.projectCreationDefaults = reusable;
      return true;
    }
    function submitProject() {
      if (saving) return;
      const current = data(), validated = workflow.validate(current, draft);
      if (!validated.valid) { step = 0; error = validated.errors[0]; redraw('[name="name"]'); activeForm.querySelector('[name="name"]').setAttribute('aria-invalid', 'true'); return; }
      let plan;
      try { plan = workflow.build(current, draft, app.makeId); }
      catch (problem) { showError(problem.message || 'Could not prepare this project.'); return; }
      saving = true;
      activeForm.querySelector('button[type="submit"]').disabled = true;
      try {
        // Prepare every artifact before creating storage, so validation never leaves a partial setup.
        const result = app.createFolder(plan.config.name);
        if (!result?.folder || !result.created) throw new Error('A project with this name already exists. Choose another name.');
        current.notes = [...plan.notes, ...array(current.notes)];
        current.boards = [...(plan.board ? [plan.board] : []), ...array(current.boards)];
        const store = workspace();
        store.projects = [...array(store.projects), plan.project];
        if (!mobile) store.taskMeta = { ...(store.taskMeta || {}), ...plan.taskMeta };
        savePreferences();
        app.save();
      } catch (problem) {
        saving = false;
        activeForm.querySelector('button[type="submit"]').disabled = false;
        showError(problem.message || 'Could not create this project. Your setup is kept here.');
        return;
      }
      callbacks.onCreated?.(plan);
      draft = null; activeForm = null; saving = false;
      if (plan.primary.kind === 'board') app.openItem({ kind: 'board', id: plan.primary.id });
      else app.openView(plan.primary.kind === 'documents' ? 'library' : plan.primary.kind === 'project' ? 'projects' : plan.primary.kind, { folder: plan.config.name });
      app.notify(mobile ? 'Project created' + (plan.board ? ' with a board.' : '.') : 'Project created with ' + plan.notes.length + ' starter note' + (plan.notes.length === 1 ? '' : 's') + (plan.board ? ' and a connected board.' : '.'));
    }
    function mount(container) {
      pageRoot = container || document;
      activeForm = pageRoot.querySelector('[data-ps-form]');
      if (!activeForm) return;
      const form = activeForm;
      form.oninput = event => {
        if (event.target.matches('[data-ps-board-search]')) {
          const query = event.target.value.trim().toLocaleLowerCase();
          const rows = [...form.querySelectorAll('[data-ps-board-name]')];
          rows.forEach(row => { row.hidden = !row.dataset.psBoardName.includes(query); });
          form.querySelector('[data-ps-no-boards]').hidden = rows.some(row => !row.hidden);
          return;
        }
        capture(form);
        if (event.target.name === 'tasks' && draft.tasks && !draft.starterNotes.includes('tasks')) {
          draft.starterNotes.push('tasks');
          form.querySelector('[name="starterNotes"][value="tasks"]').checked = true;
        }
        updatePreview(form);
        if (error) showError('');
      };
      form.onchange = event => {
        capture(form);
        if (event.target.name === 'workflow') {
          const recommended = workflow.defaultConfig(event.target.value);
          draft = workflow.normalizeConfig({ ...draft, workflow: recommended.workflow, starterNotes: recommended.starterNotes, tasks: recommended.tasks, createBoard: recommended.createBoard });
          redraw('[name="workflow"][value="' + draft.workflow + '"]'); return;
        }
        if (event.target.name === 'starterNotes' && event.target.value === 'tasks' && !event.target.checked) {
          draft.tasks = ''; redraw('[name="starterNotes"][value="tasks"]'); return;
        }
        if (event.target.name === 'createBoard') { redraw('[name="createBoard"]'); return; }
        if (event.target.matches('[data-ps-profile]')) {
          selectedProfile = event.target.value;
          const selected = profiles().find(item => item.id === selectedProfile);
          if (selected) { profileName = selected.name; applySettings(selected.settings); }
          return;
        }
        updatePreview(form);
      };
      form.onclick = event => {
        const control = event.target.closest('[data-ps-action],[data-ps-step]');
        if (!control || !form.contains(control)) return;
        capture(form);
        if (control.hasAttribute('data-ps-step')) { step = Math.max(0, Math.min(STEPS.length - 1, Number(control.dataset.psStep) || 0)); error = ''; redraw(); return; }
        const name = control.dataset.psAction;
        if (name === 'cancel') { draft = null; activeForm = null; callbacks.onCancel?.(); return; }
        if (name === 'back') { step = Math.max(0, step - 1); error = ''; redraw(); return; }
        if (name === 'load-defaults') { selectedProfile = ''; profileName = ''; applySettings(workspace().projectCreationDefaults || workflow.defaultConfig()); return; }
        if (name === 'reset') { selectedProfile = ''; profileName = ''; applySettings(workflow.defaultConfig(draft.workflow)); return; }
        if (name === 'storage-settings') { app.openView('settings'); return; }
        if (name === 'save-workflow') {
          if (!savePreferences(true)) return;
          app.save(); app.notify('Workflow saved for your next project.'); redraw('[name="profileName"]'); return;
        }
        if (name === 'delete-workflow') {
          workspace().projectCreationPresets = profiles().filter(item => item.id !== selectedProfile);
          selectedProfile = ''; profileName = ''; app.save(); app.notify('Saved workflow removed.'); redraw(); return;
        }
        if (name === 'clear-defaults') { delete workspace().projectCreationDefaults; saveAsDefault = false; app.save(); app.notify('Future projects will use the recommended settings.'); redraw(); }
      };
      form.onsubmit = event => {
        event.preventDefault(); capture(form);
        if (step < STEPS.length - 1) {
          if (step === 0) { const result = workflow.validate(data(), draft); if (!result.valid) { showError(result.errors[0], 'name'); return; } }
          step++; error = ''; redraw(); return;
        }
        submitProject();
      };
    }
    return { open, render, mount };
  }
  return { create };
});
