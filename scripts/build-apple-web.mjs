import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAppleHtml } from './apple-web-html.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'site-build', 'app');
const destination = path.join(root, 'apple', 'www');
if (!source.startsWith(root + path.sep) || !destination.startsWith(root + path.sep)) {
  throw new Error('Apple web build paths must stay inside the Noteject workspace.');
}
const sourceIndex = path.join(source, 'index.html');
const html = await fs.readFile(sourceIndex, 'utf8');
const nativeHtml = prepareAppleHtml(html);

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
await fs.cp(source, destination, { recursive: true });
await fs.writeFile(path.join(destination, 'index.html'), nativeHtml);
console.log('Prepared the Noteject iOS web bundle in apple/www.');
