const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');

const root=path.resolve(__dirname,'..');
const build=path.join(root,'site-build');

test('iPhone/iPad download clearly identifies the unsigned IPA and preserves Safari web access',{timeout:120000},async t=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(build,'manifest.webmanifest'),'utf8'));
 assert.equal(manifest.start_url,'/app/');
 assert.equal(manifest.display,'standalone');
 assert.ok(manifest.icons.some(icon=>icon.src==='/noteject-logo.svg'));
 assert.ok(fs.existsSync(path.join(build,'apple-touch-icon.png')));
 const appHtml=fs.readFileSync(path.join(build,'app','index.html'),'utf8');
 assert.match(appHtml,/apple-mobile-web-app-capable/);
 assert.match(appHtml,/apple-touch-icon\.png/);

 const iosURL='https://downloads.noteject.test/Noteject-iPhone-iPad-0.2.57-unsigned.ipa';
 const description='Unsigned development build for iPhone and iPad. Requires iOS or iPadOS 15 or later.';
 const warning='Apple signing and provisioning are required before installation. This file cannot be installed directly from Safari.';
 const downloadLabel='Download unsigned IPA', unsignedLabel='Unsigned build', webLabel='Use the web app on iPhone or iPad';
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/site-config'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({downloads:{ios:iosURL},versions:{ios:'0.2.57'},iosBuild:{signedForInstallation:false,minimumIOS:'15.0',architectures:['arm64'],devices:['iPhone','iPad']}}));}
  let relative=decodeURIComponent(url.pathname.slice(1))||'index.html';if(relative.endsWith('/'))relative+='index.html';
  const file=path.resolve(build,relative);
  if(!file.startsWith(build+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
  const type=({'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.mp4':'video/mp4'})[path.extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type});res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.route('https://**',route=>new URL(route.request().url()).hostname==='downloads.noteject.test'
  ? route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/octet-stream'},body:''})
  : route.abort());
 const origin='http://127.0.0.1:'+server.address().port;
 const viewports=[{name:'small iPhone',width:320,height:640},{name:'iPhone',width:390,height:844},{name:'iPad portrait',width:768,height:1024},{name:'iPad landscape',width:1024,height:768},{name:'desktop',width:1440,height:900}];
 for(const language of ['en','uk'])for(const viewport of viewports){
  await page.setViewportSize({width:viewport.width,height:viewport.height});
  await page.goto(origin+'/?lang='+language+'#downloads');
  await page.waitForFunction(()=>document.querySelector('[data-download="ios"]')?.dataset.releaseAvailable==='true');
  assert.equal(await page.locator('.apple-card').count(),1,viewport.name);
  const link=page.locator('[data-download="ios"]');
  assert.equal(await link.getAttribute('href'),iosURL);assert.equal(await link.getAttribute('aria-disabled'),null);
  const labels=await page.evaluate(({downloadLabel,unsignedLabel,warning,webLabel,description})=>({download:NotejectI18n.t(downloadLabel),status:NotejectI18n.t(unsignedLabel),warning:NotejectI18n.t(warning),web:NotejectI18n.t(webLabel),description:NotejectI18n.t(description)}),{downloadLabel,unsignedLabel,warning,webLabel,description});
  assert((await link.textContent()).trim().startsWith(labels.download));
  assert((await page.locator('[data-download-status="ios"]').textContent()).includes(labels.status));
  assert((await page.locator('[data-download-status="ios"]').textContent()).includes('0.2.57'));
  assert.equal(await page.locator('#ios-signing-requirement').textContent(),labels.warning);
  assert.equal(await page.locator('.apple-download-copy>p').first().textContent(),labels.description);
  assert.equal(await page.locator('#ios-signing-requirement').isVisible(),true,'Signing requirement must be visible without opening the web instructions');
  assert.equal(await page.locator('.apple-web-options').getAttribute('open'),null);
  if(process.env.NOTEJECT_SITE_SCREENSHOTS){fs.mkdirSync(process.env.NOTEJECT_SITE_SCREENSHOTS,{recursive:true});await page.locator('.apple-card').screenshot({path:path.join(process.env.NOTEJECT_SITE_SCREENSHOTS,`iphone-ipad-${language}-${viewport.width}.png`)});}
  await page.locator('.apple-web-options>summary').click();
  assert.equal(await page.locator('.apple-web-options>summary').textContent(),labels.web);
  assert.equal(await page.locator('.apple-platform').count(),2);
  assert.equal(await page.locator('.apple-card a[href="/app/"]').count(),2);
  assert.equal(await page.locator('.apple-platform').first().isVisible(),true);
  const box=await page.locator('.apple-card').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=viewport.width,viewport.name+' Apple download card overflowed');
  assert.ok(await page.locator('.apple-card').evaluate(el=>el.scrollWidth<=el.clientWidth+1),language+' '+viewport.name+' Apple content overflowed');
  assert.ok(await page.locator('html').evaluate(el=>el.scrollWidth<=document.documentElement.clientWidth+1),language+' '+viewport.name+' page overflowed horizontally');
  if(language!=='en')assert.notEqual(labels.download,downloadLabel,'The native download label must be translated');
 }
 assert.equal(await page.evaluate(async url=>(await fetch(url,{method:'HEAD'})).status,iosURL),200,'The configured IPA URL must resolve');
 await page.setViewportSize({width:390,height:844});
 const languages=await page.evaluate(()=>NotejectI18n.languages.map(item=>item.code));
 for(const language of [...languages,'en','uk','en']){
  await page.evaluate(code=>NotejectI18n.setLanguage(code),language);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const labels=await page.evaluate(({downloadLabel,unsignedLabel,warning,webLabel,description})=>({download:NotejectI18n.t(downloadLabel),status:NotejectI18n.t(unsignedLabel),warning:NotejectI18n.t(warning),web:NotejectI18n.t(webLabel),description:NotejectI18n.t(description)}),{downloadLabel,unsignedLabel,warning,webLabel,description});
  assert((await page.locator('[data-download="ios"]').textContent()).trim().startsWith(labels.download),language+' stale download label');
  assert((await page.locator('[data-download-status="ios"]').textContent()).includes(labels.status),language+' stale unsigned status');
  assert.equal(await page.locator('#ios-signing-requirement').textContent(),labels.warning,language+' stale signing notice');
  assert.equal(await page.locator('.apple-download-copy>p').first().textContent(),labels.description,language+' stale build description');
  assert.equal(await page.locator('.apple-web-options>summary').textContent(),labels.web,language+' stale web option');
  assert.equal(await page.locator('[data-download="ios"]').getAttribute('href'),iosURL,'Changing language must preserve the actual IPA link');
  assert.ok(await page.locator('.apple-card').evaluate(el=>el.scrollWidth<=el.clientWidth+1),language+' Apple card overflowed');
  if(language!=='en'){assert.notEqual(labels.download,downloadLabel,language+' untranslated download');assert.notEqual(labels.warning,warning,language+' untranslated signing notice');}
 }
 const manifestResponse=await page.request.get(origin+'/manifest.webmanifest');assert.equal(manifestResponse.status(),200);
 const iconResponse=await page.request.get(origin+'/apple-touch-icon.png');assert.equal(iconResponse.status(),200);
 await page.goto(origin+'/app/');assert.equal(await page.locator('link[rel="manifest"]').count(),1);
 assert.deepEqual(errors,[]);
});
