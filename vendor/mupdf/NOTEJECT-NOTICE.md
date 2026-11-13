# Bundled MuPDF runtime

This application includes the unmodified official `mupdf` npm package version
1.28.1, published by Artifex Software, Inc. Its JavaScript wrapper and WebAssembly
binary execute the MuPDF C rendering engine in a dedicated worker.

- Package: https://www.npmjs.com/package/mupdf/v/1.28.1
- Download: https://registry.npmjs.org/mupdf/-/mupdf-1.28.1.tgz
- Verified npm SHA-512 integrity:
  `sha512-Gi11Ow2G1SlrXKJNZBL1eAIGFVih5+4ZKqjptamTVaj/5hnlrcVrVbyb7lHE2lfFKdxZPyv9ZtfOOq7XgjzEig==`
- Upstream source: https://github.com/ArtifexSoftware/mupdf/tree/1.28.1
- Build sources: `platform/wasm/` in the upstream source tree.
- Official documentation: https://mupdf.readthedocs.io/

MuPDF is copyright Artifex Software, Inc. and other upstream contributors, and
is offered under the GNU Affero General Public License, version 3 or later, or
an Artifex commercial license. The complete AGPL text supplied by the package
is preserved in `LICENSE`; its original `README.md` and `package.json` are also
included. It is not a permissively licensed dependency.

The Noteject integration sources are `reader-mupdf.js`,
`reader-mupdf-worker.js`, `reader-mupdf-cache.js`, and the Reader hooks in
`reader-pdf.js` and `app.js`. They, the rest of the application source, and the
Android build scripts are available in this workspace. Packaging this runtime
does not grant an Artifex commercial license or change existing project license
choices. Distribution must comply with the applicable MuPDF license.

The runtime loads locally from application assets. PDF file contents and rendered
pages are processed locally; MuPDF rendering makes no third-party API requests.
