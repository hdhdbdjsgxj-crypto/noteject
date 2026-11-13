'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../cloud-sync.js'),'utf8').replace(/\r\n/g,'\n');
const marker='  restoreSession();\n  // Keep the session token';assert(source.includes(marker));
const instrumented=source.replace(marker,`  window.auditCloud={signOut,downloadWorkspace,uploadWorkspace,deleteWorkspaceBackup,refreshAccount,getAccount,
 session:value=>saveSession(value),state:()=>({session,account,syncBusy}),configure:value=>{config=value;dialog={querySelector:()=>null};}};return;
  // Keep the session token`);
const session=id=>({access_token:id+'-token',refresh_token:id+'-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id,email:id+'@test.invalid'}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const json=data=>new Response(JSON.stringify(data),{status:200});
function harness(handler,options={}){
 const nodes=new Map(),storage=new Map(),restores=[],requests=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false,style:{},dataset:{},setAttribute(){},querySelector:()=>node(id+'-span')});return nodes.get(id);};
 const window={NotejectWebApp:true,NotejectDialogs:{confirm:options.confirm||(async()=>true)}};
 const context=vm.createContext({window,document:{documentElement:{classList:{add(){}}},getElementById:node,dispatchEvent(){}},location:new URL('https://noteject.test/app'),localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},fetch:async(url,init={})=>{requests.push({url,method:init.method||'GET',signal:init.signal});if(url.includes('/logout'))return json({});if(url.endsWith('/api/account'))return handler?handler(url,init):json({plan:'free',basic:{used:0,limit:10},advanced:{used:0,limit:0}});return handler(url,init);},Blob,File,Response,Headers,URL,AbortController,AbortSignal,DOMException,TransformStream,TextEncoder,crypto:require('node:crypto').webcrypto,Event,console,setTimeout,workspaceStore:{flush:()=>true},exportWorkspaceBackup:options.exportBackup||(async()=>new Blob(['ARCHIVE'])),loadWorkspaceBackup:async(file,settings)=>{restores.push({owner:window.auditCloud.state().session?.user?.id,bytes:await file.text(),signal:settings?.signal});return true;}});
 vm.runInContext(instrumented,context);window.auditCloud.configure({cloudEnabled:true,supabaseUrl:'https://fixture.supabase.co',supabaseAnonKey:'public-test-key',syncMaxBytes:52428800});window.auditCloud.session(session('a'));
 return{api:window.auditCloud,nodes,storage,restores,requests};
}
const head=()=>json([{revision:1,snapshot_path:'a/copy.zip',archive_size:9,updated_at:new Date().toISOString()}]);
test('account change cancels a pending restore and never writes the next account sync state',async()=>{
 const requested=deferred(),response=deferred();const h=harness(async url=>{if(url.includes('/storage/')){requested.resolve();return response.promise;}if(url.includes('workspace_sync_heads'))return head();throw Error('Unexpected request');});
 const work=h.api.downloadWorkspace();await requested.promise;const transferRequest=h.requests.find(r=>r.url.includes('/storage/'));await h.api.signOut();h.api.session(session('b'));response.resolve(new Response('ACCOUNT A'));await work;
 assert.equal(transferRequest.signal.aborted,true);assert.deepEqual(h.restores,[]);assert.equal(h.storage.has('noteject-cloud-sync-v1:b'),false);assert.equal(h.api.state().syncBusy,false);
});
test('late plan and user responses cannot populate a different account',async()=>{
 for(const kind of ['plan','user']){
  const requested=deferred(),response=deferred();const h=harness(async()=>{requested.resolve();return response.promise;});
  const work=(kind==='plan'?h.api.getAccount():h.api.refreshAccount()).catch(error=>assert.equal(error.accountChanged,true));await requested.promise;await h.api.signOut();h.api.session(session('b'));response.resolve(json(kind==='plan'?{plan:'pro'}:{id:'a',email:'a@test.invalid'}));await work;
  assert.equal(h.api.state().session.user.id,'b');assert.equal(h.api.state().account,null);
 }
});
test('offline sign-out clears local credentials before waiting for the network',async()=>{
 const network=deferred();const h=harness(()=>network.promise);h.api.configure(null);const work=h.api.signOut();assert.equal(h.api.state().session,null);assert.equal(h.storage.has('noteject-cloud-session-v1:https://noteject.test'),false);network.resolve(json({}));await work;
});
test('changing accounts while preparing upload cannot upload or publish the old workspace',async()=>{
 const started=deferred(),archive=deferred();const h=harness(async url=>{if(url.includes('workspace_sync_heads'))return json([]);if(url.endsWith('/api/account'))return json({plan:'free',basic:{used:0,limit:10},advanced:{used:0,limit:0}});throw Error('Unexpected request');},{exportBackup:async({signal})=>{started.resolve(signal);return archive.promise;}});
 const work=h.api.uploadWorkspace(),signal=await started.promise;await h.api.signOut();h.api.session(session('b'));archive.resolve(new Blob(['ARCHIVE']));await work;assert.equal(signal.aborted,true);assert.equal(h.requests.some(r=>r.method==='POST'&&!r.url.includes('/logout')),false);assert.equal(h.storage.has('noteject-cloud-sync-v1:b'),false);
});
test('a confirmation started by one account cannot delete another account backup',async()=>{
 const confirmation=deferred();const h=harness(async()=>{throw Error('No requests expected');},{confirm:()=>confirmation.promise});const work=h.api.deleteWorkspaceBackup();await h.api.signOut();h.api.session(session('b'));confirmation.resolve(true);await work;assert.equal(h.requests.some(r=>r.method==='DELETE'),false);
});
test('an unchanged account completes restore and saves the correct owner revision',async()=>{
 const h=harness(async url=>{if(url.includes('/storage/'))return new Response('ACCOUNT A');if(url.includes('workspace_sync_heads'))return head();if(url.endsWith('/api/account'))return json({plan:'free',basic:{used:0,limit:10},advanced:{used:0,limit:0}});throw Error('Unexpected request');});await h.api.downloadWorkspace();assert.equal(h.restores.length,1);assert.equal(h.restores[0].owner,'a');assert(h.restores[0].signal instanceof AbortSignal);assert.equal(JSON.parse(h.storage.get('noteject-cloud-sync-v1:a')).revision,1);assert.equal(h.api.state().syncBusy,false);
});
