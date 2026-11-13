'use strict';
// Offline build-time catalogs: only public interface copy is submitted for translation.
const fs = require('node:fs');
const path = require('node:path');
const { root, builtins } = require('./localization-catalog.cjs');
const base = builtins();
const output = path.join(root, 'locales');
fs.mkdirSync(output, { recursive: true });
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'audits/languages/catalog-inventory.json')));
const additionsFile = path.join(root, 'audits/languages/missing-keys.json');
const additions = fs.existsSync(additionsFile) ? JSON.parse(fs.readFileSync(additionsFile)) : [];
const keys = [...new Set([...inventory.keys, ...additions])].sort();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function protect(source) {
  const values = [];
  const text = source.replace(/\{[\w]+\}|\[\[[^\]]+\]\]|https?:\/\/\S+|\b(?:Noteject|noteject|ChatGPT|OpenAI|MuPDF|DjVuLibre|DjVu|EPUB|PDF|TXT|DOCX?|XLSX?|PPTX?|Windows|Android|macOS|iPhone|iPad|iMac|Safari|Paddle|Supabase|ZIP|JSON|CSV|AGPL|GNU|OCR|API|Ctrl|Alt|Shift|F11|GB|MB|KB)\b|\n/gi, value => {
    const marker = 'NXPH' + String(values.length).padStart(3, '0') + 'ZX'; values.push(value); return marker;
  });
  return { text, restore(value) {
    return value.replace(/NXPH\s*(\d{3})\s*ZX/gi, (_, n) => values[Number(n)] ?? _);
  }, markers: values.length };
}
async function translate(batch, language) {
  const protectedValues = batch.map(protect);
  const q = protectedValues.map((entry, index) => '881199' + String(index).padStart(4, '0') + '\n' + entry.text + '\n771199' + String(index).padStart(4, '0')).join('\n\n');
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  for (const [key, value] of Object.entries({ client: 'gtx', sl: 'en', tl: language === 'zh' ? 'zh-CN' : language, dt: 't', q })) url.searchParams.set(key, value);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw Error('Translation HTTP ' + response.status);
      const data = await response.json();
      const text = data[0].map(entry => entry[0] || '').join('');
      const matches = [...text.matchAll(/881199(\d{4})\s*([\s\S]*?)\s*771199\1/g)];
      if (matches.length !== batch.length) { fs.writeFileSync(path.join(root, 'audits/languages/translation-response-' + language + '.txt'), text); throw Error('Translation did not preserve entry boundaries'); }
      return matches.map((match, index) => {
        if (Number(match[1]) !== index) throw Error('Translation reordered entries');
        const value = protectedValues[index].restore(match[2].trim());
        if (!value || /NXPH\s*\d|NJT\s*\d{4}/i.test(value)) { fs.writeFileSync(path.join(root, 'audits/languages/translation-response-' + language + '.txt'), text); throw Error('Translation did not preserve placeholders for ' + JSON.stringify(batch[index]) + ': ' + value.slice(0, 180)); }
        const expected = [...batch[index].matchAll(/\{\w+\}/g)].map(m => m[0]).sort();
        const actual = [...value.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error('Translation changed placeholders');
        return value;
      });
    } catch (error) {
      console.error(language + ': ' + error.message + ' (attempt ' + (attempt + 1) + ', ' + batch.length + ' phrases)');
      if (attempt === 4) {
        if (batch.length > 1) { const middle = Math.ceil(batch.length / 2); return [...await translate(batch.slice(0, middle), language), ...await translate(batch.slice(middle), language)]; }
        throw error;
      }
      await pause(1500 * (attempt + 1));
    }
  }
}
async function language(code) {
  const file = path.join(output, code + '.json');
  const values = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  const missing = keys.filter(key => !base.dictionaries[code]?.[key] && !values[key]);
  const batches = []; let batch = [], length = 0;
  for (const key of missing) { if (length + key.length > 2500 && batch.length) { batches.push(batch); batch = []; length = 0; } batch.push(key); length += key.length + 60; }
  if (batch.length) batches.push(batch);
  for (let i = 0; i < batches.length; i++) {
    const translated = await translate(batches[i], code);
    batches[i].forEach((key, index) => { values[key] = translated[index]; });
    fs.writeFileSync(file, JSON.stringify(values, null, 2) + '\n');
    if (i % 10 === 0 || i === batches.length - 1) console.log(code + ': ' + (i + 1) + '/' + batches.length + ' batches');
    await pause(200);
  }
  return values;
}
async function main() {
  const codes = base.languages.map(item => item.code).filter(code => code !== 'en');
  const queue = [...codes];
  if (!process.argv.includes('--compile-only')) await Promise.all([0, 1].map(async () => { while (queue.length) await language(queue.shift()); }));
  const reviewedFile = path.join(output, 'reviewed.json');
  const reviewed = fs.existsSync(reviewedFile) ? JSON.parse(fs.readFileSync(reviewedFile)) : {};
  const allowed = new Set(keys);
  const catalogs = Object.fromEntries(codes.map(code => {
    const values = Object.fromEntries(Object.entries({ ...JSON.parse(fs.readFileSync(path.join(output, code + '.json'))), ...reviewed[code] }).filter(([key]) => allowed.has(key)));
    fs.writeFileSync(path.join(output, code + '.json'), JSON.stringify(values, null, 2) + '\n');
    return [code, values];
  }));
  fs.writeFileSync(path.join(root, 'localization-catalogs.js'), "/* Generated interface translations. Existing reviewed translations take precedence. */\n(function(root){'use strict';root.NotejectLocaleCatalogs=" + JSON.stringify(catalogs) + ";})(globalThis);\n");
  const nativeKeys = [...fs.readFileSync(path.join(root, 'desktop/localization.cjs'), 'utf8').matchAll(/'([^']+)':/g)].map(match => match[1]);
  const native = Object.fromEntries(codes.map(code => [code, Object.fromEntries(nativeKeys.map(key => [key, base.dictionaries[code]?.[key] || catalogs[code][key]]))]));
  fs.writeFileSync(path.join(root, 'desktop/locale-catalogs.json'), JSON.stringify(native, null, 2) + '\n');
  console.log('Completed catalogs for ' + codes.length + ' languages, ' + keys.length + ' interface phrases.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
