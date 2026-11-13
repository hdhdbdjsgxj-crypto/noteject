import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Noteject version.');
const file = path.join(root, 'ios/App/App.xcodeproj/project.pbxproj');
let source = await fs.readFile(file, 'utf8');
const versions = [...source.matchAll(/MARKETING_VERSION = [^;]+;/g)];
if (versions.length !== 2 || !source.includes('TARGETED_DEVICE_FAMILY = "1,2";')) {
  throw new Error('The universal iPhone/iPad target could not be located.');
}
source = source.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
await fs.writeFile(file, source);
console.log(`Prepared universal iPhone/iPad project version ${version}.`);
