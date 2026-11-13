/* Board overview: index records once, then update only the visible gallery page. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotejectBoardGallery = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const PAGE_SIZE = 24;
  const PREVIEW_LIMIT = 60;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const number = value => Math.round(value * 10) / 10;

  function preview(items, edges) {
    if (!items.length) return { cards: [], links: [], total: 0 };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const item of items) {
      const x = finite(item.x), y = finite(item.y);
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 207); bottom = Math.max(bottom, y + 150);
    }
    const scale = Math.min(420 / Math.max(207, right - left), 164 / Math.max(150, bottom - top));
    const offsetX = (480 - (right - left) * scale) / 2;
    const offsetY = (220 - (bottom - top) * scale) / 2;
    const cards = items.slice(0, PREVIEW_LIMIT).map(item => ({
      id: String(item.id ?? ''), type: item.type === 'note' ? 'note' : 'doc',
      x: number(offsetX + (finite(item.x) - left) * scale),
      y: number(offsetY + (finite(item.y) - top) * scale),
      width: number(207 * scale), height: number(150 * scale)
    }));
    const positions = new Map(cards.map(card => [card.id, card]));
    const links = [];
    for (const edge of edges) {
      const from = positions.get(String(edge.from)), to = positions.get(String(edge.to));
      if (!from || !to) continue;
      links.push({ x1: number(from.x + from.width / 2), y1: number(from.y + from.height / 2), x2: number(to.x + to.width / 2), y2: number(to.y + to.height / 2) });
      if (links.length >= 80) break;
    }
    return { cards, links, total: items.length };
  }

  function createModel(data = {}) {
    const notes = new Map((data.notes || []).map(note => [note.id, note]));
    const docs = new Map((data.docs || []).map(doc => [doc.id, doc]));
    let cards = 0, connections = 0;
    const boards = (data.boards || []).map((board, index) => {
      const items = (board.items || []).filter(Boolean), edges = (board.edges || []).filter(Boolean);
      const names = items.map(item => ({
        id: String(item.id ?? ''), type: item.type === 'note' ? 'note' : 'doc',
        name: String(item.type === 'note' ? notes.get(item.id)?.title || 'Untitled note' : docs.get(item.id)?.name || 'Missing document')
      }));
      cards += items.length; connections += edges.length;
      return {
        id: String(board.id ?? ''), name: String(board.name || 'Untitled board'), index,
        cards: items.length, notes: items.filter(item => item.type === 'note').length,
        docs: items.filter(item => item.type === 'doc').length, connections: edges.length,
        names: names.slice(0, 3), search: (String(board.name || '') + ' ' + names.map(item => item.name).join(' ')).toLocaleLowerCase(),
        preview: preview(items, edges)
      };
    });
    return { boards, totals: { boards: boards.length, cards, connections } };
  }

  function query(model, { search = '', sort = 'name', page = 0 } = {}) {
    const term = String(search).trim().toLocaleLowerCase();
    const boards = model.boards.filter(board => !term || board.search.includes(term));
    boards.sort((a, b) => (sort === 'cards' ? b.cards - a.cards : sort === 'connections' ? b.connections - a.connections : 0) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.index - b.index);
    const pages = Math.max(1, Math.ceil(boards.length / PAGE_SIZE));
    const currentPage = Math.max(0, Math.min(pages - 1, Math.floor(finite(page))));
    return { boards: boards.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE), total: boards.length, page: currentPage, pages };
  }

  function renderPreview(board) {
    const geometry = board.preview;
    if (!geometry.cards.length) return '<div class="board-gallery-empty-canvas"><span aria-hidden="true">＋</span><span>A space for your next idea</span></div>';
    const lines = geometry.links.map(link => `<line x1="${link.x1}" y1="${link.y1}" x2="${link.x2}" y2="${link.y2}"/>`).join('');
    const cards = geometry.cards.map(card => `<g class="gallery-mini-${card.type}"><rect x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="${number(Math.min(7, card.width / 8))}"/><path d="M ${number(card.x + card.width * .16)} ${number(card.y + card.height * .3)} h ${number(card.width * .55)} M ${number(card.x + card.width * .16)} ${number(card.y + card.height * .5)} h ${number(card.width * .68)} M ${number(card.x + card.width * .16)} ${number(card.y + card.height * .69)} h ${number(card.width * .4)}"/></g>`).join('');
    return `<svg viewBox="0 0 480 220" aria-hidden="true" focusable="false"><g class="gallery-mini-links">${lines}</g>${cards}</svg>${geometry.total > PREVIEW_LIMIT ? '<span class="board-gallery-preview-limit">First 60 cards</span>' : ''}`;
  }

  function renderCard(board) {
    const favoriteAction = board.favorite ? 'Remove from Favorites' : 'Add to Favorites';
    return `<article class="board-gallery-card"><header class="board-gallery-card-top"><button type="button" class="board-gallery-title" data-gallery-open="${escape(board.id)}" aria-label="Open board ${escape(board.name)}"><b>${escape(board.name)}</b><span aria-hidden="true">↗</span></button><details class="board-gallery-management"><summary aria-label="Manage board ${escape(board.name)}" title="Manage board">⋯</summary><div class="board-gallery-management-popover" role="menu" aria-label="Board actions"><button type="button" role="menuitem" data-gallery-action="open" data-gallery-id="${escape(board.id)}">Open board</button><button type="button" role="menuitem" data-gallery-action="rename" data-gallery-id="${escape(board.id)}">Rename board</button><button type="button" role="menuitem" data-gallery-action="duplicate" data-gallery-id="${escape(board.id)}">Duplicate board</button><button type="button" role="menuitem" data-gallery-action="favorite" data-gallery-id="${escape(board.id)}">${favoriteAction}</button><button type="button" role="menuitem" data-gallery-action="export" data-gallery-id="${escape(board.id)}">Export board</button><button type="button" role="menuitem" class="is-destructive" data-gallery-action="delete" data-gallery-id="${escape(board.id)}">Delete board</button></div></details></header><button type="button" class="board-gallery-open" data-gallery-open="${escape(board.id)}" aria-label="Open board ${escape(board.name)}"><span class="board-gallery-preview">${renderPreview(board)}</span></button><div class="board-gallery-card-body"><div class="board-gallery-counts"><span><i class="gallery-note-dot" aria-hidden="true"></i>${board.notes} notes</span><span><i class="gallery-doc-dot" aria-hidden="true"></i>${board.docs} documents</span><span>${board.connections} links</span></div><div class="board-gallery-items">${board.names.length ? board.names.map(item => `<button type="button" data-gallery-item="${escape(item.id)}" data-gallery-board="${escape(board.id)}" title="Find ${escape(item.name)} on this board"><span aria-hidden="true">${item.type === 'note' ? '✎' : '▤'}</span><span>${escape(item.name)}</span></button>`).join('') : '<p>Add notes and documents to get started.</p>'}</div>${board.cards > 3 ? `<span class="board-gallery-more-items">+${board.cards - 3} more cards</span>` : ''}</div></article>`;
  }

  function renderResults(model, state) {
    const result = query(model, state);
    state.page = result.page;
    const empty = model.boards.length ? '<h2>No matching boards</h2><p>Search by board name or by a note or document inside it.</p><button type="button" class="secondary" data-gallery-reset>Clear search</button>' : '<h2>Your first board starts here</h2><p>Collect notes and documents, arrange your ideas, and connect them.</p><button type="button" class="primary" data-gallery-new>＋ Create a board</button>';
    return `<div class="board-gallery-result-summary" aria-live="polite">${result.total ? `${result.page * PAGE_SIZE + 1}–${Math.min((result.page + 1) * PAGE_SIZE, result.total)} of ${result.total}` : '0'} boards${state.search.trim() ? ' matching your search' : ''}</div><div class="board-gallery-grid">${result.boards.length ? result.boards.map(renderCard).join('') : `<div class="board-gallery-empty">${empty}</div>`}</div>${result.pages > 1 ? `<nav class="board-gallery-pagination" aria-label="Board pages"><button type="button" class="secondary" data-gallery-page="${result.page - 1}" ${result.page === 0 ? 'disabled' : ''}>← Previous</button><span>Page ${result.page + 1} of ${result.pages}</span><button type="button" class="secondary" data-gallery-page="${result.page + 1}" ${result.page === result.pages - 1 ? 'disabled' : ''}>Next →</button></nav>` : ''}`;
  }

  function create(adapter) {
    let model = createModel(), timer;
    const state = { search: '', sort: 'name', page: 0 };
    function render() {
      clearTimeout(timer);
      model = createModel(adapter.getData());
      return `<section class="board-gallery"><header class="board-gallery-heading"><div><div class="eyebrow">YOUR WORKSPACE</div><h1>Boards</h1><p>Make room for ideas. See your work at a glance.</p></div><button type="button" class="primary" data-gallery-new>＋ New board</button></header><div class="board-gallery-stats"><span><b>${model.totals.boards}</b> boards</span><span><b>${model.totals.cards}</b> cards</span><span><b>${model.totals.connections}</b> connections</span><span class="board-gallery-legend"><i class="gallery-note-dot" aria-hidden="true"></i>Notes <i class="gallery-doc-dot" aria-hidden="true"></i>Documents</span></div><div class="board-gallery-tools"><label class="board-gallery-search"><span aria-hidden="true">⌕</span><input type="search" data-gallery-search placeholder="Find boards, notes, or documents…" aria-label="Find boards, notes, or documents" value="${escape(state.search)}"></label><label class="board-gallery-sort">Sort by <select data-gallery-sort aria-label="Sort boards"><option value="name" ${state.sort === 'name' ? 'selected' : ''}>Board name</option><option value="cards" ${state.sort === 'cards' ? 'selected' : ''}>Most cards</option><option value="connections" ${state.sort === 'connections' ? 'selected' : ''}>Most connections</option></select></label></div><div data-gallery-results>${renderResults(model, state)}</div></section>`;
    }
    function mount() {
      const root = document.querySelector('.board-gallery');
      if (!root) return;
      const search = root.querySelector('[data-gallery-search]');
      const update = () => {
        if (root.isConnected) root.querySelector('[data-gallery-results]').innerHTML = renderResults(model, state);
      };
      search.oninput = () => {
        state.search = search.value; state.page = 0;
        clearTimeout(timer); timer = setTimeout(update, 90);
      };
      search.onkeydown = event => {
        if (event.key === 'Enter') { event.preventDefault(); clearTimeout(timer); update(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.search = search.value = ''; state.page = 0; clearTimeout(timer); update(); }
      };
      root.querySelector('[data-gallery-sort]').onchange = event => {
        state.sort = event.target.value; state.page = 0; clearTimeout(timer); update();
      };
      root.onclick = event => {
        const button = event.target.closest('button');
        if (!button || !root.contains(button) || button.disabled) return;
        if (button.hasAttribute('data-gallery-new')) adapter.newBoard();
        else if (button.hasAttribute('data-gallery-open')) adapter.openBoard(button.dataset.galleryOpen);
        else if (button.hasAttribute('data-gallery-item')) adapter.openItem(button.dataset.galleryBoard, button.dataset.galleryItem);
        else if (button.hasAttribute('data-gallery-action')) {
          const menu = button.closest('details');
          if (menu) menu.open = false;
          adapter.manageBoard?.(button.dataset.galleryAction, button.dataset.galleryId);
        }
        else if (button.hasAttribute('data-gallery-reset')) { state.search = ''; state.page = 0; search.value = ''; clearTimeout(timer); update(); search.focus(); }
        else if (button.hasAttribute('data-gallery-page')) { state.page = Number(button.dataset.galleryPage); clearTimeout(timer); update(); root.querySelector('[data-gallery-results]').scrollIntoView({ block: 'start' }); }
      };
    }
    return { render, mount };
  }

  return { create, createModel, query, PAGE_SIZE, PREVIEW_LIMIT };
});
