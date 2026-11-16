const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require('playwright');

const root=path.resolve(__dirname,'..');
const build=path.join(root,'site-build');

test('compact downloads preserve each platform, translated notices, and accessible mobile controls',{timeout:120000},async t=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(build,'manifest.webmanifest'),'utf8'));
 assert.equal(manifest.start_url,'/app/');
 assert.equal(manifest.display,'standalone');
 assert.ok(manifest.icons.some(icon=>icon.src==='/noteject-logo.svg'));
 assert.ok(fs.existsSync(path.join(build,'apple-touch-icon.png')));
 const appHtml=fs.readFileSync(path.join(build,'app','index.html'),'utf8');
 assert.match(appHtml,/apple-mobile-web-app-capable/);
 assert.match(appHtml,/apple-touch-icon\.png/);

 const iosURL='https://downloads.noteject.test/Noteject-iPhone-iPad-0.2.57-unsigned.ipa';
 const downloads={windows:'https://downloads.noteject.test/Noteject-Setup-0.2.57-x64.exe',android:'https://downloads.noteject.test/Noteject-Android-1.10.53.apk',macArm64:'https://downloads.noteject.test/Noteject-Mac-0.2.56-arm64-development.dmg',macX64:'https://downloads.noteject.test/Noteject-Mac-0.2.56-x64-development.dmg',ios:iosURL};
 const versions={windows:'0.2.57',android:'1.10.53',macArm64:'0.2.56',macX64:'0.2.56',ios:'0.2.57'};
 const description='Unsigned development build for iPhone and iPad. Requires iOS or iPadOS 15 or later.';
 const warning='Apple signing and provisioning are required before installation. This file cannot be installed directly from Safari.';
 const downloadLabel='Download unsigned IPA', unsignedLabel='Unsigned build', webLabel='Use the web app on iPhone or iPad';
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/site-config'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({downloads,versions,iosBuild:{signedForInstallation:false,minimumIOS:'15.0',architectures:['arm64'],devices:['iPhone','iPad']}}));}
  let relative=decodeURIComponent(url.pathname.slice(1))||'index.html';if(relative.endsWith('/'))relative+='index.html';
  const assetRoot=['index.html','site.js','site.css'].includes(relative)?path.join(root,'site'):build;
  const file=path.resolve(assetRoot,relative);
  if(!file.startsWith(assetRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
  const type=({'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.mp4':'video/mp4'})[path.extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type});res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTEJECT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.hostname==='downloads.noteject.test')return route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/octet-stream'},body:''});
  if(url.protocol==='https:')return route.abort();
  return route.continue();
 });
 const origin='http://127.0.0.1:'+server.address().port;
 const viewports=[{name:'small iPhone',width:320,height:640},{name:'iPhone',width:390,height:844},{name:'iPad portrait',width:768,height:1024},{name:'iPad landscape',width:1024,height:768},{name:'desktop',width:1440,height:900}];
 for(const language of ['en','uk'])for(const viewport of viewports){
  await page.setViewportSize({width:viewport.width,height:viewport.height});
  await page.goto(origin+'/?lang='+language+'&test-width='+viewport.width+'#downloads');
  await page.waitForFunction(()=>document.querySelector('[data-download="ios"]')?.dataset.releaseAvailable==='true');
  assert.equal(await page.locator('.apple-card').count(),1,viewport.name);
  assert.equal(await page.locator('.download-card').count(),4,'Mac variants share one compact row');
  assert.equal(await page.locator('.downloads-heading a[href="/app/"]').count(),1,'Web access stays in the heading');
  for(const [platform,url] of Object.entries(downloads)){
   const control=page.locator(`[data-download="${platform}"]`),status=page.locator(`[data-download-status="${platform}"]`);
   assert.equal(await control.count(),1);assert.equal(await status.count(),1);
   assert.equal(await control.getAttribute('href'),url,platform+' download must keep its own artifact');
   assert.equal(await control.getAttribute('aria-disabled'),null);
   assert((await status.textContent()).includes(versions[platform]),platform+' version must remain visible');
   const rect=await control.boundingBox();assert.ok(rect&&rect.height>=44&&rect.width>=44,platform+' must remain touchable');
  }
  assert.match(await page.locator('[data-download="macArm64"]').getAttribute('aria-label'),/Apple silicon/);
  assert.match(await page.locator('[data-download="macX64"]').getAttribute('aria-label'),/Intel/);
  const compactLabels=await page.evaluate(()=>({download:NotejectI18n.t('Download'),mac:NotejectI18n.t('Development builds. Not notarized; macOS may block first launch.')}));
  assert((await page.locator('[data-download="windows"]').textContent()).trim().startsWith(compactLabels.download));
  assert.equal(await page.locator('#mac-signing-requirement').textContent(),compactLabels.mac);
  if(language!=='en'){assert.notEqual(compactLabels.download,'Download');assert.notEqual(compactLabels.mac,'Development builds. Not notarized; macOS may block first launch.');}
  const panelHeight=await page.locator('.download-grid').evaluate(el=>el.getBoundingClientRect().height);
  if(viewport.width===1440)assert.ok(panelHeight<500,'Desktop download panel should stay compact: '+panelHeight);
  if(viewport.width===390)assert.ok(panelHeight<900,'Phone download panel should stay compact: '+panelHeight);
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
  if(process.env.NOTEJECT_SITE_SCREENSHOTS){fs.mkdirSync(process.env.NOTEJECT_SITE_SCREENSHOTS,{recursive:true});await page.locator('.downloads').screenshot({path:path.join(process.env.NOTEJECT_SITE_SCREENSHOTS,`downloads-${language}-${viewport.width}.png`)});}
  await page.locator('.apple-web-options>summary').click();
  assert.equal(await page.locator('.apple-web-options>summary').textContent(),labels.web);
  assert.equal(await page.locator('.apple-platform').count(),2);
  assert.equal(await page.locator('.apple-card a[href="/app/"]').count(),2);
  assert.equal(await page.locator('.apple-platform').first().isVisible(),true);
  const box=await page.locator('.apple-card').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=viewport.width,viewport.name+' Apple download card overflowed');
  assert.ok(await page.locator('.apple-card').evaluate(el=>el.scrollWidth<=el.clientWidth+1),language+' '+viewport.name+' Apple content overflowed');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1?null:[...document.querySelectorAll('body *')].map(el=>({tag:el.tagName,cls:el.className,x:el.getBoundingClientRect().x,right:el.getBoundingClientRect().right})).filter(box=>box.x<0||box.right>document.documentElement.clientWidth+1).slice(0,15));
  assert.equal(overflow,null,language+' '+viewport.name+' page overflowed horizontally: '+JSON.stringify(overflow));
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
  const currentStatus=await page.locator('[data-download-status="ios"]').textContent();
  assert(currentStatus.includes(labels.status),language+' stale unsigned status: '+JSON.stringify({actual:currentStatus,expected:labels.status}));
  assert.equal(await page.locator('#ios-signing-requirement').textContent(),labels.warning,language+' stale signing notice');
  assert.equal(await page.locator('.apple-download-copy>p').first().textContent(),labels.description,language+' stale build description');
  assert.equal(await page.locator('.apple-web-options>summary').textContent(),labels.web,language+' stale web option');
  assert.equal(await page.locator('[data-download="ios"]').getAttribute('href'),iosURL,'Changing language must preserve the actual IPA link');
  assert.ok(await page.locator('.apple-card').evaluate(el=>el.scrollWidth<=el.clientWidth+1),language+' Apple card overflowed');
  assert.ok(await page.locator('.download-grid').evaluate(el=>el.scrollWidth<=el.clientWidth+1),language+' download panel overflowed');
  const compactLabels=await page.evaluate(()=>({download:NotejectI18n.t('Download'),mac:NotejectI18n.t('Development builds. Not notarized; macOS may block first launch.')}));
  assert((await page.locator('[data-download="android"]').textContent()).trim().startsWith(compactLabels.download),language+' compact download label');
  assert.equal(await page.locator('#mac-signing-requirement').textContent(),compactLabels.mac,language+' compact Mac notice');
  if(language!=='en'){assert.notEqual(compactLabels.download,'Download',language+' untranslated Download');assert.notEqual(compactLabels.mac,'Development builds. Not notarized; macOS may block first launch.',language+' untranslated Mac notice');}
  if(language!=='en'){assert.notEqual(labels.download,downloadLabel,language+' untranslated download');assert.notEqual(labels.warning,warning,language+' untranslated signing notice');}
 }
 await page.locator('[data-download="windows"]').focus();
 for(const platform of ['android','macArm64','macX64','ios']){
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(`[data-download="${platform}"]`).evaluate(el=>el===document.activeElement),true,'Keyboard order: '+platform);
 }
 await page.keyboard.press('Tab');
 assert.equal(await page.locator('.apple-web-options>summary').evaluate(el=>el===document.activeElement),true,'Safari instructions must be reachable by keyboard');
 const manifestResponse=await page.request.get(origin+'/manifest.webmanifest');assert.equal(manifestResponse.status(),200);
 const iconResponse=await page.request.get(origin+'/apple-touch-icon.png');assert.equal(iconResponse.status(),200);
 await page.goto(origin+'/app/');assert.equal(await page.locator('link[rel="manifest"]').count(),1);
 assert.deepEqual(errors,[]);
});
