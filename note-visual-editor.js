/* Visual Note editing. Markdown stays an internal persistence format. */
(() => {
  'use strict';
  const instances = new WeakMap();
  const escaped = text => String(text).replace(/[\\`*$#>\-]/g,'\\$&');
  const palette = {violet:'#b79aff',blue:'#83baff',teal:'#6cdbc7',amber:'#f4cb77',rose:'#ee9cba',gray:'#b3bbca'};
  function mount(panel, area, note, options = {}) {
    if (instances.has(area)) return;
    const visual = document.createElement('div'); visual.className='note-visual-editor markdown';
    visual.contentEditable='true'; visual.setAttribute('role','textbox'); visual.setAttribute('aria-multiline','true'); visual.setAttribute('aria-label','Note text');
    visual.spellcheck=false; visual.setAttribute('autocorrect','off'); visual.setAttribute('autocapitalize','off');
    visual.dataset.placeholder='Write your note…';
    area.before(visual); area.hidden=true; area.dataset.visualSource='true'; area.setAttribute('aria-hidden','true');
    const toggle=panel.querySelector('#note-preview-toggle'); if(toggle) toggle.hidden=true;
    let writing=false, offsets=new WeakMap(), lastRange=null;
    function decorate() {
      visual.querySelectorAll('[data-note-source]').forEach(atom=>{atom.contentEditable='false';atom.tabIndex=0;atom.setAttribute('role','button');atom.setAttribute('aria-label',atom.matches('.note-image')?'Image: save to disk, write notes below, or edit caption':'Equation: remove');});
      visual.querySelectorAll('.markdown-task input').forEach(input=>{input.disabled=false;input.setAttribute('aria-label','Complete task');});
      visual.querySelectorAll('a[data-note-link]').forEach(link=>{
        // Read views open links; editing keeps taps inside the link editor.
        link.removeAttribute('target'); link.title='Edit link: '+link.getAttribute('href');
      });
    }
    function render() {
      visual.innerHTML=markdown(area.value);
      // The shared display renderer emits a line break after block elements.
      // Blocks already provide that boundary while editing; avoid adding a blank
      // line on every save/reopen cycle.
      visual.querySelectorAll('h2,h3,ul,ol,blockquote,pre,.note-image,.note-equation-block').forEach(block=>{
        if(block.nextSibling?.nodeName==='BR')block.nextSibling.remove();
      });
      if(visual.lastChild?.nodeType===1&&visual.lastChild.matches('[data-note-source]')){
        const paragraph=document.createElement('p');paragraph.append(document.createElement('br'));visual.append(paragraph);
      }
      decorate();
    }
    function serialize() {
      offsets=new WeakMap(); let result='';
      const add=text=>{result+=text;};
      const line=()=>{if(result && !result.endsWith('\n'))add('\n');};
      function walk(node, depth=0) {
        const start=result.length;
        if(node.nodeType===3) {
          const text=node.nodeValue || ''; const map=[start];
          const inLink=!!node.parentElement?.closest('a[data-note-link]'), inWiki=!!node.parentElement?.closest('[data-note-wiki]');
          for(const char of text){add(inWiki?char:inLink&&/[\[\]]/.test(char)?'\\'+char:escaped(char));for(let i=0;i<char.length;i++)map.push(result.length);}
          offsets.set(node,{start,end:result.length,map}); return;
        }
        if(node.nodeType!==1)return;
        const tag=node.tagName.toLowerCase(), atom=node.dataset.noteSource;
        if(atom!==undefined){
          if(node.matches('.note-image,.note-equation-block'))line();
          const from=result.length;add(atom);
          offsets.set(node,{start:from,end:result.length,atomic:true});
          if(node.matches('.note-image,.note-equation-block'))line();return;
        }
        let open='',close='';
        if(tag==='br'){add('\n');offsets.set(node,{start,end:result.length});return;}
        if(tag==='input')return;
        if(tag==='ul'||tag==='ol') {
          line();let index=Number(node.getAttribute('start'))||1;
          for(const child of node.children) {
            if(child.tagName!=='LI')continue;
            line();const at=result.length;
            const checkbox=child.querySelector(':scope > label > input[type=checkbox],:scope > input[type=checkbox]');
            add('  '.repeat(depth)+(checkbox?'- ['+(checkbox.checked?'x':' ')+'] ':tag==='ol'?String(index++)+'. ':'- '));
            const childStart=result.length;
            for(const entry of child.childNodes)walk(entry,depth+1);
            offsets.set(child,{start:at,contentStart:childStart,end:result.length});line();
          }
          offsets.set(node,{start,end:result.length});return;
        }
        if(/^h[1-6]$/.test(tag)){line();open='#'.repeat(Math.min(3,Number(tag[1])))+' ';close='\n';}
        else if(tag==='strong'||tag==='b'){open='**';close='**';}
        else if(tag==='em'||tag==='i'){open='*';close='*';}
        else if(tag==='code'&&node.parentElement?.tagName!=='PRE'){
          add('`');const from=result.length;
          const child=node.firstChild;add(node.textContent);
          if(child?.nodeType===3)offsets.set(child,{start:from,end:result.length,map:Array.from({length:child.nodeValue.length+1},(_,index)=>from+index)});
          add('`');offsets.set(node,{start,contentStart:from,contentEnd:result.length-1,end:result.length});return;
        }
        else if(tag==='pre') {line();add('```\n'+node.textContent.replace(/\n$/,'')+'\n```\n');offsets.set(node,{start,end:result.length,atomic:true});return;}
        else if(tag==='blockquote'){line();open='> ';close='\n';}
        else if(tag==='a'&&node.hasAttribute('data-note-link')){
          const href=window.NotejectNoteLinks.normalize(node.getAttribute('href'));
          if(href){open='[';close='](<'+href+'>)';}
        }
        else if(tag==='div'||tag==='p'){line();close='\n';}
        if(node.dataset.noteHighlight){open='=={'+node.dataset.noteHighlight+'}';close='==';}
        else if(node.dataset.noteWiki!==undefined){const ref=window.NotejectNoteLinks.parseWiki(node.dataset.noteWiki);open=ref.id?'[[note:'+encodeURIComponent(ref.id)+'|':'[[';close=']]';}
        else if(node.style.backgroundColor) {
          const rgb=node.style.backgroundColor.replace(/\s/g,'').toLowerCase();
          const color=Object.entries(palette).find(([,hex])=>{const value=hex.match(/\w\w/g).map(part=>parseInt(part,16));return rgb===hex||rgb==='rgb('+value.join(',')+')';});
          if(color){open='=={'+color[0]+'}';close='==';}
        }
        add(open);const contentStart=result.length;
        for(const child of node.childNodes)walk(child,depth);
        const contentEnd=result.length;add(close);
        offsets.set(node,{start,contentStart,contentEnd,end:result.length});
      }
      for(const child of visual.childNodes)walk(child);
      offsets.set(visual,{start:0,contentStart:0,contentEnd:result.length,end:result.length});
      return result.replace(/\n+$/,'');
    }
    function position(node,index) {
      if(node.nodeType===3) {const map=offsets.get(node);return map?.map?.[index]??map?.end??0;}
      const atom=node.nodeType===1?node.closest('[data-note-source]'):node.parentElement?.closest('[data-note-source]');
      if(atom && visual.contains(atom))return offsets.get(atom)?.start??0;
      const info=offsets.get(node);
      if(index===0)return info?.contentStart??info?.start??0;
      const child=node.childNodes[Math.min(index,node.childNodes.length)-1];
      return offsets.get(child)?.end??info?.contentEnd??info?.end??0;
    }
    function syncSelection() {
      const selection=getSelection();
      if(!selection?.rangeCount||!visual.contains(selection.anchorNode)||!visual.contains(selection.focusNode))return;
      const value=serialize(),range=selection.getRangeAt(0);
      if(area.value!==value){writing=true;area.value=value;area.dispatchEvent(new Event('input',{bubbles:true}));writing=false;}
      area.setSelectionRange(position(range.startContainer,range.startOffset),position(range.endContainer,range.endOffset));
      lastRange=range.cloneRange();
    }
    function focusSource(offset=area.selectionEnd) {
      serialize();let target=null, distance=Infinity;
      const walk=document.createTreeWalker(visual,NodeFilter.SHOW_TEXT);
      let node;
      while((node=walk.nextNode())) {
        if(node.parentElement.closest('[data-note-source]'))continue;
        const info=offsets.get(node); if(!info?.map)continue;
        for(let i=0;i<info.map.length;i++){const delta=Math.abs(info.map[i]-offset);if(delta<distance){distance=delta;target={node,offset:i};}}
      }
      visual.focus({preventScroll:true});const range=document.createRange();
      if(target)range.setStart(target.node,target.offset);else {const tail=visual.lastElementChild;range.selectNodeContents(tail?.matches('p')&&!tail.textContent?tail:visual);range.collapse(false);}
      range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);lastRange=range.cloneRange();
      return true;
    }
    function changed() { if(writing)return;writing=true;area.value=serialize();area.dispatchEvent(new Event('input',{bubbles:true}));writing=false;syncSelection(); }
    function restoreRange() {
      visual.focus({preventScroll:true});
      if(lastRange && visual.contains(lastRange.commonAncestorContainer)){const selection=getSelection();selection.removeAllRanges();selection.addRange(lastRange);}
    }
    function command(name,value=null) {restoreRange();document.execCommand(name,false,value);changed();}
    async function insertNoteLink() {
      syncSelection();
      const savedRange=lastRange?.cloneRange(), query=getSelection()?.toString()||'';
      const target=await window.NotejectNotePicker.pick({getNotes:options.getNotes || (()=>[]),currentNote:note,query});
      if(!visual.isConnected||!area.isConnected)return;
      lastRange=savedRange;restoreRange();
      if(target)command('insertHTML',window.NotejectNoteLinks.wikiHtml(window.NotejectNoteLinks.wikiReference(target)));
    }
    function editLink(anchor=null) {
      syncSelection();
      const selection=getSelection(), selected=selection?.toString()||'';
      if(!anchor)anchor=selection?.anchorNode?.parentElement?.closest('a[data-note-link]');
      if(anchor&&!visual.contains(anchor))anchor=null;
      const originalLabel=anchor?.textContent||selected;
      const savedRange=lastRange?.cloneRange();
      const dialog=document.createElement('dialog');dialog.className='ux-dialog note-link-dialog';
      dialog.setAttribute('aria-labelledby','note-link-title');
      const form=document.createElement('form');
      form.innerHTML='<h2 id="note-link-title">'+(anchor?'Edit link':'Add link')+'</h2><label>Link address<input name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://example.com" required maxlength="8000"></label><label>Display text<input name="label" type="text" autocomplete="off" placeholder="Optional label" maxlength="2000"></label><p class="note-link-error" role="alert" hidden></p><footer><button type="button" data-link-cancel>Cancel</button><button type="submit" class="primary">'+(anchor?'Save link':'Insert link')+'</button></footer>';
      const url=form.elements.url,label=form.elements.label,error=form.querySelector('.note-link-error');
      const selectedUrl=/^(?:https?:\/\/|www\.|mailto:|tel:|[a-z0-9-]+\.[a-z]{2,}(?:\/|$))/i.test(selected.trim())?window.NotejectNoteLinks.normalize(selected):null;
      url.value=anchor?.getAttribute('href')||selectedUrl||'';
      label.value=originalLabel;
      const restore=()=>{lastRange=savedRange;restoreRange();};
      form.querySelector('[data-link-cancel]').onclick=()=>dialog.close();
      form.onsubmit=event=>{
        event.preventDefault();
        const href=window.NotejectNoteLinks.normalize(url.value);
        if(!href){error.textContent='Enter a valid website address, email link, or phone link.';error.hidden=false;url.focus();return;}
        const text=label.value.trim()||href;
        if(!visual.isConnected){dialog.close();return;}
        dialog.close();restore();
        if(anchor?.isConnected){
          anchor.setAttribute('href',href);
          if(text!==originalLabel)anchor.textContent=text;
          changed();decorate();
        }else if(savedRange&&!savedRange.collapsed&&text===originalLabel){
          command('createLink',href);
          visual.querySelectorAll('a').forEach(link=>{link.classList.add('note-hyperlink');link.setAttribute('data-note-link','');});
          decorate();changed();
        }else command('insertHTML',window.NotejectNoteLinks.html(text,href));
        decorate();syncSelection();
      };
      if(anchor){
        const footer=form.querySelector('footer');
        const open=document.createElement('button');open.type='button';open.textContent='Open link';
        open.onclick=()=>{const href=window.NotejectNoteLinks.normalize(anchor.getAttribute('href'));if(href)window.open(href,'_blank','noopener,noreferrer');};
        const remove=document.createElement('button');remove.type='button';remove.textContent='Delete link';remove.className='danger-button';
        remove.onclick=()=>{dialog.close();restore();if(anchor.isConnected)anchor.remove();changed();focusSource(area.selectionEnd);};
        footer.prepend(open,remove);
      }
      url.oninput=()=>{error.hidden=true;};
      dialog.append(form);document.body.append(dialog);
      dialog.addEventListener('close',()=>{dialog.remove();if(visual.isConnected)restore();},{once:true});
      dialog.showModal();url.focus();url.select();
    }
    visual.addEventListener('input',changed);
    visual.addEventListener('keyup',syncSelection);visual.addEventListener('mouseup',syncSelection);visual.addEventListener('touchend',syncSelection);
    visual.addEventListener('focusout',syncSelection);
    visual.addEventListener('change',changed);
    area.addEventListener('input',()=>{if(!writing)render();});
    visual.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
        event.preventDefault();event.stopPropagation();editLink();return;
      }
      if((event.ctrlKey||event.metaKey)&&['s','z','y'].includes(event.key.toLowerCase())){
        event.preventDefault();syncSelection();
        if(event.key.toLowerCase()==='s')panel.querySelector('[data-action=save-note]')?.click();
        else panel.querySelector(event.key.toLowerCase()==='y'||event.shiftKey?'[data-note-redo]':'[data-note-undo]')?.click();
        return;
      }
      if(event.key==='Tab'){event.preventDefault();command(event.shiftKey?'outdent':'indent');}
      if(event.key==='Enter'&&event.shiftKey){
        const selection=getSelection();const li=selection?.anchorNode?.parentElement?.closest('li');
        if(li){event.preventDefault();command('insertParagraph');command('indent');}
      }
    });
    visual.addEventListener('paste',event=>{
      event.preventDefault();syncSelection();
      const files=[...(event.clipboardData?.files||[])].filter(file=>file.type.startsWith('image/'));
      if(files.length) area._notejectInsertImages?.(files);
      else {
        const text=event.clipboardData?.getData('text/plain')||'';
        const href=/^(?:https?:\/\/|www\.)\S+$/i.test(text.trim())?window.NotejectNoteLinks.normalize(text):null;
        if(href){
          const label=getSelection()?.toString()||text.trim();
          command('insertHTML',window.NotejectNoteLinks.html(label,href));decorate();
        }else command('insertText',text);
      }
    });
    visual.addEventListener('dragover',event=>{if([...(event.dataTransfer?.items||[])].some(item=>item.type.startsWith('image/')))event.preventDefault();});
    visual.addEventListener('drop',event=>{
      const files=[...(event.dataTransfer?.files||[])].filter(file=>file.type.startsWith('image/'));
      if(files.length){event.preventDefault();event.stopPropagation();syncSelection();area._notejectInsertImages?.(files);}
    });
    panel.addEventListener('pointerdown',event=>{
      if(event.target.closest('.note-format-toolbar button,.note-insert-tools button,.an-text-color-tools button')) {syncSelection();event.preventDefault();}
    },true);
    panel.addEventListener('click',event=>{
      const format=event.target.closest('[data-format]'), highlight=event.target.closest('[data-an-text-color]');
      if(!format&&!highlight)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(highlight){command('hiliteColor',palette[highlight.dataset.anTextColor]);return;}
      const type=format.dataset.format;
      if(type==='bold'||type==='italic')command(type);
      else if(type==='bullet'||type==='number')command(type==='bullet'?'insertUnorderedList':'insertOrderedList');
      else if(type==='heading'||type==='quote')command('formatBlock',type==='heading'?'h2':'blockquote');
      else if(type==='sublist')command('indent');
      else if(type==='check')command('insertHTML','<ul><li><label class="markdown-task"><input type="checkbox" aria-label="Complete task"> To-do</label></li></ul>');
      else if(type==='link')void insertNoteLink();
      else if(type==='web-link')editLink();
    },true);
    function writeAfterImage(atom) {
      const paragraph=document.createElement('p');paragraph.append(document.createElement('br'));atom.after(paragraph);
      visual.focus({preventScroll:true});const range=document.createRange();range.selectNodeContents(paragraph);range.collapse(true);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);lastRange=range.cloneRange();changed();
      paragraph.scrollIntoView({block:'nearest'});
    }
    function imageReference(atom) {
      serialize();const info=offsets.get(atom);
      return info?{assetId:atom.dataset.noteImage,source:atom.dataset.noteSource,start:info.start,end:info.end}:null;
    }
    async function captionImage(atom) {
      const reference=imageReference(atom);if(!reference)return;
      const match=reference.source.match(/^!\[([^\]]*)\]\(noteject-image:([a-zA-Z0-9_-]+)\)$/);if(!match)return;
      const caption=await window.NotejectDialogs.prompt('Image caption',match[1]);if(caption===null||caption===undefined)return;
      if(!area.isConnected||area.value.slice(reference.start,reference.end)!==reference.source){notify('The note changed. Open the image again.');return;}
      area.setRangeText('!['+String(caption).replace(/[\[\]\\\r\n]/g,' ')+'](noteject-image:'+match[2]+')',reference.start,reference.end,'end');area.dispatchEvent(new Event('input',{bubbles:true}));focusSource(area.selectionEnd);
    }
    function imageAction(id, action) {
      const atom=[...visual.querySelectorAll('.note-image')].find(node=>node.dataset.noteImage===id);if(!atom)return false;
      if(action==='write')writeAfterImage(atom);
      else if(action==='caption')void captionImage(atom);
      else return false;
      return true;
    }
    async function editAtom(atom) {
      const source=atom.dataset.noteSource;
      serialize();const info=offsets.get(atom);if(!info)return;
      const dialog=document.createElement('dialog');dialog.className='ux-dialog note-atom-dialog';
      const heading=document.createElement('h2');heading.textContent=atom.matches('.note-image')?'Image':'Equation';dialog.append(heading);
      const actions=document.createElement('div');actions.className='note-atom-actions';
      const action=(label,run)=>{const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=label;button.onclick=run;actions.append(button);return button;};
      if(atom.matches('.note-image')){
        action('Write notes below',()=>{dialog.close();writeAfterImage(atom);});
        action('Edit caption',()=>{dialog.close();void captionImage(atom);});
        const message=document.createElement('p');message.setAttribute('role','status');dialog.append(message);
        const save=action('Save to disk',async()=>{
          save.disabled=true;message.textContent='Preparing image…';
          try{const result=await window.NotejectNoteMedia.exportImage(atom.dataset.noteImage);message.textContent=result.message||(result.status==='saved'?'Image saved':'Save cancelled');}
          catch(error){message.textContent=error.message||'Could not save the image.';}finally{save.disabled=false;}
        });
      }
      action('Remove',()=>{dialog.close();area.setRangeText('',info.start,info.end,'end');area.dispatchEvent(new Event('input',{bubbles:true}));focusSource(area.selectionEnd);});
      actions.lastElementChild.className='danger-button';action('Close',()=>dialog.close());
      dialog.append(actions);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
    }
    visual.addEventListener('click',event=>{const atom=event.target.closest('[data-note-source]'),link=event.target.closest('a[data-note-link]');if(atom){event.preventDefault();void editAtom(atom);}else if(link){event.preventDefault();event.stopPropagation();editLink(link);}});
    visual.addEventListener('keydown',event=>{const atom=event.target.closest('[data-note-source]'),link=event.target.closest('a[data-note-link]');if(atom&&(event.key==='Enter'||event.key===' ')){event.preventDefault();void editAtom(atom);}else if(link&&event.key==='Enter'){event.preventDefault();editLink(link);}});
    instances.set(area,{visual,render,focusSource,syncSelection,imageAction});render();
  }
  window.NotejectVisualEditor={mount,focusSource:(area,offset)=>instances.get(area)?.focusSource(offset)||false,imageAction:(area,id,action)=>instances.get(area)?.imageAction(id,action)||false};
})();
