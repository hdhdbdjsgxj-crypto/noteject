'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function replace(file,from,to){const name=path.join(root,file),source=fs.readFileSync(name,'utf8');if(source.includes(to))return;if(source.includes(from))fs.writeFileSync(name,source.replaceAll(from,to));else throw Error('Missing update target in '+file);}
replace('reader-workspace.js','<div class="reader-nav-tabs" role="tablist"','<div class="reader-navigation-heading"><h2>Document navigation</h2>${button(\'close-navigation\',\'×\',\'Close\',\'class="reader-navigation-close" aria-label="Close"\')}</div><div class="reader-nav-tabs" role="tablist"');
replace('index.html','reader-workspace.js?v=reader-30','reader-workspace.js?v=reader-31');
replace('index.html','reader-workspace.css?v=reader-13','reader-workspace.css?v=reader-14');
for(const file of ['package.json','package-lock.json'])replace(file,'"version": "0.2.48"','"version": "0.2.49"');
