/* Phone workspace: move existing secondary controls into accessible touch menus. */
(() => {
  'use strict';
  if (!window.NotejectWebApp || window.NotejectAndroid || window.NotejectDesktop) return;
  const content = document.getElementById('view'), mobile = matchMedia('(max-width:959px)');
  if (!content) return;
  const menus = new Map();
  let scheduled = false, lastPage = '';
  const uk = {Tools:'Інструменти',Filters:'Фільтри',Actions:'Дії','Main navigation':'Основна навігація',Close:'Закрити',Projects:'Проєкти',Menu:'Меню'};
  const label = value => (window.NotejectI18n?.getLanguage()==='uk' && uk[value]) || window.NotejectI18n?.t(value) || value;
  const paths = {home:'M3 10 12 3l9 7v11h-6v-7H9v7H3z',notes:'M5 3h15v18H5zM2 7h6M2 12h6M2 17h6M11 8h5M11 12h5',library:'M4 4v16M9 4v16M14 4v16m3-15 4 14M3 20h19',boardIndex:'M3 3h7v10H3zM14 3h7v6h-7zM3 17h7v4H3zM14 13h7v8h-7z',menu:'M4 6h16M4 12h16M4 18h16'};
  const bottom = document.createElement('nav'); bottom.className = 'wm-bottom-nav'; bottom.setAttribute('aria-label', label('Main navigation'));
  for (const [target, title] of [['home','Home'],['notes','All notes'],['library','Documents'],['boardIndex','Boards'],['menu','Menu']]) {
    const button = document.createElement('button'); button.type='button'; button.dataset.wmView=target;
    button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths[target]+'"/></svg><span></span>';
    button.querySelector('span').textContent=label(title);
    button.onclick=()=>target==='menu'?document.querySelector('.web-nav-toggle')?.click():window.openWorkspaceView(target);
    bottom.append(button);
  }
  document.body.append(bottom);
  const heading=document.createElement('button'); heading.type='button'; heading.className='wm-heading'; heading.innerHTML='<img src="noteject-logo.svg" alt=""><strong></strong>'; heading.setAttribute('aria-label',label('Open Home')); heading.onclick=()=>window.openWorkspaceView('home');
  document.querySelector('.topbar')?.prepend(heading);
  function compact(group, title, keep = 1, filter = false, reader = false) {
    if (!group || menus.has(group) || group.closest('.wm-sheet')) return;
    const children = [...group.children].filter(el => !el.matches('[hidden],dialog,.wm-menu-button'));
    const candidates = children.filter(el => el.matches('button,select,label,details,.reader-view-controls,.board-search-tools,.document-view-switch') || (reader && el.matches('.reader-nav-controls')));
    const retained = filter ? candidates.filter(el => el.matches('input[type=search]') || el.querySelector('input[type=search]') || el.id === 'graph-search') : candidates.slice(0, keep);
    // Graph's search input is a direct child, unlike most labeled search fields.
    const moved = candidates.filter(el => !retained.includes(el));
    if (!moved.length || (!filter && !reader && candidates.length <= keep + 1)) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'wm-menu-button secondary';
    button.textContent = reader ? label('Tools') : label(title) + ' ⋯'; button.title=label(reader ? 'Reader tools' : title); button.setAttribute('aria-label',label(reader ? 'Reader tools' : title)); button.setAttribute('aria-haspopup', 'dialog');
    const dialog = document.createElement('dialog'); dialog.className = 'wm-sheet'; dialog.setAttribute('aria-label', label(title));
    const header = document.createElement('header'), heading = document.createElement('h2'), close = document.createElement('button'), body = document.createElement('div');
    heading.textContent = label(title); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', label('Close')); close.className = 'wm-sheet-close';
    body.className = 'wm-sheet-body'; header.append(heading, close); dialog.append(header, body);
    const placements = moved.map(el => { const marker = document.createComment('mobile control'); el.before(marker); body.append(el); return {el, marker}; });
    group.append(button, dialog); group.classList.add('wm-compact-actions');
    let savedRange = null;
    button.addEventListener('mousedown', event => { if (reader) event.preventDefault(); });
    button.onclick = () => {
      const selection = getSelection(); savedRange = reader && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      dialog.showModal(); button.setAttribute('aria-expanded', 'true');
    };
    close.onclick = () => dialog.close();
    dialog.addEventListener('click', event => {
      if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); }
      const action = event.target.closest('button');
      if (!action || !body.contains(action)) return;
      if (reader && action.dataset.readerCommand === 'save-selection' && savedRange?.startContainer.isConnected) {
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(savedRange);
      }
      if (!reader || ['save-selection','focus','previous','next','navigation'].includes(action.dataset.readerCommand)) dialog.close();
    }, true);
    dialog.addEventListener('close', () => button.setAttribute('aria-expanded', 'false'));
    menus.set(group, {button, dialog, placements});
  }
  function restore(group, state) {
    if (state.dialog.open) state.dialog.close();
    for (const {el, marker} of state.placements) { if (marker.isConnected) marker.replaceWith(el); }
    state.button.remove(); state.dialog.remove(); group.classList.remove('wm-compact-actions'); menus.delete(group);
  }
  function enhanceReader() {
    const shell = content.querySelector('.reader-shell'); if (!shell) return;
    const bookmark = shell.querySelector('.reader-header-actions > [data-reader-command="bookmark"]');
    const oldBookmarkGlyph = bookmark?.querySelector('.reader-bookmark-glyph');
    const standardBookmarkIcon = bookmark?.querySelector('.reader-bookmark-icon');
    if (standardBookmarkIcon && !standardBookmarkIcon.classList.contains('wm-bookmark-icon')) {
      standardBookmarkIcon.classList.add('wm-bookmark-icon');
    } else if (oldBookmarkGlyph && !bookmark.querySelector('.wm-bookmark-icon')) {
      oldBookmarkGlyph.outerHTML = '<svg class="wm-bookmark-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>';
    }
    const commands = shell.querySelector('.reader-commandbar'), tools = commands?.querySelector(':scope > .reader-view-controls');
    if (commands && tools && !menus.has(commands)) compact(commands, 'Tools', 0, false, true);
    const menuState = commands && menus.get(commands), header = shell.querySelector('.reader-header');
    const actions = header?.querySelector('.reader-header-actions');
    if (menuState && actions) {
      const documentMenu = actions.querySelector('.reader-document-menu');
      if (menuState.button.parentElement !== actions) actions.insertBefore(menuState.button, documentMenu || null);
      if (menuState.dialog.parentElement !== shell) header.after(menuState.dialog);
    }
    const options = shell.querySelector('.reader-document-options'), back = shell.querySelector('.reader-back');
    if (options && back && !options.querySelector('.wm-reader-return')) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'wm-reader-return'; item.dataset.readerCommand = 'back';
      item.textContent = back.getAttribute('aria-label') || label('Back'); options.prepend(item);
    }
    const status = shell.querySelector('.reader-statusbar');
    if (status && ['pdf','djvu'].includes(shell.dataset.readerType) && !status.querySelector('.wm-reader-page-step')) {
      for (const [command, glyph, title] of [['previous','‹','Previous page'],['next','›','Next page'],['zoom-fit','↔','Fit page width']]) {
        const control = document.createElement('button'); control.type = 'button'; control.className = 'wm-reader-page-step'; control.dataset.readerCommand = command;
        control.textContent = glyph; control.title = label(title); control.setAttribute('aria-label', label(title));
        control.disabled = !!shell.querySelector('.reader-nav-controls [data-reader-command="' + command + '"]')?.disabled;
        if (command === 'previous') status.prepend(control); else status.append(control);
      }
    }
  }
  function update() {
    scheduled = false;
    for (const [group, state] of menus) if (!mobile.matches || !group.isConnected) restore(group, state);
    if (!mobile.matches) return;
    const target=typeof view==='string'?view:'home';
    bottom.querySelectorAll('[data-wm-view]').forEach(button=>{const active=button.dataset.wmView===target||(button.dataset.wmView==='boardIndex'&&target==='board');if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    const titles={home:'Home',notes:'All notes',library:'Documents',inbox:'Inbox',projects:'Projects',collections:'Smart collections',favorites:'Favorites',reading:'Reading queue',boardIndex:'Boards',graph:'Graph View',smart:'Smart Engine',history:'History',trash:'Trash',settings:'Settings'};
    const title=titles[target]?label(titles[target]):document.getElementById('crumb')?.textContent||label('Home');
    if(heading.querySelector('strong').textContent!==title)heading.querySelector('strong').textContent=title;
    if(target==='graph'&&lastPage!=='graph')requestAnimationFrame(()=>content.querySelector('[data-graph-action="fit"]')?.click());
    lastPage=target;
    enhanceReader();
    const actionGroups = '.page-head:not(.board-page-head) > .buttons,.document-library-head > .buttons,.workspace-page-heading > .workspace-actions,.inbox-heading-actions,.board-page-head > .buttons,.wo-project-actions,.graph-heading .graph-stats';
    content.querySelectorAll(actionGroups).forEach(group => { if (!group.closest('form') && !group.matches('.graph-stats')) compact(group, 'Actions', group.closest('.inbox-heading') ? 2 : group.closest('.board-page-head') ? 0 : 1); });
    content.querySelectorAll('.board-toolstrip').forEach(group=>compact(group,'Tools',0));
    content.querySelectorAll('.board-toolstrip .canvas-controls').forEach(group=>compact(group,'View',3));
    content.querySelectorAll('.document-library-controls,.workspace-filterbar,.inbox-manager-toolbar,.graph-tools').forEach(group => compact(group, 'Filters', 0, true));
    content.querySelectorAll('.bulk-toolbar').forEach(group => { group.classList.toggle('wm-has-selection', [...group.querySelectorAll('button')].some(button=>!button.disabled&&!button.matches('.wm-menu-button,.wm-sheet-close'))); compact(group, 'Actions', 1); });
    content.querySelectorAll('.notes-folder-manager').forEach(group => {
      if (group.parentElement.classList.contains('wm-projects')) return;
      const details = document.createElement('details'); details.className = 'wm-projects';
      const summary = document.createElement('summary'); summary.textContent = label('Projects'); group.before(details); details.append(summary, group);
    });
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } }
  new MutationObserver(schedule).observe(content, {childList:true, subtree:true});
  new MutationObserver(schedule).observe(document.body, {childList:true});
  mobile.addEventListener('change', () => {
    if (!mobile.matches) content.querySelectorAll('.wm-projects').forEach(details => details.replaceWith(...details.querySelectorAll(':scope > .notes-folder-manager')));
    schedule();
  });
  document.addEventListener('click', event => { if (event.target.closest('.wm-sheet [data-reader-command]')) schedule(); });
  document.addEventListener('click',event=>{
    if(!mobile.matches||!event.target.closest('.reader-workspace [data-reader-command="view"]'))return;
    const shell=content.querySelector('.reader-shell');
    if(!shell?.querySelector('.wm-sheet[open]'))shell?.querySelector('.reader-header-actions > .wm-menu-button')?.click();
  },true);
  document.addEventListener('pointerdown',event=>{if(!mobile.matches)return;document.querySelectorAll('.reader-document-menu[open],.inbox-management-menu[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
  document.addEventListener('keydown',event=>{if(!mobile.matches||event.key!=='Escape'||document.querySelector('dialog[open]'))return;const menu=document.querySelector('.reader-document-menu[open],.inbox-management-menu[open]');if(menu){menu.open=false;menu.querySelector('summary')?.focus();event.preventDefault();}});
  update();
})();
