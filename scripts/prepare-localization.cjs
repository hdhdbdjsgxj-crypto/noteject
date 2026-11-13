'use strict';
const fs = require('node:fs'), path = require('node:path');
const { root, builtins } = require('./localization-catalog.cjs');
const base = builtins(), file = path.join(root, 'audits/languages/catalog-inventory.json');
const inventory = JSON.parse(fs.readFileSync(file));
const additionsFile = path.join(root, 'audits/languages/missing-keys.json');
const missing = new Set(JSON.parse(fs.readFileSync(additionsFile)));
const reviewedKeys = new Set(Object.values(base.dictionaries).flatMap(values => Object.keys(values)));
const corrections = JSON.parse(fs.readFileSync(path.join(root, 'locales/reviewed.json'), 'utf8'));
Object.values(corrections).forEach(values => Object.keys(values).forEach(key => reviewedKeys.add(key)));
function generatedExample(key) {
  if (reviewedKeys.has(key)) return false;
  if (/^Development build · Version \d/.test(key)) return true;
  return /^(?:\d|lunes,|lundi |Montag,|lunedì |segunda-feira,|Notas coincidentes:|Notes correspondantes:|Passende Notizen:|Note corrispondenti:|Notas correspondentes:|Eşleşen notlar:|☼ (?:Vista|Affichage|Ansicht|Visualizzazione|Visualização|Görünüm)|Filtros ⋯|Acciones ⋯|Filtres ⋯|Actions ⋯|Vue ⋯|Filter ⋯|Aktionen ⋯|Ansicht ⋯|Filtri ⋯|Azioni ⋯|Visualizza ⋯|Vista ⋯|Visualizar ⋯|Filtreler ⋯|Eylemler ⋯|Board · \d|audit$)/.test(key);
}
for (const value of [...missing]) if (/^(?:Home Copy|PDF ·|● )/.test(value)) missing.delete(value);
for (const value of [
  'Sign in to see your plan and monthly usage.','Sync','Page {page}','Pages {start}–{end}','Chapter {chapter}',
  'Chapter {chapter} of {count}','Chapter {chapter} of {count} · {title}','Zoom {zoom}. Reset to fit width',
  'Preparing document… {percent}%','Text indexing · {page} / {count} pages · while idle',
  'Drag a rectangle around the {kind}. Drag inside to move it. This saves the original page appearance, including scanned pages.',
  '{count} selected','{selected} of {count} selected','{count} matches','{count} matches · {page}/{total} pages',
  '{count} pages skipped','{count} remaining','{count} notes','{count} note','{count} documents','{count} document',
  '{count} boards','{count} board','{count} projects','{count} project','{count} files','{count} file',
  '{count} items','{count} item','{count} passages','{count} passage','{count} bookmarks','{count} bookmark',
  '{count} recordings','{count} recording','{count} pages','{count} page','{count} chapters','{count} chapter',
  'Open {name}','Delete board {name}','Rename {name}','Color for {name}','Change {name} color','Remove {name} from this board',
  'Version {version}','Selected items · {count}','{name} workflow','image','equation','Open menu','Close menu',
  'Bookmark this position','Remove bookmark at this position','Use the bookmark above to save a reading position.',
  'No note selected','Select a note to insert its link.','No matching notes','Search notes by title, project, or tag',
  'Insert note link','Link to a note','Find a note…','All projects','Preview link','Select a note','Reading and navigation',
  '{percent}% through text','{count} favorites','{count} links','{count} results','{count} cards','{count} connections',
  '{count} words','{count} characters','{minutes} min read','Knowledge graph showing {count} items and {relationships} relationships',
  'Matching notes: {count}','Bookmark this reading position','Tools','Add favorites','All files','All favorites'
]) missing.add(value);
const nativeRoot = path.join(root, 'android/app/src/main/java/com/noteject/app');
for (const name of fs.readdirSync(nativeRoot).filter(name => /^(?:Reader|NativeReader).*\.kt$/.test(name))) {
  const source = fs.readFileSync(path.join(nativeRoot, name), 'utf8');
  for (const match of source.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    let text; try { text = JSON.parse(match[0]); } catch { continue; }
    if (/[A-Za-z]{3}\s+[A-Za-z]{2}/.test(text) && !/[\$\\<>]|^https?:|[{};]/.test(text) && text.length < 1600) missing.add(text);
  }
}
for (const name of fs.readdirSync(path.join(root, 'site')).filter(name => name.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(root, 'site', name), 'utf8').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const match of html.matchAll(/>([^<>]+)</g)) {
    const text = match[1].trim().replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
    if (/[A-Za-z]{3}/.test(text) && !/^©|^Version \d/.test(text)) missing.add(text);
  }
}
const keys = [...new Set([...inventory.keys, ...reviewedKeys, ...missing])].filter(key => !/\$\{|\$requiredMb/.test(key) && !generatedExample(key)).sort();
fs.writeFileSync(file, JSON.stringify({ languages: base.languages, keys, dictionaries: base.dictionaries }, null, 2));
fs.writeFileSync(additionsFile, JSON.stringify([...missing].filter(key => !generatedExample(key) && !/\$\{|\$requiredMb/.test(key)).sort(), null, 2));
fs.writeFileSync(path.join(root, 'locales/inventory.json'), JSON.stringify({ languages: base.languages, keys }, null, 2));
fs.copyFileSync(additionsFile, path.join(root, 'locales/additional-keys.json'));
const partial = {};
for (const lang of base.languages) { const file = path.join(root, 'locales', lang.code + '.json'); if (fs.existsSync(file)) partial[lang.code] = JSON.parse(fs.readFileSync(file)); }
fs.writeFileSync(path.join(root, 'localization-catalogs.js'), "/* Offline interface language catalogs. */\n(function(root){'use strict';root.NotejectLocaleCatalogs=" + JSON.stringify(partial) + ";})(globalThis);\n");
console.log('Interface inventory: ' + keys.length + ' phrases; ' + missing.size + ' recent, native, and website phrases.');
