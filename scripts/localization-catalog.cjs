'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function builtins() {
  const source = fs.readFileSync(path.join(root, 'localization.js'), 'utf8');
  const context = {};
  vm.runInNewContext(source.slice(0, source.indexOf('  const languageNames')) + '\nglobalThis.catalog = { languages, dictionaries };})();', context);
  return JSON.parse(JSON.stringify(context.catalog));
}
function interfaceSources() {
  return [...fs.readdirSync(root).filter(name => name.endsWith('.js') && !/^localization/.test(name)).map(name => path.join(root, name)),
    ...fs.readdirSync(path.join(root, 'android/ui')).filter(name => name.endsWith('.js')).map(name => path.join(root, 'android/ui', name)),
    ...fs.readdirSync(path.join(root, 'site')).filter(name => /\.(html|js)$/.test(name)).map(name => path.join(root, 'site', name))];
}
module.exports = { root, builtins, interfaceSources };
