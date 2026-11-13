/* Shared workspace surfaces and accessible alternatives to spatial controls. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (label, run, className = 'secondary') => { const node = make('button', className, label); node.type = 'button'; node.onclick = run; return node; };
  let context = null;
  const readerLabels = Object.freeze({ passage:'Save passage', bookmark:'Save bookmark', contents:'Contents', saved:'Notes & Passages', view:'View & reading' });
  function androidHelp() {
    return `<dl><dt>Move around</dt><dd>Use Home, All notes, Record and Boards in the bottom bar. Menu opens Projects, Documents and Settings.</dd><dt>Write and record</dt><dd>Tap New note to write. Tap a note to read it, or touch and hold to select it. Record captures audio and can save a transcript in Notes.</dd><dt>Manage projects</dt><dd>Open Projects and use Manage to rename, organize, export or delete a project. Deleted projects can be restored from Trash.</dd><dt>Work with a Board</dt><dd>Tap to select, double tap to open, or hold then drag to move a card. Use Select to choose more cards, Connect to link them and Groups to manage groups. New assets start around the first asset at the center of the entire Board. Organize all arranges assets in the distant overview. Fit assets enlarges the layout. Center Board moves the camera without changing zoom. Use Assets to find a card or Zoom to edit it. Drag empty space to browse and pinch to zoom.</dd><dt>Read and save passages</dt><dd>Touch and hold text, adjust the handles and choose ${readerLabels.passage}. Use ${readerLabels.bookmark} to keep your position. Find saved items in ${readerLabels.saved}.</dd><dt>Adjust the Reader</dt><dd>${readerLabels.contents} opens the outline and page navigation. ${readerLabels.view} contains text size and page zoom. Pinch fixed-layout pages to zoom; scroll to read.</dd><dt>Backups and moving devices</dt><dd>Open Settings → Storage → Backup & transfer. Export a complete workspace or review a backup before importing. Import replaces the current workspace.</dd><dt>Go back</dt><dd>Android Back closes the current dialog or panel before returning to the previous page.</dd></dl>`;
  }
  function announce(message, urgent = false) {
    const target = document.getElementById(urgent ? 'workspace-alert' : 'workspace-status');
    if (!target) return;
    target.textContent = '';
    requestAnimationFrame(() => { target.textContent = String(message); });
  }
  function dialog(title) {
    const existing = document.querySelector('dialog.ux-dialog[open]'); if (existing) existing.close();
    const previous = document.activeElement, node = make('dialog', 'ux-dialog');
    const heading = make('h2', '', title); heading.id = 'ux-dialog-title'; node.setAttribute('aria-labelledby', heading.id);
    const header = make('header'); header.append(heading, button('Close', () => node.close())); node.append(header);
    node.addEventListener('close', () => { node.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }, { once: true });
    document.body.append(node); node.showModal(); return node;
  }
  // Restore the Home presentation shipped in 1.8.6. Android adds its original dashboard.
  function renderHome(data) {
    const recent=[...data.docs].sort((a,b)=>b.added-a.added).slice(0,4);return `<section class="home-hero"><div class="hero-copy"><div class="eyebrow">YOUR PRIVATE THINKING SPACE</div><h1>Make room for<br><em>good ideas.</em></h1><p>Collect what you read. Connect what you learn.<br>Keep it all on your device.</p><div class="buttons"><button class="primary" data-action="new-note">＋ Create a note</button><button class="secondary" data-action="import">＋ Add files</button></div></div><div class="hero-visual"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="hero-note note-a">✳<b>Ideas</b><small>linked and growing</small></div><div class="hero-note note-b">▤<b>Reading</b><small>highlights that stick</small></div><div class="hero-center">n</div></div></section><section class="stats-row"><article><span class="stat-icon">▦</span><div><b>${data.boards.length}</b><small>Boards</small></div></article><article><span class="stat-icon">▤</span><div><b>${data.notes.length}</b><small>Notes</small></div></article><article><span class="stat-icon">▣</span><div><b>${data.docs.length}</b><small>Documents</small></div></article><button class="tip-card" data-action="new-note"><span>✧</span><div><b>Quick capture</b><small>Save a thought before it slips away</small></div><span class="tip-arrow">↗</span></button></section><section class="home-lower"><div class="home-section-head"><div><div class="eyebrow">PICK UP WHERE YOU LEFT OFF</div><h2>Recent documents</h2></div><button class="text-button" data-view="library">View library →</button></div>${recent.length?`<div class="recent-grid">${recent.map(d=>`<article class="recent-card" data-doc="${esc(d.id)}"><div class="recent-cover ${d.type}"><span>${d.type.toUpperCase()}</span><b>↗</b></div><div><h3>${esc(d.name)}</h3><small>${size(d.size)} · ${new Date(d.added).toLocaleDateString(globalThis.document?.documentElement?.lang || undefined)}</small></div></article>`).join('')}</div>`:`<div class="home-empty"><span>✦</span><div><b>Your reading space is ready</b><small>Attach PDFs, EPUBs, photos, videos, and audio to your boards.</small></div><button class="secondary" data-action="import">Choose a document</button></div>`}</section>`
  }
  function openGraphItems() {
    const app = context; if (!app || app.view !== 'graph') return;
    const nodes = app.graphNodes(), edges = app.graphEdges(), node = dialog('Graph items & connections');
    const query = make('input'); query.type = 'search'; query.placeholder = 'Find an item…'; query.setAttribute('aria-label', 'Search graph items');
    const count = make('p', 'ux-muted'); count.setAttribute('role', 'status');
    const list = make('div', 'ux-browser-list'), detail = make('section', 'ux-browser-detail'); detail.setAttribute('aria-label', 'Selected graph item');
    let selected = null, limit = 80;
    function inspect(item) {
      selected = item; app.selectGraph(item.id);
      for (const control of list.querySelectorAll('[data-item-id]')) control.setAttribute('aria-pressed', String(control.dataset.itemId === item.id));
      const neighbors = edges.filter(edge => edge.from === item.id || edge.to === item.id);
      const heading = make('h3', '', item.label); heading.tabIndex = -1;
      detail.replaceChildren(heading, make('p', 'ux-muted', item.detail || (item.type === 'note' ? 'Note' : 'Document')),
        button('Open ' + (item.type === 'note' ? 'note' : 'document'), () => { node.close(); app.openItem({kind:item.type === 'note' ? 'note' : 'document',id:item.id}); }), make('h4', '', `Connections · ${neighbors.length}`));
      for (const edge of neighbors) {
        const other = nodes.find(entry => entry.id === (edge.from === item.id ? edge.to : edge.from));
        if (other) detail.append(button(`${other.label} · ${edge.label || 'Related'}`, () => inspect(other), 'ux-list-button'));
      }
      if (!neighbors.length) detail.append(make('p', 'ux-muted', 'No connections yet.'));
      const label = make('label', 'ux-field', 'Connect to another item'), target = make('select'); target.setAttribute('aria-label', 'Choose item to connect');
      target.add(new Option('Choose an item…', ''));
      for (const other of nodes) if (other.id !== item.id) target.add(new Option(other.label, other.id));
      const connect = button('Add connection', () => { const id = target.value; if (!id) return; node.close(); void app.connectGraph(item.id, id); });
      connect.disabled = true; target.onchange = () => { connect.disabled = !target.value; };
      label.append(target); detail.append(label, connect); heading.focus({ preventScroll:true });
      announce('Selected ' + item.label + ', ' + neighbors.length + ' connections');
      count.textContent = 'Selected ' + item.label + ' · ' + neighbors.length + ' connections';
    }
    function refresh() {
      const term = query.value.trim().toLocaleLowerCase(), visible = nodes.filter(item => (item.label + ' ' + item.detail).toLocaleLowerCase().includes(term));
      count.textContent = `${visible.length} items`; list.replaceChildren();
      for (const item of visible.slice(0,limit)) {
        const control = button(item.label + ' · ' + (item.type === 'note' ? 'Note' : item.fileType.toUpperCase()), () => inspect(item), 'ux-list-button');
        control.dataset.itemId = item.id; control.setAttribute('aria-pressed', String(selected?.id === item.id)); list.append(control);
      }
      if (visible.length > limit) list.append(button('Show more items', () => { limit += 80; refresh(); }));
      if (!visible.length) list.append(make('p', 'ux-muted', 'No matching items.'));
    }
    query.oninput = () => { limit = 80; refresh(); }; node.append(query, count, list, detail); refresh(); query.focus();
  }
  function openBoardItems() {
    const app = context; if (!app || app.view !== 'board') return;
    const board = app.board(), node = dialog('Board assets'), query = make('input'), list = make('div', 'ux-browser-list');
    query.type = 'search'; query.placeholder = 'Find a note or file…'; query.setAttribute('aria-label', 'Search Board assets');
    let limit = 60;
    function refresh() {
      const term = query.value.toLocaleLowerCase(); list.replaceChildren();
      const rows = board.items.map(item => ({item,record:(item.type === 'note' ? app.data.notes : app.data.docs).find(record => record.id === item.id)})).filter(({record}) => record && (record.title || record.name).toLocaleLowerCase().includes(term));
      for (const {item,record} of rows.slice(0,limit)) {
        const row = make('article', 'ux-asset-row'); row.append(make('h3', '', record.title || record.name));
        row.append(button('Select', () => { node.close(); app.selectBoardAsset(item.id); app.boardView.revealItems([item.id]); }),
          button('Zoom to edit', () => { node.close(); app.selectBoardAsset(item.id); app.boardView.zoom(1); app.boardView.revealItems([item.id]); }),
          button('Open', () => { node.close(); app.openItem({kind:item.type === 'note' ? 'note' : 'document',id:item.id}); })); list.append(row);
      }
      if (rows.length > limit) list.append(button('Show more assets', () => { limit += 60; refresh(); }));
      if (!rows.length) list.append(make('p','ux-muted',board.items.length ? 'No matching assets.' : 'Add your first note or file from the Board Add menu.'));
    }
    query.oninput = () => { limit = 60; refresh(); }; node.append(query,list); refresh(); query.focus();
  }
  function mount(app) {
    context = app;
    const root = document.getElementById('view'); if (!root) return;
    root.querySelectorAll('[data-ux-open]').forEach(control => { control.onclick = () => app.openItem({kind:control.dataset.uxKind,id:control.dataset.uxOpen}); });
    root.querySelectorAll('[data-ux-project]').forEach(control => { control.onclick = () => app.openView('projects',{folder:control.dataset.uxProject}); });
    root.querySelector('[data-ux-import]')?.addEventListener('click', app.chooseBackup);
    root.querySelector('[data-ux-start]')?.addEventListener('click', event => { try { localStorage.setItem('noteject-android-install-ready-v1','1'); } catch {} event.target.closest('.ux-home-setup')?.remove(); });
    if (app.view === 'notes' && !window.NotejectAndroid) {
      for (const card of root.querySelectorAll('.note-list-card')) {
        const heading = card.querySelector('h3'); if (!heading || heading.querySelector('button')) continue;
        const open = button(heading.textContent, event => { event.stopPropagation(); app.openItem({kind:'note',id:card.dataset.note}); }, 'ux-note-open');
        open.setAttribute('aria-label','Open note: ' + heading.textContent); heading.replaceChildren(open);
      }
    }
    if (app.view === 'graph') root.querySelector('[data-ux-graph-browse]')?.addEventListener('click', openGraphItems);
    if (app.view === 'settings') {
      const backup = root.querySelector('.workspace-backup-settings');
      if (backup) {
        backup.querySelector('h2').textContent = 'Backup & transfer';
        const copy = backup.querySelector('p'); if (copy) copy.textContent = 'Export your complete workspace to move devices or keep a backup. Import replaces this workspace; it does not add one project. You can review the backup before replacing anything.';
        const exp = backup.querySelector('#export-backup-settings'), imp = backup.querySelector('#load-backup-settings');
        if (exp) exp.textContent = 'Export workspace'; if (imp) imp.textContent = 'Import workspace';
      }
    }
  }
  async function confirmBackup(file, workspace, originalFiles) {
    const projects = [...new Set([...(workspace.folders || []),...(workspace.noteFolders || [])])].filter(name => name !== 'Inbox');
    const summary = `${file.name}\n\n${workspace.notes.length} notes · ${workspace.docs.length} documents · ${workspace.boards.length} Boards\nProjects: ${projects.length ? projects.slice(0,12).join(', ') + (projects.length > 12 ? '…' : '') : 'Inbox'}\nOriginal files included: ${originalFiles}\n\nThis replaces the current workspace. Your current data is kept until the import succeeds. Export your workspace first if you want a separate backup.`;
    return window.NotejectDialogs.confirm(summary,{title:'Review workspace import',confirmLabel:'Replace workspace',danger:true});
  }
  window.NotejectWorkspaceUX = { renderHome, mount, announce, openGraphItems, openBoardItems, confirmBackup, readerLabels, androidHelp };
})();
