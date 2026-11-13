/* Offline equations and binary image attachments shared by every Note surface. */
(() => {
  'use strict';
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']);
  const drafts = new Map(), urls = new Map(), loading = new WeakSet();
  const boardFigures = new Set(), boardQueue = [];
  let boardLoads = 0;
  const boardObserver = window.IntersectionObserver ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const figure = entry.target;
      figure.dataset.boardVisible = String(entry.isIntersecting);
      if (entry.isIntersecting) queueBoardImage(figure);
      else {
        delete figure.dataset.loaded;
        figure.querySelector('img')?.removeAttribute('src');
        const status = figure.querySelector('.note-image-status'); if (status) status.hidden = false;
        const id=figure.dataset.noteImage;
        if(![...boardFigures].some(other=>other!==figure && other.isConnected && other.dataset.noteImage===id && other.dataset.boardVisible==='true')) {
          const record=urls.get('board:'+id);if(record){URL.revokeObjectURL(record.url);urls.delete('board:'+id);}
        }
      }
    }
  }, {rootMargin:'160px'}) : null;
  let workspaceRef, scanQueued = false;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  const imagePattern = () => /!\[([^\]\n]*)\]\(noteject-image:([a-zA-Z0-9_-]{1,100})\)/g;
  const imageIds = source => [...String(source || '').matchAll(imagePattern())].map(match => match[2]);
  function previewText(source) {
    return window.NotejectNoteLinks.preview(source).replace(imagePattern(),(_,caption)=>caption||'Image')
      .replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([^\n]+?\\\)|\$[^$\n]+?\$/g,'Equation')
      .replace(/\\([\\`*$#>\-])/g,'$1').replace(/[#>*_`]/g,'');
  }
  function notesIn(workspace) {
    return [...(workspace?.notes || []), ...(workspace?.trash || []).filter(entry => entry?.type === 'note').map(entry => entry.payload?.item).filter(Boolean)];
  }
  function assetsForWorkspace(workspace) { return notesIn(workspace).flatMap(note => Array.isArray(note.mediaAssets) ? note.mediaAssets : []); }
  function generation() { return data.attachmentImportId || JSON.stringify(data.folderProjects || {}); }
  function draftKey(note) { return 'noteject-note-media-v1:' + note.id; }
  function checkWorkspace() {
    if (workspaceRef === data) return;
    workspaceRef = data; drafts.clear();
    for (const record of urls.values()) URL.revokeObjectURL(record.url);
    urls.clear();
  }
  function editorAssets(note) {
    checkWorkspace();
    if (!drafts.has(note.id)) {
      let pending;
      try { pending = JSON.parse(localStorage.getItem(draftKey(note)) || 'null'); } catch {}
      const assets = new Map((note.mediaAssets || []).map(asset => [asset.id, asset]));
      if (pending?.generation === generation() && pending.baseUpdated === note.updated && Array.isArray(pending.assets)) {
        for (const asset of pending.assets) if (asset?.type === 'image' && typeof asset.id === 'string') assets.set(asset.id, asset);
      }
      drafts.set(note.id, assets);
    }
    return drafts.get(note.id);
  }
  function rememberAssets(note, assets) {
    // Metadata only: the image bytes live in project files / IndexedDB.
    localStorage.setItem(draftKey(note), JSON.stringify({ generation: generation(), baseUpdated: note.updated, assets: [...assets.values()] }, (key, value) => key === 'blob' || key === 'localUrl' ? undefined : value));
    drafts.set(note.id, assets);
  }
  function prepareCommit(note, source) {
    const assets = editorAssets(note), wanted = [...new Set(imageIds(source))];
    if (wanted.some(id => !assets.has(id))) throw Error('An image attachment is missing. Reinsert the image before saving this note.');
    note.mediaAssets = wanted.map(id => ({ ...assets.get(id) }));
  }
  function didSave(note) {
    try { localStorage.removeItem(draftKey(note)); } catch {}
    // Keep the session's full set until the editor closes, so Undo can restore an image.
  }
  function findAsset(id) {
    checkWorkspace();
    for (const assets of drafts.values()) if (assets.has(id)) return assets.get(id);
    return assetsForWorkspace(data).find(asset => asset?.id === id);
  }
  async function readImage(id) {
    const asset = findAsset(id);
    if (!asset) throw Error('This image attachment is unavailable.');
    const blob = await getDocumentBlob(asset);
    if (!(blob instanceof Blob) || !blob.size) throw Error('The image file could not be loaded.');
    return { asset, blob };
  }
  async function saveImageFile(blob, name) {
    if (!(blob instanceof Blob) || !blob.size) throw Error('The image file is unavailable.');
    if (window.NotejectAndroidFiles?.save) return window.NotejectAndroidFiles.save(blob, name);
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = String(name || 'note-image.png'); document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { status: 'saved', message: 'Image sent to your browser or desktop download location.' };
  }
  async function exportImage(id) {
    const { asset, blob } = await readImage(id);
    return saveImageFile(blob, asset.name || 'note-image.png');
  }
  function editImageFromReadView(figure, action) {
    const assetId = figure.dataset.noteImage;
    const selected = data.selected?.type === 'note' && data.notes.find(note => note.id === data.selected.id && imageIds(note.content).includes(assetId));
    const note = selected || data.notes.find(note => imageIds(note.content).includes(assetId));
    if (!note) { notify('Open the note containing this image first.'); return; }
    document.querySelector('#reader-note-overlay')?.remove();
    if (window.NotejectAndroidNotesUI) { if (!window.NotejectAndroidNotesUI.editNote(note.id)) return; }
    else if (window.NotejectWindows) { if (!window.NotejectWindows.editNote(note.id)) return; }
    else { view = 'notes'; data.selected = { type:'note', id:note.id }; render(); edit(note); }
    const area = document.getElementById('edit-body');
    if (!area || !window.NotejectVisualEditor.imageAction(area, assetId, action)) notify('Tap the image in the note editor to continue.');
  }
  function showReadImageActions(figure) {
    const id = figure.dataset.noteImage, asset = findAsset(id);
    if (!asset || document.querySelector('.note-image-actions[open]')) return;
    const dialog = document.createElement('dialog'); dialog.className = 'ux-dialog note-image-actions'; dialog.setAttribute('aria-label', 'Image options');
    const title = document.createElement('h2'); title.textContent = 'Image';
    const actions = document.createElement('div'); actions.className = 'note-atom-actions';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const add = (label, run) => { const button = document.createElement('button'); button.type='button'; button.textContent=label; button.onclick=run; actions.append(button); return button; };
    add('Write notes below', () => { dialog.close(); editImageFromReadView(figure, 'write'); });
    add('Edit caption', () => { dialog.close(); editImageFromReadView(figure, 'caption'); });
    const save = add('Save to disk', async () => {
      save.disabled=true; status.textContent='Preparing image…';
      try { const result=await exportImage(id); status.textContent=result.message || (result.status==='saved'?'Image saved':'Save cancelled'); }
      catch(error) { status.textContent=error.message || 'Could not save the image.'; }
      finally { save.disabled=false; }
    });
    add('Close', () => dialog.close());
    dialog.append(title, actions, status); dialog.addEventListener('close', () => dialog.remove(), {once:true}); document.body.append(dialog); dialog.showModal();
  }
  function syncAssetBindings(workspace, files) {
    const bindings = new Map(files.map(asset => [asset.id, asset]));
    for (const asset of assetsForWorkspace(workspace)) {
      const stored = bindings.get(asset.id);
      if (stored && stored !== asset) Object.assign(asset, stored);
    }
  }
  async function releaseNoteImages(note, trashId) {
    const otherNotes = [...(data.notes || []), ...(data.trash || []).filter(entry => entry.id !== trashId && entry.type === 'note').map(entry => entry.payload?.item).filter(Boolean)];
    const shared = new Set(otherNotes.flatMap(item => (item.mediaAssets || []).map(asset => asset.id)));
    for (const [noteId, assets] of drafts) if (noteId !== note.id) for (const id of assets.keys()) shared.add(id);
    // Other recoverable drafts may not have been opened during this session.
    for (const other of otherNotes) {
      try {
        const pending = JSON.parse(localStorage.getItem(draftKey(other)) || 'null');
        if (pending?.generation === generation()) for (const asset of pending.assets || []) shared.add(asset.id);
      } catch {}
    }
    const owned = new Map((note.mediaAssets || []).map(asset => [asset.id, asset]));
    try {
      const pending = JSON.parse(localStorage.getItem(draftKey(note)) || 'null');
      if (pending?.generation === generation()) for (const asset of pending.assets || []) owned.set(asset.id, asset);
    } catch {}
    for (const asset of owned.values()) {
      if (shared.has(asset.id)) continue;
      // Android's attachment store also protects the previous recovery generation.
      await removeDiskFile(asset);
      if (!window.NotejectAndroid) await removeStoredFile(asset.id);
    }
    try { localStorage.removeItem(draftKey(note)); } catch {}
    drafts.delete(note.id);
  }
  function addReaderCaptureToBoard(note, source, options, assetId) {
    if (!options.addToBoard) { if (Object.hasOwn(options,'addToBoard')) source.readerCaptureBoardId=''; return null; }
    const board = data.boards.find(item => item.id === options.boardId);
    if (!board) { notify('Capture saved in Notes. The selected Board is no longer available.'); return null; }
    board.items ||= []; board.edges ||= [];
    let card = board.items.find(item => item.type === 'note' && item.id === note.id);
    if (!card) {
      card = { type:'note', id:note.id, ...boardAssetPosition(board,boardAssetOrigin(board),0) };
      board.items.push(card);
    }
    card.captureAssetId = assetId;
    if (board.items.some(item => item.type === 'doc' && item.id === source.id) && !board.edges.some(edge => (edge.from === source.id && edge.to === note.id) || (edge.to === source.id && edge.from === note.id))) {
      board.edges.push({ id:crypto.randomUUID(), from:source.id, to:note.id, label:'captured from' });
    }
    source.readerCaptureBoardId = board.id;
    return board;
  }
  function boardPreview(note, card) {
    const references = new Set(imageIds(note.content));
    const assets = (note.mediaAssets || []).filter(asset => references.has(asset.id));
    const asset = assets.find(asset => asset.id === card?.captureAssetId) || assets[0];
    if (!asset) return '';
    return '<figure class="note-image board-note-media" data-note-image="'+escape(asset.id)+'"><img alt="'+escape(asset.readerSource ? 'Capture from '+asset.readerSource.name : note.title || 'Note image')+'" decoding="async" hidden draggable="false"><span class="note-image-status">Image</span></figure>';
  }
  async function saveReaderImage(blob, source, options) {
    const snapshot = data;
    const assetId = options.assetId || 'note-image-' + crypto.randomUUID();
    let note = options.append && data.notes.find(item => item.id === options.noteId);
    if (!note) note = data.notes.find(item => item.id === options.noteId);
    let noteId = options.noteId;
    if (options.append && !note) {
      noteId = 'reader-note-' + assetId.replace(/^note-image-/,'');
      note = data.notes.find(item => item.id === noteId);
      if (!note) notify('The destination note was removed. This capture is being saved as a new note.');
    }
    if (note?.mediaAssets?.some(asset => asset.id === assetId)) { addReaderCaptureToBoard(note,source,options,assetId); return note; }
    const folder = note?.folder || source.folder || 'Inbox';
    const destination = await ensureProjectFolder(folder);
    if (data !== snapshot) throw Error('The workspace changed. The capture will be restored when you return.');
    const location=options.location||{},suffix=location.page?'page-'+location.page:Number.isFinite(location.chapterIndex)?'chapter-'+(location.chapterIndex+1):'text';
    const asset = { id:assetId, type:'image', name:(options.kind === 'equation' ? 'equation' : 'image') + '-' + suffix + '.png', mime:'image/png', size:blob.size, folder:destination.folder, diskProject:destination.project,
      readerSource:{documentId:source.id,name:source.name,location:options.location} };
    const stored = await saveDiskFile(blob,asset); asset.diskName = stored.name || asset.name;
    if (data !== snapshot) throw Error('The workspace changed. The capture has been kept for retry.');
    if (!note) {
      note = { id:noteId || crypto.randomUUID(), title:options.title || 'Page capture', content:'', color:'violet', tags:[], folder:destination.folder, created:Date.now(), updated:Date.now(), sourceId:source.id, sourceName:source.name, selectionLocation:options.location };
      data.notes.unshift(note);
    }
    note.mediaAssets ||= []; note.mediaAssets.push(asset);
    const caption = String(options.title || 'Page capture').replace(/[\[\]\\\r\n]/g,' ').slice(0,160);
    const addition = '![' + caption + '](noteject-image:' + assetId + ')';
    note.content = (note.content ? note.content.replace(/\s+$/,'') + '\n\n' : '') + addition;
    note.updated = Date.now();
    if (drafts.has(note.id)) drafts.get(note.id).set(assetId,asset);
    const area = document.getElementById('edit-body');
    if (area && data.selected?.id === note.id) { area.value += '\n\n' + addition; area.dispatchEvent(new Event('input',{bubbles:true})); }
    addReaderCaptureToBoard(note,source,options,assetId);
    return note;
  }
  async function importReaderCapture(event, source) {
    if (!/^[a-f0-9-]{36}$/.test(event.captureId || '') || typeof event.noteId !== 'string') throw Error('Invalid Reader page capture.');
    const existing = data.notes.find(note => note.id === event.noteId);
    if (existing?.mediaAssets?.some(asset => asset.id === 'note-image-' + event.captureId)) { addReaderCaptureToBoard(existing,source,event,'note-image-' + event.captureId); return existing; }
    const snapshot = data;
    const blob = await window.NotejectNativeReader.readCapture(event.captureId);
    if (data !== snapshot || !data.docs.includes(source)) throw Error('The workspace changed; the Reader capture has been kept for retry.');
    if (event.sourceRevision && source.sourceRevision && event.sourceRevision !== source.sourceRevision) throw Error('The document changed; the Reader capture will be checked again when you return.');
    return saveReaderImage(blob,source,{...event,assetId:'note-image-' + event.captureId});
  }
  const captureStyleProperties = ('display position top right bottom left float clear box-sizing width height min-width min-height max-width max-height margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color border-radius background-color color opacity visibility overflow overflow-x overflow-y overflow-wrap word-break white-space text-align text-indent text-transform text-decoration-line text-decoration-color text-decoration-style text-decoration-thickness font-family font-size font-style font-weight font-stretch font-variant line-height letter-spacing word-spacing direction vertical-align list-style-type list-style-position table-layout border-collapse border-spacing object-fit object-position flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content gap row-gap column-gap grid-template-columns grid-template-rows column-count column-gap column-rule transform transform-origin z-index').split(' ');
  function copyCaptureStyles(source, target) {
    const computed=getComputedStyle(source);
    for(const property of captureStyleProperties){const value=computed.getPropertyValue(property);if(value)target.style.setProperty(property,value);}
  }
  function captureIntersects(rect,bounds) { return rect.width>0&&rect.height>0&&rect.right>bounds.left&&rect.left<bounds.right&&rect.bottom>bounds.top&&rect.top<bounds.bottom; }
  function dataUrl(blob) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error||Error('Could not read an image in this chapter.'));reader.readAsDataURL(blob);}); }
  async function captureImageSource(image) {
    const url=image.currentSrc||image.src;if(!url)return '';
    if(url.startsWith('data:'))return url;
    try{const response=await fetch(url);if(!response.ok)return '';const blob=await response.blob();if(blob.size>12*1024*1024)return '';return await dataUrl(blob);}catch{return '';}
  }
  async function cloneCaptureNode(source,bounds,zoom,depth=0) {
    if(source.nodeType===Node.TEXT_NODE)return document.createTextNode(source.data);
    if(source.nodeType!==Node.ELEMENT_NODE||depth>36)return null;
    const computed=getComputedStyle(source);if(computed.display==='none'||computed.visibility==='collapse')return null;
    const rect=source.getBoundingClientRect(),visible=captureIntersects(rect,bounds),clone=source.cloneNode(false);copyCaptureStyles(source,clone);
    if(source.tagName==='IMG'){
      clone.removeAttribute('srcset');clone.removeAttribute('sizes');
      if(visible){const embedded=await captureImageSource(source);if(embedded)clone.setAttribute('src',embedded);else clone.removeAttribute('src');}
      else{clone.removeAttribute('src');clone.style.setProperty('width',Math.max(0,rect.width/zoom)+'px');clone.style.setProperty('height',Math.max(0,rect.height/zoom)+'px');clone.style.setProperty('visibility','hidden');}
      return clone;
    }
    if(!visible&&depth>0&&!computed.display.startsWith('inline')){clone.replaceChildren();clone.style.setProperty('width',Math.max(0,rect.width/zoom)+'px');clone.style.setProperty('height',Math.max(0,rect.height/zoom)+'px');clone.style.setProperty('box-sizing','border-box');clone.style.setProperty('visibility','hidden');return clone;}
    for(const child of source.childNodes){const copy=await cloneCaptureNode(child,bounds,zoom,depth+1);if(copy)clone.append(copy);}
    return clone;
  }
  function rangeRectAt(range,node,index,length) {
    for(let offset=Math.max(0,index);offset<Math.min(length,index+12);offset++){range.setStart(node,offset);range.setEnd(node,Math.min(length,offset+1));const rect=range.getBoundingClientRect();if(rect.height>0)return rect;}
    for(let offset=Math.min(length-1,index-1);offset>=Math.max(0,index-12);offset--){range.setStart(node,offset);range.setEnd(node,offset+1);const rect=range.getBoundingClientRect();if(rect.height>0)return rect;}
    return null;
  }
  function visibleTextWindow(node,bounds) {
    const text=node.data,length=text.length;if(!length)return null;const range=document.createRange();
    const firstAt=(y,byBottom)=>{let low=0,high=length;while(low<high){const mid=(low+high)>>1,rect=rangeRectAt(range,node,mid,length);if(!rect){low=mid+1;continue}const before=byBottom?rect.bottom<=y:rect.top<y;if(before)low=mid+1;else high=mid;}return Math.min(length,low);};
    const first=firstAt(bounds.top,true);if(first>=length)return null;const firstRect=rangeRectAt(range,node,first,length);if(!firstRect)return null;
    const start=firstAt(firstRect.top-.5,false),end=firstAt(bounds.bottom,false);if(end<=start)return null;
    return {text:text.slice(start,end),rect:rangeRectAt(range,node,start,length)};
  }
  async function textReaderCapture(source) {
    const shell=document.querySelector('.reader-shell[data-reader-type="'+source.type+'"]'),viewport=shell?.querySelector('.reader-content');
    const page=source.type==='epub'?viewport?.querySelector('#epub-text'):viewport?.querySelector('#txt-content');
    if(!shell||!viewport||!page)throw Error('Wait for the text page to finish opening, then try again.');
    if(source.type==='txt'&&page.dataset.readerDocument!==source.id)throw Error('Wait for the text page to finish opening, then try again.');
    const width=Math.ceil(viewport.clientWidth),height=Math.ceil(viewport.clientHeight);
    if(width<80||height<80)throw Error('The Reader page is too small to capture.');
    const bounds=viewport.getBoundingClientRect(),pageRect=page.getBoundingClientRect(),pageStyle=getComputedStyle(page),zoom=Math.max(.5,Math.min(3,Number(pageStyle.zoom)||1));
    const pageColor=pageStyle.backgroundColor&&pageStyle.backgroundColor!=='rgba(0, 0, 0, 0)'?pageStyle.backgroundColor:getComputedStyle(viewport).backgroundColor;
    const root=document.createElement('div');root.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
    Object.assign(root.style,{position:'relative',width:width+'px',height:height+'px',overflow:'hidden',backgroundColor:pageColor,color:pageStyle.color,fontFamily:pageStyle.fontFamily,fontSize:pageStyle.fontSize,lineHeight:pageStyle.lineHeight});
    let location,label;
    if(source.type==='epub'){
      const sections=[...page.querySelectorAll('.epub-section:not(.is-pending)')].filter(section=>captureIntersects(section.getBoundingClientRect(),bounds));
      if(!sections.length)throw Error('The visible chapter is still loading. Try again in a moment.');
      for(const section of sections){
        const sectionStyle=getComputedStyle(section),sectionRect=section.getBoundingClientRect();
        for(const child of section.children){
          if(['SCRIPT','STYLE','LINK'].includes(child.tagName))continue;
          const rect=child.getBoundingClientRect();if(!captureIntersects(rect,bounds))continue;
          const wrapper=document.createElement('div');Object.assign(wrapper.style,{position:'absolute',left:(rect.left-bounds.left)+'px',top:(rect.top-bounds.top)+'px',width:(rect.width/zoom)+'px',transform:'scale('+zoom+')',transformOrigin:'top left',overflow:'visible',color:sectionStyle.color,fontFamily:sectionStyle.fontFamily,fontSize:sectionStyle.fontSize,lineHeight:sectionStyle.lineHeight,direction:sectionStyle.direction});
          const copy=await cloneCaptureNode(child,bounds,zoom);if(!copy)continue;
          copy.style.setProperty('position','relative');copy.style.setProperty('display',getComputedStyle(child).display==='inline'?'block':getComputedStyle(child).display);copy.style.setProperty('left','auto');copy.style.setProperty('top','auto');copy.style.setProperty('right','auto');copy.style.setProperty('bottom','auto');copy.style.setProperty('width','100%');copy.style.setProperty('height','auto');copy.style.setProperty('margin','0');copy.style.setProperty('box-sizing','border-box');
          wrapper.append(copy);root.append(wrapper);
        }
      }
      const currentSection=sections.find(section=>section.getBoundingClientRect().bottom>bounds.top+Math.min(48,bounds.height/5))||sections[0],chapterIndex=Number(currentSection.dataset.readerChapter)||0,scroll=Math.max(0,Math.min(1,(bounds.top-currentSection.getBoundingClientRect().top)/Math.max(1,currentSection.getBoundingClientRect().height-Math.min(bounds.height,currentSection.getBoundingClientRect().height/2))));
      location={type:'epub',chapterIndex,chapter:currentSection.dataset.readerChapterTitle||'Chapter '+(chapterIndex+1),scroll,sourceRevision:source.sourceRevision};label='chapter '+(chapterIndex+1);
    }else{
      const textNode=[...page.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.data.length);
      if(!textNode)throw Error('There is no visible text to capture.');
      const windowText=visibleTextWindow(textNode,bounds);if(!windowText?.text)throw Error('There is no visible text to capture.');
      const copy=page.cloneNode(false);copy.textContent=windowText.text;copyCaptureStyles(page,copy);
      const paddingTop=(parseFloat(pageStyle.paddingTop)||0)+(parseFloat(pageStyle.borderTopWidth)||0),left=pageRect.left-bounds.left,top=windowText.rect.top-bounds.top-paddingTop*zoom;
      Object.assign(copy.style,{position:'relative',display:'block',left:'auto',top:'auto',width:'100%',height:'auto',margin:'0',boxSizing:'border-box'});
      const wrapper=document.createElement('div');Object.assign(wrapper.style,{position:'absolute',left:left+'px',top:top+'px',width:(pageRect.width/zoom)+'px',transform:'scale('+zoom+')',transformOrigin:'top left',overflow:'visible'});wrapper.append(copy);root.append(wrapper);
      const scroll=Math.max(0,Math.min(1,viewport.scrollTop/Math.max(1,viewport.scrollHeight-viewport.clientHeight)));location={type:'txt',scroll,sourceRevision:source.sourceRevision};label=Math.round(scroll*100)+'% through text';
    }
    const scale=Math.min(2,Math.sqrt(16000000/(width*height))),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    const markup=new XMLSerializer().serializeToString(root),svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'"><foreignObject x="0" y="0" width="100%" height="100%">'+markup+'</foreignObject></svg>',url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('This Reader could not render the text capture. Try another visible page.'));image.src=url;});const context=canvas.getContext('2d');if(!context)throw Error('Image capture is unavailable on this device.');context.fillStyle=pageColor||'#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);}finally{URL.revokeObjectURL(url);}
    return {canvas,location,label};
  }
  async function captureReaderPage(kind) {
    const source=data.docs.find(item=>item.id===data.selected?.id),snapshot=data;
    if(!source||!['pdf','djvu','epub','txt'].includes(source.type)){notify('Open a PDF, DjVu, EPUB, or text document first.');return;}
    try {
      notify('Preparing page capture…');
      let canvas,location,label;
      if(['pdf','djvu'].includes(source.type)){
        if(!pdfReader)throw Error('The document page is still opening. Try again in a moment.');
        const pageCapture=await pdfReader.captureCurrentPage();canvas=pageCapture.canvas;location={type:source.type,page:pageCapture.page,sourceRevision:source.sourceRevision};label='page '+pageCapture.page;
      }else({canvas,location,label}=await textReaderCapture(source));
      if(data!==snapshot||data.selected?.id!==source.id)return;
      const page=location.page||location.chapterIndex+1||1;
      const dialog=document.createElement('dialog');dialog.className='ux-dialog reader-capture-dialog';dialog.setAttribute('aria-labelledby','reader-capture-title');
      dialog.innerHTML='<h2 id="reader-capture-title">Save '+(kind==='equation'?'equation':'image')+'</h2><p>Drag around the area to save its original appearance. Use the area fields for precise selection.</p><div class="reader-capture-preview"><div class="reader-capture-area"></div></div><div class="reader-capture-fields"></div><label>Caption<input class="reader-capture-caption"></label><label>Destination note<select class="reader-capture-target"></select></label><p class="reader-capture-status" role="status"></p><footer><button type="button" class="secondary" data-cancel>Cancel</button><button type="button" class="primary" data-save>Save to Notes</button></footer>';
      const preview=dialog.querySelector('.reader-capture-preview'),box=dialog.querySelector('.reader-capture-area'),status=dialog.querySelector('.reader-capture-status');preview.prepend(canvas);
      const region={left:8,top:25,width:84,height:30},fields={};
      const update=()=>{region.left=Math.min(99,Math.max(0,region.left));region.top=Math.min(99,Math.max(0,region.top));region.width=Math.min(100-region.left,Math.max(1,region.width));region.height=Math.min(100-region.top,Math.max(1,region.height));Object.assign(box.style,{left:region.left+'%',top:region.top+'%',width:region.width+'%',height:region.height+'%'});for(const [key,field]of Object.entries(fields))field.value=Math.round(region[key]*10)/10;};
      for(const [key,fieldLabel]of [['left','Left %'],['top','Top %'],['width','Width %'],['height','Height %']]){
        const wrapper=document.createElement('label');wrapper.textContent=fieldLabel;const input=document.createElement('input');input.type='number';input.min='0';input.max='100';input.step='0.1';input.onchange=()=>{region[key]=Number(input.value)||0;update();};wrapper.append(input);dialog.querySelector('.reader-capture-fields').append(wrapper);fields[key]=input;
      }
      let start=null;
      preview.onpointerdown=event=>{event.preventDefault();const rect=preview.getBoundingClientRect();start={x:Math.max(0,Math.min(100,(event.clientX-rect.left)/rect.width*100)),y:Math.max(0,Math.min(100,(event.clientY-rect.top)/rect.height*100))};preview.setPointerCapture(event.pointerId);};
      preview.onpointermove=event=>{if(!start)return;const rect=preview.getBoundingClientRect(),x=Math.max(0,Math.min(100,(event.clientX-rect.left)/rect.width*100)),y=Math.max(0,Math.min(100,(event.clientY-rect.top)/rect.height*100));Object.assign(region,{left:Math.min(start.x,x),top:Math.min(start.y,y),width:Math.abs(x-start.x),height:Math.abs(y-start.y)});update();};
      preview.onpointerup=()=>{start=null;};preview.onpointercancel=()=>{start=null;};update();
      const caption=dialog.querySelector('.reader-capture-caption');caption.value=(kind==='equation'?'Equation':'Image')+' · '+label;
      const target=dialog.querySelector('.reader-capture-target');target.add(new Option('Create new note',''));
      for(const note of data.notes.filter(note=>!note.archived))target.add(new Option(note.title||'Untitled note',note.id));
      const boardLabel=document.createElement('label');boardLabel.textContent='Also add to Board';
      const boardPicker=document.createElement('select');boardPicker.setAttribute('aria-label','Board for this capture');boardPicker.add(new Option('Notes only',''));
      for(const board of data.boards)boardPicker.add(new Option(board.name,board.id));
      boardPicker.value=data.boards.some(board=>board.id===source.readerCaptureBoardId)?source.readerCaptureBoardId:'';
      boardLabel.append(boardPicker);target.closest('label').after(boardLabel);
      const saveButton=dialog.querySelector('[data-save]');const updateSaveLabel=()=>{saveButton.textContent=boardPicker.value?'Save to Notes & Board':'Save to Notes';};boardPicker.onchange=updateSaveLabel;updateSaveLabel();
      dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
      let attempt=null;
      dialog.querySelector('[data-save]').onclick=async()=>{
        const button=dialog.querySelector('[data-save]');button.disabled=true;
        try{
          if(data!==snapshot)throw Error('The workspace changed. Open the capture again.');
          const output=document.createElement('canvas');output.width=Math.max(1,Math.floor(canvas.width*region.width/100));output.height=Math.max(1,Math.floor(canvas.height*region.height/100));
          output.getContext('2d').drawImage(canvas,canvas.width*region.left/100,canvas.height*region.top/100,output.width,output.height,0,0,output.width,output.height);
          const blob=await new Promise(resolve=>output.toBlob(resolve,'image/png'));if(!blob)throw Error('Could not encode this capture.');
          attempt ||= {kind,title:caption.value,noteId:target.value||crypto.randomUUID(),assetId:'note-image-'+crypto.randomUUID(),append:!!target.value,addToBoard:!!boardPicker.value,boardId:boardPicker.value,location:{...location,region:[region.left/100,region.top/100,(region.left+region.width)/100,(region.top+region.height)/100]}};
          const note=await saveReaderImage(blob,source,attempt);
          save();if(!workspaceStore.flush())throw Error('The capture could not be saved. Free storage and try again.');await persistWorkspaceNote(note);
          dialog.close();notify('Saved in Notes'+(attempt.addToBoard && data.boards.some(board=>board.id===attempt.boardId)?' and Board':'')+': '+note.title);
        }catch(error){status.textContent=error.message;button.disabled=false;}
      };
      dialog.addEventListener('close',()=>{canvas.width=1;canvas.height=1;dialog.remove();},{once:true});document.body.append(dialog);dialog.showModal();
    }catch(error){notify(error.message||'Could not capture this page.');}
  }
  const mathOptions = displayMode => ({ displayMode, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20, output: 'htmlAndMathml' });
  function equationHtml(source, display) {
    if (!window.katex) throw Error('The offline equation engine is unavailable. Reopen noteject.');
    if (source.length > 4000) throw Error('Use at most 4,000 characters in one equation.');
    return window.katex.renderToString(source, mathOptions(display));
  }
  function renderMarkdown(source, renderText) {
    const links = window.NotejectNoteLinks.protect(source);
    source = links.source;
    let count = 0;
    const pieces = [], nonce = '\uE000' + crypto.randomUUID().replaceAll('-', '') + ':';
    const token = html => { const key = nonce + pieces.length + '\uE001'; pieces.push(html); return key; };
    // Protect code and math before Markdown formatting can interpret TeX underscores / stars.
    const pattern = /```[^\n]*\n[\s\S]*?```|`[^`\n]+`|!\[([^\]\n]*)\]\(noteject-image:([a-zA-Z0-9_-]{1,100})\)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|\$(?=\S)((?:[^$\n\\]|\\.)*?\S|[^\s$])\$|\\([\\`*$#>\-])/g;
    const protectedSource = String(source || '').replace(pattern, (whole, alt, imageId, dollars, brackets, inline, single, literal, offset, original) => {
      if (literal !== undefined) return token(escape(literal));
      if (whole.startsWith('```')) return token('<pre class="note-code"><code>' + escape(whole.slice(whole.indexOf('\n') + 1, -3).replace(/\n$/, '')) + '</code></pre>');
      if (whole.startsWith('`')) return token('<code>' + escape(whole.slice(1, -1)) + '</code>');
      if (imageId) return token('<figure class="note-image" data-note-source="' + escape(whole) + '" data-note-image="' + imageId + '"><img alt="' + escape(alt || 'Note image') + '" decoding="async" loading="lazy" hidden><span class="note-image-status" role="status">Loading image…</span>' + (alt ? '<figcaption>' + escape(alt) + '</figcaption>' : '') + '</figure>');
      if (offset > 0 && original[offset - 1] === '\\') return whole;
      if (++count > 200) return whole;
      const tex = dollars ?? brackets ?? inline ?? single, display = dollars !== undefined || brackets !== undefined;
      try { return token('<span data-note-source="' + escape(whole) + '" class="note-equation' + (display ? ' note-equation-block' : '') + '" title="' + escape(tex) + '">' + equationHtml(tex, display) + '</span>'); }
      catch { return token('<span data-note-source="' + escape(whole) + '" class="note-equation-error" title="Edit this equation to correct its LaTeX syntax">Equation unavailable — edit to correct</span>'); }
    });
    const rendered = renderText(protectedSource);
    const start = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return links.restore(rendered.replace(new RegExp(start + '(\\d+)\uE001', 'g'), (_, index) => pieces[Number(index)] || ''));
  }
  async function hydrate(figure) {
    if (loading.has(figure) || figure.dataset.loaded === 'true') return;
    const board = figure.classList.contains('board-note-media');
    if (board && (figure.dataset.boardVisible !== 'true' || figure.getBoundingClientRect().width < 24)) return;
    loading.add(figure);
    const snapshot = data, asset = findAsset(figure.dataset.noteImage), img = figure.querySelector('img'), status = figure.querySelector('.note-image-status');
    const cacheKey = (board ? 'board:' : '') + figure.dataset.noteImage;
    try {
      if (!asset) throw Error('Image unavailable. Edit the note to reinsert it.');
      let record = urls.get(cacheKey);
      if (!record) {
        let blob = await getDocumentBlob(asset);
        if (data !== snapshot || !figure.isConnected) return;
        if (!blob || !IMAGE_TYPES.has(blob.type || asset.mime)) throw Error('Image unavailable. Restore its ZIP backup or reinsert it.');
        if (board) {
          if (figure.dataset.boardVisible !== 'true' || figure.getBoundingClientRect().width < 24) return;
          const bitmap = await createImageBitmap(blob);
          try {
            const rect=figure.getBoundingClientRect(),edge=Math.min(512,Math.max(96,Math.ceil(Math.max(rect.width,rect.height)*Math.min(2,devicePixelRatio||1))));
            const scale=Math.min(1,edge/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
            canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
            canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
            blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.9));
            if(!blob)throw Error('Preview unavailable. Open the note to view the image.');
          } finally { bitmap.close(); }
          if (data !== snapshot || !figure.isConnected || figure.dataset.boardVisible !== 'true') return;
        }
        record = urls.get(cacheKey);
        if (!record) { record = { url: URL.createObjectURL(blob) }; urls.set(cacheKey, record); }
      }
      if (data !== snapshot || !figure.isConnected) return;
      img.onload = () => { if(board && figure.dataset.boardVisible!=='true')return; status.hidden = true; img.hidden = false; figure.dataset.loaded = 'true'; };
      img.onerror = () => { status.textContent = 'This image could not be decoded. Edit the note to replace it.'; };
      img.src = record.url;
      // Hidden lazy images have no layout box, so reveal the element while decoding.
      img.hidden = false;
    } catch (error) { if (figure.isConnected) status.textContent = error.message || 'Image unavailable'; }
    finally { loading.delete(figure); }
  }
  function queueBoardImage(figure) {
    if (!figure.isConnected || figure.dataset.loaded === 'true' || figure.getBoundingClientRect().width < 24 || loading.has(figure) || boardQueue.includes(figure)) return;
    boardQueue.push(figure); pumpBoardImages();
  }
  function pumpBoardImages() {
    while (boardLoads < 2 && boardQueue.length) {
      const figure=boardQueue.shift();
      if(!figure.isConnected || figure.dataset.boardVisible!=='true')continue;
      boardLoads++;
      hydrate(figure).finally(()=>{boardLoads--;pumpBoardImages();});
    }
  }
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      for(const figure of boardFigures)if(!figure.isConnected){boardObserver?.unobserve(figure);boardFigures.delete(figure);}
      document.querySelectorAll('.note-image:not([data-loaded="true"])').forEach(figure=>{
        if(!figure.classList.contains('board-note-media')){
          if(!figure.closest('.note-visual-editor')){figure.tabIndex=0;figure.setAttribute('role','button');figure.setAttribute('aria-label','Image options: save to disk, write notes below, or edit caption');}
          void hydrate(figure);return;
        }
        if(!boardFigures.has(figure)){boardFigures.add(figure);if(boardObserver)boardObserver.observe(figure);else figure.dataset.boardVisible='true';}
        if(figure.dataset.boardVisible==='true')queueBoardImage(figure);
      });
      // Release decoded image URLs when their note closes; stored bytes remain intact.
      const visible = new Set([...document.querySelectorAll('[data-note-image]')].map(node => node.dataset.noteImage));
      for (const [id, record] of urls) if (!visible.has(id.startsWith('board:')?id.slice(6):id)) { URL.revokeObjectURL(record.url); urls.delete(id); }
    });
  }
  function insertText(area, text, start = area.selectionStart, end = area.selectionEnd) {
    if (!area.isConnected) return;
    area.setRangeText(text, start, end, 'end'); area.dispatchEvent(new Event('input', { bubbles: true }));
    if (!window.NotejectVisualEditor?.focusSource(area, area.selectionEnd)) area.focus({ preventScroll: true });
  }
  function lineInsertion(area, text, start, end) {
    return (start && area.value[start - 1] !== '\n' ? '\n' : '') + text + (area.value[end] === '\n' ? '' : '\n');
  }
  async function imageFile(file) {
    const extension = (file.name || '').split('.').pop().toLowerCase();
    const inferred = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', bmp:'image/bmp', avif:'image/avif' }[extension];
    const mime = !file.type || file.type === 'application/octet-stream' ? inferred : file.type;
    if (!IMAGE_TYPES.has(mime)) throw Error('Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image.');
    if (file.size > MAX_IMAGE_BYTES) throw Error('Choose an image smaller than 25 MB.');
    const url = URL.createObjectURL(file), image = new Image();
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(Error('This image could not be opened. Try PNG or JPEG.')); image.src = url; });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw Error('This image is too large to insert safely. Resize it below 40 megapixels.');
      // Preserve ordinary images and animations; reduce oversized camera photos for mobile notes.
      if (mime === 'image/gif' || Math.max(image.naturalWidth, image.naturalHeight) <= 2560) return { blob: file.type === mime ? file : file.slice(0, file.size, mime), name: file.name || 'image.png' };
      const scale = 2560 / Math.max(image.naturalWidth, image.naturalHeight), canvas = document.createElement('canvas');
      canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext('2d'); if (!context) throw Error('Image resizing is unavailable. Try a smaller image.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.92));
      if (!blob) throw Error('The image could not be saved. Try a smaller image.');
      const outputExtension = blob.type === 'image/webp' ? '.webp' : '.png';
      return { blob, name: (file.name || 'image').replace(/\.[^.]+$/, '') + outputExtension };
    } finally { URL.revokeObjectURL(url); }
  }
  function mountEditor(panel, note) {
    const area = panel.querySelector('#edit-body');
    if (!area || panel.querySelector('.note-insert-tools')) return;
    editorAssets(note);
    const tools = document.createElement('div'); tools.className = 'note-insert-tools'; tools.hidden = true;
    tools.innerHTML = '<span class="note-media-feedback" role="status" aria-live="polite"></span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif" multiple hidden aria-label="Choose note images">';
    const toolbar = panel.querySelector('.note-format-toolbar'); toolbar.after(tools);
    const imageButton = document.createElement('button'); imageButton.type = 'button'; imageButton.className = 'secondary'; imageButton.dataset.image = ''; imageButton.textContent = 'Add image'; imageButton.setAttribute('aria-label', 'Add image to note');
    if (window.NotejectAndroid) tools.append(imageButton);
    else {
      const more = document.createElement('details'); more.className = 'note-more-menu';
      const summary = document.createElement('summary'); summary.textContent = 'More'; summary.setAttribute('aria-label', 'More note tools');
      const items = document.createElement('div'); items.className = 'note-more-tools';
      const linkButton = toolbar.querySelector('[data-format="web-link"]'); if (linkButton) items.append(linkButton);
      items.append(imageButton); more.append(summary,items); toolbar.append(more);
    }
    tools.addEventListener('pointerdown', event => { if (event.target.closest('button') && document.activeElement === area) event.preventDefault(); });
    const picker = tools.querySelector('input'), feedback = tools.querySelector('.note-media-feedback');
    let busy = false;
    const addImages = async files => {
      if (busy || !files.length) return;
      const start = area.selectionStart, end = area.selectionEnd, content = area.value, snapshot = data;
      busy = true; tools.hidden = false; imageButton.disabled = true;
      const saveButton = panel.querySelector('[data-action="save-note"]');
      if (saveButton) saveButton.disabled = true;
      const inserted = []; let lastError = '';
      try {
        const destination = await ensureProjectFolder(panel.querySelector('#edit-note-folder').value || note.folder || 'Inbox');
        for (const file of Array.from(files).slice(0, 10)) {
          feedback.textContent = 'Saving ' + (file.name || 'image') + '…';
          try {
            const prepared = await imageFile(file);
            if (data !== snapshot || !area.isConnected) return;
            const name = prepared.name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(-160) || 'image.png';
            const asset = { id: 'note-image-' + crypto.randomUUID(), type: 'image', name, mime: prepared.blob.type, size: prepared.blob.size, folder: destination.folder, diskProject: destination.project };
            const stored = await saveDiskFile(prepared.blob, asset); asset.diskName = stored.name || name;
            if (data !== snapshot || !area.isConnected) return;
            const assets = new Map(editorAssets(note)); assets.set(asset.id, asset);
            // Persist the binding before any text is inserted; draft recovery needs both.
            rememberAssets(note, assets);
            const alt = (file.name || 'Image').replace(/\.[^.]+$/, '').replace(/[\[\]\\\n\r]/g, ' ').slice(0, 120);
            inserted.push('![' + (alt || 'Image') + '](noteject-image:' + asset.id + ')');
          } catch (error) { lastError = error.message || 'Image could not be saved'; }
        }
        if (inserted.length && data === snapshot && area.isConnected) {
          if (area.hidden && !area.dataset.visualSource) panel.querySelector('#note-preview-toggle')?.click();
          // Typing is allowed during storage; append at the current cursor if its text changed.
          const from = area.value === content ? start : area.selectionStart, to = area.value === content ? end : area.selectionEnd;
          insertText(area, lineInsertion(area, inserted.join('\n\n'), from, to), from, to);
          feedback.textContent = inserted.length + (inserted.length === 1 ? ' image added' : ' images added');
        }
        if (files.length > 10) { lastError = (lastError ? lastError + ' ' : '') + 'Add at most 10 images at a time.'; }
        if (lastError && data === snapshot && area.isConnected) { feedback.textContent = lastError; notify(lastError); }
      } catch (error) { if (data === snapshot && area.isConnected) { feedback.textContent = error.message || 'Images could not be saved'; notify(feedback.textContent); } }
      finally { busy = false; imageButton.disabled = false; if (saveButton) saveButton.disabled = false; picker.value = ''; }
    };
    imageButton.onclick = () => { picker.click(); imageButton.closest('details')?.removeAttribute('open'); };
    area._notejectInsertImages = addImages;
    picker.onchange = () => addImages([...picker.files]);
    area.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
      if (files.length) { event.preventDefault(); addImages(files); }
    });
    area.addEventListener('dragover', event => { if ([...(event.dataTransfer?.items || [])].some(item => item.type.startsWith('image/'))) event.preventDefault(); });
    area.addEventListener('drop', event => {
      const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
      if (files.length) { event.preventDefault(); event.stopPropagation(); addImages(files); }
    });
    window.NotejectVisualEditor?.mount(panel,area,note,{getNotes:()=>data.notes});
  }
  window.NotejectNoteMedia = { renderMarkdown, mountEditor, prepareCommit, didSave, assetsForWorkspace, syncAssetBindings, releaseNoteImages, importReaderCapture, saveReaderImage, captureReaderPage, previewText, boardPreview, exportImage, refreshBoardPreviews:scheduleScan };
  const readImageAction=event=>{
    if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;
    const figure=event.target.closest?.('.note-image[data-note-image]');
    if(!figure||figure.closest('.note-visual-editor,.canvas-card')||!figure.closest('.detail-panel,#reader-note-overlay'))return;
    event.preventDefault();event.stopImmediatePropagation();showReadImageActions(figure);
  };
  document.addEventListener('click',readImageAction,true);document.addEventListener('keydown',readImageAction,true);
  document.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(records => {
      // Ignore text churn in document readers; only note surfaces need hydration.
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches('.note-image,.detail-panel,#reader-note-overlay,.note-preview') || node.querySelector('.note-image'))))) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true }); scheduleScan();
  }, { once: true });
  window.addEventListener('pagehide', () => { for (const record of urls.values()) URL.revokeObjectURL(record.url); urls.clear(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { document.querySelectorAll('.note-image').forEach(node => delete node.dataset.loaded); scheduleScan(); } });
})();
