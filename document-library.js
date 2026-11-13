/* Document library: keep controls mounted and render a bounded page of files. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotejectDocumentLibrary = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const PAGE_SIZE = 48;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function documentWasRead(doc) { if(doc.readingStatus==='to-read')return false;if(doc.readingStatus==='reading'||doc.readingStatus==='finished')return true;return doc.readAt===0?false:!!(doc.readAt||doc.lastOpened); }
  function catalog(documents) {
    const entries = documents.map(doc => ({ doc, term: [doc.name, doc.folder || 'Inbox', doc.type || 'file', ...(Array.isArray(doc.tags) ? doc.tags : [])].join(' ').toLocaleLowerCase() }));
    const duplicateCounts = new Map();
    for (const { doc } of entries) { const key = String(doc.name || '').trim().toLocaleLowerCase() + '|' + (Number(doc.size) || 0); duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1); }
    const duplicateKeys = new Set([...duplicateCounts].filter(([, count]) => count > 1).map(([key]) => key));
    return {
      query(options = {}) {
        const words = String(options.search || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const boarded = new Set(options.boardedIds || []), smart = options.smart || 'all', recentCutoff = Date.now() - 30 * 86400000;
        const smartMatch = doc => { const read = documentWasRead(doc), duplicateKey = String(doc.name || '').trim().toLocaleLowerCase() + '|' + (Number(doc.size) || 0); return smart === 'all' || (smart === 'inbox' && (doc.folder || 'Inbox') === 'Inbox') || (smart === 'favorites' && !!doc.favorite) || (smart === 'unread' && !read) || (smart === 'recent' && Number(doc.lastOpened) >= recentCutoff) || (smart === 'large' && Number(doc.size) >= 25 * 1024 * 1024) || (smart === 'duplicates' && duplicateKeys.has(duplicateKey)) || (smart === 'unlinked' && !boarded.has(doc.id)); };
        const matches = entries.filter(({ doc, term }) =>
          (!options.folder || options.folder === 'All documents' || (doc.folder || 'Inbox') === options.folder) &&
          (!options.type || options.type === 'all' || (doc.type || 'file') === options.type) &&
          (!options.tag || (Array.isArray(doc.tags) && doc.tags.some(tag => String(tag).toLocaleLowerCase() === String(options.tag).toLocaleLowerCase()))) &&
          (!options.favorites || doc.favorite) && smartMatch(doc) && words.every(word => term.includes(word))
        ).map(entry => entry.doc);
        const name = (a, b) => collator.compare(String(a.name), String(b.name));
        matches.sort((a, b) => {
          const difference = options.sort === 'name-asc' ? name(a, b) : options.sort === 'name-desc' ? name(b, a) :
            options.sort === 'oldest' ? (a.added || 0) - (b.added || 0) :
            options.sort === 'largest' ? (b.size || 0) - (a.size || 0) :
            options.sort === 'opened' ? (b.lastOpened || 0) - (a.lastOpened || 0) : (b.added || 0) - (a.added || 0);
          return difference || name(a, b);
        });
        const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
        const page = Math.max(0, Math.min(pages - 1, Number(options.page) || 0));
        return { matches, page, pages, items: matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), size: matches.reduce((sum, doc) => sum + (Number(doc.size) || 0), 0) };
      }
    };
  }

  function create(app) {
    let model, result, page = 0, search = '', searchTimer, rootElement, filterKey = '';
    let mode = 'list';
    try { mode = localStorage.getItem('noteject-document-view') === 'grid' ? 'grid' : 'list'; } catch {}
    const selected = () => app.getSelection();
    const options = () => ({ ...app.getFilters(), search, page, boardedIds: app.getData().boards.flatMap(board => (board.items || []).filter(item => item.type !== 'note').map(item => item.id)) });
    const boardOptions = () => app.getData().boards.map(board => `<option value="${escape(board.id)}">${escape(board.name)}</option>`).join('');
    function refreshModel() {
      const data = app.getData(), ids = new Set(data.docs.map(doc => doc.id));
      for (const id of selected()) if (!ids.has(id)) selected().delete(id);
      model = catalog(data.docs);
    }
    function query() { result = model.query(options()); page = result.page; return result; }
    function selectOptions(entries, value) { return entries.map(([id, label]) => `<option value="${escape(id)}"${id === value ? ' selected' : ''}>${escape(label)}</option>`).join(''); }
    function render() {
      clearTimeout(searchTimer);
      const data = app.getData(), filters = app.getFilters();
      const nextKey = JSON.stringify(filters);
      if (filterKey !== nextKey) { page = 0; filterKey = nextKey; }
      refreshModel(); query();
      const folders = [...new Set(['Inbox', ...(data.folders || []), ...data.docs.map(doc => doc.folder || 'Inbox')])];
      const types = [...new Set(['pdf', 'epub', 'txt', 'image', 'video', 'audio', ...data.docs.map(doc => doc.type || 'file')])];
      const tags = [...new Set(data.docs.flatMap(doc => Array.isArray(doc.tags) ? doc.tags.map(String) : []))].sort((a,b) => collator.compare(a,b));
      const duplicateCounts = new Map(); for (const doc of data.docs) { const key = String(doc.name || '').trim().toLocaleLowerCase() + '|' + (Number(doc.size) || 0); duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1); }
      const boarded = new Set(data.boards.flatMap(board => (board.items || []).filter(item => item.type !== 'note').map(item => item.id)));
      const recentCutoff = Date.now() - 30 * 86400000, read = doc => documentWasRead(doc);
      const smartViews = [['all','Everything',data.docs.length],['inbox','Inbox',data.docs.filter(doc => (doc.folder || 'Inbox') === 'Inbox').length],['favorites','Favorites',data.docs.filter(doc => doc.favorite).length],['unread','Not opened',data.docs.filter(doc => !read(doc)).length],['recent','Recently opened',data.docs.filter(doc => Number(doc.lastOpened) >= recentCutoff).length],['large','Large · 25 MB+',data.docs.filter(doc => Number(doc.size) >= 25 * 1024 * 1024).length],['duplicates','Duplicate candidates',data.docs.filter(doc => duplicateCounts.get(String(doc.name || '').trim().toLocaleLowerCase() + '|' + (Number(doc.size) || 0)) > 1).length],['unlinked','Not on a board',data.docs.filter(doc => !boarded.has(doc.id)).length]];
      return `<section class="document-library">
        <header class="page-head document-library-head"><div><div class="eyebrow">YOUR SOURCES</div><h1>Documents</h1><p>Find, organize, and connect your files.</p></div><div class="buttons"><button class="secondary" data-library-action="new-folder">＋ New project</button><button class="primary" data-library-action="import">＋ Import files</button></div></header>
        <nav class="document-smart-views" aria-label="Smart document collections">${smartViews.map(([id,label,count]) => `<button type="button" data-library-smart="${id}" aria-pressed="${(filters.smart || 'all') === id}"><span>${escape(label)}</span><b>${count}</b></button>`).join('')}</nav>
        <div class="document-library-controls">
          <label class="document-search-field"><span>Search files</span><input class="document-library-search" type="search" placeholder="Name, project, or file type…" value="${escape(search)}" aria-label="Search documents"></label>
          <label>Project<select data-library-filter="folder">${selectOptions([['All documents', 'All projects'], ...folders.map(folder => [folder, folder])], filters.folder)}</select></label>
          <label>Type<select data-library-filter="type">${selectOptions([['all', 'All types'], ...types.map(type => [type, type.toUpperCase()])], filters.type)}</select></label>
          <label>Tag<select data-library-filter="tag">${selectOptions([['', 'All tags'], ...tags.map(tag => [tag, '#'+tag])], filters.tag || '')}</select></label>
          <label>Sort<select data-library-filter="sort">${selectOptions([['newest','Recently added'], ['opened','Recently opened'], ['name-asc','Name A–Z'], ['name-desc','Name Z–A'], ['largest','Largest first'], ['oldest','Oldest first']], filters.sort)}</select></label>
          <label class="favorite-filter"><input type="checkbox" data-library-filter="favorites"${filters.favorites ? ' checked' : ''}> Favorites</label>
          <div class="document-view-switch" aria-label="Document display"><button data-library-mode="list" aria-pressed="${mode === 'list'}" title="Compact list">☰ List</button><button data-library-mode="grid" aria-pressed="${mode === 'grid'}" title="Icon grid">▦ Grid</button></div>
        </div>
        <div class="document-summary"><span data-library-summary aria-live="polite"></span><div><button class="text-button" data-library-reset>Clear filters</button><button class="text-button" data-library-action="rename-folder"${filters.folder === 'All documents' || filters.folder === 'Inbox' ? ' disabled' : ''}>Rename project</button><button class="text-button" data-library-action="delete-folder"${filters.folder === 'All documents' || filters.folder === 'Inbox' ? ' disabled' : ''}>Delete project</button></div></div>
        <div class="document-selection-bar"><label><input type="checkbox" data-library-select-results> Select results</label><span data-library-selection-count></span><select data-library-bulk-board aria-label="Add selected documents to a board"><option value="">＋ Add selected to board</option>${boardOptions()}</select><button class="secondary" data-library-action="bulk-move" data-needs-selection>Move</button><button class="secondary" data-library-action="bulk-tag" data-needs-selection>Add tags</button><button class="secondary" data-library-action="bulk-mark-read" data-needs-selection>Mark read</button><button class="secondary" data-library-action="bulk-mark-unread" data-needs-selection>Mark unread</button><button class="secondary" data-library-action="bulk-rename-docs" data-needs-selection>Rename</button><button class="danger-button" data-library-action="bulk-delete" data-needs-selection>Delete</button><button class="text-button" data-library-clear-selection data-needs-selection>Clear selection</button></div>
        <div class="document-results"></div><nav class="document-pagination" aria-label="Document pages"><button class="secondary" data-library-page="previous">← Previous</button><span data-library-page-label aria-live="polite"></span><button class="secondary" data-library-page="next">Next →</button></nav>
      </section>`;
    }
    function card(doc) {
      const isRead = documentWasRead(doc);
      const readingState = doc.readingStatus==='finished'?'Finished':doc.readingStatus==='to-read'?'To read':doc.readingStatus==='reading'?'Reading':doc.readAt === 0 ? 'Marked unread' : isRead ? 'Opened ' + new Date(doc.lastOpened || doc.readAt).toLocaleDateString(globalThis.document?.documentElement?.lang || undefined) : 'Not opened';
      return `<article class="list-card doc-list${selected().has(doc.id) ? ' is-selected' : ''}" data-library-doc="${escape(doc.id)}" draggable="true">
        <div class="document-card-top"><label><input type="checkbox" data-library-select="${escape(doc.id)}"${selected().has(doc.id) ? ' checked' : ''} aria-label="Select ${escape(doc.name)}"></label><button class="doc-favorite${doc.favorite ? ' is-favorite' : ''}" data-library-favorite="${escape(doc.id)}" aria-pressed="${!!doc.favorite}" aria-label="${doc.favorite ? 'Remove from' : 'Add to'} favorites: ${escape(doc.name)}">${doc.favorite ? '★' : '☆'}</button></div>
        ${app.cover(doc.type || 'file')}<div class="document-card-info"><h3 class="document-name" title="${escape(doc.name)}">${escape(doc.name)}</h3><p class="document-meta">${escape((doc.type || 'file').toUpperCase())} · ${app.size(doc.size || 0)} · ${escape(doc.folder || 'Inbox')} · ${escape(readingState)}</p>${Array.isArray(doc.tags) && doc.tags.length ? `<div class="document-tags">${doc.tags.slice(0,4).map(tag => `<span>#${escape(tag)}</span>`).join('')}${doc.tags.length > 4 ? `<small>+${doc.tags.length - 4}</small>` : ''}</div>` : ''}</div>
        <div class="document-card-actions"><button class="document-open" data-library-open="${escape(doc.id)}">Open reader →</button><select class="document-add-board" data-library-board="${escape(doc.id)}" aria-label="Add ${escape(doc.name)} to a board"><option value="">＋ Board</option>${boardOptions()}</select><button class="document-move-project" data-library-move="${escape(doc.id)}" title="Move to project" aria-label="Move ${escape(doc.name)} to project">Move to project</button><button class="document-rename" data-library-tags="${escape(doc.id)}" title="Edit tags" aria-label="Edit tags for ${escape(doc.name)}">#</button><button class="document-rename" data-library-read-toggle="${escape(doc.id)}" title="Mark ${escape(doc.name)} ${isRead ? 'unread' : 'read'}" aria-label="Mark ${escape(doc.name)} ${isRead ? 'unread' : 'read'}">${isRead ? '◉' : '○'}</button><button class="document-rename" data-library-rename="${escape(doc.id)}" title="Rename file" aria-label="Rename ${escape(doc.name)}">✎</button><button class="document-delete" data-library-delete="${escape(doc.id)}" title="Move to Trash" aria-label="Move ${escape(doc.name)} to Trash">×</button></div>
      </article>`;
    }
    function renderCard(doc) {
      try { return card(doc); }
      catch (error) {
        console.error('Document card rendering failed; showing a basic file card.', error);
        const id = escape(doc?.id), name = escape(doc?.name || 'Untitled file');
        return `<article class="list-card doc-list document-card-fallback${selected().has(doc?.id) ? ' is-selected' : ''}" data-library-doc="${id}">
          <div class="document-card-top"><label><input type="checkbox" data-library-select="${id}"${selected().has(doc?.id) ? ' checked' : ''} aria-label="Select ${name}"></label></div>
          <div class="doc-cover file-type-file"><span class="doc-type-icon">▤</span><span class="doc-type-label">FILE</span></div>
          <div class="document-card-info"><h3 class="document-name" title="${name}">${name}</h3><p class="document-meta">Saved file · ${escape(doc?.folder || 'Inbox')}</p></div>
          <div class="document-card-actions"><button class="document-open" data-library-open="${id}">Open reader →</button><button class="document-move-project" data-library-move="${id}" title="Move to project" aria-label="Move ${name} to project">Move to project</button><button class="document-delete" data-library-delete="${id}" title="Move to Trash" aria-label="Move ${name} to Trash">×</button></div>
        </article>`;
      }
    }
    function refreshSelection() {
      if (!rootElement?.isConnected) return;
      const count = selected().size;
      rootElement.querySelector('[data-library-selection-count]').textContent = count ? count + ' selected across your library' : 'Choose files to organize';
      rootElement.querySelector('.document-selection-bar')?.classList.toggle('has-selection', count > 0);
      rootElement.querySelectorAll('[data-needs-selection], [data-library-bulk-board]').forEach(control => { control.disabled = !count; });
      const all = rootElement.querySelector('[data-library-select-results]');
      const selectedMatches = result.matches.filter(doc => selected().has(doc.id)).length;
      all.checked = !!result.matches.length && selectedMatches === result.matches.length;
      all.indeterminate = !!selectedMatches && selectedMatches !== result.matches.length;
      all.disabled = !result.matches.length;
      rootElement.querySelectorAll('[data-library-select]').forEach(input => {
        input.checked = selected().has(input.dataset.librarySelect);
        input.closest('[data-library-doc]').classList.toggle('is-selected', input.checked);
      });
    }
    function refreshResults() {
      if (!rootElement?.isConnected) return;
      query();
      const grid = rootElement.querySelector('.document-results');
      grid.className = 'document-results document-grid' + (mode === 'list' ? ' document-table-mode' : '');
      grid.innerHTML = result.items.length ? result.items.map(renderCard).join('') : `<div class="empty-list"><h3>${app.getData().docs.length ? 'No matching files' : 'Your document library is ready'}</h3><p>${app.getData().docs.length ? 'Change the search or clear your filters to see more files.' : 'Import PDFs, EPUBs, text, photos, video, audio, and other files.'}</p><button class="secondary" ${app.getData().docs.length ? 'data-library-reset' : 'data-library-action="import"'}>${app.getData().docs.length ? 'Clear filters' : '＋ Import files'}</button></div>`;
      rootElement.querySelector('[data-library-summary]').textContent = result.matches.length + ' of ' + app.getData().docs.length + ' files · ' + app.size(result.size) + (result.matches.length > PAGE_SIZE ? ' · Showing ' + (page * PAGE_SIZE + 1) + '–' + Math.min((page + 1) * PAGE_SIZE, result.matches.length) : '');
      rootElement.querySelector('[data-library-page-label]').textContent = result.matches.length ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, result.matches.length)} of ${result.matches.length} · Page ${page + 1} of ${result.pages}` : '0 files';
      rootElement.querySelector('[data-library-page="previous"]').disabled = !page;
      rootElement.querySelector('[data-library-page="next"]').disabled = page >= result.pages - 1;
      rootElement.querySelectorAll('[data-library-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.libraryMode === mode)));
      rootElement.querySelectorAll('[data-library-smart]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.librarySmart === (app.getFilters().smart || 'all'))));
      for (const name of ['rename-folder', 'delete-folder']) rootElement.querySelector(`[data-library-action="${name}"]`).disabled = ['All documents', 'Inbox'].includes(app.getFilters().folder);
      refreshSelection();
    }
    function runAction(name) { Promise.resolve(app.action(name)).catch(error => app.notify(error.message || 'Action failed')); }
    function reset() {
      search = ''; page = 0; clearTimeout(searchTimer);
      app.setFilters({ folder: 'All documents', type: 'all', tag: '', favorites: false, sort: 'newest', smart: 'all' });
      rootElement.querySelector('.document-library-search').value = '';
      rootElement.querySelectorAll('[data-library-filter]').forEach(control => {
        const value = app.getFilters()[control.dataset.libraryFilter];
        if (control.type === 'checkbox') control.checked = value; else control.value = value;
      });
      refreshResults();
    }
    function mount() {
      rootElement = document.querySelector('.document-library');
      if (!rootElement) return;
      refreshResults();
      rootElement.addEventListener('input', event => {
        if (!event.target.matches('.document-library-search')) return;
        search = event.target.value; page = 0; clearTimeout(searchTimer);
        searchTimer = setTimeout(refreshResults, 120);
      });
      rootElement.addEventListener('change', event => {
        const target = event.target;
        if (target.matches('[data-library-filter]')) {
          clearTimeout(searchTimer);
          app.setFilters({ [target.dataset.libraryFilter]: target.type === 'checkbox' ? target.checked : target.value });
          page = 0; refreshResults();
          for (const name of ['rename-folder', 'delete-folder']) rootElement.querySelector(`[data-library-action="${name}"]`).disabled = ['All documents', 'Inbox'].includes(app.getFilters().folder);
        } else if (target.matches('[data-library-select]')) {
          target.checked ? selected().add(target.dataset.librarySelect) : selected().delete(target.dataset.librarySelect);
          refreshSelection();
        } else if (target.matches('[data-library-select-results]')) {
          for (const doc of result.matches) target.checked ? selected().add(doc.id) : selected().delete(doc.id);
          refreshSelection();
        } else if (target.matches('[data-library-board], [data-library-bulk-board]')) {
          const board = target.value; target.value = '';
          if (board) app.addToBoard(target.hasAttribute('data-library-bulk-board') ? [...selected()] : [target.dataset.libraryBoard], board);
        }
      });
      rootElement.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (button) {
          if (button.hasAttribute('data-library-action')) return runAction(button.dataset.libraryAction);
          if (button.hasAttribute('data-library-smart')) { app.setFilters({ smart: button.dataset.librarySmart, folder: 'All documents', type: 'all', tag: '', favorites: false }); page = 0; refreshResults(); return; }
          if (button.hasAttribute('data-library-tags')) { const doc = app.getData().docs.find(item => item.id === button.dataset.libraryTags); if (doc) { const value = await window.NotejectDialogs.prompt('Add or remove tags, separated by commas.', (doc.tags || []).join(', '), { title: 'Edit document tags', confirmLabel: 'Save tags', input: { label: 'Tags', placeholder: 'research, draft, reference' } }); if (value === null) return; doc.tags = [...new Set(value.split(',').map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))]; app.save(); refreshModel(); refreshResults(); } return; }
          if (button.hasAttribute('data-library-read-toggle')) { const doc = app.getData().docs.find(item => item.id === button.dataset.libraryReadToggle); if (doc) { const read = documentWasRead(doc); doc.readAt = read ? 0 : Date.now(); if(['pdf','epub','txt'].includes(doc.type))doc.readingStatus=read?'to-read':'finished'; app.save(); refreshResults(); } return; }
          if (button.hasAttribute('data-library-open')) return app.open(button.dataset.libraryOpen);
          if (button.hasAttribute('data-library-move')) {
            selected().clear(); selected().add(button.dataset.libraryMove);
            refreshSelection();
            return runAction('bulk-move');
          }
          if (button.hasAttribute('data-library-delete')) return app.delete(button.dataset.libraryDelete);
          if (button.hasAttribute('data-library-rename')) return app.rename(button.dataset.libraryRename);
          if (button.hasAttribute('data-library-clear-selection')) { selected().clear(); return refreshSelection(); }
          if (button.hasAttribute('data-library-reset')) return reset();
          if (button.hasAttribute('data-library-mode')) {
            mode = button.dataset.libraryMode;
            try { localStorage.setItem('noteject-document-view', mode); } catch {}
            return refreshResults();
          }
          if (button.hasAttribute('data-library-page')) { page += button.dataset.libraryPage === 'next' ? 1 : -1; refreshResults(); rootElement.querySelector('.document-results').scrollIntoView({ block: 'start' }); return; }
          if (button.hasAttribute('data-library-favorite')) {
            const doc = app.getData().docs.find(doc => doc.id === button.dataset.libraryFavorite);
            if (doc) { doc.favorite = !doc.favorite; app.save(); refreshResults(); }
            return;
          }
        }
        if (!event.target.closest('button,input,select,label,a')) {
          const row = event.target.closest('[data-library-doc]');
          if (row) app.open(row.dataset.libraryDoc);
        }
      });
      rootElement.addEventListener('dragstart', event => {
        const row = event.target.closest('[data-library-doc]');
        if (!row) return;
        if (event.target.closest('button,input,select,label,a')) { event.preventDefault(); return; }
        const docId = row.dataset.libraryDoc;
        app.drag(event, selected().has(docId) ? [...selected()] : [docId]);
      });
      rootElement.querySelector('.document-library-search').addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); search = ''; event.target.value = ''; page = 0; clearTimeout(searchTimer); refreshResults(); }
      });
    }
    function resetSearch() { clearTimeout(searchTimer); search=''; page=0; }
    return { render, mount, resetSearch };
  }
  return { catalog, create, PAGE_SIZE, isRead:documentWasRead };
});
