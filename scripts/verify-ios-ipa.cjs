'use strict';

// Read-only verification of the device IPA and JSON produced by the unsigned
// Xcode workflow. Nothing is extracted, signed, or packaged by this script.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const plist = require('plist');
let binaryPlist;
try { binaryPlist = require('bplist-parser'); } catch {}

const MAX_ENTRIES = 100000;
const MAX_TOTAL_BYTES = 4 * 1024 ** 3;
const MAX_EXECUTABLE_BYTES = 256 * 1024 ** 2;
const MAX_PLIST_BYTES = 4 * 1024 ** 2;
const ARM64 = 0x0100000c;

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

function safeArchiveName(name) {
  requireCondition(typeof name === 'string' && name.length > 0 && name.length <= 4096, 'Invalid ZIP pathname.');
  requireCondition(!/[\\\x00-\x1f:]/.test(name) && !name.startsWith('/'), 'Unsafe ZIP pathname: ' + JSON.stringify(name));
  const parts = name.replace(/\/$/, '').split('/');
  requireCondition(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'Unsafe ZIP pathname: ' + JSON.stringify(name));
  return name;
}

function safeLinkTarget(name, bytes) {
  requireCondition(bytes.length > 0 && bytes.length <= 4096, 'Invalid ZIP symbolic link.');
  const target = bytes.toString('utf8');
  requireCondition(!/[\\\x00-\x1f:]/.test(target) && !target.startsWith('/'), 'Unsafe ZIP symbolic link: ' + name);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
  requireCondition(resolved !== '..' && !resolved.startsWith('../'), 'ZIP symbolic link leaves the archive: ' + name);
  safeArchiveName(resolved);
  return resolved;
}

function parseInfoPlist(bytes) {
  requireCondition(bytes.length > 0 && bytes.length <= MAX_PLIST_BYTES, 'Info.plist is missing or too large.');
  let value;
  if (bytes.subarray(0, 8).toString('ascii') === 'bplist00') {
    requireCondition(binaryPlist, 'Binary Info.plist parsing is unavailable. Run npm ci with the existing build dependencies.');
    const roots = binaryPlist.parseBuffer(bytes);
    requireCondition(roots.length === 1, 'Expected one binary plist root.');
    value = roots[0];
  } else {
    value = plist.parse(bytes.toString('utf8'));
  }
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'Info.plist must contain a dictionary.');
  return value;
}

