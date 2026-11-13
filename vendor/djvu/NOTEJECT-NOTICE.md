# DjVu.js in Noteject

Noteject bundles the upstream DjVu.js 0.5.4 browser library from
https://djvu.js.org/assets/dist/djvu.js, with its upstream license files in this
folder. The library source and license terms are documented at
https://github.com/RussCoder/djvujs.

The DjVu.js library is licensed under GNU GPL version 2 or any later version.
The upstream project explains that the viewer is Unlicensed, while the library
itself is GPL because it includes code derived from DjVuLibre and Java DjVu.
The bundled file here is the library only. Review `LICENSE.md`,
`GNU_GPL_v2`, and `THE_UNLICENSE` before distributing Noteject with this engine.

`reader-djvu.js` is Noteject's adapter. It loads complete bundled DjVu files in
the DjVu.js worker and connects page rendering to Noteject's virtualized Reader.
