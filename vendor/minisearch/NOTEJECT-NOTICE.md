# MiniSearch SearchableMap in Noteject

This folder contains the standalone `SearchableMap` radix tree from the official
MiniSearch **7.2.0** npm package. Noteject uses this dictionary for exact, prefix,
and fuzzy lookup in its local Smart Engine. It does not load a second full search
index or contact a remote search service.

## Upstream and verification

- Repository: https://github.com/lucaong/minisearch
- Pinned source tag: https://github.com/lucaong/minisearch/tree/v7.2.0
- Package: https://registry.npmjs.org/minisearch/-/minisearch-7.2.0.tgz
- Published npm integrity (verified before extraction):
  `sha512-dqT2XBYUOZOiC5t2HRnwADjhNS2cecp9u+TJRiJ1Qp/f5qjkeT5APcGPjHw+bz89Ms8Jp+cG4AlE+QZ/QnDglg==`
- `SearchableMap.js` SHA-256:
  `5276efad045827a9bb92552817c727519762dfc5f9a8d7841de42ff2b05d33e9`

`SearchableMap.js` and its source map are unmodified copies of
`package/dist/umd/SearchableMap.js` and `package/dist/umd/SearchableMap.js.map`.
The package license is retained unmodified in `LICENSE.txt`. The original package
metadata and README are retained unmodified as `package.upstream.json` and
`README.upstream.md`. The metadata filename avoids changing how Node loads this
UMD file; the original package declares `type: "module"`.

The upstream UMD build exports the `SearchableMap` class as `globalThis.MiniSearch`
in a browser or worker, and as `module.exports` in CommonJS. This is its original
export name; it is the standalone dictionary rather than the full `MiniSearch`
search engine. Its public npm subpath is `minisearch/SearchableMap`.

## License

MiniSearch is provided under the MIT license. Include `LICENSE.txt` when
redistributing these files. This notice does not change the license of Noteject
or any other bundled component.
