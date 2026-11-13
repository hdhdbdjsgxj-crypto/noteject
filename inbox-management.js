/* Shared Inbox interface and actions. File moves use the workspace recovery layer. */
(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.NotejectInboxManagement = exported;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const colors = ['violet', 'blue', 'teal', 'amber', 'rose', 'gray'];
  const readable = item => /^(pdf|djvu|epub|txt|docx?|xlsx?|pptx?)$/.test(item.type);
  function entries(data) {
    return [
      ...(data.notes || []).filter(item => (item.folder || 'Inbox') === 'Inbox' && !item.archived).map(item => ({ kind:'note', key:'note:' + item.id, item })),
      ...(data.docs || []).filter(item => (item.folder || 'Inbox') === 'Inbox').map(item => ({ kind:'document', key:'document:' + item.id, item }))
    ];
  }
  const title = entry => entry.kind === 'note' ? entry.item.title || 'Untitled note' : entry.item.name || 'Untitled file';
  const timestamp = entry => Number(entry.item.updated || entry.item.added || entry.item.created || 0);
  function filterEntries(items, state) {
    const term = String(state.query || '').trim().toLocaleLowerCase();
    const list = items.filter(entry => (state.type === 'all' || !state.type || state.type === entry.kind) && (!state.favorites || entry.item.favorite) &&
      (!term || [title(entry), entry.item.content || '', entry.item.type || '', ...(entry.item.tags || [])].join(' ').toLocaleLowerCase().includes(term)));
    return list.sort((a, b) => {
      const name = title(a).localeCompare(title(b), undefined, { numeric:true });
      if (state.sort === 'name') return name || a.key.localeCompare(b.key);
      if (state.sort === 'kind') return a.kind.localeCompare(b.kind) || name;
      if (state.sort === 'oldest') return timestamp(a) - timestamp(b) || name;
      return timestamp(b) - timestamp(a) || name;
    });
  }
  function csv(items) {
    const cell = value => '"' + (/^\s*[=+@-]/.test(String(value ?? '')) ? "'" : '') + String(value ?? '').replace(/"/g, '""') + '"';
    return [['Name','Kind','Type','Favorite','Tags','Updated'], ...items.map(entry => [title(entry),entry.kind,entry.item.type || 'note',entry.item.favorite ? 'Yes' : 'No',(entry.item.tags || []).join('; '),timestamp(entry) ? new Date(timestamp(entry)).toISOString() : ''])].map(row => row.map(cell).join(',')).join('\r\n');
  }
  function create(api) {
    const state = { query:'', type:'all', favorites:false, sort:'newest', limit:60 };
    try { const sort = localStorage.getItem('noteject-inbox-sort'); if (['newest','oldest','name','kind'].includes(sort)) state.sort = sort; } catch {}
    let busy = false;
    const all = () => entries(api.data());
    const selected = () => all().filter(entry => api.selection().has(entry.key));
    const visible = () => filterEntries(all(), state).slice(0, state.limit);
    const button = (action, label, disabled = false, key = '', danger = false) => '<button type="button" data-ib-action="' + action + '"' + (key ? ' data-ib-key="' + esc(key) + '"' : '') + (disabled ? ' disabled' : '') + (danger ? ' class="destructive-action"' : '') + '>' + label + '</button>';
    function selectionActions(scope, key = '') {
      const notes = scope.filter(entry => entry.kind === 'note'), docs = scope.filter(entry => entry.kind === 'document');
      const disabled = !scope.length;
      return button('move','Move to project…',disabled,key) + button('board','Add to Board…',disabled,key) +
        button('favorite','Add to Favorites',disabled,key) + button('unfavorite','Remove from Favorites',disabled,key) +
        button('tags','Add tags to notes…',!notes.length,key) + button('color','Change note color…',!notes.length,key) +
        button('archive','Archive notes',!notes.length,key) + button('to-read','Mark files To read',!docs.some(entry => readable(entry.item)),key) +
        button('finished','Mark files Finished',!docs.some(entry => readable(entry.item)),key) +
        button('export-notes','Export notes as Markdown',!notes.length,key) + button('trash','Move to Trash…',disabled,key,true);
    }
    function render() {
      const items = all(), valid = new Set(items.map(entry => entry.key));
      for (const key of api.selection()) if (!valid.has(key)) api.selection().delete(key);
      const matches = filterEntries(items, state), rows = matches.slice(0,state.limit), chosen = selected();
      const notes = items.filter(entry => entry.kind === 'note').length, files = items.length - notes;
      const checked = rows.length > 0 && rows.every(entry => api.selection().has(entry.key));
      const folders = [...new Set([...(api.data().folders || []),...(api.data().noteFolders || [])])].filter(folder => folder !== 'Inbox').sort((a,b) => a.localeCompare(b));
      return `<section class="ib-page" data-inbox-root aria-busy="${busy}"><header class="page-heading inbox-heading"><div><div class="eyebrow">REVIEW &amp; ORGANIZE</div><h1>Inbox</h1><p>Organize new notes and files into projects and Boards.</p></div><div class="inbox-heading-actions">${button('new-note','＋ New note')}${button('import','Add files')}<details class="inbox-management-menu ib-main-menu"><summary aria-label="Manage Inbox">Manage <span aria-hidden="true">···</span></summary><div class="inbox-management-popover" role="group" aria-label="Inbox management actions"><strong>Create</strong>${button('new-project','New project')}${button('new-note','New note')}${button('import','Import files')}<strong>Selection</strong>${button('select-all','Select all Inbox items',!items.length)}${button('select-visible','Select visible results',!rows.length)}${button('select-notes','Select all Inbox notes',!notes)}${button('select-files','Select all Inbox files',!files)}${button('invert','Invert visible selection',!rows.length)}${button('clear','Clear selection',!chosen.length)}<strong>Organize</strong>${button('move-all','Move entire Inbox to project…',!items.length)}${button('export-list','Export Inbox list as CSV',!items.length)}${button('reset','Reset filters and sorting')}<strong>Selected items · ${chosen.length}</strong>${selectionActions(chosen)}</div></details><div class="inbox-total"><b>${items.length}</b><span>items to review</span></div></div></header><section class="inbox-manager"><div class="inbox-manager-toolbar"><label class="inbox-search">⌕ <input id="inbox-search" type="search" value="${esc(state.query)}" placeholder="Search Inbox…" aria-label="Search Inbox"></label><div class="inbox-filters" role="group" aria-label="Filter Inbox">${[['all','All',items.length],['note','Notes',notes],['document','Files',files]].map(([type,label,count]) => `<button type="button" data-ib-filter="${type}" class="${state.type === type ? 'active' : ''}" aria-pressed="${state.type === type}">${label}<small>${count}</small></button>`).join('')}</div><button type="button" class="secondary ib-favorites" data-ib-action="filter-favorites" aria-pressed="${state.favorites}">☆ Favorites</button><label class="ib-sort">Sort<select data-ib-sort aria-label="Sort Inbox">${[['newest','Newest first'],['oldest','Oldest first'],['name','Name A–Z'],['kind','Notes / files']].map(([value,label])=>`<option value="${value}" ${state.sort===value?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="inbox-bulkbar has-items${chosen.length?' has-selection':''}"><label class="inbox-select-all"><input type="checkbox" data-inbox-select-all ${checked?'checked':''} ${rows.length?'':'disabled'}> Select visible</label><span class="inbox-selected-count" role="status">${chosen.length ? chosen.length + ' selected' : matches.length + ' results'}</span><div class="inbox-bulk-actions" ${chosen.length?'':'hidden'}><select id="inbox-destination" aria-label="Choose destination project"><option value="">Move selected to…</option>${folders.map(folder=>`<option value="${esc(folder)}">${esc(folder)}</option>`).join('')}</select><button type="button" class="primary" data-inbox-move>Move selected</button><details class="inbox-management-menu ib-selection-menu"><summary aria-label="Actions for selected Inbox items">Actions <span aria-hidden="true">⌄</span></summary><div class="inbox-management-popover" role="group" aria-label="Selected Inbox actions"><strong>${chosen.length} selected</strong>${selectionActions(chosen)}${button('clear','Clear selection')}</div></details></div></div><div class="inbox-results">${rows.map(row).join('') || `<div class="inbox-empty-state"><span>✓</span><h2>${items.length?'No matching items':'Your Inbox is clear'}</h2><p>${items.length?'Change the filters or search to see more items.':'Create a note or import files to get started.'}</p>${button(items.length?'reset':'import',items.length?'Reset filters':'Add files')}</div>`}</div>${matches.length>rows.length?`<button type="button" class="secondary ib-load-more" data-ib-action="more">Show 60 more · ${matches.length-rows.length} remaining</button>`:''}</section></section>`;
    }
    function row(entry) {
      const {item,key,kind}=entry, note=kind==='note';
      const preview=note ? (api.preview(item.content)||'No content yet').replace(/\s+/g,' ').slice(0,150) : String(item.type||'file').toUpperCase()+' · '+api.size(item.size);
      return `<article class="inbox-item ${note?'inbox-note':'inbox-document'}" data-ib-row="${esc(key)}"><label class="inbox-item-check"><input type="checkbox" data-inbox-select="${esc(key)}" aria-label="Select ${esc(title(entry))}" ${api.selection().has(key)?'checked':''}></label><span class="inbox-item-icon ${note?'note-icon':'file-icon'}" aria-hidden="true">${note?'✎':api.fileIcon(item.type)}</span><div class="inbox-item-copy"><div class="inbox-item-title"><b>${esc(title(entry))}</b>${item.favorite?'<span class="ib-star" aria-label="Favorite">★</span>':''}</div><p>${esc(preview)}</p><small class="inbox-item-date">${(item.tags||[]).map(tag=>'#'+esc(tag)).join(' ')}${timestamp(entry)?' · '+new Date(timestamp(entry)).toLocaleDateString(globalThis.document?.documentElement?.lang || undefined):''}</small></div><div class="ib-row-actions">${button('open','Open',false,key)}<details class="inbox-management-menu ib-item-menu"><summary aria-label="Actions for ${esc(title(entry))}"><span aria-hidden="true">···</span></summary><div class="inbox-management-popover" role="group" aria-label="Item actions"><strong>${esc(title(entry))}</strong>${button('open','Open',false,key)}${button('rename','Rename…',false,key)}${button('move','Move to project…',false,key)}${button('board','Add to Board…',false,key)}${button(item.favorite?'unfavorite':'favorite',item.favorite?'Remove from Favorites':'Add to Favorites',false,key)}${note?button('tags','Add tags…',false,key)+button('color','Change color…',false,key)+button('copy','Copy note text',false,key)+button('export-notes','Export as Markdown',false,key)+button('archive','Archive note',false,key):button('download','Save original file',false,key)+(readable(item)?button('to-read','Mark To read',false,key)+button('finished','Mark Finished',false,key):'')}${button('trash','Move to Trash…',false,key,true)}</div></details></div></article>`;
    }
    async function download(name, body, type) {
      const blob=body instanceof Blob?body:new Blob([body],{type}), filename=name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');
      if(window.NotejectAndroid){
        if(!window.NotejectAndroidFiles?.save)throw Error('Update the Android app to enable saving files.');
        const result=await window.NotejectAndroidFiles.save(blob,filename);
        if(result?.status==='error')throw Error(result.message||'Could not save this file.');
        return result;
      }
      const url=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url; a.download=filename; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    }
    function picker({heading,label,options,accept='Apply'}) {
      if (!options.length) { api.notify('Create a '+(label==='Board'?'Board':'project')+' first.'); return Promise.resolve(null); }
      return new Promise(resolve=>{
        const previous=document.activeElement, dialog=document.createElement('dialog'); dialog.className='ib-picker';
        dialog.innerHTML=`<form method="dialog"><h2 id="ib-picker-title">${esc(heading)}</h2><label>${esc(label)}<select name="choice" aria-label="${esc(label)}">${options.map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join('')}</select></label><footer><button type="button" class="secondary" data-ib-cancel>Cancel</button><button type="submit" class="primary">${esc(accept)}</button></footer></form>`;
        dialog.setAttribute('aria-labelledby','ib-picker-title'); document.body.append(dialog);
        dialog.querySelector('[data-ib-cancel]').onclick=()=>dialog.close();
        dialog.querySelector('form').onsubmit=event=>{event.preventDefault();dialog.close('apply');};
        dialog.addEventListener('close',()=>{const value=dialog.returnValue==='apply'?dialog.querySelector('select').value:null;dialog.remove();previous?.focus?.({preventScroll:true});resolve(value);},{once:true});
        dialog.showModal(); dialog.querySelector('select').focus();
      });
    }
    function finish(message) { api.save(); api.render(); if(message)api.notify(message); }
    async function execute(action,key) {
      const scope=key?all().filter(entry=>entry.key===key):selected(), notes=scope.filter(entry=>entry.kind==='note');
      const selection=api.selection();
      document.querySelectorAll('[data-inbox-root] details[open]').forEach(menu=>menu.open=false);
      if (action==='new-project') return api.newProject();
      if (action==='new-note') return api.newNote();
      if (action==='import') return api.importFiles();
      if (action==='open' && scope[0]) return api.open(scope[0]);
      if (action==='more') {state.limit+=60;return api.render();}
      if (action==='filter-favorites') {state.favorites=!state.favorites;state.limit=60;return api.render();}
      if (action==='reset') {Object.assign(state,{query:'',type:'all',favorites:false,sort:'newest',limit:60});try{localStorage.setItem('noteject-inbox-sort','newest');}catch{} return api.render();}
      if (action==='select-all'||action==='select-notes'||action==='select-files') {selection.clear();all().filter(entry=>action==='select-all'||entry.kind===(action==='select-notes'?'note':'document')).forEach(entry=>selection.add(entry.key));return api.render();}
      if (action==='select-visible'||action==='invert') {for(const entry of visible()){if(action==='invert'&&selection.has(entry.key))selection.delete(entry.key);else selection.add(entry.key);}return api.render();}
      if (action==='clear') {selection.clear();return api.render();}
      if (action==='export-list') return download('Noteject-Inbox.csv',csv(all()),'text/csv;charset=utf-8');
      if(action==='move'||action==='move-all') {
        const targets=action==='move-all'?all():scope;if(!targets.length)return;
        const folders=[...new Set([...(api.data().folders||[]),...(api.data().noteFolders||[])])].filter(folder=>folder!=='Inbox').sort((a,b)=>a.localeCompare(b));
        const folder=await picker({heading:'Move '+targets.length+' item(s) to a project',label:'Project',options:folders.map(folder=>[folder,folder]),accept:'Move items'});
        if(folder)await api.move(targets.map(entry=>entry.key),folder);return;
      }
      if(!scope.length)return;
      if(action==='board') {
        const boardId=await picker({heading:'Add '+scope.length+' item(s) to a Board',label:'Board',options:api.data().boards.map(board=>[board.id,board.name]),accept:'Add to Board'});
        if(boardId){const added=api.addToBoard(scope,boardId);finish(added+' item(s) added to Board. Inbox items are kept.');}return;
      }
      if(action==='rename') {
        const entry=scope[0], name=await api.dialogs.prompt('Rename '+(entry.kind==='note'?'note':'file'),title(entry),{input:{maxLength:240}});
        if(name?.trim() && name.trim()!==title(entry)){await api.rename(entry,name.trim());finish('Name updated');}return;
      }
      if(action==='favorite'||action==='unfavorite') {scope.forEach(entry=>entry.item.favorite=action==='favorite');return finish(action==='favorite'?'Added to Favorites':'Removed from Favorites');}
      if(action==='tags'&&notes.length) {
        const value=await api.dialogs.prompt('Add tags to '+notes.length+' note(s). Separate tags with commas.','',{input:{maxLength:500}});
        if(value===null)return;const tags=[...new Set(value.split(',').map(tag=>tag.trim().replace(/^#+/,'')).filter(Boolean))];if(!tags.length)return;
        notes.forEach(entry=>{entry.item.tags=[...new Set([...(entry.item.tags||[]),...tags])];entry.item.updated=Date.now();});return finish('Tags added');
      }
      if(action==='color'&&notes.length) {const color=await picker({heading:'Change color for '+notes.length+' note(s)',label:'Color',options:colors.map(color=>[color,color[0].toUpperCase()+color.slice(1)])});if(color){notes.forEach(entry=>{entry.item.color=color;entry.item.updated=Date.now();});finish('Note colors updated');}return;}
      if(action==='archive'&&notes.length) {
        if(!await api.dialogs.confirm('Archive '+notes.length+' note(s)? Find them later in All notes → Archive.',{title:'Archive Inbox notes',confirmLabel:'Archive notes',danger:false}))return;
        notes.forEach(entry=>{entry.item.archived=true;entry.item.updated=Date.now();selection.delete(entry.key);});return finish(notes.length+' note(s) archived');
      }
      if(action==='to-read'||action==='finished') {scope.filter(entry=>entry.kind==='document'&&readable(entry.item)).forEach(entry=>entry.item.readingStatus=action);return finish('Reading status updated');}
      if(action==='copy'&&notes[0]) {if(!navigator.clipboard?.writeText)throw Error('Clipboard is unavailable. Export the note as Markdown instead.');await navigator.clipboard.writeText(notes[0].item.content||'');return api.notify('Note text copied');}
      if(action==='export-notes'&&notes.length) return download(notes.length===1?title(notes[0])+'.md':'Noteject-Inbox-notes.md',notes.map(entry=>'# '+title(entry)+'\n\n'+(entry.item.content||'')).join('\n\n---\n\n'),'text/markdown;charset=utf-8');
      if(action==='download'&&scope[0].kind==='document') {const blob=await api.getBlob(scope[0].item);if(!blob)throw Error('The original file is unavailable on this device.');return download(title(scope[0]),blob);}
      if(action==='trash') {
        if(!await api.dialogs.confirm('Move '+scope.length+' item(s) to Trash? Their Board cards are removed too. You can restore them from Trash.',{title:'Move Inbox items to Trash',confirmLabel:'Move to Trash',danger:true}))return;
        scope.forEach(entry=>{api.trash(entry);selection.delete(entry.key);});finish(scope.length+' item(s) moved to Trash');
      }
    }
    function bind() {
      const root=document.querySelector('[data-inbox-root]');if(!root)return;
      root.onclick=async event=>{
        const control=event.target.closest('[data-ib-action]');if(!control||control.disabled||busy)return;
        busy=true;
        try{await execute(control.dataset.ibAction,control.dataset.ibKey);}catch(error){api.notify(error.message||'Inbox action could not finish.');}
        finally{busy=false;document.querySelector('[data-inbox-root]')?.setAttribute('aria-busy','false');}
      };
      // Renders may replace the clicked button; the controller lock still blocks duplicate actions.
      root.onchange=event=>{
        const target=event.target;if(busy)return;
        if(target.matches('[data-inbox-select]')){target.checked?api.selection().add(target.dataset.inboxSelect):api.selection().delete(target.dataset.inboxSelect);api.render();}
        if(target.matches('[data-inbox-select-all]')){visible().forEach(entry=>target.checked?api.selection().add(entry.key):api.selection().delete(entry.key));api.render();}
        if(target.matches('[data-ib-sort]')){state.sort=target.value;try{localStorage.setItem('noteject-inbox-sort',state.sort);}catch{}api.render();}
      };
      const search=root.querySelector('#inbox-search');search.oninput=()=>{if(busy)return;const value=search.value;state.query=value;state.limit=60;api.render();document.querySelector('#inbox-search')?.focus();};
      root.querySelectorAll('[data-ib-filter]').forEach(control=>control.onclick=()=>{if(busy)return;state.type=control.dataset.ibFilter;state.limit=60;api.render();});
      root.onkeydown=event=>{if(event.key==='Escape'){const menu=event.target.closest('details[open]');if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary').focus();}}};
      const checkbox=root.querySelector('[data-inbox-select-all]');checkbox.indeterminate=visible().some(entry=>api.selection().has(entry.key))&&!checkbox.checked;
      root.querySelectorAll('.inbox-management-menu').forEach(menu=>menu.addEventListener('toggle',()=>{if(menu.open)root.querySelectorAll('details[open]').forEach(other=>{if(other!==menu)other.open=false;});}));
    }
    document.addEventListener('pointerdown',event=>{document.querySelectorAll('[data-inbox-root] details[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
    return {render,bind,state};
  }
  return {create,model:{entries,filterEntries,csv}};
});
