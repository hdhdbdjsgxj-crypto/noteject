# Local document engines

Noteject bundles these engines so OCR and legacy Office previews work without sending document contents to an online service.

- `office/officeparser.browser.js`: `@jose.espana/docstream` 0.1.3, MIT. Its bundle includes its dependency license notices; the package license is in `office/LICENSE.txt`.
- `ocr/tesseract.min.js` and `ocr/worker.min.js`: Tesseract.js 6.0.1, Apache-2.0. See `ocr/TESSERACT-LICENSE.txt`.
- `ocr/tesseract-core.wasm.js`: Tesseract.js Core 6.1.2, Apache-2.0. See `ocr/TESSERACT-CORE-LICENSE.txt`.
- `ocr/tessdata/eng.traineddata.gz`: English model from `@tesseract.js-data/eng` 1.0.0. The package metadata declares MIT; the upstream `tessdata` repository declares Apache-2.0. See `ocr/TESSDATA-NOTICE.txt`.

The app renders scanned PDF pages locally, runs English OCR on the rendered pages, and stores extracted text in the local search index. The legacy Office reader provides a text preview; it does not reproduce the original page layout.
