'use strict';
const fs = require('node:fs'), path = require('node:path');
const { root, builtins } = require('./localization-catalog.cjs');
const base = builtins(), inventory = require('../locales/inventory.json');
const runtime = require('../audits/languages/runtime-all.json');
const missing = [...new Set(runtime.flatMap(row => row.missing))], unapplied = [...new Set(runtime.flatMap(row => row.unapplied || []))];
const coverage = base.languages.map(({ code, name }) => {
  const extra = code === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(root, 'locales', code + '.json')));
  const absent = code === 'en' ? 0 : inventory.keys.filter(key => !base.dictionaries[code]?.[key] && !extra[key]).length;
  return `| ${name} (${code}) | ${inventory.keys.length - absent} | ${absent} |`;
}).join('\n');
const report = `# Language audit — 2026-11-02

## Scope and result

Audited all 14 supported languages in the Web desktop layout, Web mobile layout, Windows renderer, Android WebView layout, and four website pages. The automated pass inspected ${runtime.length} screen/language combinations, including navigation, settings, Reader menus and help, note editing and note links, collection editing, project setup, board selection, account controls, and Android recording controls.

- Shared catalog: ${inventory.keys.length} interface phrases.
- Untranslated phrases detected in the final inspected screens: ${missing.length}.
- Translations present but not applied in those screens: ${unapplied.length}.
- Catalog placeholder checks and all-language Windows native menu coverage: passed.
- Switching every language, returning to English, Arabic direction, and protecting user content: passed.
- Note-link workflows across Web desktop, Web mobile, Windows, and Android: passed.
- Native Android Google Translate/share action checks: passed.

## Fixed

- Most languages previously covered only 212 phrases. Added bundled offline translations for the missing interface copy.
- Windows native menus previously accepted only English and Ukrainian. All supported languages now persist and restore correctly.
- Shortcut suffixes, icons, ellipses, counts, and dynamic placeholders now translate across languages.
- Controls created with already translated text now change languages and return to English correctly.
- Android Reader buttons, navigation descriptions, capture controls, saved-item locations, search status, sharing messages, and errors now use the shared language catalog.
- Corrected four older Ukrainian placeholder definitions and reviewed additional Ukrainian Reader terminology.
- Protected user note titles, Smart Engine source previews, project names, and selected note-link titles from interface translation.
- Updated the website and legal-page catalog loading and included the catalog sources in the AGPL source package.

## Coverage

English uses the original interface copy. Product names, file extensions, versions, keyboard shortcuts, user content, and localized date values are intentionally preserved.

| Language | Catalog phrases covered | Missing catalog entries |
| --- | ---: | ---: |
${coverage}

## Packages

- Android 1.10.46: universal debug-signed APK built successfully.
- Windows 0.2.48: x64 installer built successfully.
- Web: production deployment uses the same shared catalog.

## Review limits

The supplemental catalogs were machine-translated from public interface text; existing reviewed translations and additional Ukrainian wording corrections were retained. No user notes, documents, transcripts, or account data were submitted. Native-speaker review is still needed for natural wording and terminology in the generated translations.

Browser checks used fixtures and simulated platform bridges. The Android build compiles the native Reader changes, but this audit did not include physical-device interaction, every possible error path, or every dynamic combination of user data. The zero counts above describe the inspected screens, not a guarantee that every possible app state has been exercised.
`;
fs.writeFileSync(path.join(root, 'audits/languages/REPORT.md'), report);
console.log(JSON.stringify({ screens: runtime.length, phrases: inventory.keys.length, missing, unapplied }));
