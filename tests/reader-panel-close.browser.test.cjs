'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
test('Contents, Pages, and Bookmarks close and reopen across Web and Windows Readers',{timeout:60000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try{
    for(const platform of ['web-desktop','web-mobile','windows']){
      const context=await browser.newContext({viewport:platform==='web-mobile'?{width:390,height:844}:{width:1360,height:900},hasTouch:platform==='web-mobile'});
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route('https://reader.test/',route=>route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="main"><header class="topbar"></header><section id="view" class="reader-workspace" style="height:90vh"></section></main></body></html>'}));
      await page.goto('https://reader.test/');
      await page.evaluate(platform=>{if(platform==='windows'){window.NotejectDesktop={};document.body.classList.add('windows-app');}else{window.NotejectWebApp=true;document.documentElement.classList.add('noteject-web');}},platform);
      for(const file of ['reader-workspace.css',...(platform==='windows'?['windows-reader-board.css','noteject-palette.css']:[])])await page.addStyleTag({path:path.join(root,file)});
      await page.addScriptTag({path:path.join(root,'reader-workspace.js')});
      for(const type of ['pdf','djvu','epub','txt']){
        await page.evaluate(type=>{
          window.panelBook?.dispose();localStorage.setItem('noteject-reader-workspace',JSON.stringify({navigation:true}));
          const file={id:'test',name:'Test document',type,bookmarks:[{id:'bookmark',title:'A saved place',location:type==='epub'?{chapterIndex:0}:{page:2}}]};
          const prefs={fontSize:18,lineHeight:1.8,font:'serif',theme:'paper',width:'comfortable'};
          window.panelBook=NotejectReaderWorkspace.create({getDocument:()=>file,getPdf:()=>['pdf','djvu'].includes(type)?{pageNum:2,numPages:5}:null,getEpub:()=>type==='epub'?[{},{}]:null,getChapter:()=>0,getTitles:()=>['First chapter','Second chapter'],getEpubTexts:()=>['Reader text','Second chapter'],getEpubNavigation:()=>({flatItems:[]}),getEpubPrefs:()=>prefs,getContext:()=>({page:2}),getPdfScale:()=>1,returnLabel:()=> 'Documents',save(){},saveProgress(){},notify(){}});
          document.getElementById('view').innerHTML=panelBook.render(file,'','<article id="txt-content"><p>Reader content</p></article>');panelBook.mount();
        },type);
        for(const tab of ['contents',...(['pdf','djvu'].includes(type)?['pages']:[]),'bookmarks']){
          await page.locator('[data-reader-tab='+tab+']').click();
          const close=page.locator('.reader-navigation-close'),panel=page.locator('.reader-navigation');
          assert.equal(await close.isVisible(),true,platform+' '+type+' '+tab);
          const box=await close.boundingBox(),nav=await panel.boundingBox();
          assert.ok(box.width>=44&&box.height>=44);assert.ok(box.x>=nav.x&&box.x+box.width<=nav.x+nav.width+1);
          await close.focus();await page.keyboard.press('Enter');
          assert.equal(await panel.isVisible(),false);assert.equal(await page.locator('.reader-shell.nav-open').count(),0);
          assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('noteject-reader-workspace')).navigation),false);
          assert.equal(await page.locator('[data-reader-command=navigation]').first().getAttribute('aria-expanded'),'false');
          assert.equal(await page.evaluate(()=>document.activeElement.dataset.readerCommand),'navigation');
          await page.evaluate(()=>panelBook.run('close-navigation'));assert.equal(await panel.isVisible(),false,'repeated close must not reopen');
          await page.locator('[data-reader-command=navigation]').first().click();assert.equal(await panel.isVisible(),true);
          assert.equal(await page.locator('[data-reader-tab='+tab+']').getAttribute('aria-selected'),'true','reopening preserves the selected tab');
        }
      }
      assert.deepEqual(errors,[]);await context.close();
    }
  }finally{await browser.close();}
});
