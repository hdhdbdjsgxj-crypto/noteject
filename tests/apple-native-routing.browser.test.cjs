'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const service = 'https://noteject.vercel.app';
const nativeTestOrigin = 'http://127.0.0.1:43891';
const supabase = 'https://apple-fixture.supabase.co';
const user = { id:'11111111-1111-4111-8111-111111111111', email:'iphone@example.test' };
const workspace = { boards:[{id:'board',name:'Reading',items:[],edges:[]}], activeBoard:'board', notes:[], docs:[], folders:['Inbox'], noteFolders:['Inbox'], folderProjects:{Inbox:'inbox'}, trash:[] };
const text = 'Original text stored on the iPhone or iPad must survive reopening the workspace.';
const chrome = process.env.NOTEJECT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function appleHtml() {
  const { prepareAppleHtml } = await import('../scripts/apple-web-html.mjs');
  const html = fs.readFileSync(path.join(root, 'site-build/app/index.html'), 'utf8');
  const prepared = prepareAppleHtml(html);
  const bootstrap = [...prepared.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).find(source=>source.includes('window.NotejectAppleNative=true'));
  assert(bootstrap, 'The prepared native HTML must include its platform bootstrap');
  return { prepared, bootstrap, prepareAppleHtml };
}

test('Capacitor bootstrap selects browser persistence only for the native Apple origin', async () => {
  const { prepared, bootstrap, prepareAppleHtml } = await appleHtml();
  assert.match(prepared, /<base href="\.\/">/);
  assert.doesNotMatch(prepared, /<base href="\/app\/">/);
  assert.throws(()=>prepareAppleHtml('<head></head>'), /hosted app base path/);
  for (const [protocol,hostname,expected] of [['capacitor:','localhost',true],['https:','noteject.vercel.app',false],['http:','localhost',false],['capacitor:','untrusted.example',false]]) {
    const window = {}, classes = new Set();
    vm.runInNewContext(bootstrap,{window,location:{protocol,hostname},document:{documentElement:{classList:{add(...values){values.forEach(value=>classes.add(value));}}}}});
    assert.equal(!!window.NotejectAppleNative,expected);
    assert.equal(!!window.NotejectWebApp,expected);
    if(expected){assert.equal(window.NOTEJECT_CLOUD_ORIGIN,service);assert(classes.has('noteject-web')&&classes.has('noteject-ios'));}
  }
});

