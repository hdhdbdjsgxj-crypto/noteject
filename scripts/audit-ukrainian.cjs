const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'web';
const output = path.join(root, 'audits', 'ukrainian-pages');
fs.mkdirSync(output, { recursive: true });
const workspace = { boards:[{id:'b',name:'Дослідження',items:[],edges:[]}],activeBoard:'b',notes:[],docs:[],folders:['Inbox'],noteFolders:['Inbox'],folderProjects:{Inbox:'inbox'},trash:[] };
async function main() {
  if(mode==='windows') {
    const native=require('../desktop/localization.cjs');
    const main=fs.readFileSync(path.join(root,'desktop/main.cjs'),'utf8');
    const section=main.slice(main.indexOf('function installApplicationMenu()'),main.indexOf('async function openExternalUrl'));
    const labels=[...section.matchAll(/(?:action\(|label:\s*)'([^']+)'/g)].map(match=>match[1]);
    if(labels.length<40||labels.some(label=>native.text(label,'uk')===label))throw Error('A Windows native menu label is missing its Ukrainian translation.');
  }
  const server = http.createServer((req,res) => {
    const pathname = decodeURIComponent(new URL(req.url,'http://local').pathname);
    if(pathname.startsWith('/api/')) {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(pathname === '/api/site-config' ? {cloudEnabled:false,aiEnabled:false} : {ok:true,models:[],configured:false,fileStorage:true,root:'projects'}));}
    const base = pathname.startsWith('/app') ? mode === 'android' ? path.join(root,'android/app/src/main/assets') : root : path.join(root,'site');
    const relative = pathname.startsWith('/app') ? pathname.replace(/^\/app\/?/,'') || 'index.html' : pathname.slice(1) || 'index.html';
    const file=path.resolve(base,relative);
    if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');
    let bytes=fs.readFileSync(file);
    if(pathname.startsWith('/app')&&relative==='index.html')bytes=Buffer.from(bytes.toString().replace('<head>','<head><base href="/app/">'));
    res.end(bytes);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:mode==='android'?{width:390,height:844}:{width:1440,height:1000}}), errors=[], report={};
  page.setDefaultTimeout(7000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://**',route=>route.abort());
  await page.addInitScript(({data,mode})=>{
    localStorage.setItem('noteject',JSON.stringify(data));localStorage.setItem('noteject-language-v1','uk');
    if(mode==='web')window.NotejectWebApp=true;
    if(mode==='windows'){window.__nativeLanguages=[];window.NotejectDesktop={version:'0.2.21',fileApiBase:location.origin,setAppLanguage(language){window.__nativeLanguages.push(language);}};}
    if(mode==='android')window.NotejectAndroid={apiRequest(route,method,body,id){queueMicrotask(()=>window.__notejectAndroidResponse(id,JSON.stringify({ok:true,fileStorage:true,configured:false}),200));},exitApp(){},setAppLanguage(){}};
  },{data:workspace,mode});
  const origin='http://127.0.0.1:'+server.address().port;
  async function capture(name) {
    await page.locator('#view details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    report[name]=await page.evaluate(()=>{
      const found=[];
      const english = text => /[a-z]{3}/i.test(text.replace(/\b(?:GNU Affero General Public License|noteject|MuPDF|DjVuLibre|DjVu|Libre|PDF|EPUB|TXT|DOCX?|XLSX?|PPTX?|Word|Excel|PowerPoint|Office|Windows|Android|macOS|Mac|Apple|Safari|Sonoma|Dock|iMac|iPhone|iPad|OpenAI|API|APK|OCR|CSV|ZIP|JSON|HTML|Markdown|AGPL|GNU|Artifex|Free|Starter|Pro|Team|Cloud|Ctrl|Alt|Left|Right|Shift|Enter|Tab|Home|Escape|Esc|Page|Up|Down|UTC|exe|later|http|https|localhost)\b/gi,''));
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      let node;
      while(node=walker.nextNode()) {
        const parent=node.parentElement, text=node.nodeValue.trim();
        if(!text||!english(text)||parent.closest('script,style,noscript,kbd,code:not(#storage-path),[contenteditable="true"],.note-list-card p,.canvas-card p,.search-result h3,.search-result p,.search-summary>b,.recent-card h3,.inbox-item-copy>p,[data-i18n-ignore],.reader-content,.reader-document-content,.epub-text')||!parent.checkVisibility({checkVisibilityCSS:true}))continue;
        if(/^(?:noteject|Research|PDF|EPUB|TXT|DjVu|Windows|Android|Free|Starter|Pro|Team|Ctrl\+.+|Alt\+.+|Shift\+.+|projects|[a-z]+@.+)$/i.test(text))continue;
        found.push({text,source:node.__notejectI18nSource||text,tag:parent.tagName});
      }
      for(const el of document.querySelectorAll('[placeholder],[title],[aria-label]'))for(const attr of ['placeholder','title','aria-label']){
        const text=el.getAttribute(attr);
        if(text&&english(text)&&el.checkVisibility({checkVisibilityCSS:true})&&!/^(?:Noteject|Research|[a-z]+@.+)$/i.test(text))found.push({text,attr,tag:el.tagName});
      }
      for(const select of document.querySelectorAll('select:not(#noteject-language):not(#noteject-language-quick)'))if(select.checkVisibility({checkVisibilityCSS:true}))for(const option of select.options)if(/[a-z]{3}/i.test(option.textContent)&&!/[а-яіїєґ]/i.test(option.textContent)&&! /^(?:Research|PDF|DJVU|EPUB|TXT|DOCX?|XLSX?|PPTX?|All notes)$/i.test(option.textContent))found.push({text:option.textContent,option:true});
      return [...new Map(found.map(item=>[item.text,item])).values()];
    });
    fs.writeFileSync(path.join(output,'coverage-'+mode+'.json'),JSON.stringify({errors,pages:report},null,2));
  }
  async function navigate(view) {
    await page.locator('dialog[open]').evaluateAll(nodes=>nodes.forEach(node=>node.close()));
    await page.locator('.nav-item[data-view="'+view+'"]').evaluate(el=>el.click());
  }
  try {
    await page.goto(origin+'/app/');
    if(mode==='android') {
      await page.evaluate(async()=>{
        window.NotejectAndroidAudio={command:async()=>({status:'idle',recordings:[],capabilities:{localTranscription:true}}),subscribe(){return()=>{};}};
        await window.NotejectAndroidAudioUI.open();
      });
      await capture('recordings');
      await page.evaluate(()=>window.NotejectAndroidAudioUI.leavePage());
    }
    for(const view of ['home','notes','reading','projects','favorites','history','collections','boardIndex','graph','smart','inbox','library','trash']) {
      await navigate(view);
      await capture(view);
      if(view==='boardIndex'){await page.evaluate(()=>{view='board';render();});await capture('empty-board');}
      if(view==='home')await page.screenshot({path:path.join(output,'home-uk-'+mode+'.png'),fullPage:true});
    }
    await page.locator('#open-settings').evaluate(el=>el.click());
    for(const section of ['general','storage','ai','about']) {
      await page.locator('[data-settings-tab="'+section+'"]').click();await capture('settings-'+section);
      if(section==='general')await page.screenshot({path:path.join(output,'settings-uk-'+mode+'.png'),fullPage:true});
    }
    await page.evaluate(()=>{
      const now=Date.now();data.notes.push({id:'n',title:'Дослідження',content:'Home\n\nCopy',folder:'Inbox',color:'violet',tags:[],updated:now});
      data.docs.push({id:'d',name:'Джерело.txt',type:'txt',text:'Home\n\nCopy',localUrl:'data:text/plain;charset=utf-8,Home%0A%0ACopy',folder:'Inbox',size:10,added:now});
      data.boards[0].items=[{id:'n',type:'note',x:400,y:400},{id:'d',type:'document',x:800,y:400}];save();
    });
    for(const view of ['notes','reading','projects','favorites','history','boardIndex','inbox','library','graph']){await navigate(view);await capture('populated-'+view);}
    await navigate('projects');
    await page.locator('[data-wo-action="new-project"]').evaluate(el=>el.click());
    const steps=await page.locator('[data-ps-step]').count();
    for(let i=0;i<steps;i++){await page.locator('[data-ps-step]').nth(i).evaluate(el=>el.click());await capture('project-setup-'+i);}
    if(mode!=='android') {
      const generated=await page.evaluate(()=>{
        const config=NotejectProjectWorkflow.defaultConfig('plan');config.name='Локалізація';config.description='Home & Copy';
        let n=0;return NotejectProjectWorkflow.build(data,config,()=> 'uk-created-'+(++n)).notes;
      });
      if(!generated.length||generated.some(note=>!note.content.includes('Home & Copy')||/^## (?:Project|Outcome|Scope|Milestones|Resources|Progress|Next)/m.test(note.content)))throw Error('New project notes were not localized or user text changed.');
    }
    await page.evaluate(()=>{view='search';query='Дослідження';render();});await capture('workspace-search');
    if(!await page.locator('.search-result p').first().textContent().then(text=>text.includes('Home')&&text.includes('Copy')))throw Error('Search translated the user note content.');
    await navigate('collections');
    await page.locator('[data-wo-action="new-collection"]').evaluate(el=>el.click());await capture('collection-editor');
    await page.evaluate(()=>{view='board';render();});await capture('board');
    await page.evaluate(()=>{boardSelection=new Set(['n','d']);render();});await capture('board-selection');
    await page.evaluate(()=>{view='notes';data.selected={type:'note',id:'n'};render();edit(data.notes[0]);});await capture('note-editor');
    if(await page.locator('#edit-body').inputValue()!=='Home\n\nCopy')throw Error('User note content was changed by localization');
    await page.evaluate(()=>{view='library';data.selected=null;render();});
    await page.evaluate(()=>openDocument('d'));await capture('reader');
    await page.evaluate(()=>window.NotejectReaderMenu.showHelp());await capture('reader-help');
    await page.locator('dialog[open] button').last().click();
    await page.locator('#noteject-cloud-trigger').evaluate(el=>el.click());await capture('account');
    await page.locator('dialog[open]').evaluateAll(nodes=>nodes.forEach(el=>el.close()));
    await page.evaluate(()=>window.NotejectI18n.setLanguage('en'));
    await page.locator('.nav-item[data-view="home"]').evaluate(el=>el.click());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    if(!await page.locator('#view').textContent().then(text=>text.includes(mode==='android'?'A place for':'Make room for')||text.includes('A clear space')))throw Error('Switching back to English did not restore UI copy');
    if(mode==='android') {
      await page.locator('#open-settings').evaluate(el=>el.click());
      await page.locator('[data-settings-tab="general"]').click();
      await page.locator('#noteject-language').selectOption('uk');
      await navigate('home');
    } else await page.locator('#noteject-language-quick').selectOption('uk');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    if(!await page.locator('#view').textContent().then(text=>text.includes(mode==='android'?'Місце для':'Звільніть місце')||text.includes('Вільний простір')))throw Error('Ukrainian language selector did not translate Home');
    if(mode==='windows'&&!await page.evaluate(()=>__nativeLanguages.includes('en')&&__nativeLanguages.at(-1)==='uk'))throw Error('The Windows native menu did not receive language changes.');
    for(const name of ['index.html','privacy.html','terms.html','source.html']){await page.goto(origin+'/'+(name==='index.html'?'':name));await capture('site-'+name);}
    fs.writeFileSync(path.join(output,'coverage-'+mode+'.json'),JSON.stringify({errors,pages:report},null,2));
    console.log(JSON.stringify({mode,errors,pages:Object.keys(report).length,remaining:[...new Set(Object.values(report).flat().map(item=>item.text))]},null,2));
    if(errors.length || Object.values(report).some(values=>values.length))throw Error('The Ukrainian page audit found errors or untranslated interface copy.');
  } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
