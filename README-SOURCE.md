# Noteject source package

This source archive corresponds to the public Noteject release. Noteject application source is licensed under GNU AGPL-3.0-or-later; see LICENSE and LICENSE-AGPL-3.0-or-later.txt. Third-party software keeps its own licenses.

## Build

- Web: run `npm ci --omit=dev`, then `npm run build:web`.
- Windows: install the desktop development dependencies with `npm ci`, then run `npm run desktop:installer`.
- Android: install Android Studio/SDK, NDK, and CMake, then run `npm run build:android`.

The large Vosk speech-model data archives are not bundled in this source archive. Their official download URLs and required SHA-256 hashes are listed in android/app/src/main/assets/audio-open-source-notices.txt. Place the downloaded archives in android/app/src/main/assets before building Android. Gradle obtains the unmodified MuPDF Android dependency from Artifex's Maven repository; its exact source and license details are in android/vendor/maven/com/artifex/mupdf/NOTICE.md.
