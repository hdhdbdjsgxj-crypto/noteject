/* Board editing tools and workspace commands. Original files stay in the library. */
(() => {
  'use strict';
  function create(app) {
    const history = window.NotejectBoardHistory.create(50);
    let knownRecords = new Set([...app.getData().notes, ...app.getData().docs].map(item => item.id));
    const layout = window.NotejectBoardLayout;
    const menu = window.NotejectCommandMenu;
    let lastBoardId = null;
    const boardMembership = new WeakMap();
    const itemIds = board => new Set((board.items || []).map(item => item.id));
    for (const board of app.getData().boards) boardMembership.set(board, itemIds(board));

    function observe(options = {}) {
      const data = app.getData();
      const records = new Set([...data.notes, ...data.docs].map(item => item.id));
      // A permanently deleted library record cannot be recovered by board undo.
      if ([...knownRecords].some(id => !records.has(id))) {
        for (const board of data.boards) history.discard(board.id);
      }
      knownRecords = records;
      for (const board of data.boards) {
        const previous = boardMembership.get(board), current = itemIds(board);
        const added = previous ? [...current].some(id => !previous.has(id)) : current.size && !board.viewport;
        if (added) { board.organizeNewAssets = true; board.focusNewAssets = true; }
        boardMembership.set(board, current);
        if (options.coalesceHistory) history.coalesce(board);
        else history.observe(board);
      }
      const board = app.getBoard();
      const undoButton = document.querySelector('[data-board-undo]'), redoButton = document.querySelector('[data-board-redo]');
      if (undoButton) undoButton.disabled = !history.canUndo(board.id);
      if (redoButton) redoButton.disabled = !history.canRedo(board.id);
    }

    function ready() {
      if (!document.querySelector('#edit-body')) return true;
      app.notify('Save or close your note before changing the board');
      return false;
    }
    function runSafely(run) {
      if (!ready()) return;
      try { Promise.resolve(run()).catch(error => app.notify(error.message || 'Could not finish this action')); }
      catch (error) { app.notify(error.message || 'Could not finish this action'); }
    }

    function element(tag, className, text) {
      const result = document.createElement(tag);
      if (className) result.className = className;
      if (text !== undefined) result.textContent = text;
      return result;
    }
    function button(label, run, title) {
      const control = element('button', '', label);
      control.type = 'button';
      control.onclick = () => runSafely(run);
      if (title) control.title = title;
      return control;
    }
    function sizes() {
      const result = {};
      document.querySelectorAll('.canvas-world [data-item]').forEach(card => {
        result[card.dataset.item] = { width: card.offsetWidth, height: card.offsetHeight };
      });
      return result;
    }
    function rememberViewport() {
      const canvas = document.querySelector('.canvas');
      return canvas ? { left: canvas.scrollLeft, top: canvas.scrollTop } : null;
    }
    function finish(viewport = rememberViewport(), refreshInPlace = false) {
      app.save();
      if (refreshInPlace && typeof app.refreshBoard === 'function' && app.refreshBoard(viewport) !== false) {
        refreshSelection();
        return;
      }
      app.render();
      const canvas = document.querySelector('.canvas');
      if (canvas && viewport) { canvas.scrollLeft = viewport.left; canvas.scrollTop = viewport.top; }
    }
    function refreshSelection() {
      if (app.getView() !== 'board') return;
      const board = app.getBoard(), data = app.getData(), selection = app.getSelection();
      const validIds = new Set(board.items.map(card => card.id));
      const ids = [...selection].filter(id => validIds.has(id));
      if (ids.length !== selection.size) app.setSelection(ids);
      const chosen = app.getSelection();
      document.querySelectorAll('.canvas-world [data-item]').forEach(card => {
        card.classList.toggle('multi-selected', chosen.has(card.dataset.item));
      });
      const count = document.querySelector('.board-toolstrip-count');
      if (count) count.textContent = chosen.size ? chosen.size + ' selected' : board.items.length + ' cards';
      const all = document.querySelector('[data-board-select-all]');
      if (all) all.textContent = chosen.size ? 'Clear selection' : 'Select all';
      const placeholder = document.querySelector('#board-arrange option[value=""]');
      if (placeholder) placeholder.textContent = chosen.size ? 'Arrange selected…' : 'Arrange all…';
      const tools = document.querySelector('.board-selection-tools');
      if (tools) {
        tools.hidden = !chosen.size;
        const label = tools.querySelector('span');
        if (label) label.textContent = chosen.size + ' selected';
        const colorPicker = tools.querySelector('[data-board-note-tint]');
        if (colorPicker) { colorPicker.disabled = !board.items.some(item => chosen.has(item.id) && (item.type === 'note' ? data.notes.some(note => note.id === item.id) : data.docs.some(doc => doc.id === item.id))); colorPicker.value = ''; }
        const group = tools.querySelector('[data-action="board-group-selection"]'), ungroup = tools.querySelector('[data-action="board-ungroup-selection"]');
        if (group) group.disabled = chosen.size < 2;
        if (ungroup) ungroup.disabled = !board.items.some(item => chosen.has(item.id) && (item.groupId || (board.groups || []).some(entry => entry.itemIds?.includes(item.id))));
      }
    }
    function selectAll() {
      app.setSelection(app.getBoard().items.map(item => item.id));
      refreshSelection();
    }
    function undo() {
      if (!history.undo(app.getBoard())) return;
      boardMembership.set(app.getBoard(), itemIds(app.getBoard()));
      delete app.getBoard().organizeNewAssets; delete app.getBoard().focusNewAssets;
      app.setSelection([]);
      finish();
      app.notify('Board change undone');
    }
    function redo() {
      if (!history.redo(app.getBoard())) return;
      boardMembership.set(app.getBoard(), itemIds(app.getBoard()));
      delete app.getBoard().organizeNewAssets; delete app.getBoard().focusNewAssets;
      app.setSelection([]);
      finish();
      app.notify('Board change restored');
    }
    function arrange(mode) {
      if (!ready()) return;
      app.cancelInitialBoardFit?.();
      const result = layout.arrange(app.getBoard().items, [...app.getSelection()], mode, sizes());
      if (!result.count) { app.notify(mode.startsWith('distribute') ? 'Choose at least three cards to distribute' : 'Choose at least two cards to align'); return; }
      finish(rememberViewport(), true);
      app.notify('Arranged ' + result.count + ' cards');
    }
    function fit() {
      const canvas = document.querySelector('.canvas');
      if (!canvas || !app.getBoard().items.length) { app.notify('Add cards to the board first'); return; }
      const target = layout.fit(app.getBoard().items, { width: canvas.clientWidth, height: canvas.clientHeight }, sizes());
      if (!target) return;
      app.getBoard().zoom = target.zoom;
      finish({ left: target.left, top: target.top }, true);
    }
    function tidyConnected() {
      if (!ready()) return;
      const board = app.getBoard(), data = app.getData();
      const items = board.items.filter(item => data.notes.some(note => note.id === item.id) || data.docs.some(doc => doc.id === item.id));
      if (!items.length) { app.notify('Add a note or document first'); return; }
      const valid = new Set(items.map(item => item.id));
      const edges = (board.edges || []).filter(edge => valid.has(edge.from) && valid.has(edge.to));
      if (!edges.length) {
        const result = layout.arrange(items, [], 'grid', sizes());
        if (!result.count) return;
        finish(rememberViewport(), true); fit(); app.notify('Cards arranged in a grid'); return;
      }
      const links = new Map(items.map(item => [item.id, []]));
      for (const edge of edges) { links.get(edge.from)?.push(edge.to); links.get(edge.to)?.push(edge.from); }
      const levels = new Map([[items[0].id, 0]]), queue = [items[0].id];
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        for (const next of links.get(current) || []) if (!levels.has(next)) { levels.set(next, levels.get(current) + 1); queue.push(next); }
      }
      const lastLevel = Math.max(...levels.values());
      for (const item of items) if (!levels.has(item.id)) levels.set(item.id, lastLevel + 1);
      const columns = new Map();
      for (const item of items) { const level = levels.get(item.id); if (!columns.has(level)) columns.set(level, []); columns.get(level).push(item); }
      const measured = sizes(); let left = 70;
      for (const [, column] of [...columns].sort((a, b) => a[0] - b[0])) {
        column.sort((a, b) => a.y - b.y || a.x - b.x);
        const width = Math.max(...column.map(item => measured[item.id]?.width || 207));
        let top = 70;
        for (const item of column) {
          const size = measured[item.id] || { width: 207, height: 160 };
          item.x = left + (width - size.width) / 2; item.y = top; top += size.height + 48;
        }
        left += width + 100;
      }
      finish(rememberViewport(), true); fit(); app.notify('Connected cards arranged by relationship');
    }
    function copyBoard() {
      const data = app.getData(), original = app.getBoard();
      const names = new Set(data.boards.map(board => board.name.toLowerCase()));
      let name = original.name + ' copy', number = 2;
      while (names.has(name.toLowerCase())) name = original.name + ' copy ' + number++;
      const board = JSON.parse(JSON.stringify(original));
      board.id = app.id(); board.name = name;
      board.edges = (board.edges || []).map(edge => ({ ...edge, id: app.id() }));
      data.boards.push(board);
      app.setSelection([]);
      app.navigate('board', board.id);
      app.notify('Board copied');
    }
    async function copyNotes() {
      const data = app.getData(), board = app.getBoard(), chosen = app.getSelection();
      const noteCards = board.items.filter(item => item.type === 'note' && chosen.has(item.id));
      if (!noteCards.length) { app.notify('Select note cards to duplicate'); return; }
      const copied = new Map(), newNotes = [];
      for (const card of noteCards) {
        const original = data.notes.find(note => note.id === card.id);
        if (!original) continue;
        const note = { ...JSON.parse(JSON.stringify(original)), id: app.id(), title: (original.title || 'Untitled note') + ' copy', updated: Date.now(), created: Date.now() };
        data.notes.unshift(note);
        newNotes.push(note);
        copied.set(card.id, note.id);
        board.items.push({ ...card, id: note.id, x: card.x + 40, y: card.y + 40 });
      }
      const connections = (board.edges || []).filter(edge => copied.has(edge.from) && copied.has(edge.to));
      board.edges ||= [];
      for (const edge of connections) board.edges.push({ ...edge, id: app.id(), from: copied.get(edge.from), to: copied.get(edge.to) });
      app.setSelection([...copied.values()]);
      finish();
      try { for (const note of newNotes) await app.persistNote(note); }
      catch (error) { app.notify('Copies saved in noteject; project file could not be written: ' + error.message); return; }
      app.notify('Created ' + copied.size + ' independent note copies');
    }
    function exportBoard() {
      const data = app.getData(), board = app.getBoard();
      const names = new Map();
      const lines = ['# ' + board.name, '', 'Exported from noteject', ''];
      for (const card of board.items) {
        if (card.type === 'note') {
          const note = data.notes.find(item => item.id === card.id);
          if (!note) continue;
          names.set(note.id, note.title || 'Untitled note');
          lines.push('## ' + (note.title || 'Untitled note'), '', note.content || '', '');
        } else {
          const doc = data.docs.find(item => item.id === card.id);
          if (!doc) continue;
          names.set(doc.id, doc.name);
          lines.push('## ' + doc.name, '', '- File type: ' + (doc.type || 'file').toUpperCase(), '- Project: ' + (doc.folder || 'Inbox'), '');
        }
      }
      const edges = (board.edges || []).filter(edge => names.has(edge.from) && names.has(edge.to));
      if (edges.length) {
        lines.push('## Connections', '');
        for (const edge of edges) lines.push('- ' + names.get(edge.from) + ' → ' + (edge.label || 'related to') + ' → ' + names.get(edge.to));
      }
      const link = document.createElement('a');
      const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
      link.href = url;
      link.download = (board.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Board') + '.md';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      app.notify('Board outline exported');
    }
    function boardCommands() {
      const board = app.getBoard(), chosen = app.getSelection();
      return [
        { id: 'new-idea', label: 'Create a new idea', shortcut: 'N', run: () => app.action('new-idea') },
        { id: 'undo', label: 'Undo board change', description: 'Restore cards, positions and connections', shortcut: 'Ctrl+Z', disabled: !history.canUndo(board.id), run: undo },
        { id: 'redo', label: 'Redo board change', shortcut: 'Ctrl+Shift+Z', disabled: !history.canRedo(board.id), run: redo },
        { id: 'fit', label: 'Fit assets to screen', shortcut: 'F', disabled: !board.items.length, run: fit },
        { id: 'all', label: 'Select all cards', shortcut: 'Ctrl+A', disabled: !board.items.length, run: selectAll },
        { id: 'copy-notes', label: 'Duplicate selected notes', description: 'Create independent note copies', shortcut: 'Ctrl+D', disabled: !board.items.some(card => card.type === 'note' && chosen.has(card.id)), run: copyNotes },
        { id: 'copy-board', label: 'Duplicate this board', description: 'Copy its layout and links; share the same library items', run: copyBoard },
        { id: 'grid', label: 'Arrange cards in a grid', description: chosen.size ? 'Arrange selected cards' : 'Arrange all cards', disabled: !board.items.length, run: () => arrange('grid') },
        { id: 'tidy-map', label: 'Tidy connected mind map', description: 'Arrange cards by their connections', disabled: !board.items.length, run: () => app.action('auto-layout') },
        { id: 'edit-connections', label: 'Edit a connection', description: 'Change its cards, name, arrows and appearance', disabled: !board.edges?.length, run: () => app.action('edit-connections') },
        { id: 'clear-links', label: 'Clear board connections', description: 'Remove all connectors from this board', danger: true, disabled: !board.edges?.length, run: () => app.action('clear-links') },
        { id: 'export-board', label: 'Export board as Markdown', description: 'Save notes, file names and connections as a .md outline', run: exportBoard },
      ];
    }
    function openCommands(boardOnly = false) {
      if (!ready()) return;
      const commands = app.getView() === 'board' ? boardCommands() : [];
      if (!boardOnly) {
        commands.push(
          { id: 'home', label: 'Go to Home', run: () => app.navigate('home') },
          { id: 'projects', label: 'Open Projects', description: 'Related notes, documents, and boards', run: () => app.navigate('projects') },
          { id: 'reading', label: 'Open Reading queue', description: 'Continue reading your books and papers', run: () => app.navigate('reading') },
          { id: 'favorites', label: 'Open Favorites', description: 'Pinned notes, passages, documents, and boards', run: () => app.navigate('favorites') },
          { id: 'collections', label: 'Open Smart collections', description: 'Saved rules that gather matching items', run: () => app.navigate('collections') },
          { id: 'history', label: 'Open History', description: 'Recently opened notes, documents, and boards', run: () => app.navigate('history') },
          { id: 'documents', label: 'Open Documents', run: () => app.navigate('library') },
          { id: 'notes', label: 'Open all notes', run: () => app.navigate('notes') },
          { id: 'graph', label: 'Open Graph View', run: () => app.navigate('graph') },
          { id: 'boards', label: 'Show all boards', run: () => app.navigate('boardIndex') },
          { id: 'new-board', label: 'Create a new board', run: () => app.action('create-board') },
        );
        for (const board of app.getData().boards) commands.push({ id: 'board-' + board.id, label: 'Open board: ' + board.name, run: () => app.navigate('board', board.id) });
      }
      menu.open({ commands });
    }

    function mount() {
      if (!document.getElementById('workspace-commands')) {
        const launch = button('Commands', () => openCommands(), 'Commands (Ctrl+Shift+P)');
        launch.id = 'workspace-commands';
        document.querySelector('.top-right')?.prepend(launch);
      }
      if (app.getView() !== 'board') return;
      const board = app.getBoard();
      if (lastBoardId && lastBoardId !== board.id) app.setSelection([]);
      lastBoardId = board.id;
      const validIds = new Set(board.items.map(card => card.id));
      app.setSelection([...app.getSelection()].filter(id => validIds.has(id)));
      const chosen = app.getSelection();
      const bar = element('div', 'board-toolstrip');
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Board editing tools');
      const undoButton = button('↶ Undo', undo, 'Undo board change (Ctrl+Z)');
      undoButton.dataset.boardUndo = 'true';
      undoButton.disabled = !history.canUndo(board.id);
      const redoButton = button('↷ Redo', redo, 'Redo board change (Ctrl+Shift+Z)');
      redoButton.dataset.boardRedo = 'true';
      redoButton.disabled = !history.canRedo(board.id);
      const selection = element('span', 'board-toolstrip-count', chosen.size ? chosen.size + ' selected' : board.items.length + ' cards');
      const all = button(chosen.size ? 'Clear selection' : 'Select all', () => {
        if (app.getSelection().size) { app.setSelection([]); refreshSelection(); }
        else selectAll();
      });
      all.dataset.boardSelectAll = 'true';
      const arrangeSelect = element('select');
      arrangeSelect.id = 'board-arrange';
      arrangeSelect.setAttribute('aria-label', 'Arrange cards');
      const modes = [['', chosen.size ? 'Arrange selected…' : 'Arrange all…'], ['grid', 'Grid'], ['align-left', 'Align left'], ['align-top', 'Align top'], ['distribute-horizontal', 'Space horizontally'], ['distribute-vertical', 'Space vertically']];
      for (const [value, label] of modes) {
        const option = element('option', '', label); option.value = value; arrangeSelect.append(option);
      }
      arrangeSelect.onchange = () => { const value = arrangeSelect.value; arrangeSelect.value = ''; if (value) arrange(value); };
      bar.append(undoButton, redoButton, selection, all, arrangeSelect, button('More…', () => openCommands(true), 'Copy board, duplicate notes and export'));
      const workspace = document.querySelector('.board-workspace');
      workspace?.before(bar);

      const canvas = document.querySelector('.canvas');
      if (!canvas) return;
      const frame = element('div', 'board-canvas-frame');
      const navigation = element('div', 'board-navigation-strip');
      canvas.replaceWith(frame);
      frame.append(navigation, canvas);
      for (const selector of ['.board-search-tools', '.canvas-controls']) {
        const control = canvas.querySelector(selector);
        if (control) navigation.append(control);
      }
      for (const selector of ['.board-minimap', '.board-selection-tools']) {
        const control = canvas.querySelector(selector);
        if (control) frame.append(control);
      }
      canvas.addEventListener('click', event => {
        const card = event.target.closest('[data-item]');
        if (!card || !(event.ctrlKey || event.metaKey || event.shiftKey) || event.target.closest('button,input,a,select')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!ready()) return;
        const ids = new Set(app.getSelection());
        ids.has(card.dataset.item) ? ids.delete(card.dataset.item) : ids.add(card.dataset.item);
        app.setSelection([...ids]); refreshSelection();
      }, true);

      canvas.addEventListener('dragstart', event => {
        const card = event.target.closest('.canvas-card[data-item]');
        if (!card || event.target.closest('button,input,a,select') || !ready()) return;
        const ids = app.getSelection().has(card.dataset.item) ? app.getSelection() : [card.dataset.item];
        app.setSelection(window.NotejectBoardScene.groupSelection(board, ids)); refreshSelection();
      }, true);

      // Canvas moves use a real drop, so cancelling a drag never changes a card.
      const originalOver = canvas.ondragover, originalDrop = canvas.ondrop;
      canvas.ondragover = event => {
        if (!app.getCardDrag()) { originalOver?.call(canvas, event); return; }
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      };
      canvas.ondrop = event => {
        const movement = app.getCardDrag();
        if (!movement) { originalDrop?.call(canvas, event); return; }
        event.preventDefault(); event.stopPropagation();
        if (!ready()) { app.setCardDrag(null); return; }
        const zoom = Number(board.zoom) || 1;
        const positions = [...movement.positions.values()];
        const dx = Math.max(-Math.min(...positions.map(position => position.x)), (event.clientX - movement.x + canvas.scrollLeft - movement.scrollLeft) / zoom);
        const dy = Math.max(-Math.min(...positions.map(position => position.y)), (event.clientY - movement.y + canvas.scrollTop - movement.scrollTop) / zoom);
        const cardsById = new Map(board.items.map(card => [card.id, card]));
        for (const [id, position] of movement.positions) {
          const item = cardsById.get(id);
          if (item) { item.x = position.x + dx; item.y = position.y + dy; }
        }
        app.setCardDrag(null); finish(rememberViewport(), true);
      };
    }

    document.addEventListener('keydown', event => {
      if (document.querySelector('#storage-folder-overlay')) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && event.shiftKey && !event.altKey && key === 'p') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) menu.isOpen() ? menu.close() : openCommands();
        return;
      }
      if (menu.isOpen() || document.querySelector('#storage-folder-overlay') || document.querySelector('#edit-body')) return;
      if (app.getView() !== 'board' || event.target.closest('input,textarea,select,[contenteditable=true],.board-document-panel') || document.querySelector('[role=dialog]')) return;
      let run;
      if (ctrl && !event.altKey && key === 'z') run = event.shiftKey ? redo : undo;
      else if (ctrl && !event.shiftKey && !event.altKey && key === 'y') run = redo;
      else if (ctrl && !event.shiftKey && !event.altKey && key === 'a') run = selectAll;
      else if (ctrl && !event.shiftKey && !event.altKey && key === 'd') { if (!event.repeat) run = copyNotes; else event.preventDefault(); }
      else if (!ctrl && !event.altKey && key === 'f') run = fit;
      if (run) { event.preventDefault(); event.stopImmediatePropagation(); runSafely(run); }
    }, true);
    document.addEventListener('noteject-command-error', event => app.notify(event.detail?.error?.message || 'Could not run this command'));
    return { observe, mount, openCommands, refreshSelection, tidyConnected, duplicateNotes: copyNotes, arrangeSelection: arrange };
  }
  window.NotejectWorkspaceTools = { create };
})();
