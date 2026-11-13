/* Reader presentation bridge. Native Android uses the same components for every format. */
(() => {
  'use strict';
  let active=null,sequence=0;
  const native=()=>window.NotejectAndroid;
  function request(kind,payload,callback){
    const method=kind==='compose'?'openReaderPassageComposer':'openReaderSavedItems';if(typeof native()?.[method]!=='function')return false;
    const requestId='reader-ui-'+Date.now().toString(36)+'-'+(++sequence),record={requestId,documentId:payload.documentId,callback};active=record;
    try {
      const response=JSON.parse(native()[method](JSON.stringify({...payload,requestId,uiTheme:window.NotejectNativeReader?.theme?.()}))||'{}');
      if(response.error||response.ok===false)throw Error(response.error||'Reader interface could not open.');return true;
    }catch(error){if(active===record)active=null;throw error;}
  }
  window.__notejectReaderSavedResult=window.__notejectReaderComposerResult=result=>{
    if(!active||result.requestId!==active.requestId||result.documentId!==active.documentId)return;
    const record=active;if(result.action!=='draft')active=null;record.callback(result);
  };
  function saved(payload,callback){
    if(request('saved',payload,callback))return;
    // Browser/desktop fallback follows the same list -> item actions as Android.
    const items=[...(payload.bookmarks||[]).map(item=>({...item,bookmark:true})),...(payload.passages||[]).map(item=>({...item,bookmark:false}))];
    function dialog(title){const node=document.createElement('dialog');node.className='ux-dialog reader-surface-dialog';node.setAttribute('aria-label',title);const h=document.createElement('h2');h.textContent=title;node.append(h);node.addEventListener('close',()=>node.remove(),{once:true});document.body.append(node);return node;}
    function button(parent,label,run,danger=false){const node=document.createElement('button');node.type='button';node.textContent=label;if(danger)node.className='danger-button';node.onclick=run;parent.append(node);return node;}
    function act(action,item){callback({action,id:item.id,bookmark:item.bookmark,documentId:payload.documentId});}
    function details(item){const node=dialog(item.title||'Passage');const text=document.createElement('p');text.className='reader-surface-body';text.textContent=[item.locationLabel,item.quote,item.comment].filter(Boolean).join('\n\n');node.append(text);const actions=document.createElement('footer');node.append(actions);
      button(actions,'Read',()=>{node.close();act('read',item);});if(!item.bookmark)button(actions,'Edit in Notes',()=>{node.close();act('edit',item);});
      button(actions,'Delete',async()=>{node.close();if(await window.NotejectDialogs.confirm(item.bookmark?'Delete this bookmark?':'Move this passage to Trash?'))act('delete',item);else details(item);},true);button(actions,'Close',()=>node.close());node.showModal();}
    const node=dialog('Notes & Passages'),search=document.createElement('input');search.type='search';search.placeholder='Find passages or bookmarks';search.setAttribute('aria-label','Find saved Reader items');node.append(search);const list=document.createElement('div');list.className='reader-surface-items';node.append(list);
    function render(){list.replaceChildren();const query=search.value.trim().toLowerCase(),found=items.filter(item=>!query||[item.title,item.quote,item.comment,item.locationLabel].join(' ').toLowerCase().includes(query));if(!found.length){const empty=document.createElement('p');empty.textContent=query?'No matching saved items.':'No saved items yet. Select text and choose Save passage, or bookmark your reading position.';list.append(empty);}
      for(const item of found){const row=button(list,(item.bookmark?'★ ':'✎ ')+(item.title||'Passage'),()=>{node.close();details(item);});const where=document.createElement('small');where.textContent=item.locationLabel||'Reading position';row.append(where);}}
    search.oninput=render;button(node,'Close',()=>node.close());render();node.showModal();
  }
  window.NotejectReaderSurfaces=Object.freeze({saved,compose:(payload,callback)=>request('compose',payload,callback),hasComposer:()=>typeof native()?.openReaderPassageComposer==='function'});
})();
