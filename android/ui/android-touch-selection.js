/* Android touch-and-hold selection. Native text selection in the reader is untouched. */
(() => {
  'use strict';
  if (!window.NotejectAndroid) return;
  const HOLD_MS = 520, MOVE_PX = 10;
  const rowSelector = '.canvas-card[data-item],.note-list-card[data-note],[data-library-doc],.inbox-item,.board-gallery-card';
  const controls = 'input,textarea,select,label,a,summary,details,[contenteditable="true"],button';
  const pointers = new Set();
  let pending = null, mode = null, suppression = null, frame = 0, heldBoardPointer = null, deferBoardToolbar = false;
  const content = document.getElementById('view');
  if (!content) return;

  function identify(target) {
    if (!(target instanceof Element) || target.closest('.reader-shell,.detail-panel,#reader-note-overlay,dialog[open]')) return null;
    const row = target.closest(rowSelector);
    if (!row || !content.contains(row)) return null;
    const control = target.closest(controls);
    // The gallery's open button contains its preview and title. Holding that
    // surface selects the board; smaller action buttons keep their own actions.
    if (control && !(row.matches('.board-gallery-card') && control.matches('.board-gallery-open')) && !(row.matches('.note-list-card') && control.matches('.an-note-open'))) return null;
    if (row.matches('.canvas-card')) return { kind: 'board', id: row.dataset.item, row };
    if (row.matches('.note-list-card')) return { kind: 'note', id: row.dataset.note, row };
    if (row.matches('[data-library-doc]')) return { kind: 'document', id: row.dataset.libraryDoc, row };
    if (row.matches('.inbox-item')) return { kind: 'inbox', id: row.querySelector('[data-inbox-select]')?.dataset.inboxSelect, row };
    return { kind: 'gallery', id: row.querySelector('[data-gallery-open]')?.dataset.galleryOpen, row };
  }
  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }
  function emit(kind, id, active) {
    window.dispatchEvent(new CustomEvent('noteject:touch-selection', { detail: { kind, id, active } }));
  }
  function checkedInput(entry) {
    const selector = { note: '[data-select-note]', document: '[data-library-select]', inbox: '[data-inbox-select]' }[entry.kind];
    return selector ? entry.row.querySelector(selector) : null;
  }
  function selectEntry(entry, toggle = false) {
    if (!entry?.id || !entry.row.isConnected) return false;
    if (entry.kind === 'board') {
      if (typeof boardSelection === 'undefined' || typeof workspaceTools === 'undefined') return false;
      if (toggle && boardSelection.has(entry.id)) boardSelection.delete(entry.id);
      else boardSelection.add(entry.id);
      workspaceTools.refreshSelection();
    } else if (entry.kind === 'gallery') {
      // Board gallery has a single-board selection, with an explicit Open action.
      // Notes and files continue to use their existing multiple-selection sets.
      if (toggle && mode?.id === entry.id) { exit(); return true; }
    } else {
      const input = checkedInput(entry);
      if (!input || input.disabled) return false;
      const checked = toggle ? !input.checked : true;
      if (input.checked !== checked) {
        input.checked = checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (entry.kind === 'note') window.NotejectAndroidNotesUI?.sync();
    }
    mode = { kind: entry.kind, id: entry.id, boardId: typeof data !== 'undefined' ? data.activeBoard : null };
    emit(entry.kind, entry.id, true);
    sync();
    return true;
  }
  function beginHold(entry, event) {
    const hold = { entry, pointerId: event.pointerId, x: event.clientX, y: event.clientY, fired: false, timer: 0 };
    hold.timer = setTimeout(() => {
      if (pending !== hold || pointers.size !== 1 || !entry.row.isConnected || document.hidden) return;
      hold.fired = true;
      suppression = { kind: entry.kind, id: entry.id, x: hold.x, y: hold.y, until: performance.now() + 1800 };
      if (entry.kind === 'board') {
        heldBoardPointer = hold.pointerId; deferBoardToolbar = !bar || bar.hidden;
      }
      if (selectEntry(entry)) {
        if (entry.kind === 'board') window.NotejectMobile?.startBoardHoldMove(entry.id, { pointerId: hold.pointerId, clientX: hold.x, clientY: hold.y });
        try { navigator.vibrate?.(18); } catch { /* Selection works without haptics. */ }
      } else { suppression = null; heldBoardPointer = null; deferBoardToolbar = false; }
    }, HOLD_MS);
    pending = hold;
  }
  // Window capture observes gestures before the board's document capture handler.
  // A stationary Board hold hands its live pointer to the card mover. Moving
  // before the hold threshold still pans, and two fingers still pinch.
  window.addEventListener('pointerdown', event => {
    if (!['touch', 'pen'].includes(event.pointerType)) return;
    pointers.add(event.pointerId);
    cancelPending();
    if (pointers.size !== 1 || !event.isPrimary || event.button > 0) return;
    const entry = identify(event.target);
    if (entry?.kind === 'board' && document.body.classList.contains('am-board-moving')) return;
    if (entry?.id) beginHold(entry, event);
  }, { capture: true, passive: true });
  window.addEventListener('pointermove', event => {
    if (pending?.pointerId === event.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= (pending.entry.kind === 'board' ? 8 : MOVE_PX)) cancelPending();
  }, { capture: true, passive: true });
  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (heldBoardPointer === event.pointerId) { heldBoardPointer = null; deferBoardToolbar = false; scheduleSync(); }
    if (pending?.pointerId !== event.pointerId) return;
    if (pending.fired && suppression) suppression.until = performance.now() + 800;
    // A hold never opens a menu. More actions requires an explicit button tap.
    cancelPending();
  }
  window.addEventListener('pointerup', endPointer, { capture: true, passive: true });
  window.addEventListener('pointercancel', endPointer, { capture: true, passive: true });
  window.addEventListener('scroll', cancelPending, { capture: true, passive: true });
  function resetGesture() { cancelPending(); pointers.clear(); heldBoardPointer = null; deferBoardToolbar = false; scheduleSync(); }
  window.addEventListener('blur', resetGesture);
  window.addEventListener('pagehide', resetGesture);
  window.addEventListener('orientationchange', resetGesture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetGesture(); });

  function suppressClick(event) {
    // Programmatic checkbox clicks remain available to the shared selection UI.
    if (!event.isTrusted) return false;
    if (!suppression || performance.now() >= suppression.until) return false;
    const entry = identify(event.target);
    const same = entry?.kind === suppression.kind && entry.id === suppression.id;
    const near = Math.hypot(event.clientX - suppression.x, event.clientY - suppression.y) < 30;
    if (!same && !near) return false;
    event.preventDefault(); event.stopImmediatePropagation();
    return true;
  }
  window.addEventListener('click', event => {
    if (suppressClick(event)) return;
    const entry = identify(event.target);
    if (!mode || !entry || entry.kind !== mode.kind) return;
    // Notes and board cards use their established Select modes. Inbox and the
    // gallery have no row-level Select mode, so handle those surfaces here.
    if (!['inbox', 'gallery'].includes(entry.kind)) return;
    event.preventDefault(); event.stopImmediatePropagation(); selectEntry(entry, true);
  }, true);
  window.addEventListener('dblclick', event => { suppressClick(event); }, true);
  window.addEventListener('contextmenu', event => {
    if (!identify(event.target)) return;
    // Prevent Android's image/text callout only on selectable card surfaces.
    // Reader text, editors, links, and actual controls are not affected.
    event.preventDefault();
  }, true);

  function count() {
    if (!mode) return 0;
    if (mode.kind === 'board') return typeof boardSelection !== 'undefined' ? boardSelection.size : 0;
    if (mode.kind === 'note') return typeof selectedNotes !== 'undefined' ? selectedNotes.size : 0;
    if (mode.kind === 'document') return typeof selectedDocs !== 'undefined' ? selectedDocs.size : 0;
    if (mode.kind === 'inbox') return typeof inboxSelection !== 'undefined' ? inboxSelection.size : 0;
    return document.querySelector('[data-gallery-open="' + CSS.escape(mode.id) + '"]') ? 1 : 0;
  }
  function visible() {
    if (!mode) return false;
    return { board: !!content.querySelector('.canvas') && (typeof data === 'undefined' || mode.boardId === data.activeBoard), note: !!content.querySelector('#note-sort') && !content.querySelector('.detail-panel'), document: !!content.querySelector('.document-library'), inbox: !!content.querySelector('.inbox-manager'), gallery: !!content.querySelector('.board-gallery') }[mode.kind];
  }
  function exit() {
    if (!mode) return false;
    const previous = mode; mode = null; cancelPending(); suppression = null; heldBoardPointer = null; deferBoardToolbar = false;
    if (previous.kind === 'board') {
      if (typeof boardSelection !== 'undefined') boardSelection.clear();
      if (typeof workspaceTools !== 'undefined') workspaceTools.refreshSelection();
    } else if (previous.kind === 'note') {
      if (typeof selectedNotes !== 'undefined') selectedNotes.clear();
      if (typeof updateNoteSelectionUI === 'function') updateNoteSelectionUI();
      const toggle = document.querySelector('[data-an-select-notes][aria-pressed="true"]');
      if (toggle) toggle.click();
      window.NotejectAndroidNotesUI?.sync();
    } else if (previous.kind === 'document') {
      document.querySelector('[data-library-clear-selection]')?.click();
      const toggle = document.querySelector('[data-am-select-files][aria-pressed="true"]');
      if (toggle) toggle.click();
    } else if (previous.kind === 'inbox') document.querySelector('[data-inbox-clear-selection]')?.click();
    emit(previous.kind, previous.id, false);
    sync(); return true;
  }
  let bar = null;
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('section'); bar.className = 'ats-selection-bar'; bar.hidden = true;
    bar.setAttribute('aria-label', 'Touch selection');
    const status = document.createElement('div');
    const amount = document.createElement('strong'); amount.className = 'ats-count'; amount.setAttribute('role', 'status'); amount.setAttribute('aria-live', 'polite');
    const help = document.createElement('small'); help.className = 'ats-help';
    status.append(amount, help);
    const move = document.createElement('button'); move.type = 'button'; move.className = 'ats-move'; move.textContent = 'Move'; move.title = 'Drag selected cards together';
    move.onclick = () => window.NotejectMobile?.setBoardSelectionMode('move');
    const select = document.createElement('button'); select.type = 'button'; select.className = 'ats-select'; select.textContent = 'Select'; select.title = 'Tap cards to add or remove them from the selection';
    select.onclick = () => window.NotejectMobile?.setBoardSelectionMode('select');
    const connect = document.createElement('button'); connect.type = 'button'; connect.className = 'ats-connect'; connect.textContent = 'Connect';
    connect.onclick = () => Promise.resolve(window.NotejectMobile?.connectBoardSelection()).catch(error => { if (typeof notify === 'function') notify(error.message || 'Could not connect selected cards'); });
    const actions = document.createElement('button'); actions.type = 'button'; actions.className = 'ats-card-actions'; actions.textContent = 'More'; actions.setAttribute('aria-label', 'More actions for selected cards');
    actions.addEventListener('pointerdown', () => { suppression = null; cancelPending(); });
    actions.onclick = event => {
      if (event.isTrusted && suppression && performance.now() < suppression.until) return;
      window.NotejectMobile?.openBoardSelectionMenu?.();
    };
    const open = document.createElement('button'); open.type = 'button'; open.className = 'ats-open'; open.textContent = 'Open board';
    open.onclick = () => {
      const target = mode?.kind === 'gallery' ? document.querySelector('[data-gallery-open="' + CSS.escape(mode.id) + '"]') : null;
      mode = null; suppression = null; sync(); target?.click();
    };
    const done = document.createElement('button'); done.type = 'button'; done.className = 'ats-done'; done.textContent = 'Done'; done.setAttribute('aria-label', 'Clear selection and finish selecting'); done.onclick = exit;
    bar.append(status, move, select, connect, actions, open, done); document.body.append(bar);
    new ResizeObserver(() => { if (!bar.hidden && bar.dataset.kind === 'board') document.documentElement.style.setProperty('--am-selection-height', (bar.offsetHeight + 8) + 'px'); }).observe(bar);
    return bar;
  }
  function sync() {
    frame = 0;
    if (pending && !pending.fired && !pending.entry.row.isConnected) cancelPending();
    if (mode && !visible()) { const previous = mode; mode = null; emit(previous.kind, previous.id, false); }
    // A normal tap selects a Board card without entering multiple-selection
    // mode. Its Actions button should still be available immediately.
    if (!mode && content.querySelector('.canvas') && typeof boardSelection !== 'undefined' && boardSelection.size) {
      const selectedMode = mode = { kind: 'board', id: [...boardSelection][0], boardId: data.activeBoard, revealAt: performance.now() + 400 };
      // Let a second tap finish before placing an Actions bar over the canvas.
      setTimeout(() => { if (mode === selectedMode) scheduleSync(); }, 410);
    }
    const covered = document.body.classList.contains('am-menu-open') || !!content.querySelector('.detail-panel,.am-canvas-options[open],.am-options[open],.board-note-tray,.board-document-panel:not([hidden])') || !!document.querySelector('dialog[open]');
    const total = count(), active = !!mode && total > 0 && !covered && !deferBoardToolbar && (!mode.revealAt || performance.now() >= mode.revealAt);
    const element = ensureBar(); element.hidden = !active;
    document.body.classList.toggle('ats-selecting', active);
    if (active) {
      element.dataset.kind = mode.kind;
      const boardMode = window.NotejectMobile?.boardSelectionMode(), moving = boardMode === 'move';
      const label = total + ' selected', help = mode.kind === 'board' ? moving ? 'Drag a selected card to move.' : boardMode === 'select' ? 'Tap cards to add or remove.' : 'Choose Move, Select or Connect.' : mode.kind === 'gallery' ? 'Choose Open board or Done.' : 'Tap more items to select. Done clears selection.';
      if (element.querySelector('.ats-count').textContent !== label) element.querySelector('.ats-count').textContent = label;
      if (element.querySelector('.ats-help').textContent !== help) element.querySelector('.ats-help').textContent = help;
      for (const name of ['move', 'select', 'connect', 'card-actions']) element.querySelector('.ats-' + name).hidden = mode.kind !== 'board';
      element.querySelector('.ats-move').setAttribute('aria-pressed', String(moving));
      element.querySelector('.ats-select').setAttribute('aria-pressed', String(boardMode === 'select'));
      element.querySelector('.ats-connect').setAttribute('aria-label', total > 1 ? 'Connect selected cards' : 'Connect selected card to another card');
      element.querySelector('.ats-open').hidden = mode.kind !== 'gallery';
    }
    for (const row of content.querySelectorAll(rowSelector)) {
      const gallery = row.matches('.board-gallery-card'), input = row.querySelector('[data-inbox-select]');
      const selected = gallery ? mode?.kind === 'gallery' && row.querySelector('[data-gallery-open]')?.dataset.galleryOpen === mode.id : input?.checked;
      if ((gallery || input) && row.classList.contains('ats-selected') !== !!selected) row.classList.toggle('ats-selected', !!selected);
      const description = row.matches('.canvas-card') ? 'Touch and hold, then drag to move. Double tap to open.' : 'Touch and hold to select. Move your finger to scroll.';
      if (row.getAttribute('aria-description') !== description) row.setAttribute('aria-description', description);
    }
    for (const host of content.querySelectorAll('.document-library,.inbox-manager,.board-gallery')) {
      if (host.querySelector(':scope > .ats-hint')) continue;
      const hint = document.createElement('p'); hint.className = 'ats-hint'; hint.textContent = 'Touch and hold an item to select it.'; host.prepend(hint);
    }
  }
  function scheduleSync() { if (!frame) frame = requestAnimationFrame(sync); }
  const observer = new MutationObserver(records => {
    if (records.some(record => !record.target.closest?.('#reader-pdf-pages,#reader-page-grid,.reader-statusbar,#pdf-page-total,[data-reader-command="zoom-reset"]'))) scheduleSync();
  }); observer.observe(content, { childList: true, subtree: true });
  window.addEventListener('keydown', event => {
    cancelPending();
    if (event.key === 'Escape' && visible() && exit()) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.NotejectAndroidTouchSelection = Object.freeze({ sync, handleBack: () => visible() ? exit() : false, exit,
    selectBoard(itemId) { const row = content.querySelector('.canvas-card[data-item="' + CSS.escape(itemId) + '"]'); return row ? selectEntry({ kind: 'board', id: itemId, row }) : false; }
  });
  sync();
})();
