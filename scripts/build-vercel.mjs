import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('./generate-release-version.cjs');
const output = path.resolve(root, 'site-build');
if (!output.startsWith(root + path.sep)) throw new Error('Refusing to write outside the Noteject workspace.');
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });

const appRoot = path.join(output, 'app');
await fs.mkdir(appRoot, { recursive: true });
const seen = new Set();
const queue = [path.join(root, 'index.html')];
const skipped = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:|javascript:)/i;
function addReference(base, reference) {
  const value = decodeURIComponent(String(reference || '').trim().replace(/^['"]|['"]$/g, '')).split(/[?#]/, 1)[0];
  if (!value || skipped.test(value)) return;
  const source = path.resolve(path.dirname(base), value.replace(/^\//, ''));
  if (!source.startsWith(root + path.sep)) throw new Error(`App asset escapes the workspace: ${reference}`);
  queue.push(source);
}

while (queue.length) {
  const source = queue.shift();
  if (seen.has(source)) continue;
  seen.add(source);
  let stat;
  try { stat = await fs.stat(source); } catch { throw new Error(`Missing app asset: ${path.relative(root, source)}`); }
  if (!stat.isFile()) continue;
  const relative = path.relative(root, source);
  const destination = path.join(appRoot, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  const extension = path.extname(source).toLowerCase();
  if (extension === '.html') {
    let html = await fs.readFile(source, 'utf8');
    if (source === path.join(root, 'index.html')) {
      const nativeMarker = '<script>if(window.NotejectDesktop&&!window.NotejectAndroid)document.documentElement.classList.add("nw-desktop-pending");else if(!window.NotejectDesktop&&!window.NotejectAndroid)document.documentElement.classList.add("noteject-web");</script>';
      if (!html.includes(nativeMarker)) throw new Error('Could not find the app bootstrap marker for web mode.');
      // Vercel normalizes /app/ to /app. Keep relative scripts, styles and workers
      // in their app directory regardless of that redirect.
      html = html.replace('<head>', '<head><base href="/app/">');
      html = html.replace(nativeMarker, '<script>if(window.NotejectDesktop&&!window.NotejectAndroid)document.documentElement.classList.add("nw-desktop-pending");if(!window.NotejectDesktop&&!window.NotejectAndroid&&!/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)&&location.protocol!=="file:"){window.NotejectWebApp=true;document.documentElement.classList.add("noteject-web");}</script>');
      if (!html.includes('cloud-sync.css')) html = html.replace('</head>', '<link rel="stylesheet" href="cloud-sync.css?v=cloud-1"></head>');
      if (!html.includes('cloud-sync.js')) html = html.replace('</body>', '<script src="cloud-sync.js?v=cloud-1"></script></body>');
      await fs.writeFile(destination, html);
    }
    for (const match of html.replace(/<base\b[^>]*>/gi, '').matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) addReference(source, match[1]);
  } else if (extension === '.css') {
    const css = await fs.readFile(source, 'utf8');
    for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)|@import\s+["']([^"']+)["']/gi)) addReference(source, match[1] || match[2]);
  }
}

// These workers are created from JavaScript URLs and are not referenced in HTML.
for (const file of ['reader-mupdf-worker.js', 'reader-mupdf-cache.js', 'smart-search-worker.js']) {
  const source = path.join(root, file);
  await fs.copyFile(source, path.join(appRoot, file));
}
// DjVu, MuPDF, KaTeX, Tesseract, and document previews use runtime-loaded modules.
await fs.cp(path.join(root, 'vendor'), path.join(appRoot, 'vendor'), { recursive: true });
// The root desktop distribution may be ignored by deployment, but MuPDF's
// nested dist directory is the Web Reader runtime and must reach production.
for (const file of ['vendor/mupdf/dist/mupdf.js', 'vendor/mupdf/dist/mupdf-wasm.js', 'vendor/mupdf/dist/mupdf-wasm.wasm']) {
  const asset = await fs.stat(path.join(appRoot, file)).catch(() => null);
  if (!asset?.isFile() || !asset.size) throw new Error(`The Web PDF Reader runtime is missing: ${file}. Check deployment ignore rules.`);
}

// Generate the AGPL source offer from the exact Reader asset graph and platform sources.
await import('./build-agpl-source.mjs');
await fs.cp(path.join(root, 'site'), output, { recursive: true });
await fs.copyFile(path.join(root, 'noteject-logo.svg'), path.join(output, 'noteject-logo.svg'));
await fs.copyFile(path.join(root, 'noteject-logo.png'), path.join(output, 'apple-touch-icon.png'));
for (const file of ['LICENSE', 'LICENSE-AGPL-3.0-or-later.txt', 'THIRD_PARTY_NOTICES.md']) {
  await fs.copyFile(path.join(root, file), path.join(output, file));
}

const sizeOf = async directory => {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    total += entry.isDirectory() ? await sizeOf(child) : (await fs.stat(child)).size;
  }
  return total;
};
console.log(`Prepared Noteject site and web app (${seen.size} referenced assets; ${(await sizeOf(output) / 1024 / 1024).toFixed(1)} MB).`);
