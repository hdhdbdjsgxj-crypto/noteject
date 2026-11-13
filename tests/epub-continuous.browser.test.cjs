'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),{zip}=require('./backup-fixture.cjs');
const root=path.resolve(__dirname,'..'),origin='https://noteject.test';
function book(count=10){
  const files={'mimetype':'application/epub+zip','META-INF/container.xml':'<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'};
  files['OPS/book.opf']='<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Continuous book</dc:title><dc:language>en</dc:language></metadata><manifest>'+Array.from({length:count},(_,i)=>'<item id="c'+i+'" href="c'+i+'.xhtml" media-type="application/xhtml+xml"/>').join('')+'</manifest><spine>'+Array.from({length:count},(_,i)=>'<itemref idref="c'+i+'"/>').join('')+'</spine></package>';
  for(let i=0;i<count;i++)files['OPS/c'+i+'.xhtml']='<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Section '+i+'</title><style>body{font-size:10px}p.tone{color:'+(i%2?'rgb(0,0,255)':'rgb(255,0,0)')+'}</style></head><body><h1 id="same">Section '+i+'</h1><a class="far-link" href="c6.xhtml#same">Go to section six</a>'+Array.from({length:28},(_,p)=>'<p class="tone">Chapter '+i+' paragraph '+p+'. Unique source phrase '+i+'-'+p+'. Reading continuously preserves passages and images across the whole book.</p>').join('')+'</body></html>';
  files['OPS/images/tiny.gif']=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  for(let i=0;i<count;i++)files['OPS/c'+i+'.xhtml']=files['OPS/c'+i+'.xhtml'].replace('</h1>','</h1><img class="illustration" src="images/tiny.gif" width="8" height="8" alt="Illustration"/>');
  return zip(files);
}
async function app(browser,platform,run){
  const android=platform==='android',mobile=android||platform==='web-mobile',base=android?path.join(root,'android/app/src/main/assets'):root;
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1400,height:1000},hasTouch:mobile,isMobile:mobile});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.fulfill({status:404,body:''});if(url.pathname.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,configured:false,cloudEnabled:false,fileStorage:true,models:[]})});const file=path.resolve(base,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});return route.fulfill({contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});});
  await context.addInitScript(platform=>{
    localStorage.setItem('noteject',JSON.stringify({boards:[{id:'board',name:'Board',items:[],edges:[]}],activeBoard:'board',notes:[],docs:[],folders:['Inbox'],noteFolders:['Inbox'],trash:[]}));localStorage.setItem('noteject-reader-workspace',JSON.stringify({navigation:false,tools:false}));
    if(platform==='android')window.NotejectAndroid={getAppVersion:()=> '1.10.47',setAppLanguage(){},apiRequest(route,method,body,id){queueMicrotask(()=>window.__notejectAndroidResponse(id,JSON.stringify({ok:true,configured:false,fileStorage:true}),200));}};
    else if(platform==='windows')window.NotejectDesktop={version:'0.2.50',fileApiBase:location.origin,setAppLanguage(){}};
    else {window.NotejectWebApp=true;document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('noteject-web'),{once:true});}
  },platform);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  try{await page.goto(origin);await page.waitForFunction(()=>typeof openDocument==='function');
    await page.evaluate(async bytes=>{const blob=new Blob([new Uint8Array(bytes)],{type:'application/epub+zip'});data.docs.push({id:'epub',name:'Continuous.epub',type:'epub',folder:'Inbox',blob,size:blob.size,added:Date.now()});await openDocument('epub');},[...book()]);
    await page.waitForFunction(()=>document.querySelector('.epub-section:not(.is-pending) p'));await run(page);assert.deepEqual(errors,[]);
  }finally{await context.close();}
}
test('EPUB scrolls across sections, keeps per-section styles, saves cross-section passages and restores bookmarks on every platform',{timeout:180000},async t=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});t.after(()=>browser.close());
  for(const platform of ['web-desktop','web-mobile','windows','android'])await t.test(platform,async()=>app(browser,platform,async page=>{
    assert.equal(await page.locator('#epub-toc').count(),0);assert.equal(await page.locator('.reader-chapter-step').count(),0);
    assert.equal(await page.locator('[data-reader-command=previous]:visible,[data-reader-command=next]:visible').count(),0);
    await page.evaluate(()=>{window.originalSection=document.querySelector('#epub-section-0').firstElementChild;});
    await page.evaluate(()=>readerWorkspace.run('next'));await page.waitForFunction(()=>document.querySelector('.reader-content').scrollTop>100);
    assert.equal(await page.evaluate(()=>epubChapter),0,'page commands should scroll through text rather than switch chapters');
    await page.evaluate(()=>readerWorkspace.run('previous'));await page.waitForFunction(()=>document.querySelector('.reader-content').scrollTop<30);
    await page.waitForFunction(()=>!!epubScroll.getSection(1));
    await page.waitForFunction(()=>document.querySelector('#epub-section-1 img')?.naturalWidth===1);
    await page.evaluate(()=>{const reader=document.querySelector('.reader-content'),next=document.querySelector('#epub-section-1');reader.scrollTop+=next.getBoundingClientRect().top-reader.getBoundingClientRect().top+100;});
    await page.waitForFunction(()=>epubChapter===1);assert.equal(await page.evaluate(()=>originalSection.isConnected),true);
    const colors=await page.evaluate(()=>[0,1].map(i=>getComputedStyle(document.querySelector('#epub-section-'+i+' p')).color));assert.deepEqual(colors,['rgb(255, 0, 0)','rgb(0, 0, 255)']);
    await page.evaluate(()=>document.querySelector('#epub-section-1 .far-link').click());await page.waitForFunction(()=>epubChapter===6&&!!epubScroll.getSection(6));
    assert.equal(await page.evaluate(()=>Math.abs(document.querySelector('#epub-section-6 #same').getBoundingClientRect().top-document.querySelector('.reader-content').getBoundingClientRect().top)<70),true);
    await page.evaluate(async()=>{await extractionPromise;readerSearchQuery='Unique source phrase 7-12';refreshReaderSearch();await activateReaderSearchResult(0);});await page.waitForFunction(()=>epubChapter===7);
    assert.equal(await page.evaluate(()=>!!CSS.highlights?.get('noteject-reader-search-current')),true);await page.evaluate(()=>clearReaderSearch());
    await page.evaluate(async()=>{await showEpubChapter(3);document.querySelector('.reader-content').scrollTop+=150;});await page.waitForFunction(()=>epubChapter===3);
    await page.evaluate(()=>readerWorkspace.run('bookmark'));const mark=await page.evaluate(()=>data.docs.find(doc=>doc.id==='epub').bookmarks[0]);assert.equal(mark.location.chapterIndex,3);assert.ok(mark.location.scroll>0);
    await page.evaluate(async()=>{await showEpubChapter(8);await jumpToReaderBookmark(data.docs.find(doc=>doc.id==='epub').bookmarks[0]);});await page.waitForFunction(()=>epubChapter===3);
    assert.ok(Math.abs(await page.evaluate(()=>epubScroll.getLocation().offset)-mark.location.scroll)<.08);
    await page.evaluate(async()=>{
      await epubScroll.loadSection(4);const a=epubScroll.getSection(3).querySelector('p:last-of-type').firstChild,b=epubScroll.getSection(4).querySelector('p').firstChild;
      const range=document.createRange();range.setStart(a,0);range.setEnd(b,45);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));
      window.NotejectReaderSurfaces={...window.NotejectReaderSurfaces,hasComposer:()=>true,compose:(options,callback)=>{window.capturedQuote=options.quote;callback({action:'save',fields:{title:'Across sections',folder:'Inbox',comment:'',color:'violet',tags:''}});}};
      readerSelections.mount(false);readerSelections.capture();
    });
    await page.waitForFunction(()=>data.notes.some(note=>note.title==='Across sections')).catch(async error=>{console.log('EPUB capture state',await page.evaluate(()=>({captured:window.capturedQuote,status:document.querySelector('.clip-status')?.textContent,notes:data.notes.map(note=>({title:note.title,quote:note.selectionQuote})),selection:getSelection()?.toString(),root:!!document.querySelector('#reader-selections'),toast:document.getElementById('toast')?.textContent})));throw error;});
    const saved=await page.evaluate(()=>data.notes.find(note=>note.title==='Across sections'));
    assert.equal(saved.selectionLocation.chapterIndex,3);assert.equal(saved.selectionLocation.endChapterIndex,4);assert.equal(saved.selectionLocation.chapters.length,2);assert.match(saved.selectionQuote,/Chapter 3/);assert.match(saved.selectionQuote,/Chapter 4/);
    await page.evaluate(async()=>{await showEpubChapter(9);await jumpToSavedSelection(data.notes.find(note=>note.title==='Across sections').id);});await page.waitForFunction(()=>epubChapter===3);
    await page.evaluate(()=>saveReaderProgress());const progress=await page.evaluate(()=>({chapter:data.docs.find(doc=>doc.id==='epub').readerChapter,offset:data.docs.find(doc=>doc.id==='epub').readerChapterOffset}));
    await page.evaluate(async()=>{openWorkspaceView('library');await openDocument('epub');});await page.waitForFunction(()=>epubChapter===3&&!!epubScroll.getSection(3));
    assert.ok(Math.abs(await page.evaluate(()=>epubScroll.getLocation().offset)-progress.offset)<.12);
  }));
});
test('Continuous spine bounds loaded chapters, protects selections, and discards late resources after close',{timeout:60000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try{const page=await browser.newPage();await page.setContent('<div id="viewport" style="height:500px;width:400px;overflow:auto"><article id="book"></article></div>');await page.addScriptTag({path:path.join(root,'reader-epub-scroll.js')});
    await page.evaluate(async()=>{window.loads=[];window.releases=[];window.scrollBook=NotejectEpubScroll.create({load:async index=>{loads.push(index);await new Promise(resolve=>setTimeout(resolve,10));return{html:'<p style="margin:0;height:1200px">Chapter '+index+'</p>',release:()=>releases.push(index)};}});await scrollBook.mount({container:document.getElementById('book'),viewport:document.getElementById('viewport'),count:200,documentId:'large',chapter:60,offset:.35});});
    assert.ok(await page.evaluate(()=>loads.length)<10);assert.equal(await page.evaluate(()=>scrollBook.getLocation().chapterIndex),60);
    await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(scrollBook.getSection(60));getSelection().removeAllRanges();getSelection().addRange(range);});
    for(const chapter of [80,100,120,150])await page.evaluate(chapter=>scrollBook.goToChapter(chapter),chapter);
    assert.equal(await page.evaluate(()=>!!scrollBook.getSection(60)),true);assert.ok(await page.evaluate(()=>document.querySelectorAll('.epub-section:not(.is-pending)').length)<=9);
    await page.evaluate(async()=>{const job=scrollBook.loadSection(190);scrollBook.dispose();await job;});assert.equal(await page.locator('#viewport').evaluate(el=>el.style.overflowAnchor),'');
    assert.equal(await page.evaluate(()=>loads.every(index=>releases.includes(index))),true);
  }finally{await browser.close();}
});
