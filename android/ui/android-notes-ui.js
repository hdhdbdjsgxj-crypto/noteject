/* Android note screens. Shared note fields and their Save/format handlers stay intact. */
(() => {
  'use strict';
  if (!window.NotejectAndroid) return;
  const compact = matchMedia('(max-width: 959px)');
  const colors = { violet: 'Violet', blue: 'Blue', teal: 'Teal', amber: 'Amber', rose: 'Rose', gray: 'Gray' };
  let selectionMode = false;
  let previousList = null;
  const setClass = (node, name, value) => {
    if (node.classList.contains(name) !== !!value) node.classList.toggle(name, !!value);
  };
  const button = (text, className) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function keepCurrentDraft() {
    const editor = document.getElementById('edit-body'), title = document.getElementById('edit-title');
    const note = data.notes.find(item => item.id === data.selected?.id);
    if (!editor || !title || !note) return true;
    const values = {};
    for (const fieldId of ['edit-title', 'edit-body', 'edit-note-color', 'edit-note-folder', 'edit-note-tags']) values[fieldId] = document.getElementById(fieldId)?.value || '';
    const tags = values['edit-note-tags'].split(',').map(value => value.trim().replace(/^#/, '')).filter(Boolean);
    if (editor.value === note.content && title.value === note.title && values['edit-note-color'] === (note.color || 'violet') && values['edit-note-folder'] === (note.folder || 'Inbox') && tags.join(',') === (note.tags || []).join(',')) return true;
    try {
      localStorage.setItem('noteject-android-note-draft-v1:' + note.id, JSON.stringify({ version: 1, savedAt: Date.now(), values }));
      return true;
    } catch {
      notify('Draft storage is full. Save this note before opening another one.');
      return false;
    }
  }
  function editNote(noteId, options = {}) {
    const note = data.notes.find(item => item.id === noteId);
    if (!note || !keepCurrentDraft()) return false;
    if (data.selected?.id === noteId && document.getElementById('edit-body')) {
      document.getElementById('edit-body').focus({ preventScroll: true }); return true;
    }
    if (data.selected?.id === noteId && document.querySelector('#view .detail-panel #note-display')) {
      edit(note); sync(); document.getElementById('edit-body')?.focus({ preventScroll: true }); return true;
    }
    if (!(options.keepContext && view === 'board')) {
      view = 'notes'; noteFolder = 'All notes'; noteFavorites = false; noteRecent = false; noteArchived = !!note.archived;
      query = ''; const search = document.getElementById('search'); if (search) search.value = '';
    }
    // The shared editor keeps Save, undo, formatting, and note/project persistence intact.
    data.selected = { type: 'note', id: note.id }; render(); edit(note); sync();
    document.getElementById('edit-body')?.focus({ preventScroll: true });
    return true;
  }
  async function newNote(options = {}) {
    if (!keepCurrentDraft()) return null;
    const boardId = options.board === true ? activeBoard()?.id : typeof options.board === 'string' ? options.board : null;
    const requestedFolder = options.folder || (view === 'notes' && noteFolder !== 'All notes' ? noteFolder : 'Inbox');
    const folders = [...new Set(['Inbox', ...(data.folders || []), ...(data.noteFolders || []), ...Object.keys(data.folderProjects || {}), ...(data.workspace?.projects || []).map(project => project.folder), ...data.notes.map(note => note.folder), ...data.docs.map(doc => doc.folder)].filter(name => typeof name === 'string' && name.trim()))];
    const folder = folders.includes(requestedFolder) ? requestedFolder : 'Inbox';
    // Home deliberately hides its desktop content; create on the Notes screen so
    // the editor can always receive focus and Android's keyboard.
    view = 'notes'; noteFolder = folder; noteFavorites = false; noteRecent = false; noteArchived = false;
    query = ''; const search = document.getElementById('search'); if (search) search.value = '';
    await action('new-note');
    const note = data.notes.find(item => item.id === data.selected?.id);
    if (!note) return null;
    if (boardId && data.boards.some(board => board.id === boardId)) {
      placeNotesOnBoard([note.id], boardId);
      data.selected = { type: 'note', id: note.id }; render(); edit(note);
    }
    // Apply the destination's visibility before focus; the shell's animation-frame
    // sync otherwise leaves the Home-only display rule active for this gesture.
    document.body.dataset.amPage = view;
    selectionMode = false; selectedNotes.clear(); updateNoteSelectionUI(); sync();
    const title = document.getElementById('edit-title'); title?.focus({ preventScroll: true }); title?.select();
    return note;
  }
  function deleteNote(noteId) {
    const note = data.notes.find(item => item.id === noteId);
    if (!note || document.querySelector('.an-note-delete-dialog')) return;
    const dialog = document.createElement('dialog'); dialog.className = 'an-note-delete-dialog';
    dialog.setAttribute('aria-labelledby', 'an-note-delete-title');
    const heading = document.createElement('h2'); heading.id = 'an-note-delete-title'; heading.textContent = 'Delete note?';
    const name = document.createElement('strong'); name.textContent = note.title || 'Untitled note';
    const copy = document.createElement('p'); copy.textContent = 'This note and its board cards will move to Trash. You can restore them later.';
    const controls = document.createElement('div'); controls.className = 'an-delete-actions';
    const cancel = button('Cancel', 'secondary'), remove = button('Delete note', 'danger-button');
    cancel.onclick = () => dialog.close();
    remove.onclick = () => {
      if (!trashWorkspaceItem('note', note.id)) { dialog.close(); return; }
      selectedNotes.delete(note.id); if (data.selected?.type === 'note' && data.selected.id === note.id) data.selected = null;
      dialog.close(); save(); render(); notify('Note moved to Trash');
    };
    controls.append(cancel, remove); dialog.append(heading, name, copy, controls);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  }
  function backButton(close) {
    if (!close) return;
    close.classList.add('an-note-back');
    close.setAttribute('aria-label', 'Close note');
    close.title = 'Close note';
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14"/></svg>';
  }
  function syncTabs(panel) {
    const preview = panel.querySelector('#note-preview');
    if (!preview) return;
    const isPreview = !preview.hidden;
    panel.querySelectorAll('[data-an-note-tab]').forEach(tab => {
      const active = (tab.dataset.anNoteTab === 'preview') === isPreview;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    setClass(panel, 'an-preview-active', isPreview);
  }
  function updateCount(panel) {
    const field = panel.querySelector('#edit-body'), count = panel.querySelector('.an-note-wordcount');
    if (!field || !count) return;
    const text = field.value.trim(), words = text ? text.split(/\s+/u).length : 0;
    const next = words + (words === 1 ? ' word' : ' words');
    if (count.textContent !== next) count.textContent = next;
  }
  function enhanceMeta(panel, footer) {
    const meta = panel.querySelector('.note-meta-edit');
    if (!meta) return;
    let details = meta.closest('.am-note-details');
    if (!details) {
      details = document.createElement('details'); details.className = 'am-note-details';
      const summary = document.createElement('summary'); summary.textContent = 'Project, color & tags';
      meta.before(details); details.append(summary, meta);
    }
    if (details.parentElement !== footer) footer.prepend(details);
    const summary = details.querySelector('summary');
    if (summary && !summary.querySelector('.an-meta-description')) {
      summary.replaceChildren();
      const label = document.createElement('strong'); label.textContent = 'Note details';
      const value = document.createElement('span'); value.className = 'an-meta-description';
      summary.append(label, value);
    }
    const project = panel.querySelector('#edit-note-folder'), color = panel.querySelector('#edit-note-color');
    // Project creation and editing live in the Projects menu on Android.
    project?.querySelector('option[value="__create_note_folder__"]')?.remove();
    const description = summary?.querySelector('.an-meta-description');
    if (description) {
      const next = (project?.selectedOptions[0]?.textContent || 'Inbox') + ' · ' + (colors[color?.value] || 'Violet');
      if (description.textContent !== next) description.textContent = next;
    }
    if (color && !meta.querySelector('.an-color-picker')) {
      const picker = document.createElement('div'); picker.className = 'an-color-picker';
      picker.setAttribute('role', 'group'); picker.setAttribute('aria-label', 'Note color');
      Object.entries(colors).forEach(([value, name]) => {
        const swatch = button('', 'an-color-swatch'); swatch.dataset.color = value;
        swatch.setAttribute('aria-label', name); swatch.title = name;
        swatch.onclick = () => { color.value = value; color.dispatchEvent(new Event('change', { bubbles: true })); sync(); };
        picker.append(swatch);
      });
      color.hidden = true;
      color.parentElement.append(picker);
    }
    meta.querySelectorAll('.an-color-swatch').forEach(swatch => swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color?.value)));
  }
  function enhanceEditor(panel) {
    const editor = panel.querySelector('#edit-body');
    if (!editor) return;
    setClass(panel, 'an-note-view', false);
    setClass(panel, 'an-editor', true);
    if (!editor.dataset.anEditorReady) {
      editor.dataset.anEditorReady = 'true';
      const close = panel.querySelector('[data-action="close"]');
      const title = panel.querySelector('#edit-title');
      const save = panel.querySelector('[data-action="save-note"]');
      const toolbar = panel.querySelector('.note-format-toolbar');
      const preview = panel.querySelector('#note-preview');
      const originalToggle = panel.querySelector('#note-preview-toggle');
      const actions = panel.querySelector('.edit-actions');
      const header = document.createElement('header'); header.className = 'an-editor-header';
      const heading = document.createElement('strong'); heading.textContent = 'Edit note';
      backButton(close); if (close) header.append(close); header.append(heading);
      if (save) { save.textContent = 'Save'; header.append(save); }
      panel.prepend(header);
      if (title) {
        const label = document.createElement('label'); label.className = 'an-editor-title';
        const labelText = document.createElement('span'); labelText.textContent = 'Note title';
        title.setAttribute('aria-label', 'Note title'); title.autocomplete = 'off';
        title.before(label); label.append(labelText, title);
      }
      const controls = document.createElement('div'); controls.className = 'an-editor-controls';
      const tabs = document.createElement('div'); tabs.className = 'an-note-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Note view');
      for (const [target, text] of [['write', 'Write'], ['preview', 'Preview']]) {
        const tab = button(text); tab.dataset.anNoteTab = target;
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', target === 'write' ? 'edit-body' : 'note-preview');
        tab.onclick = () => {
          const wantPreview = target === 'preview';
          if (preview && !preview.hidden !== wantPreview) originalToggle?.click();
          syncTabs(panel);
          if (!wantPreview) editor.focus({ preventScroll: true });
        };
        tab.onkeydown = event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const next = target === 'write' ? tabs.lastElementChild : tabs.firstElementChild;
          next.focus(); next.click();
        };
        tabs.append(tab);
      }
      controls.append(tabs); toolbar?.before(controls);
      if (toolbar) {
        const more = document.createElement('details'); more.className = 'an-more-format';
        const summary = document.createElement('summary'); summary.textContent = 'More'; summary.setAttribute('aria-label', 'More formatting tools');
        const tools = document.createElement('div'); tools.className = 'an-more-format-tools';
        more.append(summary, tools);
        const addImage = panel.querySelector('[data-image]'); if (addImage) tools.append(addImage);
        for (const node of [...toolbar.children]) {
          if (node.matches('.format-spacer')) { node.remove(); continue; }
          if (node === originalToggle) { node.hidden = true; controls.append(node); continue; }
          if (!['bold', 'italic', 'bullet', 'check', 'sublist'].includes(node.dataset.format)) tools.append(node);
        }
        if (!tools.querySelector('.an-text-color-tools')) {
          const colors = document.createElement('div'); colors.className = 'an-text-color-tools'; colors.setAttribute('role', 'group'); colors.setAttribute('aria-label', 'Text highlight color');
          for (const [color, hex] of Object.entries({ violet: '#b79aff', blue: '#83baff', teal: '#6cdbc7', amber: '#f4cb77', rose: '#ee9cba', gray: '#b3bbca' })) {
            const swatch = button(color); swatch.dataset.anTextColor = color; swatch.setAttribute('aria-label', 'Highlight selected text ' + color); swatch.title = 'Highlight selected text ' + color; swatch.style.setProperty('--an-text-mark', hex); colors.append(swatch);
          }
          tools.append(colors);
          colors.addEventListener('click', event => {
            const swatch = event.target.closest('[data-an-text-color]'); if (!swatch) return;
            const start = editor.selectionStart, end = editor.selectionEnd;
            if (start === end) { notify('Select some note text first.'); editor.focus({ preventScroll: true }); return; }
            const selected = editor.value.slice(start, end), color = swatch.dataset.anTextColor;
            editor.setRangeText('=={' + color + '}' + selected + '==', start, end, 'select');
            editor.dispatchEvent(new Event('input', { bubbles: true })); editor.focus({ preventScroll: true });
          });
        }
        const names = { bold: 'Bold', italic: 'Italic', bullet: 'List', check: 'To-do', sublist: 'Indent', number: 'Numbered list', heading: 'Heading', quote: 'Quote', link: 'Note link', 'web-link': 'Add link' };
        toolbar.querySelectorAll('[data-format]').forEach(tool => {
          tool.textContent = names[tool.dataset.format] || tool.textContent;
          tool.setAttribute('aria-label', tool.title || tool.textContent);
        });
        tools.querySelectorAll('[data-format]').forEach(tool => { tool.textContent = names[tool.dataset.format] || tool.textContent; });
        toolbar.append(more); controls.append(toolbar);
        toolbar.addEventListener('pointerdown', event => {
          // Preserve the text selection when a touch formatting button receives focus.
          if (event.target.closest('button') && document.activeElement === editor) event.preventDefault();
        });
        tools.addEventListener('click', event => { if (event.target.closest('button')) more.open = false; });
      }
      const writing = document.createElement('div'); writing.className = 'an-writing-pane';
      editor.before(writing); writing.append(editor); if (preview) writing.append(preview);
      const visual = panel.querySelector('.note-visual-editor'); if (visual) writing.append(visual);
      editor.placeholder = 'Write your note…';
      editor.setAttribute('aria-label', 'Note text'); editor.spellcheck = false;
      editor.setAttribute('autocorrect', 'off'); editor.setAttribute('autocapitalize', 'off');
      const titleField = panel.querySelector('#edit-title');
      if (titleField) { titleField.spellcheck = false; titleField.setAttribute('autocorrect', 'off'); titleField.setAttribute('autocapitalize', 'off'); }
      const footer = document.createElement('footer'); footer.className = 'an-editor-footer'; panel.append(footer);
      const count = document.createElement('span'); count.className = 'an-note-wordcount';
      if (actions) { actions.append(count); footer.append(actions); }
      const originalStats = panel.querySelector('#note-editor-stats'); if (originalStats) originalStats.hidden = true;
      const tools = document.createElement('div'); tools.className = 'an-editor-tools';
      header.after(tools);
      const titleLabel = panel.querySelector('.an-editor-title');
      if (titleLabel) tools.append(titleLabel);
      tools.append(controls);
      const insertTools = panel.querySelector('.note-insert-tools'); if (insertTools) tools.append(insertTools);
      tools.append(footer);
      editor.addEventListener('input', () => updateCount(panel));
      editor.addEventListener('keydown', event => {
        if (event.key === 'Backspace' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && editor.selectionStart === editor.selectionEnd) {
          const before = editor.value.slice(0, editor.selectionStart), previousWord = before.match(/\s*\S+\s*$/u);
          if (previousWord) {
            event.preventDefault();
            editor.setRangeText('', editor.selectionStart - previousWord[0].length, editor.selectionEnd, 'end');
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
        if (event.key === 'Enter' && event.shiftKey && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const start = editor.selectionStart, end = editor.selectionEnd;
          const before = editor.value.slice(0, start), line = before.slice(before.lastIndexOf('\n') + 1);
          const match = line.match(/^(\s*)([-+*]|\d+[.)]) (\[([ xX])\] )?/);
          if (match) {
            event.preventDefault();
            const lineStart = start - line.length, taskMarker = match[3] ? match[3].replace(/\[[ xX]\]/, '[ ]') : '';
            const indent = match[1] + '  ';
            let nestedMarker = match[2];
            if (/^\d/.test(nestedMarker)) {
              const number = Number.parseInt(nestedMarker, 10), delimiter = nestedMarker.slice(-1);
              const previousLine = before.slice(0, Math.max(0, lineStart - 1)).split('\n').at(-1) || '';
              const previous = previousLine.match(/^\s*(\d+)[.)] /);
              nestedMarker = String(previous ? Number.parseInt(previous[1], 10) + 1 : number) + delimiter;
            }
            const replacement = '\n' + indent + nestedMarker + ' ' + taskMarker;
            editor.setRangeText(replacement, start, end, 'end');
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
        if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        const start = editor.selectionStart, end = editor.selectionEnd;
        if (start !== end) return;
        const before = editor.value.slice(0, start), line = before.slice(before.lastIndexOf('\n') + 1);
        const match = line.match(/^(\s*)([-+*]|\d+[.)]) (\[([ xX])\] )?/);
        if (!match) return;
        event.preventDefault();
        const marker = match[0], empty = line.slice(match[0].length).trim() === '';
        const nextMarker = /^\d/.test(match[2]) ? (Number.parseInt(match[2], 10) + 1) + match[2].slice(-1) : match[2];
        const replacement = empty ? '\n' : '\n' + match[1] + nextMarker + ' ' + (match[3] || '');
        const lineStart = start - line.length;
        editor.setRangeText(replacement, start, end, 'end');
        if (empty) editor.setRangeText('', lineStart, lineStart + marker.length, 'start');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      panel.querySelector('#edit-note-folder')?.addEventListener('change', sync);
      editor.addEventListener('focus', () => { panel.querySelector('.an-more-format')?.removeAttribute('open'); });
    }
    const footer = panel.querySelector('.an-editor-footer');
    if (footer) {
      enhanceMeta(panel, footer);
      const status = panel.querySelector('.am-draft-status');
      const actions = footer.querySelector('.edit-actions');
      if (status && status.parentElement !== footer) footer.insertBefore(status, actions);
    }
    syncTabs(panel); updateCount(panel);
  }
  function enhanceNoteView(panel) {
    if (panel.querySelector('#edit-body')) return;
    const display = panel.querySelector('#note-display');
    if (!display || display.dataset.anViewReady) return;
    display.dataset.anViewReady = 'true';
    setClass(panel, 'an-editor', false); setClass(panel, 'an-note-view', true);
    const header = document.createElement('header'); header.className = 'an-editor-header';
    const close = panel.querySelector('[data-action="close"]'); backButton(close);
    const heading = document.createElement('strong'); heading.textContent = 'Note';
    if (close) header.append(close); header.append(heading);
    const edit = display.querySelector('[data-action="edit"]'); if (edit) { edit.textContent = 'Edit'; header.append(edit); }
    panel.prepend(header);
    panel.querySelector(':scope > .eyebrow')?.remove();
    const actions = display.querySelector('.panel-actions');
    if (actions) panel.append(actions);
    let lastTap = 0;
    display.addEventListener('click', event => {
      if (event.target.closest('button,a,input,select,summary,details')) return;
      const now = performance.now();
      if (lastTap > 0 && now - lastTap < 450) {
        lastTap = 0; window.getSelection()?.removeAllRanges();
        editNote(data.selected?.id, { keepContext: true });
      } else lastTap = now;
    });
    const hint = document.createElement('small'); hint.className = 'an-note-edit-hint'; hint.textContent = 'Double tap the note to edit';
    display.prepend(hint);
  }
  function enhanceProjectFilter(list) {
    const manager = list.querySelector('.notes-folder-manager');
    if (!manager) return;
    const filters = document.createElement('section'); filters.className = 'an-note-filters'; filters.setAttribute('aria-label', 'Filter notes');
    const smart = manager.querySelector('.note-smart-folders'); if (smart) filters.append(smart);
    const label = document.createElement('label'); label.textContent = 'Project';
    const project = document.createElement('select'); project.setAttribute('aria-label', 'Show notes in a project');
    const names = [...new Set(['Inbox', ...(data.folders || []), ...(data.noteFolders || [])])].sort((a, b) => a === 'Inbox' ? -1 : b === 'Inbox' ? 1 : a.localeCompare(b));
    for (const name of ['All notes', ...names]) {
      const option = document.createElement('option'); option.value = name; option.textContent = name === 'All notes' ? 'All projects' : name;
      option.selected = name === noteFolder; project.append(option);
    }
    project.onchange = () => {
      noteFolder = project.value; noteFavorites = false; noteRecent = false; noteArchived = false;
      selectedNotes.clear(); selectionMode = false; render();
    };
    const manage = button('Manage projects →', 'an-manage-projects');
    manage.onclick = () => { if (keepCurrentDraft()) openWorkspaceView('projects'); };
    label.append(project); filters.append(label, manage);
    (manager.closest('.am-note-projects') || manager).replaceWith(filters);
  }
  function enhanceList() {
    const sort = document.getElementById('note-sort');
    const list = sort?.closest('#view');
    if (!list) { const root = document.getElementById('view'); if (root) setClass(root, 'an-notes-page', false); previousList = null; return; }
    setClass(list, 'an-notes-page', true);
    enhanceProjectFilter(list);
    const hint = list.querySelector(':scope > .library-summary');
    if (hint && !hint.dataset.anTapHint) {
      hint.dataset.anTapHint = 'true';
      hint.textContent = hint.textContent.replace(/\s*·?\s*(?:Drag notes onto a board in the sidebar to add them\.|Open a board and use \+ Notes to add your ideas\.)/, '') + ' · Tap to open. Touch and hold to select.';
    }
    const tools = sort.closest('.note-tools');
    if (tools && !tools.querySelector('[data-an-select-notes]')) {
      const toggle = button('Select', 'secondary'); toggle.dataset.anSelectNotes = 'true';
      toggle.onclick = () => {
        selectionMode = !selectionMode;
        if (!selectionMode) list.querySelector('[data-action="clear-note-selection"]')?.click();
        sync();
      };
      tools.append(toggle);
    }
    const hasSelection = !!list.querySelector('[data-select-note]:checked');
    if (hasSelection) selectionMode = true;
    setClass(list, 'an-note-selection', selectionMode);
    const selectionToggle = tools?.querySelector('[data-an-select-notes]');
    if (selectionToggle) {
      const next = selectionMode ? 'Done' : 'Select';
      if (selectionToggle.textContent !== next) selectionToggle.textContent = next;
      selectionToggle.setAttribute('aria-pressed', String(selectionMode));
    }
    for (const card of list.querySelectorAll('.note-list-card')) {
      card.draggable = !compact.matches;
      if (card.dataset.anCardReady) continue;
      card.dataset.anCardReady = 'true';
      card.removeAttribute('role'); card.removeAttribute('aria-label'); card.removeAttribute('tabindex');
      const heading = card.querySelector('h3'), open = button(heading?.textContent || 'Untitled note', 'an-note-open');
      open.setAttribute('aria-label', 'Open note: ' + open.textContent);
      open.onclick = event => { event.stopPropagation(); if (keepCurrentDraft()) openWorkspaceItem({ kind: 'note', id: card.dataset.note }); };
      heading?.replaceChildren(open);
      const color = card.querySelector('.note-color-control'), archive = card.querySelector('[data-note-archive]');
      const menu = document.createElement('details'); menu.className = 'an-note-card-menu';
      const summary = document.createElement('summary'); summary.textContent = '•••';
      summary.setAttribute('aria-label', 'Note options');
      menu.addEventListener('click', event => event.stopPropagation());
      menu.addEventListener('toggle', () => setClass(card, 'an-menu-open', menu.open));
      const contents = document.createElement('dialog'); contents.className = 'ux-dialog an-note-actions-dialog'; contents.setAttribute('aria-label', 'Note actions');
      // This dialog is mounted under body, outside its original card/menu.
      // Keep taps on the color picker inside the open note actions.
      contents.addEventListener('click', event => event.stopPropagation());
      const dismiss = () => { if (contents.open) contents.close(); menu.open = false; };
      const close = button('Close note actions', 'secondary');
      close.onclick = dismiss;
      contents.append(close);
      menu.addEventListener('toggle', () => {
        if (!menu.open) { if (contents.open) contents.close(); return; }
        document.querySelectorAll('.an-note-card-menu[open]').forEach(other => { if (other !== menu) other.open = false; });
        document.body.append(contents); contents.showModal();
        contents.querySelector('button')?.focus({ preventScroll: true });
      });
      contents.addEventListener('close', () => { menu.open = false; contents.remove(); if (summary.isConnected) summary.focus({ preventScroll:true }); });
      contents.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
        if (event.key !== 'Tab' || !menu.open) return;
        const items = [...contents.querySelectorAll('button,select,input')].filter(node => !node.disabled && node.getClientRects().length);
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      });
      const editButton = button('Edit note'), previewButton = button('Read note'), move = button('Move to project'), remove = button('Delete note', 'an-delete-note');
      editButton.onclick = () => { dismiss(); editNote(card.dataset.note); };
      previewButton.onclick = () => { dismiss(); if (keepCurrentDraft()) openWorkspaceItem({ kind: 'note', id: card.dataset.note }); };
      move.onclick = () => { dismiss(); if (keepCurrentDraft()) showMoveNotesDialog([card.dataset.note]); };
      remove.onclick = () => { dismiss(); deleteNote(card.dataset.note); };
      contents.append(editButton, previewButton, move);
      if (color) {
        const noteId = card.dataset.note;
        const picker = document.createElement('section'); picker.className = 'an-menu-note-color';
        picker.setAttribute('role', 'group'); picker.setAttribute('aria-label', 'Note color');
        const label = document.createElement('span'); label.textContent = 'Note color';
        const choices = document.createElement('div'); choices.className = 'an-menu-note-colors';
        const status = document.createElement('small'); status.setAttribute('role', 'status');
        const palette = { violet: '#b89cff', blue: '#83baff', teal: '#6cdbc7', amber: '#f4cb77', rose: '#ee9cba', gray: '#b3bbca' };
        const refreshColor = () => {
          const current = data.notes.find(note => note.id === noteId)?.color || 'violet';
          for (const choice of choices.children) choice.setAttribute('aria-pressed', String(choice.dataset.noteColorChoice === current));
          status.textContent = (colors[current] || 'Violet') + ' selected';
        };
        for (const [value, name] of Object.entries(colors)) {
          const choice = button(name, 'an-menu-note-color-option');
          choice.dataset.noteColorId = noteId; choice.dataset.noteColorChoice = value;
          choice.setAttribute('aria-label', 'Change note color to ' + name);
          choice.style.setProperty('--an-menu-note-color', palette[value]);
          choice.onclick = event => {
            event.stopPropagation();
            if (setNoteColor(noteId, value)) { refreshColor(); status.textContent = name + ' saved'; }
            else status.textContent = 'Could not save the note color';
          };
          choices.append(choice);
        }
        refreshColor(); picker.append(label, choices, status); contents.append(picker);
        // The menu uses direct buttons; it no longer depends on WebView's native select popup.
        color.remove();
        menu.addEventListener('toggle', () => { if (menu.open) refreshColor(); });
      }
      if (archive) { archive.textContent = archive.title || 'Archive'; contents.append(archive); }
      contents.append(remove); menu.append(summary); card.querySelector('.note-card-tools')?.append(menu);
      card.addEventListener('keydown', event => {
        if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Enter') { if (keepCurrentDraft()) openWorkspaceItem({ kind: 'note', id: card.dataset.note }); }
        else card.querySelector('[data-select-note]')?.click();
      });
      card.addEventListener('click', event => {
        if (event.target.closest('button,input,label,a,select,details,summary')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (keepCurrentDraft()) openWorkspaceItem({ kind: 'note', id: card.dataset.note });
      }, true);
      card.addEventListener('dblclick', event => { if (!event.target.closest('button,input,label,a,select,details,summary')) event.preventDefault(); });
    }
    previousList = list;
  }
  function closeTransient() {
    const deletion = document.querySelector('.an-note-delete-dialog[open]');
    if (deletion) { deletion.close(); return true; }
    const panel = document.querySelector('.detail-panel.an-editor');
    const opened = panel?.querySelector('.an-more-format[open], .am-note-details[open]');
    if (opened) { opened.open = false; return true; }
    const menu = document.querySelector('.an-note-card-menu[open]');
    if (menu) { menu.open = false; return true; }
    if (!panel && selectionMode && document.getElementById('note-sort')) {
      selectionMode = false; document.querySelector('[data-action="clear-note-selection"]')?.click(); sync(); return true;
    }
    return false;
  }
  function sync() {
    const panel = document.querySelector('#view .detail-panel');
    if (panel?.querySelector('#edit-body')) enhanceEditor(panel);
    else if (panel) enhanceNoteView(panel);
    enhanceList();
  }
  document.addEventListener('click', event => {
    for (const menu of document.querySelectorAll('.an-note-card-menu[open], .an-more-format[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener('click', event => {
    const create = event.target.closest('[data-action="new-note"]');
    if (!create) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void newNote({ board: view === 'board' });
  }, true);
  compact.addEventListener('change', sync);
  window.NotejectAndroidNotesUI = Object.freeze({ sync, closeTransient, newNote, editNote, getModal: () => document.querySelector('.an-note-delete-dialog[open]') });
  function measureEditorViewport() {
    const viewport = window.visualViewport, width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const values = { '--an-viewport-height': height, '--an-viewport-width': width, '--an-viewport-top': viewport?.offsetTop || 0, '--an-viewport-left': viewport?.offsetLeft || 0 };
    for (const [name, value] of Object.entries(values)) {
      const next = Math.round(value) + 'px';
      if (document.body.style.getPropertyValue(name) !== next) document.body.style.setProperty(name, next);
    }
    setClass(document.body, 'an-editor-wide-short', width >= 560 && height <= 540);
  }
  window.addEventListener('resize', measureEditorViewport);
  window.addEventListener('orientationchange', measureEditorViewport);
  window.visualViewport?.addEventListener('resize', measureEditorViewport);
  window.visualViewport?.addEventListener('scroll', measureEditorViewport);
  window.addEventListener('noteject:android-insets', measureEditorViewport);
  measureEditorViewport();
  sync();
})();
