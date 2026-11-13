/* Connection edits stay in a draft until Save. Board history owns committed edits. */
(() => {
  'use strict';
  let current = null, serial = 0;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgElement = (tag, attrs = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  function close() {
    if (!current) return;
    const state = current; current = null;
    document.removeEventListener('focusin', state.containFocus, true);
    state.overlay.remove();
    document.body.style.overflow = state.overflow;
    if (state.appRoot) state.appRoot.inert = state.inert;
    if (state.previousFocus?.isConnected) state.previousFocus.focus({ preventScroll: true });
  }
  // Registered before app shortcuts so Delete/Space/Ctrl+P cannot affect the board.
  document.addEventListener('keydown', event => {
    if (!current) return;
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); current.form.requestSubmit(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...current.form.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(control => control.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }, true);

  function create(app) {
    const model = window.NotejectBoardConnectionModel;
    function recordNames() { const data = app.getData(); return new Map([...data.notes.map(note => [note.id, note.title || 'Untitled note']), ...data.docs.map(doc => [doc.id, doc.name || 'Untitled file'])]); }
    function focusAfterRefresh(edgeId) {
      const target = [...document.querySelectorAll('.mindmap-edge[data-edge]')].find(node => node.dataset.edge === edgeId);
      (target || document.querySelector('[data-board-undo]'))?.focus({ preventScroll: true });
    }
    function open(edgeId) {
      close();
      const board = app.getBoard(), edge = board?.edges?.find(edge => edge.id === edgeId);
      if (!edge) { app.notify('This connection is no longer on the board'); return; }
      const draft = { ...model.normalize(edge) }, names = recordNames(), prefix = 'connection-editor-' + ++serial;
      const overlay = element('div', 'connection-editor-overlay'); overlay.id = 'connection-editor-overlay';
      const form = element('form', 'connection-editor');
      form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', prefix + '-title'); form.setAttribute('aria-describedby', prefix + '-help');
      const heading = element('header', 'connection-editor-heading');
      const title = element('h2', '', 'Edit connection'); title.id = prefix + '-title';
      const dismiss = element('button', 'connection-editor-close', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'Close connection editor'); dismiss.onclick = close;
      heading.append(title, dismiss);
      const help = element('p', 'connection-editor-help', 'Change the label, cards, and appearance of this connection.'); help.id = prefix + '-help';
      const preview = element('div', 'connection-editor-preview'); preview.setAttribute('aria-hidden', 'true');
      const grid = element('div', 'connection-editor-grid');
      const label = element('label', '', 'Connection name');
      const name = element('input'); name.type = 'text'; name.name = 'label'; name.value = draft.label; name.maxLength = 160; name.placeholder = 'related to'; name.autocomplete = 'off'; label.append(name); grid.append(label);
      const endpoints = element('div', 'connection-editor-endpoints');
      function selectField(text, field, values) {
        const label = element('label', '', text), select = element('select'); select.name = field;
        for (const [value, text] of values) { const option = element('option', '', text); option.value = value; select.append(option); }
        select.value = String(draft[field]);
        label.append(select); return { label, select };
      }
      const items = [...new Map(board.items.map(item => [item.id, item])).values()].map(item => [item.id, names.get(item.id) || 'Unavailable card']).sort((a,b) => a[1].localeCompare(b[1]));
      const source = selectField('From card', 'from', items), target = selectField('To card', 'to', items);
      source.select.required = target.select.required = true;
      const swap = element('button', 'connection-editor-swap', '⇄'); swap.type = 'button'; swap.title = 'Swap connected cards'; swap.setAttribute('aria-label', 'Swap connected cards');
      swap.onclick = () => { const value = source.select.value; source.select.value = target.select.value; target.select.value = value; update(); };
      endpoints.append(source.label, swap, target.label); grid.append(endpoints);
      const colors = element('fieldset', 'connection-editor-colors'); colors.append(element('legend', '', 'Color'));
      for (const [value, color] of Object.entries(model.colors)) {
        const label = element('label', 'connection-color-choice'), radio = element('input');
        const title = value[0].toUpperCase() + value.slice(1);
        radio.type = 'radio'; radio.name = 'color'; radio.value = value; radio.checked = value === draft.color; radio.setAttribute('aria-label', title);
        label.title = title; label.style.setProperty('--connection-color', color); label.append(radio, element('span')); colors.append(label);
      }
      grid.append(colors);
      const styles = element('div', 'connection-editor-style-row');
      const direction = selectField('Arrows', 'direction', [['forward','From → To'], ['both','Both directions'], ['none','No arrows']]);
      const line = selectField('Line style', 'line', [['solid','Solid'], ['dashed','Dashed'], ['dotted','Dotted']]);
      const width = selectField('Thickness', 'width', [['2','Thin'], ['3','Medium'], ['4','Thick']]);
      styles.append(direction.label, line.label, width.label); grid.append(styles);
      const error = element('p', 'connection-editor-error'); error.hidden = true; error.setAttribute('role', 'alert');
      const footer = element('footer', 'connection-editor-footer');
      const remove = element('button', 'danger-button', 'Delete connection'); remove.type = 'button';
      const actions = element('div', 'connection-editor-footer-actions');
      const cancel = element('button', 'secondary', 'Cancel'); cancel.type = 'button'; cancel.onclick = close;
      const save = element('button', 'primary', 'Save connection'); save.type = 'submit';
      actions.append(cancel, save); footer.append(remove, actions); form.append(heading, help, preview, grid, error, footer); overlay.append(form);
      function update() {
        draft.label = name.value; draft.from = source.select.value; draft.to = target.select.value;
        draft.color = form.querySelector('input[name="color"]:checked')?.value || 'violet'; draft.direction = direction.select.value; draft.line = line.select.value; draft.width = Number(width.select.value);
        error.hidden = true;
        const style = model.describeStyle(draft), svg = svgElement('svg', { viewBox: '0 0 510 94', focusable: 'false' });
        const marker = svgElement('marker', { id: prefix + '-arrow', viewBox:'0 0 10 10', refX:'8', refY:'5', markerWidth:'6', markerHeight:'6', orient:'auto-start-reverse' });
        marker.append(svgElement('path', { d:'M0 0 L10 5 L0 10 z', fill:style.colorHex }));
        const defs = svgElement('defs'); defs.append(marker); svg.append(defs);
        const path = svgElement('path', { d:'M30 60 C150 60 360 60 480 60', fill:'none', stroke:style.colorHex, 'stroke-width':style.width, 'stroke-linecap':'round' });
        if (style.dasharray) path.setAttribute('stroke-dasharray', style.dasharray);
        if (style.markerStart) path.setAttribute('marker-start','url(#'+prefix+'-arrow)');
        if (style.markerEnd) path.setAttribute('marker-end','url(#'+prefix+'-arrow)');
        const text = svgElement('text', { x:'255', y:'51', 'text-anchor':'middle' }); text.textContent = draft.label.trim().slice(0,56) || 'related to';
        const from = svgElement('text', { x:'15', y:'21', class:'connection-preview-card' }); from.textContent = (names.get(draft.from) || 'From card').slice(0,32);
        const to = svgElement('text', { x:'495', y:'21', 'text-anchor':'end', class:'connection-preview-card' }); to.textContent = (names.get(draft.to) || 'To card').slice(0,32);
        svg.append(from, to, path, text); preview.replaceChildren(svg);
      }
      form.addEventListener('input', update); form.addEventListener('change', update);
      form.onsubmit = event => {
        event.preventDefault(); update();
        if (app.getBoard() !== board) { error.textContent = 'The active board changed. Close this editor and try again.'; error.hidden = false; return; }
        const result = model.commit(board, edgeId, draft);
        if (!result.ok) { error.textContent = result.error; error.hidden = false; return; }
        close();
        if (result.changed) { app.save(); app.refreshBoard(); app.notify('Connection updated'); }
        focusAfterRefresh(edgeId);
      };
      remove.onclick = () => {
        if (app.getBoard() !== board || !model.remove(board, edgeId)) return;
        close(); app.save(); app.refreshBoard(); app.notify('Connection removed. Ctrl+Z to undo.'); focusAfterRefresh(null);
      };
      overlay.onclick = event => { if (event.target === overlay) close(); };
      const appRoot = document.querySelector('.app');
      const state = { overlay, form, appRoot, inert:appRoot?.inert || false, overflow:document.body.style.overflow, previousFocus:document.activeElement, containFocus:event=>{ if (current === state && !overlay.contains(event.target)) name.focus({preventScroll:true}); } };
      current = state; document.body.append(overlay); if (appRoot) appRoot.inert = true; document.body.style.overflow = 'hidden';
      document.addEventListener('focusin', state.containFocus, true); update(); name.focus({ preventScroll:true }); name.select();
    }
    function openList(cardIds = null) {
      const board = app.getBoard(), names = recordNames();
      const seen = new Set(); let repaired = false;
      for (const edge of board?.edges || []) {
        if (!edge) continue;
        if (typeof edge.id !== 'string' || !edge.id || seen.has(edge.id)) { edge.id = crypto.randomUUID(); repaired = true; }
        seen.add(edge.id);
      }
      if (repaired) { app.save(); app.refreshBoard(); }
      const selected = Array.isArray(cardIds) ? new Set(cardIds) : null;
      const edges = (board?.edges || []).filter(edge => !selected || selected.has(edge.from) || selected.has(edge.to));
      if (!edges.length) { app.notify(selected ? 'No connections on the selected cards.' : 'No connections yet. Use Connect to link two cards.'); return; }
      window.NotejectCommandMenu.open({ commands:edges.map(edge=>({id:'edit-edge-'+edge.id,label:edge.label || 'related to',description:(names.get(edge.from)||'Card')+' → '+(names.get(edge.to)||'Card'),run:()=>open(edge.id)})) });
    }
    return { open, openList, close, isOpen:()=>!!current };
  }
  window.NotejectBoardConnectionEditor = { create };
})();
