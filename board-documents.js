/* Shared document dragging and a bounded library list for boards. */
(() => {
  'use strict';
  const batchType = 'application/x-noteject-docs';
  const singleType = 'application/x-noteject-doc';
  const prefix = 'noteject-doc:';
  const pageSize = 60;
  const normalized = new WeakMap();
  let indexedLibrary;
  let panelOpen = true;
  let searchText = '';
  let folderName = '';
  let typeName = 'all';
  let sortMode = 'name';
  let searchTimer;
  const checked = new Set();

  function uniqueIds(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0 && value.length < 512))].slice(0, 1000);
  }
  function start(event, ids) {
    const values = uniqueIds(ids);
    if (!event.dataTransfer || !values.length) return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(batchType, JSON.stringify(values));
    event.dataTransfer.setData(singleType, prefix + values[0]);
    event.dataTransfer.setData('text/plain', prefix + values[0]);
  }
  function read(transfer) {
    if (!transfer) return [];
    try {
      const batch = transfer.getData(batchType);
      if (batch) {
        const parsed = JSON.parse(batch);
        if (Array.isArray(parsed)) return uniqueIds(parsed);
      }
    } catch { /* Older clients can still supply a single document below. */ }
    try {
      const single = transfer.getData(singleType);
      if (single) return uniqueIds([single.startsWith(prefix) ? single.slice(prefix.length) : single]);
      const plain = transfer.getData('text/plain');
      return plain?.startsWith(prefix) ? uniqueIds([plain.slice(prefix.length)]) : [];
    } catch { return []; }
  }
  function accepts(transfer) {
    const types = Array.from(transfer?.types || []);
    return types.includes(batchType) || types.includes(singleType);
  }
  function dropPoint(canvas, event, zoom) {
    const world = canvas.querySelector('.canvas-world') || canvas;
    const rect = world.getBoundingClientRect();
    const scale = Math.max(0.15, Number(zoom) || 1);
    return { x: Math.max(20, (event.clientX - rect.left) / scale - 100), y: Math.max(20, (event.clientY - rect.top) / scale - 35) };
  }
  function dateNumber(value) {
    const number = Number(value);
    return value !== undefined && value !== null && value !== '' && Number.isFinite(number) ? number : Date.parse(value) || 0;
  }
  function entryFor(doc) {
    const fields = [doc.id, doc.name, doc.folder, doc.type, doc.added, doc.size, doc.lastOpened];
    const previous = normalized.get(doc);
    if (previous && fields.every((value, index) => value === previous.fields[index])) return previous.entry;
    const name = String(doc.name || 'Untitled file');
    const folder = String(doc.folder || 'Inbox');
    const type = String(doc.type || 'file').toLowerCase();
    const entry = { id: doc.id, name, folder, type, added: dateNumber(doc.added), size: Number(doc.size) || 0, opened: dateNumber(doc.lastOpened), search: (name + '\n' + folder + '\n' + type).toLocaleLowerCase() };
    normalized.set(doc, { fields, entry });
    return entry;
  }

  // Typing filters cached strings; the DOM starts at one page regardless of size.
  function createLibrary(documents, selection = new Set(), limit = pageSize) {
    const entries = documents.map(entryFor);
    const validIds = new Set(entries.map(entry => entry.id));
    for (const id of selection) if (!validIds.has(id)) selection.delete(id);
    const unchanged = indexedLibrary && entries.length === indexedLibrary.entries.length && entries.every((entry, index) => entry === indexedLibrary.entries[index]);
    const sorts = unchanged ? indexedLibrary.sorts : new Map();
    if (!unchanged) indexedLibrary = { entries, sorts };
    let filters = { term: '', folder: '', type: 'all', sort: 'name' };
    let matches = [];
    let shown = limit;
    function sorted(mode) {
      if (!sorts.has(mode)) {
        const compareName = (a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id));
        const compare = mode === 'newest' ? (a, b) => b.added - a.added || compareName(a, b)
          : mode === 'largest' ? (a, b) => b.size - a.size || compareName(a, b)
          : mode === 'opened' ? (a, b) => b.opened - a.opened || compareName(a, b) : compareName;
        sorts.set(mode, [...entries].sort(compare));
      }
      return sorts.get(mode);
    }
    function setFilters(value) {
      filters = { ...filters, ...value };
      const terms = String(filters.term || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      matches = sorted(filters.sort).filter(entry => (!filters.folder || entry.folder === filters.folder) && (filters.type === 'all' || entry.type === filters.type) && terms.every(term => entry.search.includes(term)));
      shown = limit;
    }
    setFilters(filters);
    return {
      folders: [...new Set(entries.map(entry => entry.folder))].sort(),
      types: [...new Set(entries.map(entry => entry.type))].sort(),
      setFilters,
      more() { shown = Math.min(matches.length, shown + limit); },
      view() { return { rows: matches.slice(0, shown), total: matches.length, hasMore: shown < matches.length, selected: selection.size, matchingSelected: matches.reduce((total, entry) => total + Number(selection.has(entry.id)), 0) }; },
      select(id, value) { if (validIds.has(id)) value ? selection.add(id) : selection.delete(id); },
      toggleMatches() {
        const remove = matches.length > 0 && matches.every(entry => selection.has(entry.id));
        for (const entry of matches) remove ? selection.delete(entry.id) : selection.add(entry.id);
      },
      clearSelection() { selection.clear(); },
      selection() { return [...selection]; },
      isSelected(id) { return selection.has(id); },
    };
  }
  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function button(className, text) { const result = element('button', className, text); result.type = 'button'; return result; }
  function selectControl(className, label, options, value) {
    const select = element('select', className);
    select.setAttribute('aria-label', label);
    for (const [key, text] of options) { const option = element('option', '', text); option.value = key; select.append(option); }
    select.value = value;
    return select;
  }

  function mount({ documents, board, icon, onAdd }) {
    clearTimeout(searchTimer);
    const canvas = document.querySelector('.canvas');
    const actions = document.querySelector('.page-head .buttons');
    if (!canvas || !actions) return;
    const model = createLibrary(documents, checked);
    const workspace = element('div', 'board-workspace');
    canvas.replaceWith(workspace);
    workspace.append(canvas);
    const panel = element('aside', 'board-document-panel');
    panel.id = 'board-document-panel';
    panel.setAttribute('aria-label', 'Documents to add to this board');
    // Native Enter/Space on panel buttons must not start board panning or edits.
    panel.addEventListener('keydown', event => { if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation(); });
    const header = element('div', 'board-document-heading');
    const title = element('h2', '', 'Documents');
    const total = element('span', '', documents.length.toLocaleString(globalThis.document?.documentElement?.lang || undefined));
    const close = button('board-document-close', '×');
    close.setAttribute('aria-label', 'Hide documents panel');
    header.append(title, total, close);
    const help = element('p', 'board-document-help', 'Drag files to the board, or select files and choose Add.');
    const search = element('input', 'board-document-search');
    search.type = 'search'; search.placeholder = 'Search name, project or type…'; search.setAttribute('aria-label', 'Search board documents'); search.value = searchText;
    const folders = selectControl('board-document-folder', 'Filter board documents by project', [['', 'All projects'], ...model.folders.map(name => [name, name])], folderName);
    if (folders.selectedIndex < 0) folders.value = folderName = '';
    const filters = element('div', 'board-document-filters');
    const types = selectControl('board-document-type', 'Filter documents by type', [['all', 'All types'], ...model.types.map(type => [type, type.toUpperCase()])], typeName);
    if (types.selectedIndex < 0) types.value = typeName = 'all';
    const sort = selectControl('board-document-sort', 'Sort board documents', [['name', 'Name A–Z'], ['newest', 'Recently added'], ['largest', 'Largest first'], ['opened', 'Recently opened']], sortMode);
    filters.append(types, sort);
    const bulk = element('div', 'board-document-bulk');
    const count = element('span', 'board-document-selection-count');
    const selectMatching = button('board-document-select-visible', 'Select matching');
    selectMatching.title = 'Select every matching file, including files on later pages';
    const clearSelected = button('board-document-clear', 'Clear selection');
    const addSelected = button('board-document-add-selected', 'Add selected');
    bulk.append(count, clearSelected, selectMatching, addSelected);
    const results = element('div', 'board-document-results');
    const status = element('span', 'board-document-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const reset = button('board-document-reset', 'Reset filters');
    results.append(status, reset);
    const list = element('div', 'board-document-list');
    list.setAttribute('role', 'list'); list.id = 'board-document-list';
    const more = button('board-document-more', 'Load more');
    more.setAttribute('aria-controls', list.id);
    panel.append(header, help, search, folders, filters, bulk, results, list, more);
    workspace.append(panel);
    const toggle = button('secondary', '');
    toggle.id = 'toggle-board-documents'; toggle.setAttribute('aria-controls', panel.id); actions.append(toggle);
    function updateOpen() {
      panel.hidden = !panelOpen; workspace.classList.toggle('with-documents', panelOpen);
      toggle.textContent = panelOpen ? 'Hide documents' : '▣ Documents'; toggle.setAttribute('aria-expanded', String(panelOpen));
    }
    toggle.onclick = () => { panelOpen = !panelOpen; updateOpen(); if (panelOpen) search.focus(); };
    close.onclick = () => { panelOpen = false; updateOpen(); toggle.focus(); };
    updateOpen();
    const onBoard = new Set((board.items || []).map(item => item.id));
    const mountedRows = new Map();
    function updateSelection() {
      const state = model.view();
      const eligible = model.selection().filter(id => !onBoard.has(id)).length;
      const hiddenSelected = state.selected - state.matchingSelected;
      count.textContent = state.selected ? state.selected.toLocaleString(globalThis.document?.documentElement?.lang || undefined) + ' selected' + (hiddenSelected ? ' · ' + hiddenSelected.toLocaleString(globalThis.document?.documentElement?.lang || undefined) + ' hidden' : '') : 'Select files to add';
      addSelected.disabled = !eligible; addSelected.textContent = eligible ? 'Add selected (' + eligible.toLocaleString(globalThis.document?.documentElement?.lang || undefined) + ')' : 'Add selected';
      selectMatching.disabled = !state.total;
      selectMatching.textContent = state.total && state.matchingSelected === state.total ? 'Deselect matching' : 'Select matching';
      clearSelected.disabled = !state.selected;
      for (const [id, row] of mountedRows) { const selected = model.isSelected(id); row.classList.toggle('is-selected', selected); row.querySelector('input').checked = selected; }
    }
    function makeRow(doc) {
      const row = element('div', 'board-library-document');
      row.dataset.libraryDocument = doc.id; row.draggable = true; row.setAttribute('role', 'listitem'); row.title = 'Drag ' + doc.name + ' onto the board';
      const select = element('input');
      select.type = 'checkbox'; select.checked = model.isSelected(doc.id); select.setAttribute('aria-label', 'Select ' + doc.name);
      select.onchange = () => { model.select(doc.id, select.checked); updateSelection(); };
      const badge = element('span', 'board-library-icon file-type-' + (['pdf', 'epub', 'txt', 'image', 'video', 'audio'].includes(doc.type) ? doc.type : 'file'));
      badge.setAttribute('aria-hidden', 'true'); badge.innerHTML = icon(doc.type);
      const info = element('div', 'board-library-info');
      info.append(element('b', '', doc.name), element('small', '', doc.type.toUpperCase() + ' · ' + (onBoard.has(doc.id) ? 'On board' : doc.folder)));
      const add = button('board-library-add', onBoard.has(doc.id) ? '✓' : '＋');
      add.disabled = onBoard.has(doc.id); add.setAttribute('aria-label', onBoard.has(doc.id) ? doc.name + ' is on this board' : 'Add ' + doc.name + ' to this board'); add.onclick = () => onAdd([doc.id], null);
      row.ondragstart = event => {
        if (event.target.closest('input,button,select,a')) { event.preventDefault(); return; }
        start(event, model.isSelected(doc.id) ? model.selection() : [doc.id]); row.classList.add('is-dragging');
      };
      row.ondragend = () => row.classList.remove('is-dragging');
      row.append(select, badge, info, add); mountedRows.set(doc.id, row); return row;
    }
    function renderList(append = false) {
      const state = model.view();
      if (!append) { list.replaceChildren(); mountedRows.clear(); list.scrollTop = 0; }
      const fragment = document.createDocumentFragment();
      for (const doc of state.rows) if (!mountedRows.has(doc.id)) fragment.append(makeRow(doc));
      if (!state.total) fragment.append(element('p', 'board-document-empty', documents.length ? 'No matches. Try another search or reset filters.' : 'Import files in Documents or drop files from Windows onto the board.'));
      list.append(fragment);
      status.textContent = state.rows.length.toLocaleString(globalThis.document?.documentElement?.lang || undefined) + ' of ' + state.total.toLocaleString(globalThis.document?.documentElement?.lang || undefined) + (state.total === 1 ? ' file' : ' files');
      reset.hidden = !searchText && !folderName && typeName === 'all' && sortMode === 'name'; more.hidden = !state.hasMore;
      more.textContent = 'Load ' + Math.min(pageSize, state.total - state.rows.length).toLocaleString(globalThis.document?.documentElement?.lang || undefined) + ' more'; updateSelection();
    }
    function applyFilters() { clearTimeout(searchTimer); model.setFilters({ term: searchText, folder: folderName, type: typeName, sort: sortMode }); renderList(); }
    search.oninput = () => {
      searchText = search.value; clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (panel.isConnected) applyFilters(); }, 120);
    };
    search.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); applyFilters(); }
      if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation(); search.value = searchText = ''; applyFilters(); }
    };
    folders.onchange = () => { folderName = folders.value; applyFilters(); };
    types.onchange = () => { typeName = types.value; applyFilters(); };
    sort.onchange = () => { sortMode = sort.value; applyFilters(); };
    reset.onclick = () => { searchText = search.value = ''; folderName = folders.value = ''; typeName = types.value = 'all'; sortMode = sort.value = 'name'; applyFilters(); search.focus(); };
    more.onclick = () => { const previous = model.view().rows.length; model.more(); renderList(true); list.children[previous]?.querySelector('input')?.focus(); };
    selectMatching.onclick = () => { model.toggleMatches(); updateSelection(); };
    clearSelected.onclick = () => { model.clearSelection(); updateSelection(); };
    addSelected.onclick = () => { const ids = model.selection().filter(id => !onBoard.has(id)); if (!ids.length) return; model.clearSelection(); onAdd(ids, null); };
    applyFilters();
    const originalOver = canvas.ondragover;
    const originalDrop = canvas.ondrop;
    const clearDrop = () => { canvas.classList.remove('file-drop-active', 'note-drop-target'); delete canvas.dataset.dropLabel; };
    canvas.ondragover = event => {
      if (!accepts(event.dataTransfer)) { originalOver?.call(canvas, event); return; }
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; canvas.classList.add('file-drop-active'); canvas.dataset.dropLabel = 'Drop documents here to add them to the board';
    };
    canvas.ondrop = event => {
      const ids = read(event.dataTransfer); clearDrop();
      if (!ids.length) { originalDrop?.call(canvas, event); return; }
      event.preventDefault(); event.stopPropagation(); onAdd(ids, dropPoint(canvas, event, board.zoom));
    };
    workspace.addEventListener('dragend', clearDrop);
  }
  window.NotejectDocumentDrag = { start, read, accepts, dropPoint, mount, createLibrary };
})();
