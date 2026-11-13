'use strict';
const test=require('node:test'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{zip}=require('./backup-fixture.cjs');
const root=path.resolve(__dirname,'..'),origin='https://noteject.test';
const workspace={boards:[{id:'b',name:'Audit board',items:[],edges:[]}],activeBoard:'b',notes:[{id:'n',title:'Integrity check',content:'ORIGINAL NOTE',folder:'Inbox',color:'violet',tags:[]}],docs:[],folders:['Inbox'],noteFolders:['Inbox'],trash:[]};
function backup(method,damaged=false){
 const manifest={format:'noteject-portable-backup',version:1,workspace,attachments:[]};
 const valid=zip({'manifest.json':JSON.stringify(manifest)},{method});
 if(!damaged)return valid;
 manifest.workspace=structuredClone(workspace);manifest.workspace.notes[0].content='XRIGINAL NOTE';
 const changed=zip({'manifest.json':JSON.stringify(manifest)},{method});
 changed.writeUInt32LE(valid.readUInt32LE(14),14);
 const originalDirectory=valid.indexOf(Buffer.from([0x50,0x4b,1,2])),directory=changed.indexOf(Buffer.from([0x50,0x4b,1,2]));
 changed.writeUInt32LE(valid.readUInt32LE(originalDirectory+16),directory+16);return changed;
}
async function open(browser,platform){
 const android=platform==='android',mobile=android||platform==='web-mobile',base=android?path.join(root,'android/app/src/main/assets'):root;
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1400,height:900},hasTouch:mobile,isMobile:mobile});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.fulfill({status:404,body:''});if(url.pathname.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:'{"ok":true,"configured":false,"cloudEnabled":false,"fileStorage":true}'});const file=path.resolve(base,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});return route.fulfill({contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});});
 await context.addInitScript(({platform,workspace})=>{const original=structuredClone(workspace);original.notes[0].content='Current local note';localStorage.setItem('noteject',JSON.stringify(original));if(platform==='android')window.NotejectAndroid={getAppVersion:()=> '1.10.48',setAppLanguage(){},apiRequest(route,method,body,id){queueMicrotask(()=>window.__notejectAndroidResponse(id,JSON.stringify({ok:true,configured:false,fileStorage:true}),200));}};else if(platform==='windows')window.NotejectDesktop={version:'0.2.51',fileApiBase:location.origin,setAppLanguage(){}};else{window.NotejectWebApp=true;document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('noteject-web'),{once:true});}},{platform,workspace});
 const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>typeof loadWorkspaceBackup==='function'&&!!window.NotejectWorkspaceUX);
 await page.evaluate(()=>{window.confirmations=0;window.NotejectWorkspaceUX={...NotejectWorkspaceUX,confirmBackup:async()=>{confirmations++;return true;}};});return{page,context};
}
test('all platforms reject corrupt stored/deflated metadata and cancellation before workspace publication',{timeout:120000},async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});t.after(()=>browser.close());
 for(const platform of ['web-desktop','web-mobile','windows','android'])await t.test(platform,async()=>{
  const{page,context}=await open(browser,platform);try{
   for(const method of [0,8]){
    const result=await page.evaluate(async bytes=>({restored:await loadWorkspaceBackup(new File([new Uint8Array(bytes)],'damaged.zip',{type:'application/zip'})),content:data.notes[0].content,confirmations,notice:document.querySelector('#toast').textContent}),[...backup(method,true)]);
    assert.equal(result.restored,false);assert.equal(result.content,'Current local note');assert.equal(result.confirmations,0);assert.match(result.notice,/integrity check/);
   }
   const cancelled=await page.evaluate(async bytes=>{const controller=new AbortController();window.NotejectWorkspaceUX={...NotejectWorkspaceUX,confirmBackup:async()=>{controller.abort();return true;}};return{restored:await loadWorkspaceBackup(new File([new Uint8Array(bytes)],'cancelled.zip'),{signal:controller.signal}),content:data.notes[0].content};},[...backup(8)]);
   assert.equal(cancelled.restored,false);assert.equal(cancelled.content,'Current local note');
   if(platform!=='windows'){
    const result=await page.evaluate(async bytes=>{const controller=new AbortController(),checkpoint=attachmentImports.checkpoint;window.NotejectWorkspaceUX={...NotejectWorkspaceUX,confirmBackup:async()=>true};attachmentImports.checkpoint=async record=>{await checkpoint(record);controller.abort();};try{return{restored:await loadWorkspaceBackup(new File([new Uint8Array(bytes)],'late-cancel.zip'),{signal:controller.signal}),content:data.notes[0].content,persisted:JSON.parse(localStorage.getItem('noteject')).notes[0].content};}finally{attachmentImports.checkpoint=checkpoint;}},[...backup(8)]);
    assert.equal(result.restored,false);assert.equal(result.content,'Current local note');assert.equal(result.persisted,'Current local note');
   }
   await page.evaluate(()=>{window.NotejectWorkspaceUX={...NotejectWorkspaceUX,confirmBackup:async()=>true};});
   for(const method of [0,8]){
    const result=await page.evaluate(async bytes=>({restored:await loadWorkspaceBackup(new File([new Uint8Array(bytes)],'valid.zip')),content:data.notes[0].content}),[...backup(method)]);assert.equal(result.restored,true);assert.equal(result.content,'ORIGINAL NOTE');
   }
  }finally{await context.close();}
 });
});
module.exports={open};