function inspectThinMachO(bytes, offset, length, declaredCpu) {
  requireCondition(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && length >= 32 && offset >= 0 && offset + length <= bytes.length, 'Mach-O slice is out of bounds.');
  const slice = bytes.subarray(offset, offset + length);
  requireCondition(slice.readUInt32LE(0) === 0xfeedfacf, 'Expected a little-endian 64-bit Mach-O executable.');
  const cpu = slice.readUInt32LE(4);
  requireCondition(cpu === ARM64 && (declaredCpu === undefined || declaredCpu === cpu), 'The app executable must contain arm64 device code.');
  requireCondition(slice.readUInt32LE(12) === 2, 'The app binary is not an MH_EXECUTE executable.');
  const count = slice.readUInt32LE(16), commandBytes = slice.readUInt32LE(20), commandsEnd = 32 + commandBytes;
  requireCondition(count > 0 && count <= 4096 && commandBytes <= length - 32, 'Mach-O load commands are out of bounds.');
  let cursor = 32, platform, entryOffset, textSegment, codeSignature = false;
  for (let index = 0; index < count; index++) {
    requireCondition(cursor + 8 <= commandsEnd, 'Truncated Mach-O load command.');
    const command = slice.readUInt32LE(cursor), size = slice.readUInt32LE(cursor + 4);
    requireCondition(size >= 8 && size % 8 === 0 && cursor + size <= commandsEnd, 'Invalid Mach-O load command size.');
    if (command === 0x32) { // LC_BUILD_VERSION
      requireCondition(size >= 24 && platform === undefined, 'Invalid or duplicate Mach-O platform command.');
      platform = slice.readUInt32LE(cursor + 8);
      const tools = slice.readUInt32LE(cursor + 20);
      requireCondition(24 + tools * 8 <= size, 'Truncated Mach-O build tools.');
    }
    if (command === 0x80000028) { // LC_MAIN
      requireCondition(size >= 24 && entryOffset === undefined, 'Invalid or duplicate Mach-O entry point.');
      const entry = slice.readBigUInt64LE(cursor + 8);
      requireCondition(entry <= BigInt(Number.MAX_SAFE_INTEGER), 'Mach-O entry point is too large.');
      entryOffset = Number(entry);
    }
    if (command === 0x19) { // LC_SEGMENT_64
      requireCondition(size >= 72, 'Truncated Mach-O segment.');
      requireCondition(72 + slice.readUInt32LE(cursor + 64) * 80 <= size, 'Truncated Mach-O sections.');
      const name = slice.subarray(cursor + 8, cursor + 24).toString('ascii').replace(/\0.*$/, '');
      const fileStart = slice.readBigUInt64LE(cursor + 40), fileBytes = slice.readBigUInt64LE(cursor + 48);
      requireCondition(fileStart + fileBytes <= BigInt(length), 'Mach-O segment is outside the executable.');
      if (name === '__TEXT') {
        requireCondition(textSegment === undefined && (slice.readUInt32LE(cursor + 60) & 4), 'Invalid executable __TEXT segment.');
        textSegment = { start:Number(fileStart), end:Number(fileStart + fileBytes) };
      }
    }
    if (command === 0x1d) { // LC_CODE_SIGNATURE can be ad hoc, not proof of installation signing.
      requireCondition(size >= 16 && slice.readUInt32LE(cursor + 8) + slice.readUInt32LE(cursor + 12) <= length, 'Mach-O code signature is out of bounds.');
      codeSignature = true;
    }
    if (command === 0x2c) {
      requireCondition(size >= 24 && slice.readUInt32LE(cursor + 16) === 0, 'Expected unencrypted build output.');
    }
    cursor += size;
  }
  requireCondition(cursor === commandsEnd, 'Mach-O load-command length does not match its header.');
  requireCondition(platform === 2, platform === 7 ? 'Simulator code is not an iPhone/iPad device app.' : 'The executable is not built for the iOS device platform.');
  requireCondition(textSegment && entryOffset >= commandsEnd && entryOffset >= textSegment.start && entryOffset < textSegment.end, 'The compiled executable has no valid entry point.');
  return { architecture:'arm64', platform:'iphoneos', codeSignaturePresent:codeSignature };
}

function inspectMachO(bytes) {
  requireCondition(Buffer.isBuffer(bytes) && bytes.length >= 32, 'Missing compiled app executable.');
  const magic = bytes.readUInt32BE(0);
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return [inspectThinMachO(bytes, 0, bytes.length)];
  requireCondition([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic), 'The app binary is not Mach-O; an HTML or source archive is not an IPA app.');
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
  const read32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const read64 = offset => little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
  const count = read32(4), recordSize = wide ? 32 : 20;
  requireCondition(count > 0 && count <= 16 && 8 + count * recordSize <= bytes.length, 'Invalid universal Mach-O architecture table.');
  const ranges = [], results = [];
  for (let index = 0; index < count; index++) {
    const record = 8 + index * recordSize;
    const startBig = wide ? read64(record + 8) : BigInt(read32(record + 8));
    const sizeBig = wide ? read64(record + 16) : BigInt(read32(record + 12));
    requireCondition(startBig + sizeBig <= BigInt(bytes.length) && startBig >= BigInt(8 + count * recordSize) && sizeBig >= 32n, 'Universal Mach-O slice is out of bounds.');
    const start = Number(startBig), end = Number(startBig + sizeBig);
    requireCondition(ranges.every(range => end <= range.start || start >= range.end), 'Overlapping universal Mach-O slices.');
    ranges.push({start,end});
    results.push(inspectThinMachO(bytes,start,end - start,read32(record)));
  }
  return results;
}

