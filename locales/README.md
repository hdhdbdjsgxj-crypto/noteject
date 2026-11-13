# Noteject interface catalogs

The reviewed translations in `localization.js` remain authoritative. The JSON files in this folder supplement them for all supported languages. `reviewed.json` contains additional terminology and wording corrections.

Supplemental translations were generated from public interface copy using Google's translation service. App users do not make translation requests: the compiled catalogs are bundled for offline use. User notes, imported documents, transcript content, and account data were not submitted.

Run `node scripts/complete-localization.cjs --compile-only` to rebuild the shared browser catalog and Windows menu catalog without making network requests. Run `node scripts/audit-languages.cjs` to inspect the supported languages across platform layouts and the website. Linguistic review by native speakers is still needed for the generated text.
