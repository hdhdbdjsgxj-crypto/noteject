(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const tagsOf = value => (Array.isArray(value) ? value : String(value || '').split(/[,#]/)).map(clean).filter(Boolean);
  const localTools = [['search','Search'],['summary','Summarize'],['related','Related ideas'],['review','Library review']];

  function create(app) {
    const core = root.NotejectSmartSearch;
    let query='', mode='local', tool='search', kind='all', folder='all', messages=[], matches=[], error='';
    let sources=[], sourceMap=new Map(), index=null, connection='', checkingConnection=false;
    let pending=null, requestNumber=0, inputTimer=0, resultNumber=0, localPending=false;
    let indexReady=Promise.resolve(), indexError=null, indexing=false, sourceRevision=0;
    const signatures=new Map();

    function sourceKey(source) { return core.key(source); }
    // Compare immutable body strings directly. Length-only snapshots missed
    // same-length corrections; serializing entire books on every keypress is
    // unnecessary. Only changed sources cross the worker boundary.
    const metadata=source=>JSON.stringify({...source,body:undefined});
    function buildSources(data) {
      const result=[], byId=new Map(), byKey=new Map(), titles=new Map();
      const add=source=>{source.key=sourceKey(source);source.linkedKeys=[];result.push(source);byId.set(source.id,source);byKey.set(source.key,source);titles.set(source.title.toLocaleLowerCase(),source);return source;};
      for(const note of data.notes||[]) {
        if(note.archived)continue;
        const passage=root.NotejectReaderSelectionModel?.normalize(note)||{};
        const isHighlight=!!(note.selectionSourceId||note.sourceId);
        add({kind:'note',id:note.id,title:clean(note.title)||(isHighlight?'Saved highlight':'Untitled note'),folder:note.folder||'Inbox',type:isHighlight?'Highlight':'Note',
          body:[String(note.content||''),passage.quote,passage.comment].filter(Boolean).join('\n'),tags:tagsOf(note.tags),updated:Number(note.updated||note.created||0),isHighlight});
      }
      for(const doc of data.docs||[]) {
        const body=String(app.getDocumentText(doc)||'');
        add({kind:'document',id:doc.id,title:clean(doc.name)||'Untitled file',folder:doc.folder||'Inbox',type:String(doc.type||'file').toUpperCase(),body,tags:tagsOf(doc.tags),updated:Number(doc.updated||doc.added||0),indexed:!!body.trim()});
      }
      const link=(a,b)=>{if(!a||!b||a.key===b.key)return;if(!a.linkedKeys.includes(b.key))a.linkedKeys.push(b.key);if(!b.linkedKeys.includes(a.key))b.linkedKeys.push(a.key);};
      for(const note of data.notes||[]) {
        const source=byId.get(note.id);if(!source)continue;
        link(source,byId.get(note.selectionSourceId||note.sourceId));
        for(const match of String(note.content||'').matchAll(/\[\[([^\]]+)\]\]/g))link(source,titles.get(match[1].trim().toLocaleLowerCase()));
      }
      for(const board of data.boards||[]) {
        const cards=(board.items||[]).map(item=>byId.get(item.id)).filter(Boolean);
        const boardSource=add({kind:'board',id:board.id,boardId:board.id,title:clean(board.name)||'Untitled board',folder:'Boards',type:'Board',body:[...cards.map(c=>c.title),...(board.edges||[]).map(e=>clean(e.label||e.name))].filter(Boolean).join('\n'),updated:Number(board.updated||0)});
        cards.forEach(card=>link(boardSource,card));
        for(const edge of board.edges||[]) {
          const from=byId.get(edge.from),to=byId.get(edge.to),label=clean(edge.label||edge.name||'Related to');
          const source=add({kind:'connection',id:edge.id||`${edge.from}-${edge.to}`,boardId:board.id,title:`${from?.title||'Item'} → ${to?.title||'Item'}`,folder:boardSource.title,type:'Connection',body:`${from?.title||'Item'} ${label} ${to?.title||'Item'}`,updated:Number(edge.updated||board.updated||0)});
          link(from,to);link(source,from);link(source,to);link(source,boardSource);
        }
      }
      for(const note of data.notes||[])for(const ref of note.smartSources||[])link(byId.get(note.id),byKey.get(sourceKey(ref)));
      return result;
    }
    function ensureIndex(force=false) {
      const next=buildSources(app.getData()), nextMap=new Map(), upserts=[], removals=[];
      for(const source of next) {
        const signature=metadata(source), previous=sourceMap.get(source.key);
        nextMap.set(source.key,source);
        if(force||!previous||previous.body!==source.body||signatures.get(source.key)!==signature)upserts.push(source);
        signatures.set(source.key,signature);
      }
      for(const key of sourceMap.keys())if(!nextMap.has(key)){removals.push(key);signatures.delete(key);}
      sources=next;sourceMap=nextMap;
      if(folder!=='all'&&!sources.some(source=>source.folder===folder))folder='all';
      if(!index) {
        indexError=null;
        index=root.NotejectSmartSearchWorker?.create()||core.create([]);
        upserts.length=0;for(const source of sources)upserts.push(source);
      }
      if(upserts.length||removals.length||!sourceRevision) {
        const revision=++sourceRevision;
        indexing=true;
        const full=sources, backend=index;
        indexReady=indexReady.then(()=>backend.syncDelta?backend.syncDelta(upserts,removals):backend.sync(full)).then(()=>{
          if(index===backend&&revision===sourceRevision){indexing=false;updateIndexStatus();}
        }).catch(failure=>{
          if(index===backend){indexError=failure;indexing=false;updateIndexStatus();}
        });
      }
      return indexReady.then(()=>{if(indexError)throw indexError;});
    }
    function updateIndexStatus() {
      const status=document.querySelector('.smart-index-status');
      if(status)status.textContent=indexError?'Search unavailable. Start a new session to retry.':indexing?'Preparing search…':`${sources.length} items · Ready to search`;
    }
    function hydrateResult(result,map=sourceMap) {return {...map.get(result.key),...result};}
    function eligible(source) {
      const kindMatch=kind==='all'||(kind==='highlight'?source.isHighlight:kind==='note'?source.kind==='note'&&!source.isHighlight:source.kind===kind);
      return kindMatch&&(folder==='all'||source.folder===folder);
    }
    function recent(limit=8) { return sources.filter(eligible).slice().sort((a,b)=>b.updated-a.updated||a.title.localeCompare(b.title)).slice(0,limit); }
    async function findMatches(value=query,options={kind,folder},current=()=>true) {
      // render()/refresh() synchronize library edits. Keystrokes reuse that
      // revision without rebuilding source metadata or copying book text.
      const ready=index?indexReady:ensureIndex(), map=sourceMap;
      const latest=(!clean(value)||/\b(?:recent|latest|newest)\b/i.test(value))?[...map.values()].filter(source=>{
        const category=options.kind==='all'||(options.kind==='highlight'?source.isHighlight:options.kind==='note'?source.kind==='note'&&!source.isHighlight:source.kind===options.kind);
        return category&&(options.folder==='all'||source.folder===options.folder);
      }).sort((a,b)=>b.updated-a.updated||a.title.localeCompare(b.title)).slice(0,8):[];
      await ready;
      if(!current())return [];
      if(indexError)throw indexError;
      const found=(await index.search(value,{...options,limit:12})).map(result=>hydrateResult(result,map));
      return found.length||!/\b(?:recent|latest|newest)\b/i.test(value)?found:latest.map(source=>({...source,reasons:['Recently updated, as requested']}));
    }
    function excerpt(source,limit=180,terms=query) {
      const prepared=limit>280?source.context:source.snippet;
      if(typeof prepared==='string')return prepared.slice(0,limit);
      if(index?.getStats?.().worker)return String(source.body||'').slice(0,limit*4).replace(/\s+/g,' ').trim().slice(0,limit);
      const text=clean(source.body);if(!text)return '';
      let at=-1;for(const word of clean(terms).toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]) {const i=text.toLocaleLowerCase().indexOf(word);if(i>=0&&(at<0||i<at))at=i;}
      const start=at>limit/2?Math.max(0,at-Math.floor(limit/3)):0;
      return (start?'…':'')+text.slice(start,start+limit)+(start+limit<text.length?'…':'');
    }
    function reference(source) {
      return {key:source.key||sourceKey(source),kind:source.kind,id:source.id,boardId:source.boardId,title:source.title,type:source.type,folder:source.folder,isHighlight:source.isHighlight};
    }
    function sourceButton(source,label) {
      return `<button type="button" data-smart-open="${escape(source.key||sourceKey(source))}">${label||escape(source.title)}</button>`;
    }
    function sourceCard(source,position) {
      const missing=source.kind==='document'&&['PDF','DJVU','EPUB','TXT'].includes(source.type)&&!source.indexed;
      return `<article class="smart-source-row"><button type="button" class="smart-source" data-smart-open="${escape(source.key)}" title="Open ${escape(source.title)}"><span class="smart-source-index">${position+1}</span><span class="smart-source-copy"><b>${escape(source.title)}</b><small>${escape(source.type)}<span data-i18n-ignore> · ${escape(source.folder)}</span></small>${source.body?`<span class="smart-source-preview">${escape(excerpt(source))}</span>`:''}${missing?'<span class="smart-index-hint">Open in Reader to index text</span>':''}${source.reasons?.length?`<span class="smart-match-reason">${escape(source.reasons.slice(0,2).join(' · '))}</span>`:''}</span><span class="smart-source-arrow">↗</span></button><div class="smart-source-actions"><button type="button" data-smart-related="${escape(source.key)}">Related</button>${['note','document'].includes(source.kind)?`<button type="button" data-smart-tags="${escape(source.key)}">Suggest tags</button>`:''}</div></article>`;
    }
    function citationList(refs=[]) {
      return refs.length?`<div class="smart-citation-list"><small>Sources</small>${refs.map((source,i)=>sourceButton(source,`<b>[S${i+1}]</b>${escape(source.title)}`)).join('')}</div>`:'';
    }
    function welcome() {
      return `<div class="smart-welcome"><div class="smart-mark">✧</div><div class="smart-eyebrow">YOUR KNOWLEDGE, CONNECTED</div><h2>Find the idea you need.</h2><p>Search in your own words, collect key passages, and discover connections across your workspace.</p><div class="smart-prompts"><button type="button" class="smart-prompt" data-smart-prompt="search"><span>⌕</span>Search my library</button><button type="button" class="smart-prompt" data-smart-prompt="summary"><span>≡</span>Summarize recent sources</button><button type="button" class="smart-prompt" data-smart-prompt="related"><span>⌘</span>Find related ideas</button><button type="button" class="smart-prompt" data-smart-prompt="review"><span>▣</span>Review my library</button></div><small class="smart-local-note">On-device tools work without a key. Summaries quote your existing text.</small></div>`;
    }
    function renderMessages() {
      if(!messages.length&&!pending&&!localPending)return welcome()+(error?`<div class="smart-error" role="alert">${escape(error)}</div>`:'');
      return `<div class="smart-conversation" aria-live="polite">${messages.map((message,i)=>`<article class="smart-message smart-message-${message.role}"><div class="smart-message-label">${message.role==='user'?'YOU':message.mode==='ai'?'AI · '+escape(message.model):'ON DEVICE'}</div><div class="smart-message-body">${escape(message.content)}</div>${message.role==='assistant'?citationList(message.sources):''}${message.tags?.length?`<div class="smart-tag-list">${message.tags.map(tag=>`<span>#${escape(tag)}</span>`).join('')}<button type="button" data-smart-apply-tags="${i}" ${message.tagsApplied?'disabled':''}>${message.tagsApplied?'Tags added':'Add tags'}</button></div>`:''}${message.role==='assistant'?`<button type="button" class="smart-save-answer" data-smart-save="${i}">＋ Save as a note</button>`:''}</article>`).join('')}${(pending||localPending)?`<div class="smart-thinking" role="status"><span></span><span></span><span></span> ${pending?'Asking your selected AI model…':'Working with your library…'}</div>`:''}${error?`<div class="smart-error" role="alert">${escape(error)}</div>`:''}</div>`;
    }
    function renderResults() {
      return matches.length?matches.map(sourceCard).join(''):`<div class="smart-source-empty"><span>⌕</span><b>${sources.length?'No matching items':'Your library is ready to grow'}</b><p>${sources.length?'Try another word, or change the category and project.':'Add a note or import a document to get started.'}</p></div>`;
    }
    function render() {
      ensureIndex().catch(()=>{});
      if(!clean(query))matches=recent();
      else matches=matches.filter(source=>sourceMap.has(source.key)&&eligible(source));
      const folders=[...new Set(sources.map(source=>source.folder))].sort((a,b)=>a.localeCompare(b));
      const indexed=sources.filter(s=>s.kind==='document'&&['PDF','DJVU','EPUB','TXT'].includes(s.type)&&s.indexed).length;
      const readable=sources.filter(s=>s.kind==='document'&&['PDF','DJVU','EPUB','TXT'].includes(s.type)).length;
      return `<section class="smart-engine"><header class="smart-engine-heading"><div><div class="smart-eyebrow">SEARCH · CONNECT · ORGANIZE</div><h1>Smart Engine</h1><p>A helping hand for your notes, reading, and projects.</p></div><div class="smart-heading-actions"><div class="smart-model-badge"><span>✧</span><div><small>${mode==='local'?'ON THIS DEVICE':'NOTEJECT AI'}</small><b>${mode==='local'?'Local knowledge tools':escape('Managed by Noteject')}</b></div></div><button type="button" class="secondary smart-new-chat" data-smart-clear>New session</button></div></header><div class="smart-mode-tabs" role="group" aria-label="Engine mode"><button type="button" data-smart-mode="local" class="${mode==='local'?'active':''}" aria-pressed="${mode==='local'}">On-device tools <small>No account needed</small></button><button type="button" data-smart-mode="ai" class="${mode==='ai'?'active':''}" aria-pressed="${mode==='ai'}">AI answer <small>Use your Noteject plan</small></button><span class="smart-index-status">${indexing?'Preparing search… · ':''}${sources.length} items · ${indexed}/${readable} readable files indexed</span></div><div class="smart-layout"><div class="smart-main">${mode==='local'?`<div class="smart-tool-tabs" role="group" aria-label="Local tool">${localTools.map(([value,label])=>`<button type="button" data-smart-tool="${value}" class="${tool===value?'active':''}" aria-pressed="${tool===value}">${label}</button>`).join('')}</div>`:`<div class="smart-ai-status"><span class="smart-connection-status">${escape(connection||'Uses Noteject AI with your account and monthly allowance.')}</span><button type="button" data-smart-settings>AI settings ↗</button></div>`}<div class="smart-conversation-wrap">${renderMessages()}</div><form class="smart-composer" id="smart-engine-form"><label for="smart-engine-query">${mode==='ai'?'Ask a question about matching sources':tool==='review'?'Optional topic for your next search':'Search or describe a topic'}</label><div class="smart-composer-row"><input id="smart-engine-query" value="${escape(query)}" maxlength="1200" placeholder="Try: notes about memory, physics, or a project name…" autocomplete="off"><button class="primary" type="submit" ${(pending||localPending)?'disabled':''}>${mode==='ai'?'Ask AI ✧':localTools.find(([value])=>value===tool)?.[1]||'Search'}</button>${(pending||localPending)?'<button type="button" class="secondary" data-smart-cancel>Stop</button>':''}</div><div class="smart-composer-foot"><span>${mode==='local'?'Search, summaries, connections, and suggestions run on this device.':'Only the matching source excerpts and this conversation are sent when you ask.'}</span><small>${mode==='local'?'Enter to run the selected tool':'Uses your Noteject AI plan allowance'}</small></div></form></div><aside class="smart-results"><header><div><div class="smart-eyebrow">YOUR LIBRARY</div><h2>Matching sources</h2></div><span class="smart-source-count">${matches.length}</span></header><div class="smart-filter-row"><select id="smart-kind" aria-label="Source category">${[['all','Everything'],['note','Notes'],['highlight','Highlights'],['document','Documents'],['board','Boards'],['connection','Connections']].map(([value,label])=>`<option value="${value}" ${kind===value?'selected':''}>${label}</option>`).join('')}</select><select id="smart-folder" aria-label="Source project"><option value="all">All projects</option>${folders.map(value=>`<option value="${escape(value)}" ${folder===value?'selected':''}>${escape(value)}</option>`).join('')}</select></div><p class="smart-source-hint">${query.trim()?'Ranked by text, tags, and title matches.':'Recently updated items. Type a topic to search.'}</p><div class="smart-source-list">${renderResults()}</div><div class="smart-source-footer"><small>PDF and DjVu text is indexed while Reader is idle. EPUB and TXT text joins after opening. Very large native documents can have partial indexes. Images, video, and other files are searchable by their names and tags.</small></div></aside></div></section>`;
    }
    function paint(focus=false) {
      if(app.isActive&&!app.isActive())return;
      app.render();
      if(focus)document.querySelector('#smart-engine-query')?.focus({preventScroll:true});
      const conversation=document.querySelector('.smart-conversation-wrap');
      if(conversation){const latest=conversation.querySelector?.('.smart-message:last-of-type');conversation.scrollTop=pending?conversation.scrollHeight:latest?.getBoundingClientRect?Math.max(0,latest.getBoundingClientRect().top-conversation.getBoundingClientRect().top+conversation.scrollTop-8):0;}
    }
    async function updateResults() {
      const number=++resultNumber, value=query, options={kind,folder};
      try {
        const found=await findMatches(value,options,()=>number===resultNumber&&value===query&&options.kind===kind&&options.folder===folder);
        if(number!==resultNumber||value!==query||options.kind!==kind||options.folder!==folder)return;
        matches=found;
      }catch(failure){if(number!==resultNumber)return;matches=[];error=failure.message||'Search is unavailable. Start a new session to retry.';}
      const shell=document.querySelector('#view .smart-engine');if(!shell)return;
      const list=shell.querySelector('.smart-source-list');if(list)list.innerHTML=renderResults();
      const count=shell.querySelector('.smart-source-count');if(count)count.textContent=String(matches.length);
      const hint=shell.querySelector('.smart-source-hint');if(hint)hint.textContent=indexError?error:query.trim()?'Ranked by text, tags, and title matches.':'Recently updated items. Type a topic to search.';
      updateIndexStatus();
    }
    function addAnswer(content,selected=[],extra={}) {
      const unique=[...new Map(selected.map(source=>[source.key||sourceKey(source),reference(source)])).values()];
      messages.push({role:'assistant',mode:'local',question:query||localTools.find(([value])=>value===tool)?.[1]||'Library review',content,sources:unique,...extra});
      error='';paint(true);
    }
    function runRelated(source) {return runLocal('related',source);}
    function runTags(source) {return runLocal('tags',source);}
    async function runLocal(operation=tool,target=null) {
      if(pending||localPending)return;
      const number=++requestNumber, submitted=query, options={kind,folder};
      const question=target?(operation==='tags'?'Tag suggestions: ':'Related ideas: ')+target.title:submitted||localTools.find(([value])=>value===operation)?.[1]||'Library review';
      localPending=true;error='';paint();
      const current=()=>number===requestNumber;
      try {
        await indexReady;
        if(indexError)throw indexError;
        if(!current())return;
        let content='', refs=[], extra={question};
        if(operation==='review') {
          const report=await index.insights();if(!current())return;
          const groups=report.duplicateGroups.slice(0,5), missing=report.missingIndexedDocuments.slice(0,5);
          refs=[...groups.flatMap(group=>group.sources.slice(0,3)),...missing].map(result=>hydrateResult(result));
          content=`Library review\n\n${report.noteCount} notes and highlights · ${report.documentCount} documents\n${report.inboxCount} items in Inbox\n${report.missingIndexedDocuments.length} readable file${report.missingIndexedDocuments.length===1?'':'s'} waiting for text indexing\n${report.duplicateGroups.length} possible duplicate group${report.duplicateGroups.length===1?'':'s'}`;
          if(groups.length)content+='\n\nPossible duplicates (review the originals):\n'+groups.map(group=>'- '+group.sources.map(source=>source.title+' ('+source.folder+')').join(' / ')).join('\n');
          if(missing.length)content+='\n\nOpen these files in Reader to make their text searchable:\n'+missing.map(source=>'- '+source.title).join('\n');
          if(report.inboxCount)content+='\n\nUse Inbox to move new notes and files into projects.';
          if(!report.noteCount&&!report.documentCount)content+='\n\nAdd a note or import a document to begin.';
        }else {
          const selected=target?[sourceMap.get(target.key)||target]:(await findMatches(submitted,options,current)).slice(0,8);
          if(!current())return;
          if(!selected.length)content='No matching items found. Try a shorter topic or change the category and project.';
          else if(operation==='related') {
            const source=selected[0];
            const found=(await index.related(source.key,{limit:12})).map(result=>hydrateResult(result)).filter(eligible).slice(0,8);
            if(!current())return;
            matches=found;refs=[source,...found];
            content=found.length?`Related to “${source.title}”:\n\n`+found.map((item,i)=>`- ${item.title} [S${i+2}]\n  ${item.reasons?.join(' · ')||'Shared terms or links'}`).join('\n'):'No related items found for “'+source.title+'” yet. Add shared tags, note links, or board connections to build its context.';
          }else if(operation==='tags') {
            const source=selected[0], tags=await index.suggestTags(source.key,{limit:5});
            refs=[source];extra={...extra,tags,tagSource:reference(source)};
            content=tags.length?`Suggested tags for “${source.title}”, based on its text:\n\n${tags.map(tag=>'#'+tag).join('  ')}`:`There is not enough distinctive text to suggest new tags for “${source.title}”. Open the file in Reader or add more detail to the note.`;
          }else if(operation==='summary') {
            const readable=selected.filter(source=>['note','document'].includes(source.kind)&&String(source.body||'').trim());
            const summary=await index.summarize(readable.map(source=>source.key),{maxSentences:6});
            refs=(summary.sourceKeys||[]).map(key=>selected.find(source=>source.key===key)).filter(Boolean);
            content=summary.sentences?.length?'Key passages from '+(submitted.trim()?'the matching sources':'recent sources')+' (quoted from your text):\n\n'+summary.sentences.map(sentence=>'- '+sentence.text+' [S'+(refs.findIndex(source=>source.key===sentence.sourceKey)+1)+']').join('\n\n'):'No readable passages are available for these matches. Open a PDF, EPUB, or TXT file in Reader to index its text, or add content to a note.';
          }else {
            refs=selected;matches=selected;
            content=(submitted.trim()?`Matching sources for “${submitted}”:`:'Recently updated sources:')+'\n\n'+selected.map((source,i)=>`- ${source.title} [S${i+1}]\n  ${excerpt(source,240,submitted)||[source.type,source.folder].join(' · ')}`).join('\n\n');
          }
        }
        if(!current())return;
        localPending=false;addAnswer(content,refs,extra);
      }catch(failure){if(current()){localPending=false;error=failure.message||'The local tool could not finish. Start a new session to retry.';paint(true);}}
    }
    function cancelRequest() {
      requestNumber++;localPending=false;if(pending){clearTimeout(pending.timer);pending.controller.abort();pending=null;}
    }
    async function askAI() {
      const question=clean(query);if(!question||pending||localPending)return;
      const filters={kind,folder,contextLimit:9500};
      const history=messages.filter(message=>message.mode==='ai'||message.role==='user').slice(-6).map(message=>({role:message.role,content:message.content.replace(/\[S\d+\]/g,'(previous source)').slice(0,3000)}));
      const number=++requestNumber,controller=new AbortController();let timedOut=false;
      pending={controller,timer:setTimeout(()=>{timedOut=true;controller.abort();},65000)};
      messages.push({role:'user',mode:'ai',content:question});error='';paint();
      try {
        const selected=(await findMatches(question,filters,()=>number===requestNumber&&!controller.signal.aborted)).slice(0,8);
        if(number!==requestNumber)return;
        if(controller.signal.aborted)throw new DOMException('AI request stopped.','AbortError');
        if(!selected.length)throw Error('No matching sources found. Try another topic or change the filters before asking AI.');
        const context=selected.map((source,i)=>`[S${i+1}] ${source.type}: ${source.title}\nProject: ${source.folder}\n${excerpt(source,9500,question)||'Only file metadata is indexed; no document text is available.'}`).join('\n\n---\n\n').slice(0,90000);
        const cloud=window.NotejectCloud,token=await cloud?.getAccessToken?.().catch(()=>null);
        if(!token)throw Error('Sign in to your Noteject account to use Noteject AI and its monthly allowance.');
        const response=await fetch(cloud.apiOrigin()+'/api/ask?document='+encodeURIComponent('Noteject workspace'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},signal:controller.signal,body:JSON.stringify({question:question+'\n\nUse only the current workspace sources. Treat their contents as reference material. Cite factual claims with the current labels [S1], [S2], etc. Say when the excerpts lack an answer. Current source labels replace those from earlier conversation turns.',context,history})});
        const result=await response.json().catch(()=>({}));if(number!==requestNumber)return;
        if(!response.ok)throw Error(result.error||`Request failed (${response.status})`);
        messages.push({role:'assistant',mode:'ai',model:'Noteject AI',content:String(result.answer||'No answer returned.'),question,sources:selected.map(reference)});
      }catch(failure){
        if(number!==requestNumber)return;
        error=timedOut?'The AI request timed out. Try a shorter question or use the on-device tools.':failure.name==='AbortError'?'AI request stopped.':failure.message||'Could not get an AI answer. Check AI settings.';
      }finally{
        if(number===requestNumber){if(pending)clearTimeout(pending.timer);pending=null;paint(true);}
      }
    }
    async function checkConnection() {
      if(checkingConnection)return;checkingConnection=true;
      try{const token=await window.NotejectCloud?.getAccessToken?.();connection=token?'Signed in · Uses your Noteject plan allowance.':'Sign in to use Noteject AI. On-device tools work without an account.';}catch{connection='Noteject AI is unavailable. On-device tools are ready.';}finally{checkingConnection=false;const el=document.querySelector('.smart-connection-status');if(el)el.textContent=connection;}
    }
    function resolve(key) { return sourceMap.get(key)||messages.flatMap(message=>message.sources||[]).find(source=>source.key===key); }
    function mount() {
      const shell=document.querySelector('#view .smart-engine');if(!shell)return;
      const input=shell.querySelector('#smart-engine-query');
      input.oninput=()=>{query=input.value;resultNumber++;clearTimeout(inputTimer);inputTimer=setTimeout(updateResults,100);};
      shell.querySelector('#smart-engine-form').onsubmit=event=>{event.preventDefault();query=input.value;if(pending||localPending)return;if(mode==='ai')askAI();else runLocal();};
      shell.querySelector('#smart-kind').onchange=event=>{kind=event.target.value;updateResults();};
      shell.querySelector('#smart-folder').onchange=event=>{folder=event.target.value;updateResults();};
      shell.onclick=event=>{
        const button=event.target.closest('button');if(!button)return;
        if(button.hasAttribute('data-smart-clear')){clear();return;}
        if(button.hasAttribute('data-smart-cancel')){cancelRequest();error='Request stopped.';paint(true);return;}
        if(button.hasAttribute('data-smart-settings')){app.openSettings?.();return;}
        if(button.hasAttribute('data-smart-mode')){cancelRequest();mode=button.dataset.smartMode;error='';paint(true);if(mode==='ai')checkConnection();return;}
        if(button.hasAttribute('data-smart-tool')){cancelRequest();tool=button.dataset.smartTool;paint(true);return;}
        if(button.hasAttribute('data-smart-prompt')){cancelRequest();tool=button.dataset.smartPrompt;mode='local';if(tool==='search'){paint(true);return;}runLocal();return;}
        if(button.hasAttribute('data-smart-open')){const source=resolve(button.dataset.smartOpen);if(source)app.openSource(source);return;}
        if(button.hasAttribute('data-smart-related')){cancelRequest();mode='local';tool='related';const source=resolve(button.dataset.smartRelated);if(source)runRelated(source);return;}
        if(button.hasAttribute('data-smart-tags')){cancelRequest();mode='local';const source=resolve(button.dataset.smartTags);if(source)runTags(source);return;}
        if(button.hasAttribute('data-smart-save')){const message=messages[Number(button.dataset.smartSave)];if(message?.role==='assistant')app.saveAnswer(message.question,message.content,message.sources);return;}
        if(button.hasAttribute('data-smart-apply-tags')){const message=messages[Number(button.dataset.smartApplyTags)];if(message?.tags?.length&&app.addTags?.(message.tagSource,message.tags)!==false){message.tagsApplied=true;paint();}return;}
      };
      updateResults();
      if(mode==='ai')checkConnection();
    }
    function clear() {
      cancelRequest();resultNumber++;clearTimeout(inputTimer);query='';messages=[];matches=[];error='';
      if(indexError){index?.destroy?.();index=null;indexError=null;indexReady=Promise.resolve();sourceRevision=0;}
      paint(true);
    }
    function refresh() {ensureIndex().catch(()=>{});updateResults();}
    function search(value) { cancelRequest();query=clean(value);mode='local';tool='search';error='';app.openEngine(); }
    document.addEventListener('keydown',event=>{
      if(!(event.ctrlKey||event.metaKey)||!event.shiftKey||event.key.toLocaleLowerCase()!=='k'||event.isComposing)return;
      event.preventDefault();event.stopImmediatePropagation();app.openEngine();
    },true);
    root.addEventListener?.('pagehide',()=>{cancelRequest();resultNumber++;index?.destroy?.();index=null;indexError=null;sourceRevision=0;indexReady=Promise.resolve();});
    return {render,mount,clear,refresh,search,getStats:()=>index?.getStats?.()||{worker:false,sourceCount:sources.length}};
  }
  root.NotejectSmartEngine=Object.freeze({create});
})(window);
