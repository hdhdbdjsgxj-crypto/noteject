'use strict';
const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..');
function edit(file,run){const full=path.join(root,file);fs.writeFileSync(full,run(fs.readFileSync(full,'utf8').replace(/\r\n/g,'\n')));}
function swap(source,from,to){if(source.includes(to))return source;if(!source.includes(from))throw Error('Missing EPUB integration target: '+from.slice(0,100));return source.replaceAll(from,to);}
edit('app.js',s=>{
  s=s.replace('pdfReader?.dispose();pdfReader=null;const previous=pdfDoc;', 'pdfReader?.dispose();pdfReader=null;epubScroll?.dispose();epubScroll=null;const previous=pdfDoc;');
  s=swap(s,"if(d.type==='epub'&&reader)reader.scrollTop=Number.isFinite(resume.chapterOffset)?resume.chapterOffset*Math.max(0,reader.scrollHeight-reader.clientHeight):resume.scroll;", "if(d.type==='epub'&&reader&&epubScroll)await epubScroll.goToChapter(epubChapter,Number.isFinite(resume.chapterOffset)?resume.chapterOffset:0);");
  s=swap(s,"doc.readerChapter=epubChapter;doc.readerChapterOffset=Math.max(0,Math.min(1,reader.scrollTop/Math.max(1,reader.scrollHeight-reader.clientHeight)))", "doc.readerChapter=epubScroll?.getLocation().chapterIndex??epubChapter;doc.readerChapterOffset=epubScroll?.getLocation().offset??0");
  s=swap(s,"doc?.type==='epub'?$('#epub-text'):doc?.type==='txt'?$('#txt-content'):null;if(!term||!root)return;", "doc?.type==='epub'?(epubScroll?.getSection(active?.type==='epub'?active.chapter:epubChapter)||$('#epub-text')):doc?.type==='txt'?$('#txt-content'):null;if(!term||!root)return;");
  s=swap(s,"const content=isPagedReaderDoc(doc)?(element?.closest('.pdf-text-layer')||pdfReader?.getTextLayer()):doc.type==='epub'?$('#epub-text'):$('#txt-content');", "const content=isPagedReaderDoc(doc)?(element?.closest('.pdf-text-layer')||pdfReader?.getTextLayer()):doc.type==='epub'?(element?.closest('.epub-section')||epubScroll?.getSection(epubChapter)):$('#txt-content');");
  s=swap(s,"chapter:epubTitles[chapterIndex]||`Chapter ${chapterIndex+1}`,scroll}", "chapter:epubTitles[chapterIndex]||`Chapter ${chapterIndex+1}`,scroll:epubScroll?.getLocation(chapterIndex).offset??scroll}");
  s=swap(s,"function readerPassageContent(docId,page){", "function readerPassageContent(docId,page,chapter=epubChapter){");
  s=swap(s,"doc.type==='epub'?$('#epub-text'):$('#txt-content');return content?.dataset.readerDocument===docId?content:null}", "doc.type==='epub'?(epubScroll?.getSection(chapter)||null):$('#txt-content');return content?.dataset.readerDocument===docId?content:null}");
  s=swap(s,'readerPassageContent(docId,location.page);','readerPassageContent(docId,location.page,location.chapterIndex??epubChapter);');
  const anchorStart=s.indexOf('function scrollToEpubAnchor(anchor)'),anchorEnd=s.indexOf('\nasync function unzip',anchorStart);
  if(anchorStart>=0)s=s.slice(0,anchorStart)+`function scrollToEpubAnchor(anchor,chapter=epubChapter){if(!anchor)return;let target=String(anchor);try{target=decodeURIComponent(target)}catch{}const page=epubScroll?.getSection(chapter)||$('#epub-text');if(!page)return;const node=[...page.querySelectorAll('[id],[name]')].find(el=>el.id===target||el.getAttribute('name')===target);node?.scrollIntoView({behavior:'auto',block:'start'})}`+s.slice(anchorEnd);
  s=swap(s,"else{if(doc.type==='epub'&&Number.isFinite(location.chapterIndex))await showEpubChapter(location.chapterIndex);if(data.selected?.id!==doc.id)return;const reader=$('.reader-content');if(reader)reader.scrollTop=Math.max(0,Number(location.scroll)||0)*Math.max(0,reader.scrollHeight-reader.clientHeight)}readerWorkspace.updateLocation();", "else if(doc.type==='epub'&&Number.isFinite(location.chapterIndex)){await showEpubChapter(location.chapterIndex);if(data.selected?.id===doc.id)await epubScroll?.goToChapter(location.chapterIndex,location.scroll||0)}else{const reader=$('.reader-content');if(reader)reader.scrollTop=Math.max(0,Number(location.scroll)||0)*Math.max(0,reader.scrollHeight-reader.clientHeight)}readerWorkspace.updateLocation();");
  s=swap(s,"else reader.scrollTo({top:(Number(location.scroll)||0)*Math.max(0,reader.scrollHeight-reader.clientHeight),behavior:'smooth'});", "else if(doc.type==='epub')await epubScroll?.goToChapter(location.chapterIndex||0,location.scroll||0);else reader.scrollTo({top:(Number(location.scroll)||0)*Math.max(0,reader.scrollHeight-reader.clientHeight),behavior:'smooth'});");
  return s;
});
edit('reader-workspace.js',s=>{
  s=swap(s,'sequenceNavigation = isPaged || isEpub','sequenceNavigation = isPaged');
  s=s.replace(/\$\{button\('(previous|next)',([^}]+)\)\}/g,(_match,direction,args)=>"${isEpub?'':button('"+direction+"',"+args+")}");
  s=swap(s,"isEpub?'<select id=\"epub-toc\" aria-label=\"Go to chapter\"><option>Loading chapters…</option></select>'", "isEpub?'<span class=\"reader-continuous-label\">Reader</span>'");
  s=s.replace(/\$\{isEpub\?button\('(previous|next)',[^}]+?:''\}/g,'');
  s=swap(s,"file?.type === 'pdf' || file?.type === 'djvu' || file?.type === 'epub', unit", "file?.type === 'pdf' || file?.type === 'djvu', unit");
  s=swap(s,'ratio=clamp(viewport.scrollTop/Math.max(1,viewport.scrollHeight-viewport.clientHeight),0,1),lengths=', 'ratio=app.getEpubLocation?.()?.offset??clamp(viewport.scrollTop/Math.max(1,viewport.scrollHeight-viewport.clientHeight),0,1),lengths=');
  s=swap(s,"page=shell.querySelector('#epub-text');let activeLink", "page=app.getEpubSection?.(current)||shell.querySelector('#epub-text');let activeLink");
  return s;
});
edit('android/ui/android-reader-ui.js',s=>{
  s=swap(s,"if (!viewport) return;\n    const ignored", "if (!viewport || shell.dataset.arKind === 'epub') return () => {};\n    const ignored");
  s=swap(s,"shell.dataset.arKind = shell.querySelector('#pdf-page-input')", "shell.dataset.arKind = shell.dataset.readerType || (shell.querySelector('#pdf-page-input')");
  s=swap(s,": reading ? 'txt' : 'attachment';", ": reading ? 'txt' : 'attachment');");
  s=swap(s,'panel.append(tapSetting);',"if(shell.dataset.arKind!=='epub')panel.append(tapSetting);");
  s=swap(s,'panel.append(help);',"if(shell.dataset.arKind!=='epub')panel.append(help);");
  return s;
});
edit('index.html',s=>{
  s=swap(s,'<script src="reader-epub.js?v=reader-1"></script>','<script src="reader-epub.js?v=reader-1"></script><script src="reader-epub-scroll.js?v=1"></script>');
  for(const [a,b] of [['app.js?v=web-workspace-5','app.js?v=web-workspace-6'],['reader-workspace.js?v=reader-31','reader-workspace.js?v=reader-32'],['reader-workspace.css?v=reader-14','reader-workspace.css?v=reader-15'],['reader-selections.js?v=noteject-17','reader-selections.js?v=noteject-18']])s=swap(s,a,b);
  return s;
});
for(const file of ['package.json','package-lock.json'])edit(file,s=>swap(s,'"version": "0.2.49"','"version": "0.2.50"'));
edit('android/app/build.gradle',s=>swap(swap(s,"versionCode 120","versionCode 121"),"versionName '1.10.46'","versionName '1.10.47'"));
