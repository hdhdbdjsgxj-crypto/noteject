'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const releases = require('../release-manifest.json');
const handler = require('../api/site-config');

function configuration() {
  const response = {setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;},end(){}};
  handler({method:'GET',headers:{}},response);
  assert.equal(response.code,200);
  return response.body;
}
function withIos(value, run) {
  const original = releases.ios;
  if(value) releases.ios=value; else delete releases.ios;
  try { run(); } finally { if(original) releases.ios=original; else delete releases.ios; }
}
const ipa={version:'0.2.57',url:'https://downloads.example/Noteject-iPhone-iPad-0.2.57-unsigned.ipa',signedForInstallation:false,minimumIOS:'15.0',architectures:['arm64'],devices:['iPhone','iPad']};

test('site config exposes the unsigned IPA and its installation metadata with the download version',()=>{
  withIos({...ipa,version:'stale-version'},()=>{
    const config=configuration();
    assert.equal(config.downloads.ios,ipa.url);
    assert.equal(config.versions.ios,'0.2.57');
    assert.deepEqual(config.iosBuild,{signedForInstallation:false,minimumIOS:'15.0',architectures:['arm64'],devices:['iPhone','iPad']});
    assert(config.downloads.windows&&config.downloads.android&&config.downloads.macArm64&&config.downloads.macX64);
  });
});
test('absent or differently signed iOS builds do not enable the unsigned download',()=>{
  for(const value of [null,{...ipa,signedForInstallation:true},{...ipa,signedForInstallation:undefined},{...ipa,url:'http://downloads.example/unsigned.ipa'}]){
    withIos(value,()=>{const config=configuration();assert.equal(config.downloads.ios,'');assert.equal(config.iosBuild,null);});
  }
});