function openZip(file) {
  return new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true,autoClose:false,decodeStrings:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>error?reject(error):resolve(zip)));
}

function readEntry(zip, entry, maximum, allowLink = false) {
  requireCondition(entry && (entry.kind === 'file' || (allowLink && entry.kind === 'link')) && entry.uncompressedSize > 0 && entry.uncompressedSize <= maximum, 'Missing, invalid, or oversized app file: ' + (entry?.fileName || 'unknown'));
  return new Promise((resolve,reject)=>zip.openReadStream(entry,(error,stream)=>{
    if(error)return reject(error);
    const chunks=[];let length=0;
    stream.on('data',chunk=>{length+=chunk.length;if(length>maximum)stream.destroy(new Error('Decompressed app file exceeds its limit.'));else chunks.push(chunk);});
    stream.on('error',reject);
    stream.on('end',()=>length===entry.uncompressedSize?resolve(Buffer.concat(chunks)):reject(new Error('ZIP file length does not match its entry.')));
  }));
}

async function entriesOf(zip) {
  const entries = new Map(), caseNames = new Set(), links = [];
  await new Promise((resolve,reject)=>{
    let total=0;
    zip.once('error',reject);zip.once('end',resolve);
    zip.on('entry',entry=>{
      try {
        safeArchiveName(entry.fileName);
        requireCondition(entries.size < MAX_ENTRIES && !(entry.generalPurposeBitFlag & 1), 'Too many ZIP entries or encrypted app content.');
        const folded=entry.fileName.normalize('NFC').toLowerCase();
        requireCondition(!caseNames.has(folded), 'Duplicate ZIP pathname: ' + entry.fileName);caseNames.add(folded);
        total+=entry.uncompressedSize;
        requireCondition(Number.isSafeInteger(total)&&total<=MAX_TOTAL_BYTES,'The uncompressed IPA exceeds its verification limit.');
        const mode=(entry.externalFileAttributes>>>16)&0xffff, kind=mode&0o170000;
        requireCondition(!kind||[0o040000,0o100000,0o120000].includes(kind),'Unsupported special file in ZIP: '+entry.fileName);
        entry.kind=entry.fileName.endsWith('/')||kind===0o040000?'directory':kind===0o120000?'link':'file';
        entries.set(entry.fileName,entry);if(entry.kind==='link')links.push(entry);
        zip.readEntry();
      }catch(error){reject(error);}
    });zip.readEntry();
  });
  for(const entry of links){
    const bytes=await readEntry(zip,entry,4096,true);
    safeLinkTarget(entry.fileName,bytes);
  }
  return entries;
}

