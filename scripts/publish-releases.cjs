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
async function main(){
 const current=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 const android=fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8').match(/versionName\s+'([^']+)'/)[1];
 const windows=require('../package.json').version,base=new URL(current.android.url).origin;
 const mac=process.argv.includes('--include-mac')?windows:(current.macArm64?.version||windows);
 const next={};
 for(const release of [
  {platform:'android',version:android,name:'Noteject-Android-'+android+'.apk'},
  {platform:'windows',version:windows,name:'Noteject-Setup-'+windows+'-x64.exe'},
  {platform:'macArm64',version:mac,name:'Noteject-Mac-'+mac+'-arm64-development.dmg'},
  {platform:'macX64',version:mac,name:'Noteject-Mac-'+mac+'-x64-development.dmg'}
 ]){
  const file=path.join(root,'release',release.platform.startsWith('mac')?'apple':'',release.name),bytes=fs.statSync(file).size,pathname=release.name,url=base+'/'+pathname;
  let remote=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(30000)});
  if(!remote.ok){console.log('Uploading '+release.platform+' '+release.version+'…');await upload(file,pathname);remote=await fetch(url,{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(30000)});}
  let publishedBytes=remote.headers.get('content-length')===null?NaN:Number(remote.headers.get('content-length'));
  if(remote.ok&&!Number.isSafeInteger(publishedBytes)){
   // Vercel's public download CDN may omit Content-Length for Windows
   // installers. A one-byte range reports the full object size without
   // downloading the installer again.
   const probe=await fetch(url,{headers:{Range:'bytes=0-0'},cache:'no-store',signal:AbortSignal.timeout(30000)});
   const range=/^bytes\s+0-0\/(\d+)$/i.exec(probe.headers.get('content-range')||'');
   publishedBytes=probe.status===206&&range?Number(range[1]):NaN;
   await probe.body?.cancel();
  }
  if(!remote.ok||publishedBytes!==bytes)throw Error('Published '+release.platform+' size check failed.');
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  next[release.platform]={version:release.version,url,bytes,sha256:hash.digest('hex')};console.log('Verified '+release.platform+' '+release.version+' ('+bytes+' bytes).');
 }
 // Do not advertise either release until both uploads have been verified.
 fs.writeFileSync(manifestPath,JSON.stringify(next,null,2)+'\n');console.log('Updated the shared release manifest. Redeploy the site to publish these links.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
