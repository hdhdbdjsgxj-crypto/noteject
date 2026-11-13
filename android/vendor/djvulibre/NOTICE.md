# DjVuLibre Android Reader

Noteject builds DjVuLibre **3.5.29** from the unmodified official source release.

- Upstream: https://djvu.sourceforge.net/
- Source: https://sourceforge.net/projects/djvu/files/DjVuLibre/3.5.29/djvulibre-3.5.29.tar.gz/download
- Archive SHA256: `d3b4b03ae2bdca8516a36ef6eb27b777f0528c9eda26745d9962824a3fdfeccf`.
- Copyright: AT&T, LizardTech, Leon Bottou, Yann Le Cun, and other upstream contributors.
- License: GPL version 2 or later; see `djvulibre-3.5.29/COPYING` and `COPYRIGHT`.
- The archive and complete extracted source are retained beside this file.

The Android build configuration and JNI integration are in
`android/app/src/main/cpp/`. The Kotlin adapter is `DjVuDocument.kt`.
Android NDK 27.2.12479018 and CMake 3.22.1 build the library for arm64-v8a,
armeabi-v7a, x86, and x86_64. Only the app's JNI entry points are exported;
DjVuLibre and its JPEG codec are linked privately to avoid symbol conflicts with MuPDF.

JPEG pages use unmodified **libjpeg-turbo 3.1.4.1**:

- Source: https://github.com/libjpeg-turbo/libjpeg-turbo/archive/refs/tags/3.1.4.1.tar.gz
- Archive SHA256: `a7da42b640377c2a9a9665e2c4b0ea60cd5599afb48c2521e6df0c9dc9d15a25`.
- The corresponding source, `LICENSE.md`, and `README.ijg` are retained in
  `android/vendor/libjpeg-turbo/libjpeg-turbo-3.1.4.1/`.
- Copyright and license notices: Independent JPEG Group; D. R. Commander;
  libjpeg-turbo Project and contributors; see the bundled notices for details.

Native rendering reads a complete, seekable local document. Only bundled DjVu
documents and single-page DjVu/IW44 files are accepted. Indirect multi-file documents
must first be bundled with their companion files; the decoder does not fetch
resources over the network. This format restriction is reported as an explicit error.
