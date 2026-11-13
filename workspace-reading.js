/* Local reading queue. Reader positions stay with the original library item. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectWorkspaceReading = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STATUSES = Object.freeze(['to-read', 'reading', 'finished']);
  const LABELS = Object.freeze({ 'to-read': 'To read', reading: 'Reading', finished: 'Finished' });
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => value === null || value === '' || value === undefined || typeof value === 'boolean' ? NaN : Number(value);
  const clamp = value => Math.max(0, Math.min(1, value));
  const time = value => { const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? numeric : 0; };
  const readableType = doc => String(doc && doc.type || '').toLowerCase();
  const isReadable = doc => !!doc && ['pdf', 'djvu', 'epub', 'txt', 'doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx'].includes(readableType(doc));
  const getStatus = doc => STATUSES.includes(doc && doc.readingStatus) ? doc.readingStatus : time(doc && doc.lastOpened) || time(doc && doc.readAt) ? 'reading' : 'to-read';
  const positiveTotal = (...values) => { for (const value of values) { const numeric = number(value); if (Number.isFinite(numeric) && numeric >= 1) return Math.floor(numeric); } return null; };

  function getProgress(doc) {
    if (!isReadable(doc)) return { known: false, ratio: null, percent: null, label: 'Open in Documents' };
    if (getStatus(doc) === 'finished') return { known: true, ratio: 1, percent: 100, label: 'Finished' };
    const type = readableType(doc);
    let ratio = null, label = 'Open to start reading';
    if (type === 'pdf' || type === 'djvu') {
      const total = positiveTotal(doc.readerPages, doc.pageCount);
      const page = number(doc.readerPage);
      const current = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
      if (total) {
        const bounded = Math.min(total, current), offset = number(doc.readerPageOffset);
        label = 'Page ' + bounded + ' of ' + total;
        ratio = (bounded - 1 + (Number.isFinite(offset) ? clamp(offset) : 0)) / total;
      } else if (Number.isFinite(page)) label = 'Page ' + current + ' · total not yet available';
    } else if (type === 'epub') {
      const total = positiveTotal(doc.readerChapters, Array.isArray(doc.epubTitles) ? doc.epubTitles.length : null);
      const chapter = number(doc.readerChapter), current = Number.isFinite(chapter) ? Math.max(0, Math.floor(chapter)) : 0;
      if (total) {
        const bounded = Math.min(total - 1, current), offset = number(doc.readerChapterOffset);
        label = 'Chapter ' + (bounded + 1) + ' of ' + total;
        ratio = (bounded + (Number.isFinite(offset) ? clamp(offset) : 0)) / total;
      } else if (Number.isFinite(chapter)) label = 'Chapter ' + (current + 1) + ' · total not yet available';
      if (typeof doc.readerChapterTitle === 'string' && doc.readerChapterTitle.trim()) label += ' · ' + doc.readerChapterTitle.trim();
    } else if (time(doc.lastOpened) || time(doc.readAt)) label = 'Saved reading position';
    const saved = number(doc.readerProgress);
    if (Number.isFinite(saved)) { ratio = clamp(saved); if (type === 'txt') label = Math.round(ratio * 100) + '% through text'; }
    if (ratio === null) return { known: false, ratio: null, percent: null, label };
    ratio = clamp(ratio);
    return { known: true, ratio, percent: Math.round(ratio * 100), label };
  }

  function resumeIdentity(doc) { return isReadable(doc) && typeof doc.id === 'string' && doc.id ? { kind: 'document', id: doc.id } : null; }

  function setStatus(doc, status, now = Date.now()) {
    if (!isReadable(doc) || !STATUSES.includes(status)) return false;
    const changedAt = time(now) || Date.now();
    doc.readingStatus = status;
    doc.readingUpdated = changedAt;
    if (status === 'to-read') doc.readAt = 0;
    else if (status === 'finished') doc.readAt = changedAt;
    else if (!time(doc.readAt)) doc.readAt = changedAt;
    return true;
  }

  function filterDocuments(docs, options) {
    const filter = options || {}, query = String(filter.query || '').trim().toLocaleLowerCase();
    const result = (Array.isArray(docs) ? docs : []).filter(doc => isReadable(doc) &&
      (!filter.status || filter.status === 'all' || getStatus(doc) === filter.status) &&
      (!filter.folder || filter.folder === 'all' || String(doc.folder || 'Inbox') === filter.folder) &&
      (!filter.favorites || !!doc.favorite) &&
      (!query || [doc.name, doc.title, doc.author, doc.folder || 'Inbox', ...(Array.isArray(doc.tags) ? doc.tags : [])].join(' ').toLocaleLowerCase().includes(query)));
    const title = doc => String(doc.name || doc.title || 'Untitled document');
    result.sort((a, b) => {
      if (filter.sort === 'name') return title(a).localeCompare(title(b)) || String(a.id).localeCompare(String(b.id));
      if (filter.sort === 'progress') {
        const ap = getProgress(a), bp = getProgress(b);
        if (ap.known !== bp.known) return ap.known ? -1 : 1;
        if (ap.known && ap.ratio !== bp.ratio) return bp.ratio - ap.ratio;
      }
      return Math.max(time(b.lastOpened), time(b.readAt)) - Math.max(time(a.lastOpened), time(a.readAt)) || time(b.added || b.created) - time(a.added || a.created) || title(a).localeCompare(title(b));
    });
    return result;
  }

  function selectContinueReading(docs) {
    return filterDocuments(docs, { sort: 'recent' }).find(doc => getStatus(doc) !== 'finished' && (time(doc.lastOpened) || time(doc.readAt))) || null;
  }

  function create(app) {
    let status = 'all', folder = 'all', query = '', sort = 'recent', favorites = false, limit = 60;
    const docs = () => app.getData().docs || [];
    const label = doc => String(doc.name || doc.title || 'Untitled document');
    function progressMarkup(doc) {
      const progress = getProgress(doc);
      return '<div class="wr-progress-copy"><span>' + esc(progress.label) + '</span>' + (progress.known ? '<b>' + progress.percent + '%</b>' : '') + '</div>' +
        (progress.known ? '<div class="wr-progress-track" role="progressbar" aria-label="Reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress.percent + '"><span style="width:' + progress.percent + '%"></span></div>' : '<div class="wr-progress-unknown">Your position will be saved when you read.</div>');
    }
    function fileIcon(doc) {
      const type = readableType(doc);
      return '<span class="wr-file-icon wr-type-' + type + '" aria-hidden="true">' + (type === 'epub' ? '<svg viewBox="0 0 24 24"><path d="M3 5c3-1 6-.3 9 1.5C15 4.7 18 4 21 5v14c-3-1-6-.3-9 1.5C9 18.7 6 18 3 19zM12 6.5v14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/></svg>') + '<small>' + type.toUpperCase() + '</small></span>';
    }
    function statusSelect(doc) {
      return '<label class="wr-status-control"><span class="wr-visually-hidden">Reading status for ' + esc(label(doc)) + '</span><select data-wr-status="' + esc(doc.id) + '">' + STATUSES.map(value => '<option value="' + value + '"' + (getStatus(doc) === value ? ' selected' : '') + '>' + LABELS[value] + '</option>').join('') + '</select></label>';
    }
    function card(doc) {
      const state = getStatus(doc), hasOpened = time(doc.lastOpened) || time(doc.readAt);
      return '<article class="workspace-card wr-card">' + fileIcon(doc) + '<div class="wr-card-copy"><div class="wr-card-heading"><button type="button" class="wr-title-button" data-wr-open="' + esc(doc.id) + '">' + esc(label(doc)) + '</button><button type="button" class="wr-favorite' + (doc.favorite ? ' is-active' : '') + '" data-wr-favorite="' + esc(doc.id) + '" aria-label="' + (doc.favorite ? 'Unpin ' : 'Pin ') + esc(label(doc)) + '" aria-pressed="' + !!doc.favorite + '" title="' + (doc.favorite ? 'Remove from Favorites' : 'Add to Favorites') + '">' + (doc.favorite ? '★' : '☆') + '</button></div><p class="wr-file-meta">' + esc(doc.folder || 'Inbox') + (doc.author ? ' · ' + esc(doc.author) : '') + '</p>' + progressMarkup(doc) + '<div class="wr-card-actions">' + statusSelect(doc) + '<button type="button" class="workspace-small-button" data-wr-open="' + esc(doc.id) + '">' + (state === 'finished' ? 'Open again' : hasOpened ? 'Continue reading' : 'Start reading') + ' ↗</button></div></div></article>';
    }
    function continueMarkup(doc) {
      if (!doc) return '<section class="workspace-card wr-continue wr-start"><div><span class="workspace-eyebrow">YOUR NEXT CHAPTER</span><h2>Make room for reading</h2><p>Open a PDF, DjVu, EPUB, text, Word, Excel, or PowerPoint document below. Come back here to continue from your saved position.</p></div><button type="button" class="workspace-small-button" data-wr-library>Browse Documents ↗</button></section>';
      return '<section class="workspace-card wr-continue">' + fileIcon(doc) + '<div class="wr-continue-copy"><span class="workspace-eyebrow">CONTINUE READING</span><h2>' + esc(label(doc)) + '</h2><p class="wr-file-meta">' + esc(doc.folder || 'Inbox') + ' · ' + readableType(doc).toUpperCase() + '</p>' + progressMarkup(doc) + '</div><button type="button" class="primary" data-wr-open="' + esc(doc.id) + '">Continue reading ↗</button></section>';
    }
    function render(view) {
      if (view !== 'reading') return '';
      const all = docs().filter(isReadable);
      const folders = [...new Set(all.map(doc => String(doc.folder || 'Inbox')))].sort((a, b) => a.localeCompare(b));
      if (folder !== 'all' && !folders.includes(folder)) folder = 'all';
      const visible = filterDocuments(all, { status, folder, query, sort, favorites });
      const counts = Object.fromEntries(STATUSES.map(value => [value, all.filter(doc => getStatus(doc) === value).length]));
      return '<section class="workspace-page wr-page" data-workspace-reading><header class="workspace-page-heading"><div><span class="workspace-eyebrow">YOUR WORKSPACE</span><h1>Reading queue</h1><p>Keep your books and papers moving, and pick up where you left off.</p></div><div class="workspace-actions"><button type="button" class="secondary" data-wr-library>Browse Documents ↗</button></div></header>' + continueMarkup(selectContinueReading(all)) + '<div class="workspace-stat-row wr-stats">' + STATUSES.map(value => '<button type="button" class="workspace-stat" data-wr-filter="' + value + '"><b>' + counts[value] + '</b><span>' + LABELS[value] + '</span></button>').join('') + '</div><div class="workspace-filterbar wr-filterbar"><div class="wr-segments" role="group" aria-label="Reading status">' + [['all', 'All', all.length], ...STATUSES.map(value => [value, LABELS[value], counts[value]])].map(([value, text, count]) => '<button type="button" class="workspace-pill' + (status === value ? ' is-active' : '') + '" data-wr-filter="' + value + '" aria-pressed="' + (status === value) + '">' + text + '<small>' + count + '</small></button>').join('') + '</div><div class="wr-filter-controls"><input type="search" data-wr-query value="' + esc(query) + '" placeholder="Find a book or paper…" aria-label="Search reading queue"><select data-wr-folder aria-label="Filter reading project"><option value="all">All projects</option>' + folders.map(value => '<option value="' + esc(value) + '"' + (folder === value ? ' selected' : '') + '>' + esc(value) + '</option>').join('') + '</select><select data-wr-sort aria-label="Sort reading queue"><option value="recent"' + (sort === 'recent' ? ' selected' : '') + '>Recently opened</option><option value="name"' + (sort === 'name' ? ' selected' : '') + '>Name</option><option value="progress"' + (sort === 'progress' ? ' selected' : '') + '>Progress</option></select><button type="button" class="workspace-small-button' + (favorites ? ' is-active' : '') + '" data-wr-favorites aria-pressed="' + favorites + '">☆ Favorites</button></div></div><div class="wr-results-heading"><span>' + visible.length + ' ' + (visible.length === 1 ? 'document' : 'documents') + '</span><small>PDF · DjVu · EPUB · TXT · DOC · XLS · PPT</small></div>' + (visible.length ? '<div class="workspace-card-grid wr-card-grid">' + visible.slice(0, limit).map(card).join('') + '</div>' + (visible.length > limit ? '<div class="wr-more"><button type="button" class="secondary" data-wr-more>Show 60 more · ' + (visible.length - limit) + ' remaining</button></div>' : '') : '<div class="workspace-empty wr-empty"><span aria-hidden="true">▤</span><h2>' + (all.length ? 'No documents match' : 'Your reading queue is ready') + '</h2><p>' + (all.length ? 'Try another status, project, or search.' : 'Import a PDF, DjVu, EPUB, TXT, Word, Excel, or PowerPoint file in Documents. It will appear here automatically.') + '</p><button type="button" class="workspace-small-button" ' + (all.length ? 'data-wr-reset>Clear filters' : 'data-wr-library>Open Documents') + '</button></div>') + '</section>';
    }
    function refresh() { limit = 60; app.render(); }
    function find(id) { return docs().find(doc => isReadable(doc) && doc.id === id); }
    function open(id) {
      const doc = find(id), target = resumeIdentity(doc);
      if (!target) { if (app.notify) app.notify('This document is no longer in the library'); return; }
      app.openItem(target);
    }
    function mount(view) {
      if (view !== 'reading' || typeof document === 'undefined') return;
      const shell = document.querySelector('[data-workspace-reading]');
      if (!shell) return;
      shell.onclick = event => {
        const control = event.target.closest('button');
        if (!control || !shell.contains(control)) return;
        if (control.hasAttribute('data-wr-open')) { open(control.dataset.wrOpen); return; }
        if (control.hasAttribute('data-wr-favorite')) { const doc = find(control.dataset.wrFavorite); if (doc) { doc.favorite = !doc.favorite; app.save(); app.render(); } return; }
        if (control.hasAttribute('data-wr-filter')) { status = control.dataset.wrFilter; refresh(); return; }
        if (control.hasAttribute('data-wr-favorites')) { favorites = !favorites; refresh(); return; }
        if (control.hasAttribute('data-wr-library')) { app.openView('library'); return; }
        if (control.hasAttribute('data-wr-reset')) { status = 'all'; folder = 'all'; query = ''; favorites = false; refresh(); return; }
        if (control.hasAttribute('data-wr-more')) { limit += 60; app.render(); }
      };
      shell.onchange = event => {
        const control = event.target;
        if (control.hasAttribute('data-wr-status')) {
          const doc = find(control.dataset.wrStatus);
          if (setStatus(doc, control.value)) { app.save(); app.render(); }
        } else if (control.hasAttribute('data-wr-folder')) { folder = control.value; refresh(); }
        else if (control.hasAttribute('data-wr-sort')) { sort = control.value; refresh(); }
      };
      shell.oninput = event => {
        if (!event.target.hasAttribute('data-wr-query')) return;
        query = event.target.value;
        const start = event.target.selectionStart, end = event.target.selectionEnd;
        refresh();
        const replacement = document.querySelector('[data-workspace-reading] [data-wr-query]');
        if (replacement) { replacement.focus(); try { replacement.setSelectionRange(start, end); } catch (_) {} }
      };
    }
    return { render, mount };
  }
  return { create, STATUSES, getStatus, setStatus, isReadable, getProgress, resumeIdentity, filterDocuments, selectContinueReading };
});
