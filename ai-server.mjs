import http from 'node:http';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.NOTEJECT_PORT || 41783);
const storageConfigPath=path.resolve(process.env.NOTEJECT_STORAGE_CONFIG || path.join(root,'.noteject-storage.json'));
let projectsRoot = path.resolve(process.env.NOTEJECT_PROJECTS_DIR || (()=>{try{return JSON.parse(fs.readFileSync(storageConfigPath,'utf8')).projectsRoot}catch{return path.join(root,'projects')}})());
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.wasm':'application/wasm', '.ttf':'font/ttf', '.woff':'font/woff', '.woff2':'font/woff2' };
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocalOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function isLocalAppOrigin(origin) {
  try {
    const parsed = new URL(origin);
    const appPort = String(process.env.NOTEJECT_APP_PORT || (port === 41784 ? 41783 : port));
    const allowedPorts = new Set([String(port), appPort]);
    return isLocalOrigin(origin) && allowedPorts.has(parsed.port);
  } catch { return false; }
}
function requireLocalStorageRequest(req, res) {
  if (!localAddresses.has(req.socket.remoteAddress) || (req.headers.origin && !isLocalAppOrigin(req.headers.origin))) {
    res.writeHead(403, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Only the local noteject app can browse or choose project storage locations.'}));
    return false;
  }
  return true;
}
function requireLocalAiRequest(req, res) {
  if (!localAddresses.has(req.socket.remoteAddress) || (req.headers.origin && !isLocalAppOrigin(req.headers.origin))) {
    res.writeHead(403, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Only the local noteject app can use the AI service.'}));
    return false;
  }
  return true;
}
function requireJsonRequest(req, res) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    res.writeHead(415, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Send this request as application/json.'}));
    return false;
  }
  return true;
}
function parseLocalDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value)) {
    throw new Error('Enter a valid absolute path.');
  }
  // Avoid Windows device paths and network shares: this chooser manages local disk folders.
  if (process.platform === 'win32' && (!/^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value))) {
    throw new Error('Choose a local drive location, such as C:\\Users\\Name\\Documents.');
  }
  return path.resolve(value);
}
async function isDirectory(directory) {
  let timeout;
  try {
    const stat = await Promise.race([
      fs.promises.stat(directory),
      new Promise((_,reject) => { timeout=setTimeout(() => reject(new Error('Project storage access timed out.')),750); })
    ]);
    return stat.isDirectory();
  } catch { return false; }
  finally { clearTimeout(timeout); }
}
function pathsOverlap(left, right) {
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  };
  return within(left, right) || within(right, left);
}
async function fileHash(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'), stream = fs.createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
async function copyProjectStorage(source, destination) {
  const copied = {copiedFiles:0, reusedFiles:0};
  let sourceInfo;
  try { sourceInfo = await fs.promises.lstat(source); }
  catch (error) { if (error.code === 'ENOENT') return copied; throw error; }
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('The current project storage location is not a regular folder.');
  async function visit(from, to) {
    await fs.promises.mkdir(to, {recursive:true});
    const entries = await fs.promises.readdir(from, {withFileTypes:true});
    for (const entry of entries) {
      const fromPath = path.join(from, entry.name), toPath = path.join(to, entry.name), info = await fs.promises.lstat(fromPath);
      if (info.isSymbolicLink()) throw new Error('Project storage contains a shortcut or symbolic link. Remove it before changing locations.');
      if (info.isDirectory()) {
        try {
          const targetInfo = await fs.promises.lstat(toPath);
          if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('A different item already exists at ' + entry.name + '. Choose an empty folder or resolve the name conflict.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await visit(fromPath, toPath);
        continue;
      }
      if (!info.isFile()) throw new Error('Project storage contains an unsupported item: ' + entry.name);
      let targetInfo;
      try { targetInfo = await fs.promises.lstat(toPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (targetInfo) {
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.size !== info.size || await fileHash(fromPath) !== await fileHash(toPath)) {
          throw new Error('A different file already exists at ' + entry.name + '. The old folder is still active; choose an empty folder or resolve the conflict.');
        }
        copied.reusedFiles++;
        continue;
      }
      await fs.promises.mkdir(path.dirname(toPath), {recursive:true});
      try { await fs.promises.copyFile(fromPath, toPath, fs.constants.COPYFILE_EXCL); copied.copiedFiles++; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const racedInfo = await fs.promises.lstat(toPath);
        if (!racedInfo.isFile() || racedInfo.size !== info.size || await fileHash(fromPath) !== await fileHash(toPath)) throw new Error('A different file appeared at ' + entry.name + '. The old folder is still active.');
        copied.reusedFiles++;
      }
    }
  }
  await visit(source, destination);
  return copied;
}
async function defaultBrowserDirectory() {
  let directory;
  try { directory=parseLocalDirectory(projectsRoot); } catch { return os.homedir(); }
  const deadline=Date.now()+1500;
  for (let depth = 0; depth < 12; depth++) {
    if (await isDirectory(directory)) return directory;
    if (Date.now() >= deadline) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return os.homedir();
}
async function folderLocations() {
  const home = os.homedir();
  const candidates = [
    {name:'Project attachments', path:projectsRoot},
    {name:'Home', path:home},
    {name:'Documents', path:path.join(home, 'Documents')},
    {name:'Desktop', path:path.join(home, 'Desktop')},
    {name:'Downloads', path:path.join(home, 'Downloads')}
  ];
  const available = await Promise.all(candidates.map(async place => await isDirectory(place.path) ? place : null));
  const seen = new Set();
  const places = available.filter(place => {
    if (!place) return false;
    const key = process.platform === 'win32' ? place.path.toLowerCase() : place.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const roots = process.platform === 'win32' ? Array.from({length:26}, (_, index) => String.fromCharCode(65 + index) + ':\\') : ['/'];
  const drives = (await Promise.all(roots.map(async directory => await isDirectory(directory) ? {name:directory, path:directory} : null))).filter(Boolean);
  return {places, drives};
}
function folderError(error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'That location does not exist. Choose another location or enter its full path.';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'Windows denied access to this location. Choose a location you can access.';
  return error.message && !error.code ? error.message.slice(0,250) : 'Could not open this location. Choose another location.';
}
function openAiErrorMessage(error) {
  const cause=error?.cause, code=cause?.code;
  if(code==='EACCES'||code==='EPERM') return 'Windows denied noteject network access to api.openai.com ('+code+'). Allow node.exe through your firewall or VPN, then retry.';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN') return 'Could not resolve api.openai.com. Check your internet connection, DNS, or VPN.';
  if(code==='ECONNRESET'||code==='ETIMEDOUT'||code==='ECONNREFUSED') return 'Could not connect to api.openai.com ('+code+'). Check your internet connection, VPN, or firewall.';
  if(error?.name==='TimeoutError') return 'The connection to api.openai.com timed out. Check your internet connection and retry.';
  return cause?.message ? 'Could not connect to api.openai.com: '+cause.message : (error?.message||'Could not contact OpenAI.');
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader('Cache-Control','no-store');
  if (url.pathname === '/api/files/move' || url.pathname === '/api/files/rename' || url.pathname === '/api/files' || url.pathname === '/api/file-status' || url.pathname === '/api/projects' || url.pathname === '/api/project-notes' || url.pathname === '/api/storage-path' || url.pathname === '/api/choose-folder' || url.pathname === '/api/folders') {
    const origin=req.headers.origin||'';
    if (!localAddresses.has(req.socket.remoteAddress) || (origin && !isLocalAppOrigin(origin))) { res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Only the local noteject app can access project storage.'})); return; }
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Range');res.setHeader('Access-Control-Expose-Headers','Accept-Ranges, Content-Range, Content-Length, Content-Disposition')}
    if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  }
  if (url.pathname === '/api/files/move' && req.method === 'POST') {
    if (!requireLocalStorageRequest(req,res)) return;
    let body=''; for await (const chunk of req) { body+=chunk; if(body.length>30000){res.writeHead(413).end('Request too large');return;} }
    try {
      const {fromProject,toProject,id:fileId,name}=JSON.parse(body), clean=value=>path.basename(String(value||'')).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180), cleanName=clean(name);
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(fromProject||'')||!/^[a-zA-Z0-9_-]{1,100}$/.test(toProject||'')||!/^[a-zA-Z0-9_-]{1,100}$/.test(fileId||'')||!cleanName||cleanName==='.'||cleanName==='..'){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Invalid project or file name.'}));return;}
      if(fromProject===toProject){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,project:toProject,name:cleanName}));return;}
      const source=path.join(projectsRoot,fromProject,'attachments',fileId,cleanName), destinationFolder=path.join(projectsRoot,toProject,'attachments',fileId), destination=path.join(destinationFolder,cleanName), sourceStat=await fs.promises.lstat(source);
      if(!sourceStat.isFile()||sourceStat.isSymbolicLink())throw Object.assign(Error('The source attachment is not a regular file.'),{code:'EINVAL'});
      await fs.promises.mkdir(destinationFolder,{recursive:true});
      try { await fs.promises.lstat(destination); throw Object.assign(Error('A file with this name already exists in the destination project.'),{code:'EEXIST'}); } catch(error) { if(error.code!=='ENOENT') throw error; }
      try { await fs.promises.rename(source,destination); }
      catch(error) {
        if(error.code!=='EXDEV')throw error;
        const temporary=destination+'.'+randomUUID()+'.tmp';
        try { await fs.promises.copyFile(source,temporary,fs.constants.COPYFILE_EXCL); await fs.promises.rename(temporary,destination); await fs.promises.unlink(source); }
        catch(copyError){await fs.promises.unlink(temporary).catch(()=>{});throw copyError;}
      }
      await fs.promises.rmdir(path.dirname(source)).catch(()=>{});
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,project:toProject,name:cleanName}));
    } catch(error) {
      const status=error.code==='ENOENT'?404:error.code==='EEXIST'?409:400;
      res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.code==='ENOENT'?'Original attachment file was not found.':error.message||'Could not move attachment.'}));
    }
    return;
  }
  if (url.pathname === '/api/files/rename' && req.method === 'POST') {
    if (!requireLocalStorageRequest(req,res)) return;
    let body=''; for await (const chunk of req) { body+=chunk; if(body.length>20000){res.writeHead(413).end('Request too large');return;} }
    try { const {project,id:fileId,oldName,newName}=JSON.parse(body); const clean=n=>path.basename(String(n||'')).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180); const oldClean=clean(oldName),nextClean=clean(newName); if(!/^[a-zA-Z0-9_-]{1,100}$/.test(project||'')||!/^[a-zA-Z0-9_-]{1,100}$/.test(fileId||'')||!oldClean||!nextClean){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Invalid file or name.'}));return;} const folder=path.join(projectsRoot,project,'attachments',fileId),from=path.join(folder,oldClean),to=path.join(folder,nextClean);await fs.promises.rename(from,to);res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,name:nextClean})); }
    catch(error) { res.writeHead(error.code==='ENOENT'?404:400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.code==='ENOENT'?'Original attachment file was not found.':error.message||'Could not rename attachment.'})); }
    return;
  }
  if (url.pathname === '/api/choose-folder' && req.method === 'POST') {
    if (!requireLocalStorageRequest(req,res)) return;
    // Older clients must refresh instead of silently saving the current folder again.
    res.writeHead(409,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Refresh noteject to open the project storage browser.',storageBrowserVersion:3}));
    return;
  }
  if (url.pathname === '/api/folders' && req.method === 'GET') {
    if (!requireLocalStorageRequest(req,res)) return;
    let handle;
    try {
      const directory = url.searchParams.has('directory') ? parseLocalDirectory(url.searchParams.get('directory')) : await defaultBrowserDirectory();
      handle = await fs.promises.opendir(directory);
      const folders = [];
      let truncated = false;
      let entriesRead = 0;
      for await (const entry of handle) {
        if (++entriesRead > 10000) { truncated = true; break; }
        if (!entry.isDirectory()) continue;
        if (folders.length >= 1000) { truncated = true; break; }
        folders.push({name:entry.name, path:path.join(directory, entry.name)});
      }
      handle = null;
      folders.sort((left,right) => left.name.localeCompare(right.name,undefined,{numeric:true,sensitivity:'base'}));
      const parent = path.dirname(directory);
      const locations = await folderLocations();
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({directory,parent:parent===directory?null:parent,folders,...locations,truncated}));
    } catch(error) {
      res.writeHead(error.code==='EACCES'||error.code==='EPERM'?403:400,{'Content-Type':'application/json'}).end(JSON.stringify({error:folderError(error)}));
    } finally { if(handle) await handle.close().catch(()=>{}); }
    return;
  }
  if (url.pathname === '/api/file-status' && req.method === 'GET') { res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({fileStorage:true,path:projectsRoot,storageBrowserVersion:3})); return; }
  if (url.pathname === '/api/storage-path' && req.method === 'POST') {
    if (!requireLocalStorageRequest(req,res)) return;
    let body=''; for await (const chunk of req) { body+=chunk; if(body.length>20000){res.writeHead(413).end('Request too large');return;} }
    let probePath, temporaryConfig;
    try {
      const {directory}=JSON.parse(body), selected=parseLocalDirectory(directory);
      const previous = path.resolve(projectsRoot), destination = path.resolve(selected);
      const sameDirectory = path.relative(previous, destination) === '' && path.relative(destination, previous) === '';
      if (pathsOverlap(previous, destination) && !sameDirectory) throw new Error('Choose a folder outside the current project storage folder.');
      await fs.promises.mkdir(destination,{recursive:true});
      if (!(await fs.promises.stat(destination)).isDirectory()) throw Error('Selected path cannot be used for project storage.');
      probePath=path.join(destination,'.noteject-write-check-'+randomUUID());
      const probe=await fs.promises.open(probePath,'wx');
      await probe.close();
      await fs.promises.unlink(probePath);
      probePath=null;
      const migrated = sameDirectory ? {copiedFiles:0,reusedFiles:0} : await copyProjectStorage(previous, destination);
      temporaryConfig=storageConfigPath+'.'+randomUUID()+'.tmp';
      await fs.promises.writeFile(temporaryConfig,JSON.stringify({projectsRoot:destination},null,2),{encoding:'utf8',flag:'wx'});
      await fs.promises.rename(temporaryConfig,storageConfigPath);
      temporaryConfig=null;
      projectsRoot=destination;
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,path:projectsRoot,previousPath:previous,...migrated}));
    }
    catch(error) { res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:folderError(error)})); }
    finally { if(probePath) await fs.promises.unlink(probePath).catch(()=>{}); if(temporaryConfig) await fs.promises.unlink(temporaryConfig).catch(()=>{}); }
    return;
  }
  if (url.pathname === '/api/project-notes' && ['POST','DELETE'].includes(req.method)) {
    if (!requireLocalStorageRequest(req,res)) return;
    let body=''; for await (const chunk of req) { body+=chunk; if(body.length>2_000_000){res.writeHead(413).end('Request too large');return;} }
    try { const note=JSON.parse(body), project=note.project, noteId=note.id; if(typeof project!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(project)||typeof noteId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(noteId)){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Invalid project or note ID.'}));return;} const folder=path.join(projectsRoot,project,'notes'); const filename=path.join(folder,noteId+'.md'); if(req.method==='DELETE'){await fs.promises.rm(filename,{force:true});res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true}));return;} await fs.promises.mkdir(folder,{recursive:true}); const title=String(note.title||'Untitled note').replace(/[\r\n]+/g,' ').slice(0,500); const content='# '+title+'\n\n'+String(note.content||'')+'\n'; await fs.promises.writeFile(filename,content,'utf8'); res.writeHead(201,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,path:filename})); }
    catch(error) { res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message||'Could not save project note.'})); }
    return;
  }
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    if (!requireLocalStorageRequest(req,res)) return;
    let body=''; for await (const chunk of req) { body+=chunk; if(body.length>10000){res.writeHead(413).end('Request too large');return;} }
    try { const {project}=JSON.parse(body); if(typeof project!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(project)){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Invalid project storage name.'}));return;} const folder=path.join(projectsRoot,project); await fs.promises.mkdir(folder,{recursive:true}); res.writeHead(201,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,project,path:folder})); }
    catch(error) { res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message||'Could not create project storage.'})); }
    return;
  }
  if (url.pathname === '/api/files' && ['POST','GET','DELETE'].includes(req.method)) {
    if (!requireLocalStorageRequest(req,res)) return;
    const project=url.searchParams.get('project')||'', fileId=url.searchParams.get('id')||'', name=url.searchParams.get('name')||'';
    const cleanName=path.basename(name).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(project) || !/^[a-zA-Z0-9_-]{1,100}$/.test(fileId) || !cleanName || cleanName==='.' || cleanName==='..') { res.writeHead(400).end('Invalid project or file name'); return; }
    const folder=path.join(projectsRoot,project,'attachments',fileId), filename=path.resolve(folder,cleanName);
    if (!filename.startsWith(folder+path.sep)) { res.writeHead(400).end('Invalid file path'); return; }
    if (req.method === 'POST') {
      let bytes=0; const maxBytes=2*1024*1024*1024;
      try { await fs.promises.mkdir(folder,{recursive:true}); await pipeline(req,new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>maxBytes?new Error('File exceeds the 2 GB limit'):null,chunk)}}),fs.createWriteStream(filename)); res.writeHead(201,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,bytes,project,fileId,name:cleanName})); }
      catch(error) { await fs.promises.rm(folder,{recursive:true,force:true}).catch(()=>{}); res.writeHead(error.message.includes('2 GB')?413:500,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message||'Could not save file'})); }
      return;
    }
    if (req.method === 'DELETE') { try { await fs.promises.rm(folder,{recursive:true,force:true}); res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true})); } catch(error) { res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message||'Could not delete project attachment.'})); } return; }
    try { const stat=await fs.promises.stat(filename); if(!stat.isFile())throw Error('Not a file'); const types={'.txt':'text/plain; charset=utf-8','.pdf':'application/pdf','.epub':'application/epub+zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.avif':'image/avif','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.m4v':'video/x-m4v','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac'}; const baseHeaders={'Content-Type':types[path.extname(cleanName).toLowerCase()]||'application/octet-stream','Content-Disposition':url.searchParams.get('download')==='1'?'attachment; filename="'+cleanName.replace(/"/g,'')+'"':'inline; filename="'+cleanName.replace(/"/g,'')+'"','Accept-Ranges':'bytes'};const range=req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);if(range){let start=range[1]?Number(range[1]):Math.max(0,stat.size-Number(range[2]||0)),end=range[2]?Number(range[2]):stat.size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){res.writeHead(416,{'Content-Range':'bytes */'+stat.size}).end();return}end=Math.min(end,stat.size-1);res.writeHead(206,{...baseHeaders,'Content-Length':end-start+1,'Content-Range':'bytes '+start+'-'+end+'/'+stat.size});fs.createReadStream(filename,{start,end}).pipe(res)}else{res.writeHead(200,{...baseHeaders,'Content-Length':stat.size});fs.createReadStream(filename).pipe(res)} }
    catch { res.writeHead(404).end('File not found'); }
    return;
  }
  if (url.pathname === '/api/key-status' && req.method === 'GET') {
    if (!requireLocalAiRequest(req,res)) return;
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({configured:false,managed:true,serviceVersion:3})); return;
  }
  if (['/api/key','/api/models','/api/ask'].includes(url.pathname)) {
    res.writeHead(410,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Sign in to your Noteject account to use Noteject AI. Personal API keys are not supported.'})); return;
  }
  if (req.method !== 'GET') { res.writeHead(405).end('Method not allowed'); return; }
  const relative = decodeURIComponent(url.pathname.slice(1) || 'index.html');
  const filename = path.resolve(root,relative);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200,{'Content-Type':mime[path.extname(filename)] || 'application/octet-stream'}).end(fs.readFileSync(filename));
});
server.listen(port,'127.0.0.1',()=>console.log(`noteject local AI server: http://127.0.0.1:${port}`));
