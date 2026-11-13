# Third-party notices

Noteject's application source is licensed under AGPL-3.0-or-later. Third-party
components retain their own licenses and notices.

- **MuPDF.js 1.28.1** is offered under AGPL-3.0-or-later or a commercial
  Artifex license. Its package license and source location are in
  `vendor/mupdf/` and `vendor/mupdf/NOTEJECT-NOTICE.md`.
- **MuPDF Android Fitz 1.28.5** is offered under AGPL-3.0-or-later or a
  commercial Artifex license. The license, checksum, and corresponding source
  links are in `android/vendor/maven/com/artifex/mupdf/`.
- **DjVuLibre** and **libjpeg-turbo** source and notices used for Android are
  in `android/vendor/`.
- Other web and Android dependencies retain the licenses in their respective
  `vendor/` directories and Android asset notices.
- **Stripe Node SDK 23.1.0** is used by the hosted subscription service under
  the MIT license. Its source and license are available at
  https://github.com/stripe/stripe-node. The exact package is pinned by package-lock.json.
- Development checks use **PGlite 0.5.13** and **Playwright 1.64.1**, each under
  Apache-2.0. They are development dependencies and are excluded from the hosted
  production dependency installation. Sources: https://github.com/electric-sql/pglite
  and https://github.com/microsoft/playwright.

The offline speech model data is not included in the source archive because
the archives are large. Its upstream Apache-2.0 source URLs and SHA-256 hashes
are preserved in `android/app/src/main/assets/audio-open-source-notices.txt`.
