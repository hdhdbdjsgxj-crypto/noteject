'use strict';
/* Run with `vercel env run -e production -- node scripts/publish-releases.cjs`.
   The storage secret stays in child-process environment variables. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),manifestPath=path.join(root,'release-manifest.json');
const cli=process.env.NOTEJECT_VERCEL_CLI||'C:/Users/Name/AppData/Roaming/npm/node_modules/vercel/dist/vc.js';
function upload(file,pathname){
 if(!process.env.BLOB_READ_WRITE_TOKEN)throw Error('The linked Production download storage is not configured.');
 const env={...process.env};delete env.VERCEL_OIDC_TOKEN;delete env.BLOB_STORE_ID;
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,'blob','put',file,'--access','public','--pathname',pathname,'--multipart','true','--scope','eclipse-creative','--non-interactive'],{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  child.on('error',()=>reject(Error('Could not start the installer upload.')));
  child.on('close',code=>{if(code===0)return resolve();const safe=output.replace(/(?:vercel_blob_rw_|sb_secret_|sk-proj-)[A-Za-z0-9_.-]+/g,'[private]').slice(-1600);reject(Error('Installer upload failed: '+safe));});
 });
}
async function publishedSize(url){
 const head=await fetch(url,{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(30000)});
 const bytes=head.headers.get('content-length')===null?NaN:Number(head.headers.get('content-length'));
 if(head.ok&&Number.isSafeInteger(bytes))return {ok:true,bytes};
 // A range also handles missing Content-Length or a stale negative HEAD cache.
 const probe=await fetch(url,{headers:{Range:'bytes=0-0'},cache:'no-store',signal:AbortSignal.timeout(30000)});
 const range=/^bytes\s+0-0\/(\d+)$/i.exec(probe.headers.get('content-range')||'');
 const result={ok:probe.status===206&&!!range,bytes:range?Number(range[1]):NaN};
 await probe.body?.cancel();return result;
}
async function main(){
 const current=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 const android=fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8').match(/versionName\s+'([^']+)'/)[1];
 const windows=require('../package.json').version,base=new URL(current.android.url).origin;
 const mac=process.argv.includes('--include-mac')?windows:(current.macArm64?.version||windows);
 const next={...current};
 const releases=[
  {platform:'android',version:android,name:'Noteject-Android-'+android+'.apk'},
  {platform:'windows',version:windows,name:'Noteject-Setup-'+windows+'-x64.exe'},
  {platform:'macArm64',version:mac,name:'Noteject-Mac-'+mac+'-arm64-development.dmg'},
  {platform:'macX64',version:mac,name:'Noteject-Mac-'+mac+'-x64-development.dmg'}
 ];
 if(process.argv.includes('--include-ios')||current.ios){
  const version=process.argv.includes('--include-ios')?windows:current.ios.version;
  releases.push({platform:'ios',version,name:'Noteject-iPhone-iPad-'+version+'-unsigned.ipa'});
 }
 for(const release of releases){
  const file=path.join(root,'release',release.platform==='ios'||release.platform.startsWith('mac')?'apple':'',release.name),bytes=fs.statSync(file).size,pathname=release.name,url=base+'/'+pathname;
  let ios=null;
  if(release.platform==='ios'){
   ios=await require('./verify-ios-ipa.cjs').verifyIpa(file);
   if(!ios.verified||ios.version!==release.version||ios.signedForInstallation!==false)throw Error('The iOS build verification failed.');
  }
  let remote=await publishedSize(url);
  if(!remote.ok){
   console.log('Uploading '+release.platform+' '+release.version+'…');await upload(file,pathname);
   for(let attempt=0;attempt<6;attempt++){
    remote=await publishedSize(url);if(remote.ok&&remote.bytes===bytes)break;
    if(attempt<5)await new Promise(resolve=>setTimeout(resolve,2000));
   }
  }
  if(!remote.ok||remote.bytes!==bytes)throw Error('Published '+release.platform+' size check failed.');
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  const sha256=hash.digest('hex');
  if(ios){
   const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw Error('The public IPA could not be downloaded.');
   const publicHash=crypto.createHash('sha256');for await(const chunk of response.body)publicHash.update(chunk);
   if(publicHash.digest('hex')!==sha256)throw Error('The public IPA checksum does not match the verified build.');
  }
  next[release.platform]={version:release.version,url,bytes,sha256,...(ios?{signedForInstallation:false,minimumIOS:ios.minimumIOS,architectures:ios.architectures,devices:ios.devices}:{})};console.log('Verified '+release.platform+' '+release.version+' ('+bytes+' bytes).');
 }
 // Advertise only after every upload and the public IPA checksum are verified.
 fs.writeFileSync(manifestPath,JSON.stringify(next,null,2)+'\n');console.log('Updated the shared release manifest. Redeploy the site to publish these links.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
