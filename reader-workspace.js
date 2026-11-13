(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function create(app) {
    let shell = null, thumbnailObserver = null, saveTimer = 0, locationFrame = 0, navTab = 'contents', outline = [], metadata = {}, focused = false, fullscreenRequest = 0, zoomPreview = null, fullscreenGestureCleanup = null;
    let readinessObserver = null, readinessFrame = 0;
    // A large book must not allocate hundreds of canvases or compete with the page being read.
    const pagePreviewLimit = 24;
    let navigationDirty = true, navigationKey = '', pageRangeStart = 1, outlineVersion = 0, outlineRequested = false, outlineResolved = false;
    let thumbnailGeneration = 0, thumbnailQueue = [], thumbnailRunning = false, activeThumbnail = null, activePageTile = null, highlightedPage = 0;
    const visibleThumbnails = new Set();
    const abandonedThumbnails = new WeakSet();
    let preferences;
    try { preferences = JSON.parse(localStorage.getItem('noteject-reader-workspace') || '{}'); } catch { preferences = {}; }
    preferences = { navigation: true, tools: false, assistant: false, pdfMode: 'continuous', zoom: 'fit', textZoom: 1, ...preferences };
    if (preferences.assistant) preferences.tools = false;
    preferences.textZoom = clamp(Number(preferences.textZoom) || 1, 0.5, 3);
    const doc = () => app.getDocument();
    const pdf = () => app.getPdf();
    const epub = () => app.getEpub();
    const persist = () => { try { localStorage.setItem('noteject-reader-workspace', JSON.stringify(preferences)); } catch {} };
    const button = (command, label, title = label, extra = '') => `<button type="button" data-reader-command="${command}" title="${escape(title)}" ${extra}>${label}</button>`;
    const translate = source => root.NotejectI18n?.t?.(source) || source;
    const menuCommands = { contents: 'navigation', find: 'find', saved: 'saved', 'add-to-board': 'add-to-board', bookmark: 'bookmark', 'save-passage': 'save-selection', 'extend-passage': 'extend-passage', 'save-image': 'capture-image', comment: 'comment', view: 'view', fullscreen: 'focus', help: 'help' };
    const menuGlyphs = { contents: '☷', find: '⌕', saved: '✎', 'add-to-board': '↗', 'save-passage': '✎', 'extend-passage': '↔', 'save-image': '▧', comment: '＋', view: '☼', fullscreen: '⛶', help: '?' };
    function renderDocumentMenu(file, reading) {
      const entries = !root.NotejectAndroid && reading ? (root.NotejectReaderMenu?.forType?.(file?.type) || []) : [];
      const actions = entries.map(entry => {
        const command = menuCommands[entry.id];
        if (!command) return '';
        const label = escape(translate(entry.label));
        const glyph = entry.id === 'bookmark'
          ? '<svg class="reader-menu-bookmark-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>'
          : menuGlyphs[entry.id] || '•';
        return button(command, `<span class="reader-menu-glyph" aria-hidden="true">${glyph}</span><span>${label}</span>`, entry.label, `data-reader-menu-id="${escape(entry.id)}"`);
      }).join('');
      const extras = `${reading ? button('previous-file',escape(translate('‹ Previous file')),translate('Previous file (Ctrl+Page Up)')) + button('next-file',escape(translate('Next file ›')),translate('Next file (Ctrl+Page Down)')) + button('assistant',escape(translate('✧ Ask this document')),translate('Open on-device and AI document tools'),'aria-pressed="'+Boolean(preferences.assistant)+'"') : ''}${button('download',escape(translate('↓ Download original')),translate('Download original'))}`;
      return `<div class="reader-document-options"><div class="reader-menu-label">READER MENU</div>${actions}${extras}</div>`;
    }
    function setupFullscreenGesture(viewport) {
      if (!viewport) return () => {};
      let firstTap = null, activeTap = null, mouseHadSelection = false;
      const interactive = 'a,button,input,textarea,select,label,summary,[contenteditable],[role="button"],[role="link"],audio,video,iframe,object,embed,.reader-error,.reader-loading,.clip-composer';
      const inViewportSelection = () => {
        const selection = root.getSelection?.();
        return !!selection && !selection.isCollapsed && (viewport.contains(selection.anchorNode) || viewport.contains(selection.focusNode));
      };
      const enabled = event => event.pointerType === 'touch' && matchMedia('(max-width: 959px), (pointer: coarse)').matches;
      const rememberMouseSelection = event => { if (event.pointerType === 'mouse') mouseHadSelection = inViewportSelection(); };
      const doubleClick = event => {
        if (!matchMedia('(hover: hover) and (pointer: fine)').matches || event.target.closest(interactive) || mouseHadSelection) return;
        event.preventDefault();
        void run('focus');
      };
      const down = event => {
        if (!enabled(event) || !event.isPrimary || event.button !== 0 || event.target.closest(interactive) || inViewportSelection()) { activeTap = null; firstTap = null; return; }
        const now = performance.now(), point = { x: event.clientX, y: event.clientY };
        const second = firstTap && now - firstTap.time <= 340 && Math.hypot(point.x - firstTap.x, point.y - firstTap.y) <= 36;
        activeTap = { ...point, id: event.pointerId, time: now, second: !!second, moved: false };
        if (second) firstTap = null;
      };
      const move = event => {
        if (!activeTap || event.pointerId !== activeTap.id) return;
        if (Math.hypot(event.clientX - activeTap.x, event.clientY - activeTap.y) > 18) { activeTap.moved = true; firstTap = null; }
      };
      const up = event => {
        const tap = activeTap; activeTap = null;
        if (!tap || event.pointerId !== tap.id || !enabled(event) || tap.moved || event.timeStamp - tap.time > 340 || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 18 || event.target.closest(interactive) || inViewportSelection()) { if (tap?.second) firstTap = null; return; }
        if (tap.second) {
          firstTap = null;
          event.preventDefault();
          void run('focus');
        } else firstTap = { x: tap.x, y: tap.y, time: performance.now() };
      };
      const cancel = () => { activeTap = null; firstTap = null; };
      viewport.addEventListener('pointerdown', down, { passive: true });
      viewport.addEventListener('pointerdown', rememberMouseSelection, { capture: true, passive: true });
      viewport.addEventListener('dblclick', doubleClick);
      viewport.addEventListener('pointermove', move, { passive: true });
      viewport.addEventListener('pointerup', up, { passive: false });
      viewport.addEventListener('pointercancel', cancel, { passive: true });
      viewport.addEventListener('scroll', cancel, { passive: true });
      return () => {
        cancel();
        viewport.removeEventListener('pointerdown', down);
        viewport.removeEventListener('pointerdown', rememberMouseSelection, true);
        viewport.removeEventListener('dblclick', doubleClick);
        viewport.removeEventListener('pointermove', move);
        viewport.removeEventListener('pointerup', up);
        viewport.removeEventListener('pointercancel', cancel);
        viewport.removeEventListener('scroll', cancel);
      };
    }
    function render(file, aside, fallback = '') {
      if (focused) setFocus(false, { restore: false });
      releaseThumbnails();
      metadata = {}; outline = []; navTab = 'contents'; focused = false;
      navigationDirty = true; navigationKey = ''; pageRangeStart = 1; outlineVersion = 0; outlineRequested = false; outlineResolved = false; activePageTile = null; highlightedPage = 0;
      const reading = ['pdf','djvu','epub','txt'].includes(file?.type), isPdf = file?.type === 'pdf', isDjvu = file?.type === 'djvu', isPaged = isPdf || isDjvu, isEpub = file?.type === 'epub', sequenceNavigation = isPaged || isEpub;
      const content = isPaged ? `<div id="reader-pdf-pages"><div class="reader-loading"><span class="reader-loading-spinner"></span><h2>Opening ${isPdf?'PDF':'DjVu'}…</h2><p>Opening the document and preparing your starting page.</p></div></div>` : isEpub ? '<article id="epub-text" class="epub-text"><div class="reader-loading"><span class="reader-loading-spinner"></span><h2>Opening book…</h2><p>Preparing the chapters and illustrations.</p></div></article>' : fallback;
      const sidePanel = preferences.assistant ? 'assistant' : preferences.tools ? 'tools' : '';
      const bookmarkControl = '<svg class="reader-bookmark-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>';
      return `<div class="reader-shell ${preferences.navigation&&reading?'nav-open':''} ${sidePanel==='tools'&&reading?'tools-open':''} ${sidePanel==='assistant'&&reading?'assistant-open':''}" data-reader-type="${escape(file?.type||'file')}">
        <header class="reader-header">${button('back','←',translate('Return to '+app.returnLabel()),'class="reader-back" aria-label="'+escape(translate('Return to '+app.returnLabel()))+'"')}<div class="reader-document-identity"><small>${escape((file?.type||'file').toUpperCase())} <span id="reader-author"></span></small><h1 title="${escape(file?.name)}">${escape(file?.name||'Reader')}</h1></div><div class="reader-header-actions">${reading?button('find','⌕','Find in document (Ctrl+F)','aria-label="Find in document"')+button('bookmark',bookmarkControl,'Bookmark this position','aria-label="Bookmark this position"')+button('assistant','✧','Ask this document','aria-label="Ask this document" aria-pressed="'+Boolean(preferences.assistant)+'"')+button('saved','✎ Notes','Show saved passages and comments','aria-pressed="'+Boolean(preferences.tools)+'"'):''}<details class="reader-popover reader-document-menu"><summary aria-label="Reader menu" title="Reader menu">⋯ <span>Menu</span></summary>${renderDocumentMenu(file,reading)}</details></div></header>
        ${reading?`<div class="reader-commandbar"><div class="reader-nav-controls">${button('navigation','☷','Show navigation','aria-label="Show navigation" aria-pressed="'+Boolean(preferences.navigation)+'"')}${isEpub?'':button('previous','‹','Previous '+(isPaged?'page':'chapter'),'aria-label="Previous '+(isPaged?'page':'chapter')+'"'+(sequenceNavigation?'':' hidden'))}${isPaged?'<label class="reader-page-input-label"><input id="pdf-page-input" type="number" min="1" value="1" aria-label="Go to document page"><span>of <b id="pdf-page-total">…</b></span></label>':isEpub?'<span class="reader-continuous-label">Reader</span>':'<span>Text document</span>'}${isEpub?'':button('next','›','Next '+(isPaged?'page':'chapter'),'aria-label="Next '+(isPaged?'page':'chapter')+'"'+(sequenceNavigation?'':' hidden'))}</div><div class="reader-view-controls">${isPaged?`${zoomControls()}<label class="reader-control-label">View<select id="reader-pdf-mode" aria-label="Document page view"><option value="continuous">All pages</option><option value="single">Single page</option></select></label>`:(isEpub||file?.type==='txt')?`${zoomControls()}${appearance()}`:zoomControls()}${button('save-selection','✎ Save selection','Save selected text as a note (Ctrl+Shift+S)','class="reader-save-selection"')}</div></div>
        <div class="reader-findbar" role="search" aria-label="Search inside this document" hidden><label class="reader-find-input"><span>⌕</span><input id="reader-search-input" type="search" aria-label="Find in document" placeholder="Find in this document…" autocomplete="off"><kbd>Enter ↵</kbd></label><span id="reader-search-status" class="reader-find-status" role="status" aria-live="polite">Search this document</span><div class="reader-find-controls"><button type="button" id="reader-search-prev" title="Previous match">↑</button><button type="button" id="reader-search-next" title="Next match">↓</button><button type="button" data-reader-command="close-find" title="Close search">×</button></div></div>`:''}
        <div class="reader-workspace-body"><nav class="reader-navigation" aria-label="Document navigation" ${preferences.navigation&&reading?'':'hidden'}><div class="reader-navigation-heading"><h2>Document navigation</h2>${button('close-navigation','×','Close','class="reader-navigation-close" aria-label="Close"')}</div><div class="reader-nav-tabs" role="tablist" aria-label="Navigation views"><button role="tab" data-reader-tab="contents" aria-selected="true" class="is-active">Contents</button>${isPaged?'<button role="tab" data-reader-tab="pages" aria-selected="false">Pages</button>':''}<button role="tab" data-reader-tab="bookmarks" aria-selected="false">Bookmarks <span id="reader-bookmark-count">0</span></button></div><label class="reader-navigation-filter"><span>⌕</span><input id="reader-navigation-filter" type="search" placeholder="Filter contents…" aria-label="Filter navigation"></label><div class="reader-nav-panel" role="tabpanel" id="reader-nav-panel"><div class="reader-navigation-empty">Loading contents…</div></div></nav><div class="reader-content" tabindex="0" aria-label="${escape(isPdf?'PDF pages':isDjvu?'DjVu pages':isEpub?'Book chapter':'Document')}">${content}</div><aside class="reader-side" aria-label="${sidePanel==='assistant'?'Ask this document':'Saved passages and comments'}" ${sidePanel&&reading?'':'hidden'}><div class="reader-tools-heading"><div><small>${sidePanel==='assistant'?'DOCUMENT TOOLS':'READING NOTES'}</small><h2>${sidePanel==='assistant'?'Ask this document':'Passages & comments'}</h2></div>${button(sidePanel==='assistant'?'assistant':'tools','×',sidePanel==='assistant'?'Close Ask this document':'Close reading notes','aria-label="Close '+(sidePanel==='assistant'?'Ask this document':'reading notes')+'"')}</div><div class="reader-side-content">${aside}</div></aside></div>
        <footer class="reader-statusbar"><span id="reader-location-label">${reading?'Opening document…':'Attachment'}</span><div class="reader-progress-track" role="progressbar" aria-label="Reading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="reader-progress-fill"></span></div><span id="reader-progress-label"></span><span class="reader-saved-status">Saved on this device</span></footer>${button('focus','','','hidden aria-hidden="true" tabindex="-1"')}</div>`;
    }
    function appearance() {
      const prefs = app.getEpubPrefs();
      return `<details class="reader-popover"><summary title="Reading appearance">Aa <span>Appearance</span></summary><div class="reader-appearance-panel"><h3>Make yourself comfortable</h3><label>Text size <span class="reader-font-controls">${button('font-down','A−','Smaller text')}<output id="reader-font-size">${prefs.fontSize}px</output>${button('font-up','A+','Larger text')}</span></label><label>Font<select data-reader-preference="font"><option value="serif">Book serif</option><option value="sans">Clear sans</option></select></label><label>Line spacing<select data-reader-preference="lineHeight"><option value="1.5">Compact</option><option value="1.8">Comfortable</option><option value="2.1">Spacious</option></select></label><label>Page width<select data-reader-preference="width"><option value="narrow">Narrow</option><option value="comfortable">Comfortable</option><option value="wide">Wide</option></select></label><label>Page tone<select data-reader-preference="theme"><option value="paper">Paper</option><option value="sepia">Sepia</option><option value="night">Night</option></select></label>${button('appearance-reset','Reset reading appearance')}</div></details>`;
    }
    function zoomControls() {
      return `<div class="reader-zoom" role="group" aria-label="Document zoom">${button('zoom-down','−','Zoom out (Ctrl+-)','aria-label="Zoom out"')}${button('zoom-reset',`${Math.round(preferences.textZoom*100)}%`,'Reset zoom to 100% (Ctrl+0)','aria-label="Reset zoom to 100 percent"')}${button('zoom-up','+','Zoom in (Ctrl++)','aria-label="Zoom in"')}</div>`;
    }
    function mount() {
      readinessObserver?.disconnect(); cancelAnimationFrame(readinessFrame); readinessFrame = 0;
      fullscreenGestureCleanup?.(); fullscreenGestureCleanup = null;
      releaseThumbnails(); shell = document.querySelector('#view .reader-shell');
      if (!shell) return;
      shell.onclick = async event => {
        const tab = event.target.closest('[data-reader-tab]');
        if (tab) { if(navTab!==tab.dataset.readerTab){navTab=tab.dataset.readerTab;shell.querySelector('#reader-navigation-filter').value='';if(navTab==='pages')pageRangeStart=Math.floor(((pdf()?.pageNum||1)-1)/pagePreviewLimit)*pagePreviewLimit+1;renderNavigation()}return; }
        const command = event.target.closest('[data-reader-command]');
        if (command) { if(command.dataset.readerMenuId)shell.querySelector('.reader-document-menu')?.removeAttribute('open'); await run(command.dataset.readerCommand); return; }
        // Reader content also carries chapter metadata; navigation belongs to the sidebar.
        if (!event.target.closest('.reader-navigation')) return;
        const chapter = event.target.closest('[data-reader-chapter]');
        if (chapter) { await app.goToChapter(Number(chapter.dataset.readerChapter)); if(chapter.dataset.readerAnchor)app.goToAnchor(chapter.dataset.readerAnchor); return; }
        const page = event.target.closest('[data-reader-page-jump]');
        if (page) { await app.goToPage(Number(page.dataset.readerPageJump)); return; }
        const entry = event.target.closest('[data-reader-outline]');
        if (entry) { await app.goToDestination(outline[Number(entry.dataset.readerOutline)]?.dest); return; }
        const markButton = event.target.closest('[data-reader-bookmark]');
        if (markButton) { const mark = bookmarks().find(item=>item.id===markButton.dataset.readerBookmark); if(mark) await app.goToBookmark(mark); return; }
        const rename = event.target.closest('[data-reader-bookmark-rename]');
        if (rename) { const mark=bookmarks().find(item=>item.id===rename.dataset.readerBookmarkRename); if(!mark)return;const title=await window.NotejectDialogs.prompt('Choose a name for this reading position.',mark.title,{title:'Rename bookmark',input:{label:'Bookmark name'}});if(title?.trim()){mark.title=title.trim().slice(0,150);app.save();renderNavigation()}return; }
        const remove = event.target.closest('[data-reader-bookmark-remove]');
        if (remove) { if(!await window.NotejectDialogs.confirm('Delete this bookmark?'))return;doc().bookmarks=bookmarks().filter(item=>item.id!==remove.dataset.readerBookmarkRemove);app.save();renderNavigation(); }
      };
      shell.querySelector('[data-reader-command="save-selection"]')?.addEventListener('mousedown',event=>event.preventDefault());
      shell.querySelector('#reader-navigation-filter').oninput = filterNavigation;
      const mode=shell.querySelector('#reader-pdf-mode');
      if(mode){mode.value=preferences.pdfMode;mode.onchange=async()=>{preferences.pdfMode=mode.value;persist();await app.setPdfMode(mode.value);updateLocation()}}
      shell.querySelectorAll('[data-reader-preference]').forEach(select=>{select.value=String(app.getEpubPrefs()[select.dataset.readerPreference]);select.onchange=()=>changeAppearance(select.dataset.readerPreference,select.dataset.readerPreference==='lineHeight'?Number(select.value):select.value)});
      const viewport=shell.querySelector('.reader-content');
      fullscreenGestureCleanup = setupFullscreenGesture(viewport);
      viewport.addEventListener('scroll',()=>{if(!locationFrame)locationFrame=requestAnimationFrame(()=>{locationFrame=0;updateLocation()});clearTimeout(saveTimer);saveTimer=setTimeout(app.saveProgress,300)},{passive:true});
      renderNavigation();applyPreferences();app.onMount?.();
      readinessObserver = new MutationObserver(() => { if (!readinessFrame) readinessFrame = requestAnimationFrame(() => { readinessFrame = 0; updateReadiness(); }); });
      readinessObserver.observe(shell, { childList:true, subtree:true, characterData:true });
      updateReadiness();
    }
    function contentReady() {
      if (!shell?.isConnected) return false;
      const area = shell.querySelector('.reader-content'), file = doc();
      if (!area || !file || area.querySelector('.relink-card,.reader-error,.office-preview-error,.reader-loading')) return false;
      if (file.type === 'txt') return area.querySelector('#txt-content')?.dataset.readerDocument === file.id;
      if (file.type === 'epub') return !!epub()?.length;
      if (['pdf','djvu'].includes(file.type)) return Number(pdf()?.numPages) > 0;
      return area.querySelector('#office-reader-content')?.dataset.readerReady === 'true';
    }
    function updateReadiness() {
      if (!shell?.isConnected) return;
      const ready = contentReady(), missing = !!shell.querySelector('.reader-content .relink-card');
      shell.dataset.readerReady = String(ready);
      let hint = shell.querySelector('.reader-readiness-hint');
      if (!hint) { hint = document.createElement('small'); hint.className = 'reader-readiness-hint'; hint.setAttribute('role','status'); shell.querySelector('.reader-document-identity')?.append(hint); }
      const message = missing ? 'Reconnect to use Find and Save passage.' : 'Preparing document…';
      if (hint.textContent !== message) hint.textContent = message;
      hint.hidden = ready;
      const controls = shell.querySelectorAll('[data-reader-command="find"],[data-reader-command="save-selection"],[data-reader-command="bookmark"],[data-ar-action="reader-find"],[data-ar-action="reader-save"],[data-ar-action="add-bookmark"],[data-reader-requires-ready],.clip-capture-button');
      controls.forEach(control => {
        if (!ready) {
          if (!control.hasAttribute('data-reader-blocked')) { control.dataset.readerBlocked = 'true'; control.dataset.readerPriorDisabled = String(control.disabled); }
          control.disabled = true;
          control.setAttribute('aria-disabled','true');
        } else if (control.hasAttribute('data-reader-blocked')) {
          control.disabled = control.dataset.readerPriorDisabled === 'true'; control.removeAttribute('aria-disabled'); delete control.dataset.readerBlocked; delete control.dataset.readerPriorDisabled;
        }
      });
    }
    function bookmarks() {
      const file=doc();if(!file)return [];
      if(!Array.isArray(file.bookmarks))file.bookmarks=[];
      if(Array.isArray(file.readerBookmarks)&&file.readerBookmarks.length){for(const old of file.readerBookmarks){if(!file.bookmarks.some(mark=>mark.id===old.id))file.bookmarks.push({id:old.id,title:old.name||'Bookmark',created:old.createdAt,location:{chapterIndex:old.chapterIndex,chapter:app.getTitles()[old.chapterIndex],scroll:old.scroll}})}delete file.readerBookmarks;app.save()}
      return file.bookmarks;
    }
    function navigationVisible() {
      return !!(shell?.isConnected && !focused && !shell.querySelector('.reader-navigation')?.hidden);
    }
    function releaseThumbnails() {
      thumbnailGeneration++;
      thumbnailObserver?.disconnect(); thumbnailObserver = null;
      thumbnailQueue = []; visibleThumbnails.clear();
      if(activeThumbnail)app.cancelThumbnail?.(activeThumbnail);
      shell?.querySelectorAll('[data-reader-thumbnail]').forEach(canvas=>{
        if(canvas!==activeThumbnail)app.cancelThumbnail?.(canvas);
        // Setting both dimensions to zero releases the backing bitmap immediately.
        canvas.width = 0; canvas.height = 0; delete canvas.dataset.readerPreviewState;
      });
    }
    async function drainThumbnails() {
      if(thumbnailRunning)return;
      thumbnailRunning=true;
      try{
        while(thumbnailQueue.length){
          const {canvas,page,generation}=thumbnailQueue.shift();
          if(generation!==thumbnailGeneration||!navigationVisible()||navTab!=='pages'||!visibleThumbnails.has(canvas)||!canvas.isConnected)continue;
          activeThumbnail=canvas;abandonedThumbnails.delete(canvas);canvas.dataset.readerPreviewState='rendering';
          try{
            const rendered=await app.renderThumbnail(page,canvas);
            if(generation===thumbnailGeneration&&canvas.isConnected)canvas.dataset.readerPreviewState=rendered===false||abandonedThumbnails.has(canvas)?'':'ready';
          }catch{
            if(generation===thumbnailGeneration&&canvas.isConnected)canvas.dataset.readerPreviewState=abandonedThumbnails.has(canvas)?'':'error';
          }finally{
            activeThumbnail=null;
            if(generation===thumbnailGeneration&&abandonedThumbnails.has(canvas)&&visibleThumbnails.has(canvas)&&canvas.isConnected){canvas.dataset.readerPreviewState='queued';thumbnailQueue.push({canvas,page,generation})}
          }
        }
      }finally{thumbnailRunning=false}
    }
    function observeThumbnails(panel) {
      const generation=thumbnailGeneration;
      thumbnailObserver=new IntersectionObserver(entries=>{
        if(generation!==thumbnailGeneration||!navigationVisible()||navTab!=='pages')return;
        for(const entry of entries){
          const canvas=entry.target.querySelector('canvas');if(!canvas)continue;
          if(entry.isIntersecting&&!entry.target.hidden){
            visibleThumbnails.add(canvas);
            if(!['ready','queued','rendering','error'].includes(canvas.dataset.readerPreviewState)){
              canvas.dataset.readerPreviewState='queued';thumbnailQueue.push({canvas,page:Number(canvas.dataset.readerThumbnail),generation});
            }
          }else{
            visibleThumbnails.delete(canvas);thumbnailQueue=thumbnailQueue.filter(item=>item.canvas!==canvas);
            if(canvas===activeThumbnail){abandonedThumbnails.add(canvas);app.cancelThumbnail?.(canvas)}
            if(canvas.dataset.readerPreviewState==='queued')delete canvas.dataset.readerPreviewState;
          }
        }
        drainThumbnails();
      },{root:panel,rootMargin:'80px'});
      panel.querySelectorAll('.reader-page-tile').forEach(tile=>thumbnailObserver.observe(tile));
    }
    function requestOutline() {
      if(outlineRequested||outlineResolved||!['pdf','djvu'].includes(doc()?.type)||!pdf()||navTab!=='contents'||!navigationVisible())return;
      outlineRequested=true;
      const file=doc();
      Promise.resolve().then(()=>app.loadPdfOutline?.()||[]).then(items=>{
        if(doc()===file&&!outlineResolved)setOutline(items||[]);
      },()=>{if(doc()===file&&!outlineResolved)setOutline([])});
    }
    function pageRange() {
      const count=pdf()?.numPages||0,value=shell?.querySelector('#reader-navigation-filter')?.value.trim()||'';
      const match=value.match(/^(?:p(?:age)?\.?\s*)?(\d+)(?:\s*[-–]\s*(\d+))?$/i);
      if(value&&!match)return {count,start:1,end:0,invalid:true};
      const start=clamp(match?Number(match[1]):pageRangeStart,1,Math.max(1,count));
      const end=Math.min(count,start+pagePreviewLimit-1,match?.[2]?Math.max(start,Number(match[2])):Infinity);
      return {count,start,end,invalid:false};
    }
    function renderNavigation() { navigationDirty=true;refreshNavigation(); }
    function refreshNavigation() {
      if(!shell?.isConnected)return;
      if(!navigationVisible())return;
      const file=doc();if(!file)return;
      const range=navTab==='pages'&&['pdf','djvu'].includes(file.type)?pageRange():null;
      const key=[file.id,file.type,navTab,range?`${range.count}:${range.start}:${range.end}:${range.invalid}`:'',navTab==='contents'?outlineVersion:''].join('|');
      if(!navigationDirty&&key===navigationKey){requestOutline();return}
      releaseThumbnails();navigationDirty=false;navigationKey=key;activePageTile=null;highlightedPage=0;
      const panel=shell.querySelector('#reader-nav-panel'),items=bookmarks();
      shell.querySelectorAll('[data-reader-tab]').forEach(tab=>{const active=tab.dataset.readerTab===navTab;tab.classList.toggle('is-active',active);tab.setAttribute('aria-selected',String(active))});
      shell.querySelector('#reader-bookmark-count').textContent=items.length||'';
      const filter=shell.querySelector('#reader-navigation-filter');filter.placeholder=navTab==='bookmarks'?'Filter bookmarks…':navTab==='pages'?'Page number or range…':'Filter contents…';filter.inputMode=navTab==='pages'?'numeric':'search';
      if(navTab==='bookmarks'){
        panel.innerHTML=`<div id="reader-bookmark-list">${items.map(mark=>`<div class="reader-nav-bookmark" data-reader-filter="${escape(mark.title)}"><button data-reader-bookmark="${escape(mark.id)}"><b>${escape(mark.title||'Bookmark')}</b><small>${escape(locationLabel(mark.location))}</small></button><div><button data-reader-bookmark-rename="${escape(mark.id)}" title="Rename bookmark" aria-label="Rename bookmark">✎</button><button data-reader-bookmark-remove="${escape(mark.id)}" title="Delete bookmark" aria-label="Delete bookmark">×</button></div></div>`).join('')||'<div class="reader-navigation-empty"><svg class="reader-navigation-bookmark-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg><b>Keep your place</b><p>Use the bookmark above to save a reading position.</p></div>'}</div>`;
      }else if(range){
        const {count,start,end,invalid}=range;
        panel.innerHTML=count&&!invalid?`<div class="reader-page-ranges" role="group" aria-label="Page preview range">${button('page-range-previous','‹','Previous page previews',start<=1?'disabled':'')}<span aria-live="polite">${start}–${end} of ${count}</span>${button('page-range-next','›','Next page previews',end>=count?'disabled':'')}</div><div id="reader-page-grid">${Array.from({length:end-start+1},(_,i)=>{const page=start+i;return `<button class="reader-page-tile" data-reader-page-jump="${page}" aria-label="Go to page ${page}"><canvas width="0" height="0" data-reader-thumbnail="${page}" aria-hidden="true"></canvas><span>${page}</span></button>`}).join('')}</div>`:`<p class="reader-navigation-empty">${invalid?'Enter a page number or a range such as 600–620.':'Preparing page previews…'}</p>`;
        panel.scrollTop=0;if(count&&!invalid)observeThumbnails(panel);
      }else if(file.type==='epub'){
        const navigation=app.getEpubNavigation(),flat=navigation.flatItems?.length?navigation.flatItems:app.getTitles().map((label,index)=>({label,index,depth:0}));
        panel.innerHTML=`<div id="reader-outline-list">${flat.map((item,index)=>`<button class="reader-outline-item" style="--reader-outline-depth:${Math.min(5,item.depth||0)}" data-reader-chapter="${item.index}" data-reader-anchor="${escape(item.anchor||'')}" data-reader-filter="${escape(item.label)}"><span class="reader-outline-number">${index+1}</span><span>${escape(item.label)}</span></button>`).join('')||'<p class="reader-navigation-empty">Preparing the book contents…</p>'}</div>`;
      }else if(['pdf','djvu'].includes(file.type)){
        if(outline.length)panel.innerHTML=`<div id="reader-outline-list">${outline.map((item,index)=>`<button class="reader-outline-item" style="--reader-outline-depth:${Math.min(5,item.depth||0)}" data-reader-outline="${index}" data-reader-filter="${escape(item.title)}"><span>›</span><span>${escape(item.title)}</span></button>`).join('')}</div>`;
        else panel.innerHTML=`<div class="reader-navigation-empty"><span>▤</span><b>${pdf()?pdf().numPages+' pages':'Opening PDF…'}</b><p>${outlineResolved?'This PDF has no table of contents. Open Pages to browse the document.':'Preparing the table of contents…'}</p>${button('show-pages','Browse pages')}</div>`;
      }else panel.innerHTML='<div class="reader-navigation-empty">Use search to find a passage in this file.</div>';
      if(!range)filterRows();requestOutline();updateLocation();
    }
    function filterRows(){const value=shell?.querySelector('#reader-navigation-filter')?.value.trim().toLocaleLowerCase()||'';shell?.querySelectorAll('[data-reader-filter]').forEach(row=>row.hidden=!row.dataset.readerFilter.toLocaleLowerCase().includes(value))}
    function filterNavigation(){if(navTab==='pages'&&['pdf','djvu'].includes(doc()?.type))refreshNavigation();else filterRows()}
    function locationLabel(location={}){return location.page?'Page '+location.page:location.chapter||Number.isFinite(location.chapterIndex)?location.chapter||'Chapter '+(location.chapterIndex+1):'Reading position'}
    function sameBookmark(a={},b={}){
      if(Number(a.page||0)!==Number(b.page||0))return false;
      if(Number(a.chapterIndex??-1)!==Number(b.chapterIndex??-1))return false;
      return Math.abs(Number(a.pageScroll??a.scroll??0)-Number(b.pageScroll??b.scroll??0))<.003;
    }
    function updateBookmarkState(){
      const location=app.getContext?.();const saved=location&&bookmarks().some(mark=>sameBookmark(mark.location,location));
      shell.querySelectorAll('[data-reader-command="bookmark"]').forEach(button=>{
        button.setAttribute('aria-pressed',String(!!saved));
        button.setAttribute('aria-label',saved?'Remove bookmark at this position':'Bookmark this position');
        button.title=saved?'Remove bookmark':'Save bookmark';
        const menuGlyph=button.querySelector('.reader-menu-glyph');
        if(menuGlyph){
          button.setAttribute('aria-pressed',String(!!saved));
          const label=button.querySelector(':scope > span:not(.reader-menu-glyph)');
          if(label)label.textContent=saved?(root.NotejectI18n?.t?.('Remove bookmark')||'Remove bookmark'):(root.NotejectI18n?.t?.('Bookmark')||'Bookmark');
        }
      });
    }
    function updateLocation(){
      if(!shell?.isConnected||!doc())return;
      updateBookmarkState();
      // The PDF proxy can become ready after mount. Refresh a visible, changed panel only.
      refreshNavigation();
      const file=doc(),viewport=shell.querySelector('.reader-content');let percent=0,label='Opening document…',current=0;
      if(['pdf','djvu'].includes(file.type)&&pdf()){current=pdf().pageNum||1;percent=current/pdf().numPages*100;label=`Page ${current} of ${pdf().numPages}`;const input=shell.querySelector('#pdf-page-input');if(input){if(document.activeElement!==input)input.value=current;input.max=pdf().numPages}shell.querySelector('#pdf-page-total').textContent=pdf().numPages;if(highlightedPage!==current){activePageTile?.classList.remove('is-active');activePageTile?.removeAttribute('aria-current');activePageTile=shell.querySelector(`[data-reader-page-jump="${current}"]`);if(activePageTile){activePageTile.classList.add('is-active');activePageTile.setAttribute('aria-current','page')}highlightedPage=current}}
      if(file.type==='epub'&&epub()?.length){current=app.getChapter();const titles=app.getTitles(),texts=app.getEpubTexts(),ratio=app.getEpubLocation?.()?.offset??clamp(viewport.scrollTop/Math.max(1,viewport.scrollHeight-viewport.clientHeight),0,1),lengths=texts.map(text=>Math.max(1,text.length)),total=lengths.reduce((sum,value)=>sum+value,0)||1;percent=(lengths.slice(0,current).reduce((sum,value)=>sum+value,0)+(lengths[current]||1)*ratio)/total*100;label=`Chapter ${current+1} of ${epub().length} · ${titles[current]||'Book'}`;const select=shell.querySelector('#epub-toc');if(select)select.value=String(current);const chapterLinks=[...shell.querySelectorAll('.reader-navigation [data-reader-chapter]')],candidates=chapterLinks.filter(item=>Number(item.dataset.readerChapter)===current),page=app.getEpubSection?.(current)||shell.querySelector('#epub-text');let activeLink=candidates[0];for(const item of candidates){const anchor=item.dataset.readerAnchor;if(!anchor)continue;const target=page?.querySelector('#'+CSS.escape(anchor))||[...(page?.querySelectorAll('[name]')||[])].find(node=>node.getAttribute('name')===anchor);if(target&&target.getBoundingClientRect().top<=viewport.getBoundingClientRect().top+100)activeLink=item}chapterLinks.forEach(item=>{const active=item===activeLink;item.classList.toggle('is-active',active);if(active)item.setAttribute('aria-current','location');else item.removeAttribute('aria-current')})}
      if(file.type==='txt'){label='Text document';percent=clamp(viewport.scrollTop/Math.max(1,viewport.scrollHeight-viewport.clientHeight)*100,0,100)}shell.querySelector('#reader-location-label').textContent=label;shell.querySelector('#reader-progress-label').textContent=Number.isFinite(percent)?Math.round(percent)+'%':'';const track=shell.querySelector('.reader-progress-track');track.setAttribute('aria-valuenow',String(Math.round(percent)));track.querySelector('.reader-progress-fill').style.width=clamp(percent||0,0,100)+'%';
      shell.querySelectorAll('[data-reader-command="previous"]').forEach(button=>button.disabled=['pdf','djvu'].includes(file.type)?current<=1:current<=0);shell.querySelectorAll('[data-reader-command="next"]').forEach(button=>button.disabled=['pdf','djvu'].includes(file.type)?current>=(pdf()?.numPages||1):current>=(epub()?.length||1)-1);
    }
    function setMetadata(value={}){metadata=value;if(!shell?.isConnected)return;const author=shell.querySelector('#reader-author');if(author)author.textContent=value.author?' · '+value.author:'';const heading=shell.querySelector('.reader-document-identity h1');if(heading&&value.title?.trim())heading.textContent=value.title.trim();const select=shell.querySelector('#epub-toc');if(select)select.innerHTML=app.getTitles().map((title,index)=>`<option value="${index}">${index+1}. ${escape(title)}</option>`).join('');if(doc()?.type==='epub')renderNavigation();else refreshNavigation()}
    function cleanOutlineTitle(value) {
      return String(value ?? '')
        .replace(/\uFFFD+/g, ' ')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'Untitled section';
    }
    function setOutline(items=[]) {
      outline=[];
      const walk=(entries,depth=0)=>entries.forEach(item=>{
        outline.push({...item,title:cleanOutlineTitle(item.title),depth});
        if(item.items)walk(item.items,depth+1);
      });
      walk(items);outlineResolved=true;outlineVersion++;if(navTab==='contents')renderNavigation();
    }
    function updateZoomControl(){
      const file=doc(),label=shell?.querySelector('[data-reader-command="zoom-reset"]'),down=shell?.querySelector('[data-reader-command="zoom-down"]'),up=shell?.querySelector('[data-reader-command="zoom-up"]');
      if(!label)return;const factor=['pdf','djvu'].includes(file?.type)?(Number(app.getPdfScale())||(preferences.zoom==='fit'?1:Number(preferences.zoom)||1)):preferences.textZoom;label.textContent=Math.round(factor*100)+'%';label.disabled=['pdf','djvu'].includes(file?.type)?Math.abs(factor-1)<.005:preferences.textZoom===1;
      const minimum=['pdf','djvu'].includes(file?.type) ? 0.25 : 0.5,maximum=['pdf','djvu'].includes(file?.type) ? 4 : 3;if(down)down.disabled=factor<=minimum;if(up)up.disabled=factor>=maximum;
    }
    function applyPreferences(){
      if(!shell?.isConnected)return;const prefs=app.getEpubPrefs(),page=shell.querySelector('#epub-text, #txt-content');
      if(page){page.dataset.readerTheme=prefs.theme;page.dataset.readerFont=prefs.font||'serif';page.style.setProperty('--reader-font-size',prefs.fontSize+'px');page.style.setProperty('--reader-line-height',prefs.lineHeight||1.8);page.style.setProperty('--reader-max-width',prefs.width==='wide'?'960px':prefs.width==='narrow'?'600px':'760px')}
      const zoomTarget=page||shell.querySelector('#txt-content');if(zoomTarget)zoomTarget.style.zoom=String(preferences.textZoom);
      updateZoomControl();
      const output=shell.querySelector('#reader-font-size');if(output)output.textContent=prefs.fontSize+'px';shell.querySelectorAll('[data-reader-preference]').forEach(select=>select.value=String(prefs[select.dataset.readerPreference]));updateLocation();
    }
    function preservePagePosition(change){
      const viewport=shell?.querySelector('.reader-content'),page=shell?.querySelector('#epub-text, #txt-content');if(!viewport||!page){change();return}
      const top=viewport.getBoundingClientRect().top,anchor=[...page.querySelectorAll('p,h1,h2,h3,li,blockquote,figure')].find(node=>node.getBoundingClientRect().bottom>top+20)||page,before=anchor.getBoundingClientRect().top-top;
      change();requestAnimationFrame(()=>{if(!anchor.isConnected||!viewport.isConnected)return;viewport.scrollTop+=anchor.getBoundingClientRect().top-viewport.getBoundingClientRect().top-before;updateLocation()});
    }
    function setFocus(active, { restore = true, platform = true } = {}) {
      if (active && !shell?.isConnected) return;
      if (focused === !!active) return;
      focused = !!active;
      const target = shell, request = ++fullscreenRequest;
      const change = () => {
        if (!target) return;
        target.classList.toggle('is-focused', focused);
        target.querySelectorAll('details[open]').forEach(details => { details.open = false; });
        target.querySelectorAll('[data-reader-command="focus"]').forEach(button => button.setAttribute('aria-pressed', String(focused)));
        if (focused || restore) {
          const navigation = !focused && preferences.navigation, tools = !focused && preferences.tools, assistant = !focused && preferences.assistant;
          target.classList.toggle('nav-open', navigation); target.classList.toggle('tools-open', tools); target.classList.toggle('assistant-open', assistant);
          const nav = target.querySelector('.reader-navigation'), side = target.querySelector('.reader-side');
          if (nav) nav.hidden = !navigation; if (side) side.hidden = !(tools || assistant);
          const find = target.querySelector('.reader-findbar'); if (focused && find) find.hidden = true;
        }
      };
      if (restore && target?.isConnected) preservePagePosition(change); else change();
      if(focused){releaseThumbnails();navigationDirty=true}else if(restore)refreshNavigation();
      if (platform) {
        if (typeof root.NotejectAndroid?.setReaderFullscreen === 'function') {
          try { root.NotejectAndroid.setReaderFullscreen(focused); } catch { app.notify('Could not change the Android full-screen display.'); }
        } else if (!root.NotejectAndroid) {
          if (focused && target?.requestFullscreen) {
            try {
              Promise.resolve(target.requestFullscreen()).then(() => {
                if ((request !== fullscreenRequest || !focused || shell !== target) && document.fullscreenElement === target) document.exitFullscreen().catch(() => {});
              }).catch(() => { /* The reader still fills the app window when browser fullscreen is unavailable. */ });
            } catch {}
          } else if (!focused && document.fullscreenElement === target) document.exitFullscreen?.().catch(() => {});
        }
      }
      root.dispatchEvent(new CustomEvent('noteject:reader-focus', { detail: { active: focused } }));
      if (restore && target?.isConnected) {
        target.querySelector('.reader-content')?.focus({ preventScroll: true });
        app.saveProgress();
      }
    }
    function changeAppearance(key,value){preservePagePosition(()=>{app.setEpubPref(key,value);applyPreferences()})}
    function setTextZoom(value){preservePagePosition(()=>{preferences.textZoom=Math.round(clamp(value,0.5,3)*100)/100;persist();applyPreferences()})}
    function beginPdfZoomPreview(point){
      if(!['pdf','djvu'].includes(doc()?.type)||!shell?.isConnected)return false;
      if(!app.beginPdfZoomPreview?.(point))return false;
      zoomPreview={shell,documentId:doc().id};return true;
    }
    function updatePdfZoomPreview(value,point){
      if(!zoomPreview||zoomPreview.shell!==shell||zoomPreview.documentId!==doc()?.id)return false;
      return app.updatePdfZoomPreview?.(clamp(Number(value)||1,.25,4),point);
    }
    async function endPdfZoomPreview({commit=true}={}){
      const preview=zoomPreview;if(!preview)return false;zoomPreview=null;
      const scale=await app.endPdfZoomPreview?.({commit});
      if(commit&&preview.shell===shell&&preview.documentId===doc()?.id&&shell?.isConnected){
        rememberPdfZoom(app.getPdfZoomValue?.()??scale);
      }
      return scale;
    }
    function rememberPdfZoom(value){
      if(!['pdf','djvu'].includes(doc()?.type)||!shell?.isConnected)return;
      if(value!=='fit'&&!(Number.isFinite(Number(value))&&Number(value)>0))return;
      preferences.zoom=value==='fit'?'fit':clamp(Number(value),.25,4);persist();updateZoomControl();app.saveProgress();
    }
    async function adjustZoom(command){
      if(['pdf','djvu'].includes(doc()?.type)){
        const current=Number(app.getPdfScale())||(preferences.zoom==='fit'?1:Number(preferences.zoom)||1),next=command==='zoom-reset'?1:clamp(Math.round((current+(command==='zoom-up' ? 0.1 : -0.1))*100)/100,0.25,4);
        preferences.zoom=next;persist();await app.setPdfZoom(next);updateZoomControl();return;
      }
      setTextZoom(command==='zoom-reset'?1:preferences.textZoom+(command==='zoom-up' ? 0.1 : -0.1));
    }
    function sidePanel(){return preferences.assistant?'assistant':preferences.tools?'tools':''}
    function showSidePanel(panel){
      if(!shell?.isConnected)return;
      if(focused)setFocus(false);
      const next=sidePanel()===panel?'':panel;
      preservePagePosition(()=>{
        preferences.tools=next==='tools';preferences.assistant=next==='assistant';persist();
        shell.classList.toggle('tools-open',preferences.tools);shell.classList.toggle('assistant-open',preferences.assistant);
        const side=shell.querySelector('.reader-side');side.hidden=!next;
        const heading=side.querySelector('.reader-tools-heading'),title=next==='assistant'?'Ask this document':'Passages & comments',label=next==='assistant'?'DOCUMENT TOOLS':'READING NOTES',command=next==='assistant'?'assistant':'tools';
        side.setAttribute('aria-label',next==='assistant'?'Ask this document':'Saved passages and comments');
        heading.querySelector('small').textContent=label;heading.querySelector('h2').textContent=title;
        const close=heading.querySelector('[data-reader-command]');close.dataset.readerCommand=command;close.title=next==='assistant'?'Close Ask this document':'Close reading notes';close.setAttribute('aria-label',next==='assistant'?'Close Ask this document':'Close reading notes');
        shell.querySelectorAll('[data-reader-command="tools"]').forEach(button=>button.setAttribute('aria-pressed',String(preferences.tools)));
        shell.querySelectorAll('[data-reader-command="assistant"]').forEach(button=>button.setAttribute('aria-pressed',String(preferences.assistant)));
        app.renderSidePanel?.(next);
      });
    }
    function openTools(){if(focused)setFocus(false);if(!shell?.isConnected||preferences.tools)return;showSidePanel('tools')}
    async function run(command){
      const file=doc();if(!file)return;
      if(command==='capture-image'){shell.querySelector('.reader-document-menu')?.removeAttribute('open');if(focused)setFocus(false);await root.NotejectNoteMedia.captureReaderPage('image');return;}
      if (['find','bookmark','save-selection'].includes(command) && !contentReady()) { app.notify('Open or reconnect the document before using Find or Save passage.'); return; }
      if(focused&&['navigation','tools','assistant','find','save-selection','bookmark','show-pages','back','previous-file','next-file'].includes(command))setFocus(false);
      if(command==='previous-file'||command==='next-file'){await app.navigateFile(command==='next-file'?1:-1);return}if(command==='download'){const blob=await app.getBlob();if(!blob){app.notify('Original file is unavailable');return}const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);return}if(command==='back'){app.saveProgress();app.back();return}
      if(command==='navigation'||command==='close-navigation'){
        preservePagePosition(()=>{
          preferences.navigation=command==='navigation'?!preferences.navigation:false;persist();
          shell.classList.toggle('nav-open',preferences.navigation);
          shell.querySelector('.reader-navigation').hidden=!preferences.navigation;
          shell.querySelectorAll('[data-reader-command="navigation"]').forEach(control=>{
            control.setAttribute('aria-pressed',String(preferences.navigation));
            control.setAttribute('aria-expanded',String(preferences.navigation));
          });
        });
        if(preferences.navigation)refreshNavigation();else{releaseThumbnails();navigationDirty=true}
        if(command==='close-navigation'){
          const target=[...shell.querySelectorAll('[data-reader-command="navigation"],.reader-header .wm-menu-button')].find(control=>control.getClientRects().length);
          (target||shell.querySelector('.reader-content'))?.focus({preventScroll:true});
        }
        return;
      }
      if(command==='saved'){app.showSaved?.();return}
      if(command==='tools'){showSidePanel('tools');return}
      if(command==='assistant'){shell.querySelector('.reader-document-menu')?.removeAttribute('open');showSidePanel('assistant');return}
      if(command==='add-to-board'){app.addSavedPassagesToBoard?.();return}
      if(command==='comment'){app.captureComment?.();return}
      if(command==='extend-passage'){app.extendSelection?.();return}
      if(command==='view'){if(root.NotejectDesktopReaderToolbar?.openView?.(shell))return;const appearance=shell.querySelector('.reader-appearance-panel')?.closest('details');if(appearance){appearance.open=true;appearance.querySelector('summary')?.focus()}else{const control=shell.querySelector('.reader-view-controls select, .reader-view-controls button');control?.focus();control?.scrollIntoView({block:'nearest'})}return}
      if(command==='help'){root.NotejectReaderMenu?.showHelp?.();return}
      if(command==='find'){const bar=shell.querySelector('.reader-findbar');if(bar){bar.hidden=false;bar.querySelector('input').focus();bar.querySelector('input').select()}return}
      if(command==='close-find'){shell.querySelector('.reader-findbar').hidden=true;app.clearSearch();return}
      if(command==='previous'||command==='next'){const delta=command==='next'?1:-1;if(file.type==='epub'){const viewport=shell.querySelector('.reader-content');viewport.scrollBy({top:delta*viewport.clientHeight*.85,behavior:'smooth'});return;}await(['pdf','djvu'].includes(file.type)?app.goToPage((pdf()?.pageNum||1)+delta):app.goToChapter(app.getChapter()+delta));return}
      if(command==='save-selection'){openTools();app.captureSelection();return}
      if(command==='bookmark'){const location=app.getContext();if(!location){app.notify('The document is still opening');return}const items=bookmarks(),title=locationLabel(location),existing=items.some(mark=>sameBookmark(mark.location,location));if(existing)file.bookmarks=items.filter(mark=>!sameBookmark(mark.location,location));else items.unshift({id:app.makeId(),title,location:{...location},created:Date.now(),updated:Date.now()});app.save();updateBookmarkState();navTab='bookmarks';preferences.navigation=true;persist();shell.classList.add('nav-open');shell.querySelector('.reader-navigation').hidden=false;renderNavigation();app.notify(existing?'Bookmark removed':'Bookmark saved');return}
      if(command==='show-pages'){navTab='pages';pageRangeStart=Math.floor(((pdf()?.pageNum||1)-1)/pagePreviewLimit)*pagePreviewLimit+1;shell.querySelector('#reader-navigation-filter').value='';renderNavigation();return}
      if(command==='page-range-previous'||command==='page-range-next'){const range=pageRange();pageRangeStart=command==='page-range-next'?Math.min(range.count,range.end+1):Math.max(1,range.start-pagePreviewLimit);shell.querySelector('#reader-navigation-filter').value='';renderNavigation();return}
      if(command==='focus'){setFocus(!focused);return}
      if(command==='zoom-fit'&&['pdf','djvu'].includes(file.type)){preferences.zoom='fit';persist();await app.setPdfZoom('fit');updateZoomControl();return}
      if(command==='font-down'||command==='font-up'){changeAppearance('fontSize',clamp(Number(app.getEpubPrefs().fontSize)+(command==='font-up'?1:-1),14,32));return}
      if(command==='zoom-down'||command==='zoom-up'||command==='zoom-reset'){await adjustZoom(command);return}
      if(command==='appearance-reset'){for(const [key,value]of Object.entries({fontSize:18,font:'serif',lineHeight:1.8,width:'comfortable',theme:'paper'}))app.setEpubPref(key,value);applyPreferences();return}
      if(command==='retry')await app.retry();
    }
    function setError(message){if(!shell?.isConnected)return;shell.querySelector('.reader-content').innerHTML=`<div class="reader-error"><span>!</span><h2>This document could not open</h2><p>${escape(message)}</p>${button('retry','Try again')}</div>`;shell.querySelector('#reader-location-label').textContent='Could not open document'}
    function dispose(){readinessObserver?.disconnect();readinessObserver=null;cancelAnimationFrame(readinessFrame);readinessFrame=0;fullscreenGestureCleanup?.();fullscreenGestureCleanup=null;if(focused)setFocus(false,{restore:false});clearTimeout(saveTimer);cancelAnimationFrame(locationFrame);locationFrame=0;if(zoomPreview)void endPdfZoomPreview({commit:false});releaseThumbnails();focused=false;shell=null;outline=[];navigationDirty=true;navigationKey='';activePageTile=null}
    document.addEventListener('fullscreenchange',()=>{if(focused&&!root.NotejectAndroid&&document.fullscreenElement!==shell)setFocus(false,{platform:false})});
    document.addEventListener('keydown',event=>{if(!shell?.isConnected)return;const typing=event.target.closest('input,textarea,select,[contenteditable=true]');if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();event.stopImmediatePropagation();run('find');return}if((event.ctrlKey||event.metaKey)&&!typing&&['pdf','djvu','epub','txt'].includes(doc()?.type)){if(event.key==='0'){event.preventDefault();event.stopImmediatePropagation();run('zoom-reset');return}if(event.key==='+'||event.key==='='||event.key==='Add'){event.preventDefault();event.stopImmediatePropagation();run('zoom-up');return}if(event.key==='-'||event.key==='_'){event.preventDefault();event.stopImmediatePropagation();run('zoom-down');return}}if(event.key==='Escape'){if(focused){run('focus');event.preventDefault();event.stopImmediatePropagation()}else if(shell.querySelector('.reader-findbar')&&!shell.querySelector('.reader-findbar').hidden){run('close-find');event.preventDefault();event.stopImmediatePropagation()}return}},true);
    return {closeTools:()=>{if(sidePanel()==='tools')showSidePanel('tools');},run,render,mount,dispose,renderNavigation,updateLocation,updateZoomControl,setMetadata,setOutline,applyPreferences,openTools,setError,beginPdfZoomPreview,updatePdfZoomPreview,endPdfZoomPreview,rememberPdfZoom,getSidePanel:sidePanel,getPdfMode:()=>preferences.pdfMode,getPdfZoom:()=>preferences.zoom};
  }
  root.NotejectReaderWorkspace={create};
})(window);
