/* One desktop Reader toolbar, shared by the hosted app and Windows. */
(() => {
  'use strict';
  if (window.NotejectAndroid || (!window.NotejectWebApp && !window.NotejectDesktop)) return;
  const view = document.getElementById('view'), topbar = document.querySelector('.main > .topbar');
  if (!view || !topbar) return;
  const desktop = matchMedia('(min-width: 960px)');
  const navigation = topbar.querySelector('.nw-location-controls,.web-history');
  let current = null, scheduled = false;
  const t = label => window.NotejectI18n?.t?.(label) || label;
  function move(element, parent, before, placements) {
    if (!element) return;
    const marker = document.createComment('desktop Reader control');
    element.before(marker); parent.insertBefore(element, before || null);
    placements.push({ element, marker });
  }
  function restore(placements) {
    for (const { element, marker } of placements.reverse()) marker.replaceWith(element);
    placements.length = 0;
  }
  function dispose() {
    if (!current) return;
    current.resize.disconnect(); restore(current.zoomPlacement); restore(current.placements);
    current.extras.forEach(element => element.remove());
    current.header.removeAttribute('role'); current.header.removeAttribute('aria-label');
    current.shell.classList.remove('reader-desktop-unified');
    current = null;
    document.body.classList.remove('reader-desktop-active');
  }
  function labelAction(button, glyph, label, captionClass = '') {
    if (!button || button.querySelector('.reader-desktop-action-caption')) return;
    let icon = button.querySelector('.reader-bookmark-icon,.reader-bookmark-glyph');
    if (glyph === 'bookmark') {
      if (!icon || icon.tagName.toLowerCase() !== 'svg') {
        const template = document.createElement('template');
        template.innerHTML = '<svg class="reader-bookmark-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>';
        icon = template.content.firstElementChild;
      }
    } else {
      icon ||= document.createElement('span');
      if (!icon.isConnected) { icon.textContent = glyph; icon.setAttribute('aria-hidden', 'true'); }
    }
    const caption = button.querySelector('.reader-bookmark-label') || document.createElement('span');
    caption.classList.add('reader-desktop-action-caption');
    if (captionClass) caption.classList.add(captionClass);
    caption.textContent = t(label);
    button.replaceChildren(icon, document.createTextNode(' '), caption);
  }
  function setup(shell) {
    const header = shell.querySelector('.reader-header'), commands = shell.querySelector('.reader-commandbar');
    const actions = header?.querySelector('.reader-header-actions'), options = shell.querySelector('.reader-document-options');
    if (!header || !actions || !options) return;
    const state = { shell, header, placements: [], zoomPlacement: [], extras: [] };
    current = state;
    shell.classList.add('reader-desktop-unified'); document.body.classList.add('reader-desktop-active');
    header.setAttribute('role', 'toolbar'); header.setAttribute('aria-label', t('Reading and navigation'));
    move(navigation, header, header.firstChild, state.placements);
    if (navigation) header.classList.add('reader-desktop-has-history');
    move(commands?.querySelector('.reader-nav-controls'), header, actions, state.placements);
    const controls = commands?.querySelector('.reader-view-controls');
    move(controls, header, actions, state.placements);
    labelAction(actions.querySelector('[data-reader-command="find"]'), '⌕', 'Find');
    labelAction(actions.querySelector('[data-reader-command="bookmark"]'), 'bookmark', 'Bookmark', 'reader-bookmark-label');
    labelAction(actions.querySelector('[data-reader-command="saved"]'), '✎', 'Notes');

    const settings = document.createElement('details'); settings.className = 'reader-desktop-view-settings';
    const summary = document.createElement('summary'); summary.textContent = '☼ ' + t('View & reading');
    const settingsBody = document.createElement('div'); settingsBody.className = 'reader-desktop-view-body';
    settings.append(summary, settingsBody);
    const viewCommand = options.querySelector('[data-reader-menu-id="view"]');
    options.insertBefore(settings, viewCommand || options.firstChild); state.extras.push(settings);
    if (controls) for (const child of [...controls.children]) {
      if (!child.matches('.reader-zoom,.reader-save-selection')) move(child, settingsBody, null, state.placements);
    }
    const zoom = controls?.querySelector('.reader-zoom');
    const fit = () => {
      if (!zoom) return;
      if (shell.clientWidth < 680 && !state.zoomPlacement.length) move(zoom, settingsBody, settingsBody.firstChild, state.zoomPlacement);
      else if (shell.clientWidth >= 680 && state.zoomPlacement.length) restore(state.zoomPlacement);
    };
    state.resize = new ResizeObserver(fit); state.resize.observe(shell); fit();

    const workspace = document.createElement('div'); workspace.className = 'reader-desktop-workspace-actions';
    const add = (label, run, command) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = t(label);
      if (command) button.dataset.readerCommand = command;
      else button.onclick = () => { shell.querySelector('.reader-document-menu').open = false; run(); };
      workspace.append(button);
    };
    add(shell.querySelector('.reader-back')?.getAttribute('aria-label') || 'Return to workspace', null, 'back');
    add('Search notes, documents, and boards', () => {
      window.openWorkspaceView?.('search');
      requestAnimationFrame(() => document.getElementById('search')?.focus());
    });
    add('Commands', () => document.getElementById('workspace-commands')?.click());
    add('Sync', () => document.getElementById('noteject-cloud-trigger')?.click());
    options.append(workspace); state.extras.push(workspace);
  }
  function sync() {
    scheduled = false;
    const shell = view.querySelector('.reader-shell');
    const active = !window.NotejectAndroid && (window.NotejectDesktop || desktop.matches);
    if (current && (current.shell !== shell || !active)) dispose();
    if (shell && active && !current) setup(shell);
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(sync); } }
  new MutationObserver(schedule).observe(view, { childList: true, subtree: true });
  desktop.addEventListener('change', schedule);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !current || document.querySelector('dialog[open]')) return;
    const menu = current.shell.querySelector('.reader-document-menu[open]');
    if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); event.preventDefault(); }
  });
  window.NotejectDesktopReaderToolbar = {
    openView(shell) {
      if (current?.shell !== shell) return false;
      shell.querySelector('.reader-document-menu').open = true;
      const settings = shell.querySelector('.reader-desktop-view-settings'); settings.open = true;
      (settings.querySelector('select,button') || settings.querySelector('summary')).focus();
      return true;
    }
  };
  sync();
})();
