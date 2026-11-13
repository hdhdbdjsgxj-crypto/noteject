/* Reading clips update independently so the document and its selection stay mounted. */
(() => {
  'use strict';
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className, run) => {
    const node = make('button', className, text); node.type = 'button'; node.onclick = run; return node;
  };
  function create(app) {
    const model = window.NotejectReaderSelectionModel;
    let root, docId = null, candidate = null, draft = null, search = '', sort = 'newest', favorites = false, limit = 24, frame = 0;
    let highlightObserver = null, highlightRoot = null, highlightTimer = 0;
    let composer, list, status, count, saveButton, bookmarks, boardBulkButton;
    const currentDoc = () => app.getDocument();
    const all = () => model.selectionsFor(app.getData(), currentDoc());
    const notify = message => app.notify(message);
    const androidDrafts = !!window.NotejectAndroid;
    let sourceContext = null;
    // Keep the context captured when the composer mounted: a workspace import
    // can replace the current book while an old pagehide/input callback runs.
    const contextFor = doc => doc ? JSON.stringify([
      app.getData().attachmentImportId || 'original', doc.id,
      app.getData().attachmentKeys?.[doc.id] || doc.id,
      doc.sourceRevision || '', doc.name, doc.type, doc.size ?? null, doc.added ?? null
    ]) : null;
    const draftKey = context => 'noteject-android-reader-draft:v2:' + encodeURIComponent(context);
    let draftStorageWarning = false;
    function draftStorageError() {
      if (draftStorageWarning) return;
      draftStorageWarning = true;
      notify('Your reading draft could not be saved on this device. Storage may be full. Keep the reader open and save the passage or comment before leaving.');
    }
    function persistDraft() {
      if (!androidDrafts || !docId || !sourceContext || !draft) return;
      try {
        localStorage.setItem(draftKey(sourceContext), JSON.stringify({ version: 2, documentId: docId, sourceContext, updatedAt: Date.now(), draft }));
        draftStorageWarning = false;
      } catch { draftStorageError(); }
    }
    function clearStoredDraft() {
      if (!androidDrafts || !sourceContext) return;
      try { localStorage.removeItem(draftKey(sourceContext)); draftStorageWarning = false; }
      catch { draftStorageError(); }
    }
    function restoreDraft(documentId) {
      if (!androidDrafts) return null;
      try {
        const cached = JSON.parse(localStorage.getItem(draftKey(sourceContext)) || 'null');
        // Unscoped v1 drafts remain stored for recovery, but cannot prove which
        // file they came from and must never be attached automatically.
        if (cached?.version !== 2 || cached.sourceContext !== sourceContext || cached.documentId !== documentId || !cached.draft || typeof cached.draft !== 'object' || Array.isArray(cached.draft)) return null;
        const restored = cached.draft;
        return {
          ...restored,
          title: String(restored.title || ''), comment: String(restored.comment || ''), quote: String(restored.quote || ''),
          tags: Array.isArray(restored.tags) ? restored.tags.map(tag => String(tag)) : [],
          location: restored.location && typeof restored.location === 'object' ? restored.location : {},
          noteId: restored.noteId && app.getData().notes?.some(note => note.id === restored.noteId) ? restored.noteId : null
        };
      } catch (error) { if (!(error instanceof SyntaxError)) draftStorageError(); return null; }
    }
    if (androidDrafts) {
      window.addEventListener('pagehide', persistDraft);
      document.addEventListener('visibilitychange', () => { if (document.hidden) persistDraft(); });
    }
    function readSelection() {
      const doc=currentDoc(),selection=window.getSelection();
      if(!root?.isConnected||doc?.id!==docId||contextFor(doc)!==sourceContext||!selection?.rangeCount||selection.isCollapsed)return;
      const range=selection.getRangeAt(0),element=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
      const content=element?.closest('.pdf-text-layer,.epub-section,#epub-text,#txt-content');
      if(!content||content.dataset.readerDocument!==docId)return;
      const context=app.getContext();if(!context)return;
      if(content.classList.contains('pdf-text-layer')){
        const endElement=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement,end=endElement?.closest('.pdf-text-layer');
        if(!end||end.dataset.readerDocument!==docId)return;
        const from=Number(content.dataset.readerPage),to=Number(end.dataset.readerPage);
        if(to<from||to-from>=128)return;
        const parts=[];
        for(const layer of document.querySelectorAll('.reader-content .pdf-text-layer')){
          const page=Number(layer.dataset.readerPage);if(page<from||page>to)continue;
          const part=document.createRange();part.selectNodeContents(layer);
          if(layer===content)part.setStart(range.startContainer,range.startOffset);if(layer===end)part.setEnd(range.endContainer,range.endOffset);
          const raw=part.toString(),quote=raw.trim();if(!quote)continue;
          const before=document.createRange();before.selectNodeContents(layer);before.setEnd(part.startContainer,part.startOffset);
          parts.push({page,textOffset:before.toString().length+raw.length-raw.trimStart().length,quote});
        }
        const quote=parts.map(part=>part.quote).join('\n\n');if(!quote||quote.length>200000)return;
        candidate={docId,quote,location:{...context,page:from,textOffset:parts[0].textOffset,sourceRevision:doc.sourceRevision||'',...(to>from?{endPage:to,endTextOffset:parts.at(-1).textOffset+parts.at(-1).quote.length,pages:parts}:{})}};
      }else if(doc.type==='epub'&&content.classList.contains('epub-section')){
        const endElement=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement,end=endElement?.closest('.epub-section');
        if(!end||end.dataset.readerDocument!==docId)return;
        const from=Number(content.dataset.readerChapter),to=Number(end.dataset.readerChapter);if(to<from||to-from>=128)return;
        const parts=[];
        for(const section of document.querySelectorAll('#epub-text .epub-section')){
          const chapterIndex=Number(section.dataset.readerChapter);if(chapterIndex<from||chapterIndex>to)continue;
          const part=document.createRange();part.selectNodeContents(section);if(section===content)part.setStart(range.startContainer,range.startOffset);if(section===end)part.setEnd(range.endContainer,range.endOffset);
          const raw=part.toString(),quote=raw.trim();if(!quote)continue;const before=document.createRange();before.selectNodeContents(section);before.setEnd(part.startContainer,part.startOffset);
          parts.push({chapterIndex,textOffset:before.toString().length+raw.length-raw.trimStart().length,quote});
        }
        const quote=parts.map(part=>part.quote).join('\n\n');if(!quote||quote.length>200000)return;
        candidate={docId,quote,location:{...context,chapterIndex:from,textOffset:parts[0].textOffset,sourceRevision:doc.sourceRevision||'',...(to>from?{endChapterIndex:to,chapters:parts}:{})}};
      }else{
        if(!content.contains(range.endContainer))return;
        const raw=selection.toString(),quote=raw.replace(/\r\n?/g,'\n').trim();if(!quote)return;
        const before=range.cloneRange();before.selectNodeContents(content);before.setEnd(range.startContainer,range.startOffset);
        const offset=before.toString().length+raw.length-raw.trimStart().length,full=content.textContent||'';
        candidate={docId,quote,location:{...context,chapterIndex:doc.type==='epub'?Number(content.dataset.readerChapter):undefined,textOffset:offset,sourceRevision:doc.sourceRevision||'',prefix:full.slice(Math.max(0,offset-64),offset),suffix:full.slice(offset+raw.trim().length,offset+raw.trim().length+64)}};
      }
      updateStatus();
    }
    // Snapshot before a touch on Save moves focus away from EPUB text handles.
    document.addEventListener('pointerdown',event=>{if(event.target.closest('[data-reader-command="save-selection"],[data-ar-action="reader-save"],.clip-capture-button'))readSelection();},true);
    document.addEventListener('selectionchange', () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; readSelection(); });
    });
    // Android WebView can update its Selection after selectionchange has fired
    // for the drag. Re-read it after touch and pointer completion so EPUB text
    // selections reliably reach the passage composer on mobile.
    const captureTouchSelection = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; readSelection(); });
      setTimeout(readSelection, 80);
    };
    document.addEventListener('touchend', captureTouchSelection, { capture: true, passive: true });
    document.addEventListener('pointerup', captureTouchSelection, true);
    document.addEventListener('keydown', event => {
      if (!currentDoc() || event.defaultPrevented || !event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      if (event.target.closest('input,textarea,select,[contenteditable=true]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); capture();
    }, true);
    function updateStatus() {
      if (!status?.isConnected) return;
      const ready = candidate?.docId === docId;
      status.textContent = ready ? `${candidate.quote.split(/\s+/).length} words selected · ${model.locationLabel(candidate.location) || 'Current passage'}` : 'Select text in the document to capture a passage.';
      status.classList.toggle('is-ready', !!ready);
      saveButton.setAttribute('aria-disabled', ready ? 'false' : 'true');
    }
    function cancel() {
      clearStoredDraft();
      draft = null; composer.replaceChildren(); composer.hidden = true; saveButton.focus({ preventScroll: true });
    }
    function capture() {
      if (!currentDoc()) return;
      app.openTools?.();
      if (!root?.isConnected) return;
      readSelection();
      if (draft) { composer.querySelector('input')?.focus(); notify('Save or cancel the open passage first'); return; }
      if (!candidate || candidate.docId !== docId) { updateStatus(); notify('Select text inside the document first'); return; }
      showComposer({ quote: candidate.quote, location: { ...candidate.location }, title: '', comment: '', tags: [], color: 'violet' });
    }
    function captureComment() {
      if (!root?.isConnected || !currentDoc()) return;
      app.openTools?.();
      if (draft) { composer.querySelector('input')?.focus(); notify('Save or cancel the open item first'); return; }
      const location = app.getContext();
      if (!location) { notify('Reader location is not ready yet'); return; }
      showComposer({ quote: '', location: { ...location }, title: 'Reader comment', comment: '', tags: [], color: 'violet', addToBoard: false });
      composer.querySelector('[name="comment"]')?.focus({ preventScroll: true });
    }
    function bookmarkItems() { const doc = currentDoc(); if (!doc) return []; if (!Array.isArray(doc.bookmarks)) doc.bookmarks = []; return doc.bookmarks; }
    function renderBookmarks() {
      if (!bookmarks?.isConnected) return;
      bookmarks.replaceChildren();
      const items = bookmarkItems();
      if (!items.length) { bookmarks.append(make('p', 'reader-bookmark-empty', 'No bookmarks yet. Save this page or chapter to return here later.')); return; }
      for (const mark of items) {
        const row = make('div', 'reader-bookmark-row'), meta = make('div', 'reader-bookmark-meta'), actions = make('div', 'reader-bookmark-actions'), jump = button(mark.title || 'Untitled bookmark', 'reader-bookmark-open', () => app.goToBookmark?.(mark));
        jump.title = 'Jump to ' + model.locationLabel(mark.location || {}); meta.append(jump, make('small', '', model.locationLabel(mark.location || {}) || 'Reading position'));
        const remove = button('×', 'reader-bookmark-action destructive-action', async () => { if (!await window.NotejectDialogs.confirm('Delete this bookmark?')) return; const doc = currentDoc(); doc.bookmarks = bookmarkItems().filter(item => item.id !== mark.id); app.save(); renderBookmarks(); });
        remove.setAttribute('aria-label', 'Delete bookmark'); remove.title = 'Delete bookmark';
        actions.append(button('Rename', 'reader-bookmark-action', async () => { const title = await window.NotejectDialogs.prompt('Choose a name for this reading position.', mark.title || 'Bookmark', { title: 'Rename bookmark', input: { label: 'Bookmark name' } }); if (title?.trim()) { mark.title = title.trim().slice(0, 120); app.save(); renderBookmarks(); } }), remove);
        row.append(meta, actions);
        bookmarks.append(row);
      }
    }
    async function saveBookmark() {
      const location = app.getContext();
      if (!location) { notify('Reader location is not ready yet'); return; }
      const label = model.locationLabel(location) || 'Current position';
      const title = await window.NotejectDialogs.prompt('Name this reading position so you can find it again.', label, { title: 'Save bookmark', input: { label: 'Bookmark name' } });
      if (!title?.trim()) return;
      const items = bookmarkItems(), doc = currentDoc();
      const same = items.find(mark => JSON.stringify(mark.location || {}) === JSON.stringify(location));
      if (same) { same.title = title.trim().slice(0, 120); same.updated = Date.now(); }
      else items.unshift({ id: app.makeId(), title: title.trim().slice(0, 120), location: { ...location }, created: Date.now(), updated: Date.now() });
      doc.bookmarks = items; app.save(); renderBookmarks(); notify(same ? 'Bookmark updated' : 'Bookmark saved');
    }
    async function extendPassage() {
      const value=draft,context=sourceContext,doc=currentDoc();if(!value?.quote||!doc)return;
      const paged=['pdf','djvu'].includes(doc.type),key=paged?'pages':'chapters',unit=paged?'page':'chapterIndex';
      const parts=value.location[key]?.map(part=>({...part}))||[{[unit]:paged?value.location.page:value.location.chapterIndex,textOffset:value.location.textOffset||0,quote:value.quote}];
      const last=parts.at(-1),index=last[unit],next=index+1;
      if(parts.length>=128){notify('Select up to 128 pages or chapters.');return}
      const control=composer.querySelector('[data-extend-passage]');if(control)control.disabled=true;
      try {
        const tail=await app.getSection(doc.type,index),following=await app.getSection(doc.type,next);
        if(context!==sourceContext||draft!==value||currentDoc()?.id!==doc.id)return;
        if(following===null){notify('This is the last page or chapter.');return}
        const matches=window.NotejectReaderTextSearch.find(window.NotejectReaderTextSearch.index(tail||''),last.quote);
        const match=matches.sort((a,b)=>Math.abs(a.offset-last.textOffset)-Math.abs(b.offset-last.textOffset))[0];
        if(!match)throw Error('The selected text could not be matched. Select it again before extending.');
        last.textOffset=match.offset;last.quote=tail.slice(match.offset).trimEnd();parts.push({[unit]:next,textOffset:0,quote:following.trimEnd()});
        const quote=parts.map(part=>part.quote).join('\n\n');if(quote.length>200000)throw Error('Select a shorter passage, up to 200,000 characters.');
        const location={...value.location,[key]:parts,...(paged?{endPage:next,endTextOffset:following.length}:{endChapterIndex:next})};
        showComposer({...value,quote,location},value.noteId,false);notify('Selection extended through '+(paged?'page '+next:'chapter '+(next+1)));
      }catch(error){notify(error.message||'Could not extend this selection.')}finally{if(control?.isConnected)control.disabled=false;}
    }
    function showNativeComposer(value,noteId,context) {
      const doc=currentDoc(),workspace=app.getData(),boards=workspace.boards||[];
      const folder=value.folder||doc.readerPassageFolder||doc.folder||'Inbox',boardId=value.boardId||doc.readerPassageBoardId||workspace.activeBoard||boards[0]?.id||'';
      composer.hidden=true;persistDraft();app.closeTools?.();
      window.NotejectReaderSurfaces.compose({documentId:doc.id,sourceLabel:doc.name+' · '+(model.locationLabel(value.location)||'Reading position'),quote:value.quote||'',title:value.title||'',comment:value.comment||'',tags:Array.isArray(value.tags)?value.tags.join(', '):value.tags||'',folder,
        folders:[...new Set(['Inbox',...(workspace.noteFolders||[]),...(workspace.folders||[])])],color:value.color||'violet',boards:boards.map(board=>({id:board.id,name:board.name})),boardId,addToBoard:value.addToBoard??!!doc.readerPassageBoardId,editing:!!noteId,error:value.error||''},event=>{
        if(context!==sourceContext||contextFor(currentDoc())!==context){notify('This draft belongs to another document. Reopen its Reader.');return;}
        if(event.action==='close'){cancel();return;}
        const fields=event.fields||{};draft={...value,...fields,tags:typeof fields.tags==='string'?fields.tags.split(',').map(tag=>tag.trim()).filter(Boolean):value.tags||[],noteId};persistDraft();
        if(event.action==='draft')return;
        const result=model.saveSelection(app.getData(),{docId,noteId,draft,addToBoard:!!draft.addToBoard,boardId:draft.boardId},app.makeId,Date.now());
        if(!result.ok){notify(result.error);showComposer({...draft,error:result.error},noteId);return;}
        doc.readerPassageFolder=result.note.folder;doc.readerPassageBoardId=draft.addToBoard?draft.boardId:'';app.save();app.noteSaved?.(result.note);
        clearStoredDraft();draft=null;candidate=null;window.getSelection()?.removeAllRanges();composer.hidden=true;composer.replaceChildren();renderList();renderHighlights();app.updateCounts?.();notify(result.created?'Passage saved in Notes':'Passage updated');
      });
    }
    function showComposer(value, noteId = null, focus = true) {
      const composerContext = sourceContext;
      value = { ...value, title: String(value.title || '').trim() || model.normalizeDraft(value).title };
      draft = { ...value, noteId };
      if(window.NotejectReaderSurfaces?.hasComposer()){
        try {showNativeComposer(value,noteId,composerContext);return;}
        catch(error){notify(error.message||'The passage form could not open. Your draft is still available.');app.openTools?.();}
      }
      composer.hidden = false; composer.replaceChildren();
      composer.append(make('h4', '', noteId ? (value.quote ? 'Edit passage' : 'Edit comment') : (value.quote ? 'Save passage' : 'Add reader comment')));
      const quote = make(value.quote ? 'blockquote' : 'p', 'clip-quote-preview', value.quote || 'Comment at this page or chapter');
      const source = make('div', 'clip-source-chip', `${currentDoc().name} · ${model.locationLabel(value.location) || 'Current reading position'}`);
      source.dataset.selectionColor = value.color || 'violet';
      composer.append(source, quote);
      if(value.quote&&['epub','pdf','djvu'].includes(currentDoc()?.type)){const extend=button(currentDoc().type==='epub'?'Extend to next chapter':'Extend to next page','secondary',()=>void extendPassage());extend.dataset.extendPassage='true';composer.append(extend);}
      const fields = {};
      function field(labelText, name, tag = 'input') {
        const label = make('label', '', labelText), control = make(tag);
        control.name = name; fields[name] = control;
        if (tag === 'input') control.type = 'text';
        label.append(control); composer.append(label); return control;
      }
      const title = field('Title', 'title'); title.maxLength = 160; title.value = value.title || ''; title.placeholder = 'Automatic title from your passage';
      const comment = field(value.quote ? 'Your thoughts' : 'Comment', 'comment', 'textarea'); comment.rows = 3; comment.value = value.comment || ''; comment.placeholder = value.quote ? 'Why does this matter? Add a question or an idea…' : 'Write a note about this page or chapter…';
      const tags = field('Tags', 'tags'); tags.value = (value.tags || []).join(', '); tags.placeholder = 'evidence, chapter 1, follow up';
      const folder = field('Save in Notes folder', 'folder', 'select'), workspace = app.getData();
      const folderNames = [...new Set(['Inbox', ...(workspace.noteFolders || []), ...(workspace.folders || []), ...(workspace.notes || []).map(note => note.folder || 'Inbox')])];
      const defaultFolder = (() => { try { return localStorage.getItem('noteject-reader-passage-folder') || ''; } catch { return ''; } })();
      const selectedFolder = String(value.folder || currentDoc()?.readerPassageFolder || currentDoc()?.folder || defaultFolder || (workspace.folderProjects?.['Notes'] ? 'Notes' : 'Inbox')).trim() || 'Inbox';
      if (!folderNames.includes(selectedFolder)) folderNames.push(selectedFolder);
      for (const name of folderNames) { const option = make('option', '', name); option.value = name; folder.append(option); }
      folder.value = selectedFolder;
      folder.onchange = () => { try { localStorage.setItem('noteject-reader-passage-folder', folder.value); } catch {} };
      const colors = make('fieldset', 'clip-options'); colors.append(make('legend', '', 'Color'));
      for (const [color, hex] of Object.entries(model.colors)) {
        const label = make('label', 'clip-color-choice'), radio = make('input');
        radio.type = 'radio'; radio.name = 'color'; radio.value = color; radio.checked = color === value.color;
        radio.setAttribute('aria-label', color[0].toUpperCase() + color.slice(1));
        label.style.setProperty('--clip-color', hex); label.append(radio, make('span')); colors.append(label);
      }
      composer.append(colors);
      const boardOption = make('label', 'clip-board-option'), add = make('input'); add.type = 'checkbox'; add.name = 'addToBoard';
      const boards = app.getData().boards || [], sourceBoard = boards.find(board => board.id === app.getData().activeBoard && board.items?.some(item => item.id === docId)) || boards.find(board => board.items?.some(item => item.id === docId)) || boards.find(board => board.id === app.getData().activeBoard) || boards[0];
      const preferredBoard = boards.find(board => board.id === currentDoc()?.readerPassageBoardId);
      add.checked = value.addToBoard ?? !!preferredBoard; add.disabled = !boards.length;
      boardOption.append(add, document.createTextNode('Also add passages to a Board')); composer.append(boardOption);
      const boardLabel = make('label', 'clip-board-target', 'Board'), boardSelect = make('select'); boardSelect.name = 'boardId';
      for (const board of boards) { const option = make('option', '', board.name); option.value = board.id; boardSelect.append(option); }
      if (value.boardId && boards.some(board => board.id === value.boardId)) boardSelect.value = value.boardId;
      else if (preferredBoard) boardSelect.value = preferredBoard.id;
      else if (sourceBoard) boardSelect.value = sourceBoard.id;
      boardSelect.disabled = !add.checked; add.onchange = () => { boardSelect.disabled = !add.checked; }; boardLabel.append(boardSelect); composer.append(boardLabel);
      composer.append(make('small', 'clip-source-hint', 'Remembered for this book. Passages stay in Notes and link back to their source.'));
      const error = make('p', 'clip-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      const actions = make('div', 'clip-composer-actions'), submit = make('button', 'primary', noteId ? 'Save changes' : (value.quote ? 'Save passage' : 'Save comment')); submit.type = 'submit';
      actions.append(button('Cancel', 'secondary', cancel), submit); composer.append(error, actions);
      const liveDraft = () => {
        // Removing a focused old form can emit change during mount teardown.
        if (composerContext !== sourceContext || contextFor(currentDoc()) !== composerContext) return;
        draft = { ...value, noteId, title: title.value, comment: comment.value, tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean), folder: folder.value, color: composer.querySelector('input[name="color"]:checked')?.value || 'violet', addToBoard: add.checked, boardId: boardSelect.value }; persistDraft();
      };
      composer.oninput = liveDraft; composer.onchange = liveDraft;
      if (androidDrafts) liveDraft();
      composer.onsubmit = event => {
        event.preventDefault();
        if (currentDoc()?.id !== docId || composerContext !== sourceContext || contextFor(currentDoc()) !== composerContext) {
          persistDraft(); notify('This draft belongs to a different version of the document. It has been kept separately.'); return;
        }
        try { localStorage.setItem('noteject-reader-passage-folder', folder.value); } catch {}
        const result = model.saveSelection(app.getData(), {
          docId, noteId,
          draft: { ...value, title: title.value, comment: comment.value, tags: tags.value, folder: folder.value, color: composer.querySelector('input[name="color"]:checked')?.value || 'violet', favorite: noteId ? !!app.getData().notes.find(note => note.id === noteId)?.favorite : false },
          boardId: boardSelect.value, addToBoard: add.checked
        }, app.makeId, Date.now());
        if (!result.ok) {
          error.hidden = false; error.textContent = result.error;
          if (result.duplicate) error.append(button('View saved passage', 'text-button', () => { cancel(); search = ''; favorites = false; limit = Math.max(24, all().length); resetFilters(); renderList(); focusCard(result.duplicate); }));
          return;
        }
        currentDoc().readerPassageBoardId = add.checked ? boardSelect.value : '';currentDoc().readerPassageFolder = folder.value;
        app.save(); app.noteSaved?.(result.note);
        const wasNew = !noteId;
        clearStoredDraft();
        draft = null; composer.hidden = true; composer.replaceChildren();
        if (wasNew) { candidate = null; window.getSelection()?.removeAllRanges(); }
        updateStatus(); renderList(); renderHighlights(); app.updateCounts?.(); focusCard(result.note.id);
        notify(result.created ? (result.board ? 'Passage saved and connected on ' + result.board.name : 'Passage saved in Notes') : 'Passage updated');
      };
      composer.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); composer.requestSubmit(); }
      };
      if (focus) { title.focus({ preventScroll: true }); composer.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    }
    function focusCard(noteId) {
      const card = [...list.querySelectorAll('[data-clip-id]')].find(node => node.dataset.clipId === noteId);
      card?.focus({ preventScroll: true }); card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function resetFilters() {
      root.querySelector('input[type="search"]').value = search;
      root.querySelector('.clip-favorites-filter input').checked = favorites;
    }
    function renderList() {
      if (!list?.isConnected) return;
      const notes = all(), term = search.trim().toLowerCase();
      if (boardBulkButton) boardBulkButton.disabled = !notes.length || !app.getData().boards?.length;
      const matches = notes.map(note => ({ note, clip: model.normalize(note) })).filter(({ clip }) => (!favorites || clip.favorite) && (!term || [clip.title, clip.quote, clip.comment, ...(clip.tags || [])].join(' ').toLowerCase().includes(term)));
      matches.sort((a, b) => sort === 'source' ? ((a.clip.location.page || a.clip.location.chapterIndex + 1 || 1) - (b.clip.location.page || b.clip.location.chapterIndex + 1 || 1) || (a.clip.location.textOffset || 0) - (b.clip.location.textOffset || 0) || a.clip.created - b.clip.created) : sort === 'oldest' ? a.clip.created - b.clip.created : b.clip.updated - a.clip.updated);
      count.textContent = String(matches.length); count.setAttribute('aria-label', matches.length + ' matching saved selections'); list.replaceChildren();
      if (!matches.length) { list.append(make('p', 'clip-empty', notes.length ? 'No passages match. Try another search or turn off Favorites.' : 'Your saved passages will appear here, linked to this document.')); return; }
      for (const { note, clip } of matches.slice(0, limit)) {
        const card = make('article', 'clip-card'); card.dataset.clipId = note.id; card.tabIndex = -1; card.style.setProperty('--clip-color', model.colors[clip.color]);
        const heading = make('div', 'clip-card-heading'), star = button(clip.favorite ? '★' : '☆', 'clip-star', () => {
          note.favorite = !note.favorite; app.save(); renderList(); focusCard(note.id);
        });
        star.setAttribute('aria-label', (clip.favorite ? 'Unfavorite ' : 'Favorite ') + clip.title); star.setAttribute('aria-pressed', String(clip.favorite));
        heading.append(make('h4', '', clip.title), star); card.append(heading);
        const location = model.locationLabel(clip.location) || 'Source passage';
        card.append(button('↗ ' + location, 'clip-card-location', () => app.goToLocation(note)));
        const quote = make(clip.quote ? 'blockquote' : 'p', 'clip-card-quote', clip.quote ? (clip.quote.length > 320 ? clip.quote.slice(0, 320) + '…' : clip.quote) : 'Reader comment'); card.append(quote);
        if (clip.quote.length > 320) {
          let expanded = false;
          const expand = button('Show full passage', 'text-button', () => { expanded = !expanded; quote.textContent = expanded ? clip.quote : clip.quote.slice(0,320) + '…'; expand.textContent = expanded ? 'Show less' : 'Show full passage'; expand.setAttribute('aria-expanded', String(expanded)); });
          expand.setAttribute('aria-expanded', 'false'); card.append(expand);
        }
        if (clip.comment) card.append(make('p', 'clip-card-comment', clip.comment));
        if (clip.tags.length) { const tags = make('div', 'clip-card-tags'); for (const tag of clip.tags) tags.append(make('span', '', '#' + tag)); card.append(tags); }
        const actions = make('div', 'clip-card-actions');
        actions.append(button('Edit in Notes', '', () => app.editNote(note.id)), button('Edit passage', '', () => {
          if (draft) { composer.querySelector('input')?.focus(); notify('Save or cancel the open passage first'); return; }
          showComposer(clip, note.id);
        }), button('Copy', '', async () => {
          try { await navigator.clipboard.writeText(note.content); notify('Passage copied with source'); } catch { notify('Clipboard is unavailable. Open the note to copy its text.'); }
        }));
        const remove = button('Delete', 'clip-delete', async () => {
          if (draft?.noteId === note.id) { notify('Save or cancel this passage edit before deleting it'); return; }
          if (!await window.NotejectDialogs.confirm('Move this passage or comment to Trash? You can restore it later.')) return;
          const cards = [...list.querySelectorAll('[data-clip-id]')], position = cards.findIndex(item => item.dataset.clipId === note.id), focusId = cards[position + 1]?.dataset.clipId || cards[position - 1]?.dataset.clipId;
          if (app.deleteNote?.(note.id)) { renderList(); renderHighlights(); if (focusId) focusCard(focusId); else root.querySelector('.clip-list-tools input')?.focus({ preventScroll: true }); }
        });
        remove.setAttribute('aria-label', 'Delete passage or comment'); remove.title = 'Move this passage or comment to Trash'; actions.append(remove);
        card.append(actions); list.append(card);
      }
      const summary = make('small', 'clip-result-count', `${Math.min(limit, matches.length)} of ${matches.length} passage${matches.length === 1 ? '' : 's'}`); list.append(summary);
      if (matches.length > limit) list.append(button('Load more passages', 'secondary clip-more', () => { limit += 24; renderList(); }));
    }
    function clearHighlightObserver() {
      if (highlightObserver) highlightObserver.disconnect();
      highlightObserver = null; highlightRoot = null; clearTimeout(highlightTimer);
      if (typeof CSS !== 'undefined' && CSS.highlights) for (const color of Object.keys(model.colors)) CSS.highlights.delete('noteject-saved-' + color);
    }
    function renderHighlights() {
      if (!currentDoc() || typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
      const clips = all().map(note => model.normalize(note)).flatMap(clip=>{const parts=clip.location.pages||clip.location.chapters;return parts?.length?parts.map(part=>({...clip,quote:part.quote,location:{...clip.location,...part}})):[clip]}).filter(clip => clip.quote.trim() && model.colors[clip.color] && (!clip.location.sourceRevision || clip.location.sourceRevision === currentDoc().sourceRevision));
      if (!clips.length) { clearHighlightObserver(); return; }
      const groups = new Map();
      for (const color of Object.keys(model.colors)) groups.set(color, []);
      const reader = document.querySelector('.reader-content');
      if (!reader) return;
      if (highlightObserver && highlightRoot !== reader) clearHighlightObserver();
      // PDF passages carry their page. Walk only a mounted text layer that can
      // contain one, so hundreds of distant saved clips cost no glyph mapping.
      const roots = ['pdf','djvu'].includes(currentDoc().type) ? [...reader.querySelectorAll('.pdf-text-layer')].filter(layer => clips.some(clip => !clip.location.page || clip.location.page === Number(layer.dataset.readerPage))) : currentDoc().type==='epub'&&reader.querySelector('.epub-section') ? [...reader.querySelectorAll('.epub-section:not(.is-pending)')] : [reader.querySelector(currentDoc().type === 'epub' ? '#epub-text' : '#txt-content')].filter(Boolean);
      for (const textRoot of roots) {
      const page = Number(textRoot.dataset.readerPage), context = app.getContext() || {}, chapter = Number(textRoot.dataset.readerChapter);
      const relevant = ['pdf','djvu'].includes(currentDoc().type) ? clips.filter(clip => !clip.location.page || clip.location.page === page) : currentDoc().type === 'epub' ? clips.filter(clip => Number.isInteger(clip.location.chapterIndex) ? clip.location.chapterIndex === chapter : !clip.location.chapter || clip.location.chapter === context.chapter) : clips;
      if(!relevant.length)continue;
      const chars = [], positions = [];
      const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.parentElement?.closest('script,style,button,textarea,input,.reader-commandbar,.reader-selections') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
      let node, rawOffset = 0;
      while ((node = walker.nextNode())) {
        const raw = node.textContent || '';
        for (let index = 0; index < raw.length; index++, rawOffset++) {
          const value = /\s/.test(raw[index]) ? ' ' : raw[index], previous = positions.at(-1);
          if (value === ' ' && chars.at(-1) === ' ') { previous.endNode = node; previous.endOffset = index + 1; previous.rawEnd = rawOffset + 1; continue; }
          chars.push(value); positions.push({ startNode: node, startOffset: index, endNode: node, endOffset: index + 1, rawStart: rawOffset, rawEnd: rawOffset + 1 });
        }
      }
      const content = chars.join('');
      const textIndex = { text: content, starts: positions.map(position => position.rawStart), ends: positions.map(position => position.rawEnd) };
      for (const clip of relevant) {
        const quote = clip.quote.replace(/\s+/g, ' ').trim();
        if (!quote || !groups.has(clip.color)) continue;
        const match = model.findTextRange(textIndex, quote, clip.location);
        if (!match || !positions[match.index] || !positions[match.endIndex]) continue;
        const range = document.createRange(), first = positions[match.index], last = positions[match.endIndex];
        range.setStart(first.startNode, first.startOffset); range.setEnd(last.endNode, last.endOffset); groups.get(clip.color).push(range);
      }
      }
      for (const [color, ranges] of groups) { const key = 'noteject-saved-' + color; if (ranges.length) CSS.highlights.set(key, new Highlight(...ranges)); else CSS.highlights.delete(key); }
      if (!highlightObserver) {
        highlightObserver = new MutationObserver(records => {
          if (['pdf','djvu'].includes(currentDoc()?.type) && !records.some(record => {
            const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            return element?.closest('.pdf-text-layer') || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches('.pdf-text-layer') || node.querySelector('.pdf-text-layer')));
          })) return;
          clearTimeout(highlightTimer); highlightTimer = setTimeout(renderHighlights, 120);
        });
        highlightObserver.observe(reader, { childList: true, characterData: true, subtree: true });
        highlightRoot = reader;
      }
    }
    function mount(restoreComposer = true) {
      const nextRoot = document.querySelector('#reader-selections'), doc = currentDoc();
      if (!nextRoot || !doc || !['pdf', 'djvu', 'epub', 'txt'].includes(doc.type)) { persistDraft(); clearHighlightObserver(); root = null; return; }
      const nextContext = contextFor(doc);
      if (root === nextRoot && doc.id === docId && nextContext === sourceContext) { renderHighlights(); return; }
      clearHighlightObserver();
      if (doc.id !== docId || nextContext !== sourceContext) { persistDraft(); docId = doc.id; sourceContext = nextContext; candidate = null; draft = restoreDraft(docId); search = ''; favorites = false; limit = 24; }
      root = nextRoot; root.className = 'reader-clips'; root.replaceChildren();
      // Keep reader-level destructive shortcuts away from focused clip controls.
      root.addEventListener('keydown', event => { if (event.key === 'Delete' && !event.target.matches('input,textarea')) { event.preventDefault(); event.stopPropagation(); } });
      root.append(make('div', 'eyebrow', 'READING NOTES'));
      const heading = make('div', 'clip-heading'); heading.append(make('h3', '', 'Capture what matters')); root.append(heading, make('p', 'clip-intro', 'Keep passages, add your thoughts, and return to the source.'));
      saveButton = button('✎ Save current selection', 'primary clip-capture-button', capture); saveButton.title = 'Capture selected document text (Ctrl+Shift+S)';
      root.append(saveButton, make('small', 'clip-shortcut', 'Ctrl + Shift + S to capture'));
      const help=make('details','clip-edit-help');help.append(make('summary','','How to edit passages in Notes'),make('p','','Select text and choose Save passage. Choose a Notes folder, add your thoughts and an optional Board, then save. In Saved selections choose Edit in Notes. Edit the note, add text, links or images, and Save. Use Return to passage to resume reading; the original source location stays linked.'));root.append(help);
      const readerTools = make('div', 'reader-side-actions'); readerTools.append(button('＋ Add comment here', 'secondary', captureComment), button('☆ Bookmark this position', 'secondary', saveBookmark)); root.append(readerTools);
      const bookmarkSection = make('section', 'reader-bookmarks'); bookmarkSection.append(make('h3', '', 'Bookmarks')); bookmarks = make('div', 'reader-bookmark-list'); bookmarkSection.append(bookmarks); root.append(bookmarkSection); renderBookmarks();
      status = make('p', 'clip-status'); status.setAttribute('role', 'status'); root.append(status);
      composer = make('form', 'clip-composer'); composer.setAttribute('aria-label', 'Passage details'); composer.hidden = true; root.append(composer);
      const library = make('section', 'clip-library'); library.id = 'saved-passages'; library.setAttribute('aria-label', 'Saved selections');
      const libraryHeading = make('div', 'clip-heading'); count = make('span', 'clip-count'); libraryHeading.append(make('h3', '', 'Saved selections'), count); library.append(libraryHeading);
      const boardTools = make('div', 'clip-board-bulk'), boardPicker = make('select'); boardPicker.setAttribute('aria-label', 'Board for all saved passages');
      const availableBoards = app.getData().boards || [];
      for (const board of availableBoards) { const option = make('option', '', board.name); option.value = board.id; boardPicker.append(option); }
      const preferred = availableBoards.find(board => board.id === currentDoc()?.readerPassageBoardId) || availableBoards.find(board => board.id === app.getData().activeBoard) || availableBoards[0];
      if (preferred) boardPicker.value = preferred.id;
      boardPicker.disabled = !availableBoards.length;
      boardBulkButton = button('Add all saved passages to Board', 'secondary', () => {
        if (contextFor(currentDoc()) !== sourceContext) { notify('Reopen this document before adding its passages.'); return; }
        const result = model.addSelectionsToBoard(app.getData(), docId, boardPicker.value, app.makeId);
        if (!result.ok) { notify(result.error); return; }
        app.save(); notify(result.added ? result.added + ' passages added to ' + result.board.name : 'Saved passages are already on ' + result.board.name);
      });
      boardTools.append(boardPicker, boardBulkButton); library.append(boardTools);
      const tools = make('div', 'clip-list-tools'), filter = make('input'); filter.type = 'search'; filter.placeholder = 'Search passages, thoughts, tags…'; filter.setAttribute('aria-label', 'Search saved selections'); filter.value = search;
      filter.oninput = () => { search = filter.value; limit = 24; renderList(); };
      const order = make('select'); order.setAttribute('aria-label', 'Sort saved selections');
      for (const [value, label] of [['newest', 'Recently updated'], ['oldest', 'Oldest saved'], ['source', 'Document order']]) { const option = make('option', '', label); option.value = value; order.append(option); }
      order.value = sort; order.onchange = () => { sort = order.value; limit = 24; renderList(); }; tools.append(filter, order); library.append(tools);
      const favoriteLabel = make('label', 'clip-favorites-filter'), favorite = make('input'); favorite.type = 'checkbox'; favorite.checked = favorites;
      favorite.onchange = () => { favorites = favorite.checked; limit = 24; renderList(); }; favoriteLabel.append(favorite, document.createTextNode('Favorites only')); library.append(favoriteLabel);
      list = make('div', 'clip-list'); library.append(list); root.append(library); updateStatus(); renderList();
      if (draft && restoreComposer) showComposer(draft, draft.noteId, !androidDrafts);
      renderHighlights();
    }
    function showList() {
      mount(false);const doc=currentDoc();if(!doc)return;const context=sourceContext;
      if(draft){showComposer(draft,draft.noteId);notify('Save or cancel the open passage first');return;}
      app.closeTools?.();
      const passages=all().map(note=>({...model.normalize(note),locationLabel:model.locationLabel(note.selectionLocation),quote:model.normalize(note).quote.slice(0,16000),comment:model.normalize(note).comment.slice(0,16000)}));
      try {window.NotejectReaderSurfaces.saved({documentId:doc.id,bookmarks:bookmarkItems().map(mark=>({...mark,locationLabel:model.locationLabel(mark.location)})),passages},event=>{
        if(context!==sourceContext||contextFor(currentDoc())!==context)return;
        if(event.action==='close')return;
        const item=event.bookmark?bookmarkItems().find(mark=>mark.id===event.id):all().find(note=>note.id===event.id);if(!item){notify('This saved item is no longer available.');return;}
        if(event.action==='read'){if(event.bookmark)app.goToBookmark?.(item);else app.goToLocation(item);}
        if(event.action==='edit'&&!event.bookmark)app.editNote(item.id);
        if(event.action==='delete'){if(event.bookmark){doc.bookmarks=bookmarkItems().filter(mark=>mark.id!==item.id);app.save();renderBookmarks();notify('Bookmark deleted');}else{app.deleteNote?.(item.id);renderList();renderHighlights();}}
      });}catch(error){notify(error.message||'Saved Reader items could not open.');}
    }

    return {refreshHighlights:renderHighlights,clearSelection:()=>{candidate=null;window.getSelection()?.removeAllRanges();updateStatus();}, mount, capture, captureComment, showList, showBoardTools:()=>{app.openTools?.();root?.querySelector('.clip-board-bulk')?.scrollIntoView({block:'start'});root?.querySelector('.clip-board-bulk select')?.focus();},extendCurrentSelection:()=>{if(!draft)capture();if(draft?.quote)void extendPassage();}, hasDraft: () => !!draft && docId === currentDoc()?.id && contextFor(currentDoc()) === sourceContext, persistDraft };
  }
  window.NotejectReaderSelections = { create };
})();
