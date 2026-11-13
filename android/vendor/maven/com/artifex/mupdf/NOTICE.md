# MuPDF native Android library

Noteject uses the unmodified official MuPDF Java/JNI Android binding,
`com.artifex.mupdf:fitz:1.28.5`.

- Copyright Artifex Software, Inc. and contributors.
- License: GNU Affero General Public License, version 3 or later. The complete
  upstream license is in [COPYING](COPYING). Artifex also offers commercial
  licenses: <https://artifex.com/licensing>.
- Official package repository: <https://maven.ghostscript.com/com/artifex/mupdf/fitz/1.28.5/>.
- Corresponding source: <https://github.com/ArtifexSoftware/mupdf/tree/1.28.5> and
  Android build project: <https://github.com/ArtifexSoftware/mupdf-android-fitz>.
- The local Maven package is an exact copy of the official artifact, retained to
  make Android builds reproducible without a network connection.
- SHA-256 of `fitz-1.28.5.aar`:
  `e6887a242882cdd2dce062430bb46b6727513e3eb94e222255cc1a37db7a7d8e`.
- Included native ABIs: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`.

MuPDF supports PDF and several other formats, but does not decode DjVu. No
platform PdfRenderer or WebAssembly renderer is included in this dependency.
