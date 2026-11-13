'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),{version}=require('../package.json');
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version.');
const file=path.join(root,'release-version.js'),content='/* Generated from package.json by each build. */\nwindow.NotejectRelease=Object.freeze('+JSON.stringify({version})+');\n';
if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content)fs.writeFileSync(file,content);
