'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
function replace(name, from, to) {
  const file = path.join(root, name), source = fs.readFileSync(file, 'utf8');
  if (!source.includes(from)) { if (source.includes(to)) return; throw Error('Missing update target in ' + name); }
  fs.writeFileSync(file, source.replace(from, to));
}
replace('smart-engine.js', '<small>${escape([source.type,source.folder].join(\' · \'))}</small>', '<small>${escape(source.type)}<span data-i18n-ignore> · ${escape(source.folder)}</span></small>');
replace('index.html', 'note-link-picker.js?v=1', 'note-link-picker.js?v=2');
replace('index.html', 'smart-engine.js?v=smart-5', 'smart-engine.js?v=smart-6');
for (const file of ['package.json','package-lock.json']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  fs.writeFileSync(path.join(root, file), source.replaceAll('"version": "0.2.47"','"version": "0.2.48"'));
}
replace('android/app/build.gradle', "versionCode 119", "versionCode 120");
replace('android/app/build.gradle', "versionName '1.10.45'", "versionName '1.10.46'");