async function verifyIpa(file, reportFile = file.replace(/\.ipa$/i,'.json')) {
  const absolute=path.resolve(file), stat=fs.statSync(absolute);
  requireCondition(/\.ipa$/i.test(absolute)&&stat.isFile()&&stat.size>0,'Provide an existing .ipa file.');
  requireCondition(path.resolve(reportFile)!==absolute,'Provide the CI JSON report next to the IPA.');
  const reportStat=fs.statSync(reportFile);
  requireCondition(reportStat.isFile()&&reportStat.size>0&&reportStat.size<=1024*1024,'Invalid CI verification report.');
  const expected=JSON.parse(fs.readFileSync(reportFile,'utf8'));
  requireCondition(expected&&expected.signedForInstallation===false&&expected.platform==='iphoneos','Expected the unsigned iPhone/iPad device build report.');
  requireCondition(Number.isSafeInteger(expected.bytes)&&expected.bytes===stat.size,'IPA size does not match the CI report.');
  requireCondition(typeof expected.sha256==='string'&&/^[a-f0-9]{64}$/i.test(expected.sha256),'Invalid CI SHA-256.');
  const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(absolute))digest.update(chunk);
  const sha256=digest.digest('hex');
  requireCondition(sha256===expected.sha256.toLowerCase(),'IPA SHA-256 does not match the CI report.');
  const zip=await openZip(absolute);
  try {
    const entries=await entriesOf(zip), apps=new Set([...entries.keys()].map(name=>name.match(/^Payload\/([^/]+\.app)\//)?.[1]).filter(Boolean));
    requireCondition(apps.size===1,'Expected exactly one device app in Payload/.');
    const prefix='Payload/'+[...apps][0]+'/', info=parseInfoPlist(await readEntry(zip,entries.get(prefix+'Info.plist'),MAX_PLIST_BYTES));
    requireCondition(info.CFBundleIdentifier==='com.noteject.app'&&info.CFBundlePackageType==='APPL','The IPA is not the Noteject application.');
    requireCondition(info.DTPlatformName==='iphoneos'&&Array.isArray(info.CFBundleSupportedPlatforms)&&info.CFBundleSupportedPlatforms.includes('iPhoneOS')&&!info.CFBundleSupportedPlatforms.includes('iPhoneSimulator'),'Info.plist does not identify an iOS device app.');
    requireCondition(Array.isArray(info.UIDeviceFamily)&&info.UIDeviceFamily.length===2&&info.UIDeviceFamily.includes(1)&&info.UIDeviceFamily.includes(2),'Expected one universal iPhone and iPad app.');
    requireCondition(String(info.CFBundleShortVersionString)===String(expected.version)&&String(info.CFBundleVersion)===String(expected.build),'App version/build do not match the CI report.');
    const executable=info.CFBundleExecutable;
    requireCondition(typeof executable==='string'&&executable.length>0&&executable.length<=255&&!/[\/\\:\x00-\x1f]/.test(executable)&&executable!=='.'&&executable!=='..','Invalid app executable name.');
    const slices=inspectMachO(await readEntry(zip,entries.get(prefix+executable),MAX_EXECUTABLE_BYTES));
    requireCondition(Array.isArray(expected.architectures)&&expected.architectures.length===1&&expected.architectures[0]==='arm64','CI architecture metadata does not match the compiled executable.');
    requireCondition(Array.isArray(expected.devices)&&expected.devices.length===2&&expected.devices.includes('iPhone')&&expected.devices.includes('iPad'),'CI device metadata does not match the app.');
    requireCondition(!entries.has(prefix+'embedded.mobileprovision'),'Unexpected provisioning profile in an unsigned build.');
    const html=await readEntry(zip,entries.get(prefix+'public/index.html'),8*1024*1024);
    requireCondition(/<html\b/i.test(html.toString('utf8')),'The native workspace HTML is missing.');
    const config=JSON.parse((await readEntry(zip,entries.get(prefix+'capacitor.config.json'),1024*1024)).toString('utf8'));
    requireCondition(config.appId===info.CFBundleIdentifier,'Capacitor app ID does not match the native bundle.');
    return { verified:true,file:absolute,bytes:stat.size,sha256,bundleId:info.CFBundleIdentifier,version:String(info.CFBundleShortVersionString),build:String(info.CFBundleVersion),platform:'iphoneos',architectures:[...new Set(slices.map(slice=>slice.architecture))],devices:['iPhone','iPad'],minimumIOS:String(info.MinimumOSVersion||''),codeSignaturePresent:slices.some(slice=>slice.codeSignaturePresent),signedForInstallation:false,installation:'Unsigned device build. Requires Apple signing and provisioning before installation on ordinary iPhones or iPads.' };
  }finally{zip.close();}
}

module.exports={verifyIpa,inspectMachO,parseInfoPlist,safeArchiveName,safeLinkTarget};
if(require.main===module){
  const [file,report]=process.argv.slice(2);
  if(!file){console.error('Usage: node scripts/verify-ios-ipa.cjs <unsigned.ipa> [CI-report.json]');process.exitCode=1;}
  else verifyIpa(file,report).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error('IPA verification failed: '+error.message);process.exitCode=1;});
}