test('Native Apple imports and restores original files locally, with cloud and cited AI routed to HTTPS', {timeout:90000}, async t => {
  const { prepared, bootstrap } = await appleHtml();
  const browser = await chromium.launch({headless:true,executablePath:chrome});
  t.after(()=>browser.close());
  const context = await browser.newContext({viewport:{width:390,height:844}});
  t.after(()=>context.close());
  const calls = { local:[], cloud:[], ai:[], errors:[] };
  await context.route('**/*', async route => {
    const request=route.request(),url=new URL(request.url());
    const headers={'Access-Control-Allow-Origin':'*'};
    const json=value=>route.fulfill({status:200,contentType:'application/json',headers,body:JSON.stringify(value)});
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'}});
    if(url.origin===service){
      calls.cloud.push(request.url());
      if(url.pathname==='/api/site-config')return json({cloudEnabled:true,supabaseUrl:supabase,supabaseAnonKey:'sb_publishable_fixture',aiEnabled:true,checkoutPlans:[],syncMaxBytes:50*1024*1024});
      if(url.pathname==='/api/account')return json({plan:'free',basic:{used:0,limit:10},advanced:{used:0,limit:0}});
      if(url.pathname==='/api/ask'){
        assert.equal(request.headers().authorization,'Bearer apple-fixture-token');
        calls.ai.push(request.postDataJSON());
        return json({answer:'Supported answer. [S1]'});
      }
      return route.fulfill({status:404,headers,body:''});
    }
    if(url.origin===supabase){
      if(url.pathname==='/auth/v1/user')return json(user);
      if(url.pathname==='/rest/v1/workspace_sync_heads')return json([]);
      return route.fulfill({status:404,headers,body:''});
    }
    if(url.hostname==='localhost'||url.hostname==='127.0.0.1'){
      if(url.origin!==nativeTestOrigin||url.pathname.startsWith('/api/')){calls.local.push(request.url());return route.abort('failed');}
      if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:prepared});
      const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});
      return route.fulfill({status:200,contentType:({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
    }
    return route.fulfill({status:404,body:''});
  });
  await context.addInitScript(({bootstrap,workspace,user,service})=>{
    // Chromium cannot navigate a custom WKWebView scheme. Execute the actual
    // prepared bootstrap with its Capacitor location before loading real assets.
    new Function('location','document',bootstrap)({protocol:'capacitor:',hostname:'localhost'},{documentElement:{classList:{add(...tokens){document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add(...tokens),{once:true});}}}});
    if(!localStorage.getItem('noteject'))localStorage.setItem('noteject',JSON.stringify(workspace));
    localStorage.setItem('noteject-cloud-session-v1:'+service,JSON.stringify({access_token:'apple-fixture-token',refresh_token:'apple-fixture-refresh',expires_at:4102444800,user}));
  },{bootstrap,workspace,user,service});
  const page=await context.newPage();page.on('pageerror',error=>calls.errors.push(error.message));
  await page.goto(nativeTestOrigin+'/?lang=en');await page.locator('.home-hero').waitFor();
  await page.waitForFunction(()=>window.NotejectCloud?.isConfigured());
  assert.equal(await page.evaluate(()=>NotejectCloud.apiOrigin()),service);
  assert.equal(await page.evaluate(()=>NotejectCloud.getAccessToken()),'apple-fixture-token','Native cloud session must use the official-service storage key');
  await page.locator('#file-picker').setInputFiles({name:'Reference.txt',mimeType:'text/plain',buffer:Buffer.from(text)});
  await page.waitForFunction(()=>data.docs.length===1);
  assert.equal(await page.evaluate(async()=>await(await getStoredFile(data.docs[0].id)).text()),text);
  const project=await page.evaluate(()=>{const created=createNoteFolder('Notes created locally');return {...created,key:data.folderProjects[created.folder]};});
  assert.equal(project.folder,'Notes created locally');assert.equal(project.created,true);assert.match(project.key,/^project-/);
  await page.evaluate(async()=>{await moveDocumentToProject(data.docs[0],'Native project');await renameDocument(data.docs[0].id,'Reference-renamed.txt');});
  await page.reload();await page.locator('.home-hero').waitFor();
  await page.waitForFunction(()=>data.docs[0]?.blob&&data.docs[0].name==='Reference-renamed.txt');
  assert.equal(await page.evaluate(()=>NotejectCloud.getAccessToken()),'apple-fixture-token','Native cloud session must survive reload');
  assert.equal(await page.evaluate(async()=>await(await getStoredFile(data.docs[0].id)).text()),text);
  assert.equal(await page.evaluate(()=>data.docs[0].folder),'Native project');
  assert.equal(await page.evaluate(()=>data.folders.includes('Notes created locally')&&!!data.folderProjects['Notes created locally']),true,'Native project creation must persist locally');
  await page.evaluate(()=>openDocument(data.docs[0].id));
  await page.waitForFunction(expected=>document.getElementById('txt-content')?.textContent===expected,text);
  const answer=await page.evaluate(()=>askReaderAssistantAI({documentId:data.docs[0].id,question:'What does the passage say?',context:'[S1] Original text stored on the device.'}));
  assert.equal(answer,'Supported answer. [S1]');
  assert.equal(calls.ai.length,1);
  assert(calls.cloud.some(url=>url===service+'/api/site-config'));
  assert(calls.cloud.some(url=>url.startsWith(service+'/api/ask?')));
  assert.deepEqual(calls.local,[],'Native import, project move, rename, reload and AI must never request the desktop file server');
  assert.deepEqual(calls.errors,[]);
});

test('Cloud origin selection preserves hosted web, Windows, and Android routing', {timeout:60000}, async t => {
  const browser=await chromium.launch({headless:true,executablePath:chrome});t.after(()=>browser.close());
  for(const mode of ['web','windows','android','apple']){
    const context=await browser.newContext();
    try{
      await context.route('**/*',route=>route.fulfill({status:200,contentType:route.request().isNavigationRequest()?'text/html':'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:route.request().isNavigationRequest()?'<html><body><div class="top-right"></div></body></html>':JSON.stringify({cloudEnabled:false})}));
      await context.addInitScript(mode=>{if(mode==='web')window.NotejectWebApp=true;if(mode==='windows')window.NotejectDesktop={};if(mode==='android')window.NotejectAndroid={};if(mode==='apple'){window.NotejectAppleNative=true;window.NotejectWebApp=true;window.NOTEJECT_CLOUD_ORIGIN='http://127.0.0.1:41784';}},mode);
      const page=await context.newPage();await page.goto('https://workspace.example.test');await page.addScriptTag({path:path.join(root,'cloud-sync.js')});
      assert.equal(await page.evaluate(()=>NotejectCloud.apiOrigin()),mode==='web'?'https://workspace.example.test':service,mode);
    }finally{await context.close();}
  }
});

test('Existing bearer-token API CORS supports the Capacitor origin without a server policy expansion', async () => {
  const {preflight,requireUser}=require('../api/_shared');
  const response={headers:{},setHeader(name,value){this.headers[name]=value;},status(code){this.code=code;return this;},end(){}};
  assert.equal(preflight({method:'OPTIONS',headers:{origin:'capacitor://localhost'}},response),true);
  assert.equal(response.code,204);
  assert.equal(response.headers['Access-Control-Allow-Origin'],'*');
  assert.match(response.headers['Access-Control-Allow-Headers'],/Authorization/);
  assert.equal(response.headers['Access-Control-Allow-Credentials'],undefined);
  await assert.rejects(requireUser({headers:{origin:'capacitor://localhost'}}),/Sign in/);
});
