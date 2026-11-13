/* Continuous EPUB spine: stable section hosts, bounded live chapters, and chapter-relative locations. */
(function(root){
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function create(options){
    let container=null,viewport=null,entries=[],alive=false,frame=0,observer=null,resize=null,current=0,active=null,navigation=0,interaction=0,oldAnchor='',generation=0,positioning=0;
    const pending=new Set();
    const t=value=>root.NotejectI18n?.t(value)||value;
    const section=index=>entries[clamp(Math.trunc(Number(index)||0),0,entries.length-1)];
    function location(index){
      if(!viewport||!entries.length)return {chapterIndex:current,offset:0};
      const box=viewport.getBoundingClientRect(),entry=index==null?at(box.top+Math.min(48,box.height/5)):section(index);
      if(!entry)return {chapterIndex:0,offset:0};
      const rect=entry.host.getBoundingClientRect();
      return {chapterIndex:entry.index,offset:clamp((box.top-rect.top)/Math.max(1,rect.height-Math.min(box.height,rect.height/2)),0,1)};
    }
    function at(y){let low=0,high=entries.length-1;while(low<high){const mid=(low+high)>>1;if(entries[mid].host.getBoundingClientRect().bottom<=y)low=mid+1;else high=mid;}return entries[low];}
    function anchor(){const box=viewport.getBoundingClientRect(),entry=at(box.top+32);if(!entry)return null;return {entry,top:entry.host.getBoundingClientRect().top,scroll:viewport.scrollTop,interaction};}
    function restore(value){if(!value||!alive||value.interaction!==interaction)return;const delta=value.entry.host.getBoundingClientRect().top-value.top;viewport.scrollTop+=delta;}
    function update(){
      frame=0;if(!alive||positioning)return;
      const value=location();current=value.chapterIndex;container.dataset.readerChapter=String(current);
      options.onLocation?.(value);
      pump();trim();
    }
    function schedule(){if(alive&&!frame)frame=requestAnimationFrame(update);}
    function intent(){interaction++;navigation++;}
    function protectedEntry(entry){const selection=root.getSelection?.();if(!selection||selection.isCollapsed||!selection.rangeCount)return false;try{return selection.getRangeAt(0).intersectsNode(entry.host);}catch{return false;}}
    function wanted(){
      const box=viewport.getBoundingClientRect(),first=at(box.top)?.index??current,last=at(box.bottom)?.index??current,result=new Set(pending);
      for(let index=Math.max(0,first-1);index<=Math.min(entries.length-1,last+1);index++)result.add(index);
      result.add(current);return result;
    }
    function trim(){
      const residents=entries.filter(entry=>entry.payload&&!entry.promise);if(residents.length<=8)return;
      residents.sort((a,b)=>Math.abs(b.index-current)-Math.abs(a.index-current));
      let count=residents.length;const keep=wanted();
      for(const entry of residents){if(count<=8)break;if(keep.has(entry.index)||protectedEntry(entry))continue;
        const before=anchor();entry.height=Math.max(1,entry.host.getBoundingClientRect().height);entry.host.style.minHeight=entry.height+'px';
        entry.payload.release?.();entry.payload=null;entry.style?.remove();entry.style=null;entry.host.replaceChildren();entry.host.classList.add('is-pending');restore(before);count--;
      }
    }
    async function load(index){
      const entry=section(index);if(!alive||!entry)return null;if(entry.payload)return entry.host;if(entry.promise)return entry.promise;
      const ticket=generation;
      entry.promise=(async()=>{
        let payload;
        try{
          payload=await options.load(entry.index,()=>alive&&ticket===generation&&!!container?.isConnected);
          if(!alive||ticket!==generation||!container?.isConnected){payload?.release?.();return null;}
          if(!payload)throw Error('Could not open chapter');
          const before=anchor();entry.payload=payload;entry.error=null;entry.host.innerHTML=payload.html;
          entry.host.className=['epub-section',...(payload.classes||[])].join(' ');entry.host.lang=payload.lang||'';entry.host.dir=payload.dir||'auto';entry.host.style.minHeight='';
          if(payload.css){entry.style=document.createElement('style');entry.style.textContent=payload.css;document.head.append(entry.style);}
          entry.height=entry.host.getBoundingClientRect().height;restore(before);options.onContent?.(entry.index,entry.host);schedule();return entry.host;
        }catch(error){
          payload?.release?.();if(!alive||ticket!==generation)return null;entry.error=error;entry.host.classList.remove('is-pending');
          const button=document.createElement('button');button.type='button';button.className='epub-section-retry';button.textContent=t('Try again');button.title=t('Could not open chapter');
          button.onclick=()=>{entry.error=null;void load(entry.index);};entry.host.replaceChildren(button);return null;
        }finally{entry.promise=null;}
      })();return entry.promise;
    }
    function pump(){
      if(!alive||active)return;
      const next=[...wanted()].map(index=>section(index)).filter(entry=>entry&&!entry.payload&&!entry.promise&&!entry.error).sort((a,b)=>(pending.has(b.index)-pending.has(a.index))||Math.abs(a.index-current)-Math.abs(b.index-current))[0];
      if(next){const ticket=generation;active=next;void load(next.index).finally(()=>{if(ticket!==generation)return;active=null;if(alive){trim();pump();}});}
    }
    async function goToChapter(index,offset=0){
      if(!alive)return false;const entry=section(index),ticket=++navigation,mountTicket=generation;pending.add(entry.index);positioning++;
      const host=await load(entry.index);if(mountTicket!==generation)return false;positioning--;pending.delete(entry.index);if(!alive||ticket!==navigation||!host){schedule();return false;}
      current=entry.index;const rect=host.getBoundingClientRect(),box=viewport.getBoundingClientRect();
      viewport.scrollTop+=rect.top-box.top+clamp(Number(offset)||0,0,1)*Math.max(1,rect.height-Math.min(box.height,rect.height/2));
      container.dataset.readerChapter=String(current);options.onLocation?.(location());schedule();return true;
    }
    async function mount(settings){
      dispose();container=settings.container;viewport=settings.viewport;alive=true;current=clamp(settings.chapter||0,0,settings.count-1);
      oldAnchor=viewport.style.overflowAnchor;viewport.style.overflowAnchor='none';container.replaceChildren();container.classList.add('epub-continuous');container.dataset.readerDocument=settings.documentId;
      const fragment=document.createDocumentFragment();
      for(let index=0;index<settings.count;index++){
        const host=document.createElement('section');host.id='epub-section-'+index;host.className='epub-section is-pending';host.dataset.readerChapter=String(index);host.dataset.readerDocument=settings.documentId;
        const height=Math.max(500,viewport.clientHeight);host.style.minHeight=height+'px';fragment.append(host);entries.push({index,host,height,payload:null,promise:null,error:null,style:null});
      }
      container.append(fragment);viewport.addEventListener('scroll',schedule,{passive:true});viewport.addEventListener('touchstart',intent,{passive:true});viewport.addEventListener('wheel',intent,{passive:true});
      observer=new IntersectionObserver(schedule,{root:viewport,rootMargin:'100% 0px'});entries.forEach(entry=>observer.observe(entry.host));
      resize=new ResizeObserver(records=>{if(!alive)return;const top=viewport.getBoundingClientRect().top;for(const record of records){const entry=entries[Number(record.target.dataset.readerChapter)];if(!entry||entry.host!==record.target)continue;const height=entry.host.getBoundingClientRect().height,delta=height-entry.height;if(Math.abs(delta)>1&&entry.host.getBoundingClientRect().bottom<=top)viewport.scrollTop+=delta;entry.height=height;}schedule();});entries.forEach(entry=>resize.observe(entry.host));
      const starting=current,ready=await goToChapter(current,settings.offset||0);if(!alive)return false;if(!ready&&!section(starting)?.payload)throw section(starting)?.error||Error('Could not open chapter');schedule();return true;
    }
    function dispose(){
      alive=false;generation++;navigation++;positioning=0;cancelAnimationFrame(frame);frame=0;observer?.disconnect();resize?.disconnect();observer=resize=null;
      if(viewport){viewport.removeEventListener('scroll',schedule);viewport.removeEventListener('touchstart',intent);viewport.removeEventListener('wheel',intent);viewport.style.overflowAnchor=oldAnchor;}
      for(const entry of entries){entry.payload?.release?.();entry.style?.remove();}entries=[];pending.clear();active=null;container=viewport=null;
    }
    return {mount,dispose,goToChapter,getLocation:location,getSection:index=>section(index)?.payload?section(index).host:null,getRoot:()=>container,loadSection:load};
  }
  root.NotejectEpubScroll={create};
})(window);
