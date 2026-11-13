/* One local note picker for the Web, Windows, and Android editors. */
(() => {
  'use strict';
  let activePicker = null;
  const t = value => window.NotejectI18n?.t(value) || value;
  const fold = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  function pick({ getNotes, currentNote, query = '' }) {
    if (activePicker) return Promise.resolve(null);
    const currentId = currentNote?.id;
    const records = (getNotes() || []).filter(note => note.id !== currentId).map(note => ({
      note, title: note.title || t('Untitled note'), folder: note.folder || 'Inbox',
      search: fold([note.title, note.folder, ...(note.tags || [])].join(' ')),
      preview: (window.NotejectNoteMedia?.previewText(String(note.content || '').slice(0, 2000)) || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    })).sort((a, b) => Number(b.folder === currentNote?.folder) - Number(a.folder === currentNote?.folder) || (b.note.updated || b.note.created || 0) - (a.note.updated || a.note.created || 0) || a.title.localeCompare(b.title));
    const returnFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'note-picker';
    dialog.setAttribute('aria-labelledby', 'note-picker-title');
    dialog.setAttribute('aria-describedby', 'note-picker-description');
    dialog.innerHTML = '<form><header><div><h2 id="note-picker-title"></h2><p id="note-picker-description"></p></div><button type="button" class="note-picker-close" data-note-picker-cancel aria-label="Close">×</button></header><div class="note-picker-filters"><label class="note-picker-search"><span aria-hidden="true">⌕</span><input type="search" name="search" autocomplete="off" autocapitalize="off" spellcheck="false"></label><label class="note-picker-project"><span></span><select name="project"></select></label></div><p class="note-picker-count" role="status" aria-live="polite"></p><div class="note-picker-results" role="group"></div><footer><p class="note-picker-selection" aria-live="polite"></p><div><button type="button" class="secondary" data-note-picker-cancel></button><button type="submit" class="primary" disabled></button></div></footer></form>';
    const form = dialog.querySelector('form'), search = form.elements.search, project = form.elements.project;
    const list = dialog.querySelector('.note-picker-results'), count = dialog.querySelector('.note-picker-count');
    const selection = dialog.querySelector('.note-picker-selection'), insert = dialog.querySelector('[type=submit]');
    dialog.querySelector('h2').textContent = t('Link to a note');
    dialog.querySelector('#note-picker-description').textContent = t('Choose a note to connect your ideas.');
    search.placeholder = t('Search notes by title or tag…'); search.setAttribute('aria-label', t('Search notes by title or tag…'));
    search.value = String(query).slice(0, 200);
    dialog.querySelector('.note-picker-project > span').textContent = t('Project');
    list.setAttribute('aria-label', t('Matching notes'));
    insert.textContent = t('Insert note link');
    dialog.querySelector('footer [data-note-picker-cancel]').textContent = t('Cancel');
    const addProject = (value, title) => { const option = document.createElement('option'); option.value = value; option.textContent = title; if(value)option.dataset.i18nIgnore=''; project.append(option); };
    addProject('', t('All projects'));
    [...new Set(records.map(record => record.folder))].sort((a, b) => a.localeCompare(b)).forEach(folder => addProject(folder, folder));
    let selectedId = null, shown = [], finished = false;
    function select(id) {
      selectedId = id;
      const record = records.find(record => record.note.id === id);
      list.querySelectorAll('[data-note-picker-id]').forEach(row => row.setAttribute('aria-pressed', String(row.dataset.notePickerId === id)));
      insert.disabled = !record;
      if (record) selection.dataset.i18nIgnore = ''; else delete selection.dataset.i18nIgnore;
      selection.textContent = record ? record.title : t('Select a note to insert its link.');
      selection.title = record ? record.title : '';
    }
    function render() {
      const terms = fold(search.value).trim().split(/\s+/).filter(Boolean);
      const matches = records.filter(record => (!project.value || record.folder === project.value) && terms.every(term => record.search.includes(term)));
      shown = matches.slice(0, 60);
      if (!shown.some(record => record.note.id === selectedId)) selectedId = null;
      list.replaceChildren();
      count.textContent = (window.NotejectI18n?.format('Matching notes: {count}', { count: matches.length }) || t('Matching notes') + ': ' + matches.length) + (matches.length > shown.length ? ' · ' + t('Showing the first 60. Refine your search.') : '');
      if (!shown.length) {
        const empty = document.createElement('div'); empty.className = 'note-picker-empty';
        const heading = document.createElement('strong'), text = document.createElement('p');
        heading.textContent = t(records.length ? 'No matching notes' : 'No other notes yet');
        text.textContent = t(records.length ? 'Try another title, tag, or project.' : 'Create another note, then link it here.');
        empty.append(heading, text); list.append(empty);
      }
      for (const record of shown) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'note-picker-result';
        row.dataset.notePickerId = String(record.note.id); row.setAttribute('aria-pressed', 'false');
        const icon = document.createElement('span'); icon.className = 'note-picker-icon'; icon.setAttribute('aria-hidden', 'true');
        const colors = { violet: '#b79aff', blue: '#83baff', teal: '#6cdbc7', amber: '#f4cb77', rose: '#ee9cba', gray: '#b3bbca' };
        icon.style.setProperty('--note-picker-color', colors[record.note.color] || colors.violet); icon.textContent = '▤';
        const copy = document.createElement('span'); copy.className = 'note-picker-copy'; copy.dataset.i18nIgnore = '';
        const title = document.createElement('strong'), meta = document.createElement('small'), preview = document.createElement('span');
        title.textContent = record.title; meta.textContent = [record.folder, ...(record.note.tags || []).slice(0, 3).map(tag => '#' + tag)].join(' · ');
        preview.textContent = record.preview || t('Empty note');
        copy.append(title, meta, preview); row.append(icon, copy); list.append(row);
      }
      select(selectedId);
      list.scrollTop = 0;
    }
    const promise = new Promise(resolve => {
      const finish = value => {
        if (finished) return;
        finished = true; activePicker = null;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        resolve(value);
      };
      activePicker = dialog;
      function commit() {
        const note = (getNotes() || []).find(note => note.id === selectedId && note.id !== currentId);
        if (note) finish(note);
        else if (selectedId) { select(null); count.textContent = t('This note is no longer available. Choose another note.'); }
      }
      form.onsubmit = event => { event.preventDefault(); commit(); };
      search.oninput = render; project.onchange = render;
      dialog.querySelectorAll('[data-note-picker-cancel]').forEach(button => button.onclick = () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.addEventListener('close', () => finish(null));
      dialog.addEventListener('click', event => {
        const row = event.target.closest('[data-note-picker-id]');
        if (row) select(row.dataset.notePickerId);
        else if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) finish(null); }
      });
      list.addEventListener('dblclick', event => { if (event.target.closest('[data-note-picker-id]')) commit(); });
      dialog.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); finish(null); return; }
        const row = event.target.closest('[data-note-picker-id]');
        if ((event.target === search || row) && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          const buttons = [...list.querySelectorAll('[data-note-picker-id]')];
          const current = buttons.indexOf(row), index = Math.max(0, Math.min(buttons.length - 1, current < 0 ? 0 : current + (event.key === 'ArrowDown' ? 1 : -1)));
          if (buttons[index]) { select(buttons[index].dataset.notePickerId); buttons[index].focus(); }
        } else if (event.key === 'Enter' && (event.target === search || row)) {
          event.preventDefault(); if (!selectedId && shown[0]) select(shown[0].note.id); commit();
        }
      });
    });
    render(); document.body.append(dialog); dialog.showModal(); search.focus(); search.select();
    return promise;
  }
  window.NotejectNotePicker = Object.freeze({ pick });
})();
