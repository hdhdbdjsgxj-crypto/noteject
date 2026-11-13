'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const plist=require('plist');
const {verifyIpa,inspectMachO,parseInfoPlist,safeArchiveName,safeLinkTarget}=require('../scripts/verify-ios-ipa.cjs');
const actual=path.resolve(__dirname,'../release/apple/Noteject-iPhone-iPad-0.2.57-unsigned.ipa');

// Header buffers exercise the parser only. They are never written or packaged
// as a release IPA; the integration test below reads the genuine Xcode output.
function header({platform=2,cpu=0x0100000c,type=2,encrypted=false}={}){
  const text=Buffer.alloc(72),build=Buffer.alloc(24),entry=Buffer.alloc(24),commands=[text,build,entry];
  text.writeUInt32LE(0x19);text.writeUInt32LE(72,4);text.write('__TEXT',8);text.writeBigUInt64LE(4096n,32);text.writeUInt32LE(5,60);
  build.writeUInt32LE(0x32);build.writeUInt32LE(24,4);build.writeUInt32LE(platform,8);
  entry.writeUInt32LE(0x80000028);entry.writeUInt32LE(24,4);
  if(encrypted){const encryption=Buffer.alloc(24);encryption.writeUInt32LE(0x2c);encryption.writeUInt32LE(24,4);encryption.writeUInt32LE(1,16);commands.push(encryption);}
  const commandBytes=commands.reduce((size,command)=>size+command.length,0),size=32+commandBytes+32;
  text.writeBigUInt64LE(BigInt(size),48);entry.writeBigUInt64LE(BigInt(32+commandBytes),8);
  const result=Buffer.alloc(size);result.writeUInt32LE(0xfeedfacf);result.writeUInt32LE(cpu,4);result.writeUInt32LE(type,12);result.writeUInt32LE(commands.length,16);result.writeUInt32LE(commandBytes,20);
  Buffer.concat(commands).copy(result,32);result.set([0xc0,0x03,0x5f,0xd6],32+commandBytes);
  return result;
}

test('IPA paths and symbolic links cannot escape or use Windows path separators',()=>{
  assert.equal(safeArchiveName('Payload/App.app/public/index.html'),'Payload/App.app/public/index.html');
  assert.equal(safeArchiveName('Payload/App.app/'),'Payload/App.app/');
  for(const name of ['../Payload/App.app','Payload/../App.app','/Payload/App.app','C:/Payload/App.app','Payload\\App.app','Payload/App.app/file:stream','Payload//App.app','Payload/App.app/..','Payload/App.app/file.','Payload/App.app/file\0'])assert.throws(()=>safeArchiveName(name),/ZIP pathname/);
  assert.equal(safeLinkTarget('Payload/App.app/Frameworks/Test.framework/Current',Buffer.from('Versions/A')),'Payload/App.app/Frameworks/Test.framework/Versions/A');
  for(const target of ['../../../../../../outside','/private/key','C:\\private\\key'])assert.throws(()=>safeLinkTarget('Payload/App.app/link',Buffer.from(target)),/ZIP symbolic link/);
});

test('Mach-O verification distinguishes iOS device executables from simulator, Mac and source files',()=>{
  assert.deepEqual(inspectMachO(header()),[{architecture:'arm64',platform:'iphoneos',codeSignaturePresent:false}]);
  assert.throws(()=>inspectMachO(header({platform:7})),/Simulator/);
  assert.throws(()=>inspectMachO(header({platform:1})),/iOS device/);
  assert.throws(()=>inspectMachO(header({platform:6})),/iOS device/);
  assert.throws(()=>inspectMachO(header({cpu:0x01000007})),/arm64/);
  assert.throws(()=>inspectMachO(header({type:6})),/MH_EXECUTE/);
  assert.throws(()=>inspectMachO(header({encrypted:true})),/unencrypted/);
  assert.throws(()=>inspectMachO(Buffer.from('<html>This is source, not a compiled iOS app.</html>')),/not Mach-O/);
});

test('Mach-O bounds checks reject malformed load commands, segments, entry points and universal slices',()=>{
  let bytes=header();bytes.writeUInt32LE(0xffffffff,20);assert.throws(()=>inspectMachO(bytes),/load commands/);
  bytes=header();bytes.writeUInt32LE(0xffffff00,36);assert.throws(()=>inspectMachO(bytes),/command size/);
  bytes=header();bytes.writeBigUInt64LE(BigInt(bytes.length+1),80);assert.throws(()=>inspectMachO(bytes),/segment/);
  bytes=header();bytes.writeBigUInt64LE(1n,136);assert.throws(()=>inspectMachO(bytes),/entry point/);
  const thin=header(),fat=Buffer.alloc(64+thin.length);fat.writeUInt32BE(0xcafebabe);fat.writeUInt32BE(1,4);fat.writeUInt32BE(0x0100000c,8);fat.writeUInt32BE(64,16);fat.writeUInt32BE(thin.length,20);fat.writeUInt32BE(6,24);thin.copy(fat,64);
  assert.equal(inspectMachO(fat)[0].platform,'iphoneos');fat.writeUInt32BE(fat.length,20);assert.throws(()=>inspectMachO(fat),/out of bounds/);
});

test('Info.plist supports the existing XML and binary parsers and rejects invalid roots',()=>{
  const value={CFBundleIdentifier:'com.noteject.app',CFBundleExecutable:'App',UIDeviceFamily:[1,2]};
  assert.deepEqual(parseInfoPlist(Buffer.from(plist.build(value))),value);
  const createBinary=require('bplist-creator');assert.deepEqual(parseInfoPlist(createBinary(value)),value);
  assert.throws(()=>parseInfoPlist(Buffer.alloc(0)),/missing/);
  assert.throws(()=>parseInfoPlist(Buffer.from(plist.build(['not a dictionary']))),/dictionary/);
});

test('Genuine hosted-build IPA matches its CI report and cannot be validated with altered size or SHA', {skip:!fs.existsSync(actual)}, async()=>{
  const verified=await verifyIpa(actual);
  assert.equal(verified.verified,true);assert.equal(verified.bundleId,'com.noteject.app');assert.equal(verified.platform,'iphoneos');assert.deepEqual(verified.architectures,['arm64']);assert.deepEqual(verified.devices,['iPhone','iPad']);assert.equal(verified.signedForInstallation,false);assert.match(verified.installation,/Requires Apple signing/);
  const report=JSON.parse(fs.readFileSync(actual.replace(/\.ipa$/,'.json'),'utf8'));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'noteject-ipa-report-check-')),bad=path.join(directory,'invalid-report.json');
  try{
    fs.writeFileSync(bad,JSON.stringify({...report,bytes:report.bytes+1}));await assert.rejects(verifyIpa(actual,bad),/size does not match/);
    fs.writeFileSync(bad,JSON.stringify({...report,sha256:(report.sha256[0]==='0'?'1':'0')+report.sha256.slice(1)}));await assert.rejects(verifyIpa(actual,bad),/SHA-256 does not match/);
    fs.writeFileSync(bad,JSON.stringify({...report,signedForInstallation:true}));await assert.rejects(verifyIpa(actual,bad),/unsigned/);
  }finally{fs.unlinkSync(bad);fs.rmdirSync(directory);}
});
