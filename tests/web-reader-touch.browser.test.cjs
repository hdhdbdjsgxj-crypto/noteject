'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
async function surface(browser) {
  const context = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, deviceScaleFactor:3 });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<html class="noteject-web"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="reader-workspace"><div id="viewport" style="width:370px;height:640px;overflow:auto;position:relative"><div id="pages"></div></div></div></body></html>');
  await page.addStyleTag({ path:path.join(root,'reader-workspace.css') });
  await page.evaluate(() => { window.NotejectWebApp=true; });
  await page.addScriptTag({ path:path.join(root,'reader-page-view.js') });
  await page.evaluate(async () => {
    window.touchTest={ renders:0, commits:0, delay:5, errors:[] };
    touchTest.reader=NotejectPageReader.create({getViewport:()=>document.getElementById('viewport'),onZoomCommit(){touchTest.commits++;},onError(error){touchTest.errors.push(error.message);}});
    await touchTest.reader.mount({container:document.getElementById('pages'),documentId:'touch-book',page:1,zoom:'fit',pdf:{numPages:30,async getPage(number){return{getViewport:({scale=1})=>({width:612*scale,height:792*scale}),getTextContent:async()=>({items:[{str:'Touch selection remains available',x:20,y:40,width:280,height:22,fontSize:18}]}),getAnnotations:async()=>[],cleanup(){}};}},rasterizer:{renderPage({width,height}){touchTest.renders++;return{promise:new Promise(resolve=>setTimeout(()=>{const pixels=new Uint8ClampedArray(width*height*4);pixels.fill(255);resolve({width,height,pixels:pixels.buffer});},touchTest.delay)),cancel(){}};}}});
  });
  await page.waitForFunction(()=>touchTest.reader.getTextLayer());
  const cdp=await context.newCDPSession(page);
  const send=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:3,radiusY:3,force:1}))});
  return {page,context,errors,send};
}
test('Web phone gestures preview pinch zoom without blanking pages, retain native panning, and clean up on close',{timeout:60000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const {page,context,errors,send}=await surface(browser);
    const before=await page.evaluate(()=>{touchTest.canvas=touchTest.reader.getPageElement(1).querySelector('canvas');return{zoom:touchTest.reader.getZoom(),renders:touchTest.renders};});
    await send('touchStart',[[1,110,230],[2,250,230]]);
    const previewRenders=await page.evaluate(()=>touchTest.renders);
    await send('touchMove',[[1,65,245],[2,295,245]]);
    await page.waitForTimeout(50);
    const during=await page.evaluate(()=>({renders:touchTest.renders,canvas:touchTest.canvas.isConnected,preview:touchTest.reader.getPageElement(1).style.transform,browserZoom:visualViewport.scale}));
    assert.equal(during.canvas,true); assert.equal(during.renders,previewRenders); assert.match(during.preview,/scale\(/); assert.equal(during.browserZoom,1);
    await send('touchEnd',[]);
    await page.waitForFunction(()=>touchTest.commits===1);
    const zoom=await page.evaluate(()=>touchTest.reader.getZoom());
    assert.ok(zoom>before.zoom*1.5); assert.ok(zoom<before.zoom*1.8);
    assert.equal(await page.evaluate(()=>touchTest.reader.getPageElement(1).style.transform),'');
    await send('touchStart',[[3,180,540]]);
    for(let i=1;i<=8;i++)await send('touchMove',[[3,180,540-i*32]]);
    await send('touchEnd',[]);
    await page.waitForFunction(()=>document.getElementById('viewport').scrollTop>25);
    assert.equal(await page.evaluate(()=>touchTest.reader.getZoom()),zoom);
    const passThrough=await page.evaluate(()=>{
      const layer=touchTest.reader.getTextLayer(1),range=document.createRange();range.selectNodeContents(layer);getSelection().removeAllRanges();getSelection().addRange(range);
      const touch=new Touch({identifier:5,target:layer,clientX:160,clientY:250});
      const event=new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[touch],targetTouches:[touch],changedTouches:[touch]});layer.dispatchEvent(event);
      const result={blocked:event.defaultPrevented,text:getSelection().toString()};getSelection().removeAllRanges();return result;
    });
    assert.equal(passThrough.blocked,false); assert.match(passThrough.text,/Touch selection/);
    for (const number of [5,10,20,30]) await page.evaluate(number=>touchTest.reader.goToPage(number),number);
    const cache=await page.locator('.reader-pdf-canvas').evaluateAll(canvases=>({count:canvases.length,pixels:canvases.reduce((sum,canvas)=>sum+canvas.width*canvas.height,0)}));
    assert.ok(cache.count<=6); assert.ok(cache.pixels<=9000000,'Web phones must use the mobile canvas budget');
    await page.evaluate(()=>touchTest.reader.dispose());
    assert.equal(await page.locator('#viewport').evaluate(el=>el.style.touchAction),'');
    assert.deepEqual(errors,[]); await context.close();
  } finally {await browser.close();}
});
test('Cancelled pinch and late render cannot change zoom or pull a new touch scroll back',{timeout:60000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const {page,context,errors,send}=await surface(browser);
    const original=await page.evaluate(()=>touchTest.reader.getZoomValue());
    await send('touchStart',[[1,110,230],[2,250,230]]);await send('touchMove',[[1,75,230],[2,285,230]]);await send('touchCancel',[]);
    assert.equal(await page.evaluate(()=>touchTest.reader.getZoomValue()),original);
    assert.equal(await page.evaluate(()=>touchTest.reader.getPageElement(1).style.transform),'');
    await page.evaluate(()=>touchTest.delay=250);
    await send('touchStart',[[3,110,230],[4,250,230]]);await send('touchMove',[[3,75,230],[4,285,230]]);await send('touchEnd',[]);
    const position=await page.evaluate(()=>{const el=document.getElementById('viewport');el.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[],changedTouches:[]}));el.scrollTop+=90;return el.scrollTop;});
    await page.waitForFunction(()=>touchTest.commits===1);
    assert.ok(Math.abs(await page.locator('#viewport').evaluate(el=>el.scrollTop)-position)<4,'a render completion must not undo a newer touch scroll');
    assert.deepEqual(errors,[]); await context.close();
  } finally {await browser.close();}
});
test('PDF and DjVu mobile footer provides touch-sized page arrows and fit width',{timeout:60000},async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
    await page.setContent('<html class="noteject-web"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header class="topbar"></header><section id="view" class="reader-workspace"></section></body></html>');
    await page.addStyleTag({path:path.join(root,'reader-workspace.css')});await page.addStyleTag({path:path.join(root,'web-mobile-workspace.css')});
    await page.evaluate(()=>{window.NotejectWebApp=true;window.openWorkspaceView=()=>{};window.view='reader';});
    await page.addScriptTag({path:path.join(root,'reader-workspace.js')});await page.addScriptTag({path:path.join(root,'web-mobile-workspace.js')});
    for(const type of ['pdf','djvu']){
      await page.evaluate(type=>{window.book?.dispose();window.calls=[];const file={id:'touch-book',type,name:'Touch book',bookmarks:[]};const state={pageNum:1,numPages:5};window.book=NotejectReaderWorkspace.create({getDocument:()=>file,getPdf:()=>state,getPdfScale:()=>1,getContext:()=>({page:state.pageNum}),getEpubPrefs:()=>({}),returnLabel:()=> 'Documents',saveProgress(){},save(){},goToPage:async page=>{calls.push(page);state.pageNum=page;book.updateLocation();},setPdfZoom:async value=>calls.push(value)});document.getElementById('view').innerHTML=book.render(file,'');book.mount();},type);
      await page.waitForFunction(()=>document.querySelectorAll('.wm-reader-page-step').length===3);
      const previous=page.locator('.wm-reader-page-step[data-reader-command=previous]');await page.waitForFunction(()=>document.querySelector('.wm-reader-page-step[data-reader-command=previous]').disabled);assert.equal(await previous.isDisabled(),true);
      for(const button of await page.locator('.wm-reader-page-step').all()){const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44);}
      await page.locator('.wm-reader-page-step[data-reader-command=next]').tap();await previous.tap();await page.locator('.wm-reader-page-step[data-reader-command=zoom-fit]').tap();assert.deepEqual(await page.evaluate(()=>calls),[2,1,'fit']);
    }
    await context.close();
  }finally{await browser.close();}
});
