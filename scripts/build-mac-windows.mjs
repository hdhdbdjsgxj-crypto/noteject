import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { downloadArtifact } from '@electron/get';
import asar from '@electron/asar';
import plist from 'plist';
import yauzl from 'yauzl';
import { verifyAdHocSignature } from './verify-mac-signature.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const tools = path.join(root, '.apple-build', 'tools');
const go = path.join(tools, 'go', 'bin', 'go.exe');
const signer = path.join(tools, 'rcodesign', 'apple-codesign-0.29.0-x86_64-pc-windows-msvc', 'rcodesign.exe');
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const electronVersion = require('electron/package.json').version;
const architectures = process.argv.includes('--x64') ? ['x64'] :
  process.argv.includes('--arm64') ? ['arm64'] : ['arm64', 'x64'];
const digest = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest();

if (process.platform !== 'win32') throw new Error('Use apple:build-mac on macOS.');
await Promise.all([fs.access(go), fs.access(signer)]);
process.chdir(root);
if (!process.argv.includes('--reuse-web-build')) await import('./build-vercel.mjs');

function safePath(value) {
  if (value.includes('\\') || value.startsWith('/') || value.split('/').includes('..') ||
      /^[a-z]:/i.test(value)) throw new Error(`Unsafe archive path: ${value}`);
  return value.replace(/\/$/, '');
}

async function extractElectron(archive, stage) {
  const entries = [];
  await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error) return reject(error);
      zip.once('error', reject);
      zip.once('end', () => { zip.close(); resolve(); });
      zip.on('entry', async entry => {
        try {
          const name = safePath(entry.fileName);
          const runtimeLicense = name === 'LICENSE' ? 'Electron-LICENSE.txt' :
            name === 'LICENSES.chromium.html' ? 'Chromium-LICENSES.html' : null;
          if ((!name.startsWith('Electron.app/') && !runtimeLicense) ||
              name.endsWith('/Resources/default_app.asar')) {
            zip.readEntry();
            return;
          }
          const targetPath = runtimeLicense ? 'Noteject.app/Contents/Resources/' + runtimeLicense :
            name.replace(/^Electron\.app/, 'Noteject.app');
          const mode = entry.externalFileAttributes >>> 16;
          if (entry.fileName.endsWith('/')) {
            entries.push({ path: targetPath, type: 'directory', mode: 0o755 });
            await fs.mkdir(path.join(stage, targetPath), { recursive: true });
          } else {
            const stream = await new Promise((done, fail) => zip.openReadStream(entry,
              (err, data) => err ? fail(err) : done(data)));
            if ((mode & 0o170000) === 0o120000) {
              const chunks = [];
              for await (const chunk of stream) chunks.push(chunk);
              const target = Buffer.concat(chunks).toString('utf8');
              const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(targetPath), target));
              if (!resolved.startsWith('Noteject.app/') || path.posix.isAbsolute(target)) {
                throw new Error(`Framework link escapes the app: ${targetPath}`);
              }
              entries.push({ path: targetPath, type: 'symlink', target, mode: 0o777 });
            } else {
              const source = path.join(stage, targetPath);
              await fs.mkdir(path.dirname(source), { recursive: true });
              await pipeline(stream, createWriteStream(source));
              entries.push({ path: targetPath, type: 'file', source, mode: (mode & 0o777) || 0o644 });
            }
          }
          zip.readEntry();
        } catch (error) {
          zip.close();
          reject(error);
        }
      });
      zip.readEntry();
    });
  });
  return entries;
}

async function addTree(source, destination, entries) {
  entries.push({ path: destination, type: 'directory', mode: 0o755 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = destination + '/' + entry.name;
    if (entry.isDirectory()) await addTree(sourcePath, destinationPath, entries);
    else if (entry.isFile()) entries.push({ path: destinationPath, type: 'file', source: sourcePath, mode: 0o644 });
    else throw new Error(`Unexpected special file in the workspace assets: ${sourcePath}`);
  }
}

async function sealResources(stage, entries) {
  const contents = 'Noteject.app/Contents/';
  const sealPath = path.join(stage, contents, '_CodeSignature', 'CodeResources');
  const seal = {
    files: {}, files2: {},
    rules: { '^Resources/': true },
    rules2: {
      '^.*': true,
      '^Info\\.plist$': { omit: true, weight: 20 },
      '^PkgInfo$': { omit: true, weight: 20 }
    }
  };
  for (const entry of entries) {
    if (!entry.path.startsWith(contents)) continue;
    const relative = entry.path.slice(contents.length);
    if (relative === 'Info.plist' || relative === 'PkgInfo' || relative === 'MacOS/Electron' ||
        relative.startsWith('_CodeSignature/')) continue;
    if (entry.type === 'symlink') seal.files2[relative] = { symlink: entry.target };
    if (entry.type === 'file') {
      const bytes = await fs.readFile(entry.source);
      if (relative.startsWith('Resources/')) seal.files[relative] = digest(bytes, 'sha1');
      seal.files2[relative] = { hash: digest(bytes, 'sha1'), hash2: digest(bytes) };
    }
  }
  await fs.mkdir(path.dirname(sealPath), { recursive: true });
  await fs.writeFile(sealPath, plist.build(seal));
  entries.push({ path: contents + '_CodeSignature', type: 'directory', mode: 0o755 });
  entries.push({ path: contents + '_CodeSignature/CodeResources', type: 'file', source: sealPath, mode: 0o644 });
}

await fs.mkdir(path.join(root, '.apple-build'), { recursive: true });
const stage = await fs.mkdtemp(path.join(root, '.apple-build', 'windows-mac-'));
console.log(`Mac build staging: ${stage}`);
const asarSource = path.join(stage, 'asar-source');
await fs.mkdir(asarSource);
await fs.cp(path.join(root, 'desktop'), path.join(asarSource, 'desktop'), { recursive: true });
await fs.writeFile(path.join(asarSource, 'package.json'), JSON.stringify({
  name: 'noteject', version: metadata.version, main: 'desktop/main.cjs'
}));
const appArchive = path.join(stage, 'app.asar');
await asar.createPackage(asarSource, appArchive);

// ICNS accepts the existing 512 px PNG directly as its ic09 representation.
const png = await fs.readFile(path.join(root, 'noteject-logo.png'));
if (png.readUInt32BE(16) !== 512 || png.readUInt32BE(20) !== 512) throw new Error('Expected the 512 px brand icon.');
const icns = Buffer.alloc(16 + png.length);
icns.write('icns', 0);
icns.writeUInt32BE(icns.length, 4);
icns.write('ic09', 8);
icns.writeUInt32BE(8 + png.length, 12);
png.copy(icns, 16);
const icon = path.join(stage, 'noteject.icns');
await fs.writeFile(icon, icns);

const output = path.join(root, 'release', 'apple');
await fs.mkdir(output, { recursive: true });
for (const architecture of architectures) {
  console.log(`Assembling Noteject for ${architecture} Macs.`);
  const archive = await downloadArtifact({
    version: electronVersion, artifactName: 'electron', platform: 'darwin', arch: architecture,
    checksums: require('electron/checksums.json'), cacheRoot: path.join(tools, 'electron-cache')
  });
  const appStage = path.join(stage, architecture);
  await fs.mkdir(appStage);
  const entries = await extractElectron(archive, appStage);
  const contents = 'Noteject.app/Contents/';
  const resources = path.join(appStage, contents, 'Resources');
  const workspace = path.join(resources, 'app');
  await fs.cp(path.join(root, 'site-build', 'app'), workspace, { recursive: true });
  for (const file of ['index.html', 'ai-server.mjs', 'noteject-logo.png', 'LICENSE',
    'LICENSE-AGPL-3.0-or-later.txt', 'THIRD_PARTY_NOTICES.md']) {
    await fs.copyFile(path.join(root, file), path.join(workspace, file));
  }
  await addTree(workspace, contents + 'Resources/app', entries);
  entries.push({ path: contents + 'Resources/app.asar', source: appArchive, type: 'file', mode: 0o644 });
  entries.push({ path: contents + 'Resources/noteject.icns', source: icon, type: 'file', mode: 0o644 });

  const infoPath = path.join(appStage, contents, 'Info.plist');
  const info = plist.parse(await fs.readFile(infoPath, 'utf8'));
  Object.assign(info, {
    CFBundleIdentifier: 'com.noteject.desktop', CFBundleName: 'Noteject',
    CFBundleDisplayName: 'Noteject', CFBundleShortVersionString: metadata.version,
    CFBundleVersion: metadata.version, CFBundleIconFile: 'noteject.icns'
  });
  info.ElectronAsarIntegrity = {
    'Resources/app.asar': { algorithm: 'SHA256', hash: digest(asar.getRawHeader(appArchive).headerString).toString('hex') }
  };
  await fs.writeFile(infoPath, plist.build(info));
  await sealResources(appStage, entries);
  const entitlements = path.relative(appStage, path.join(root, 'apple', 'entitlements.mac.plist'));
  const executable = contents + 'MacOS/Electron';
  execFileSync(signer, [
    'sign', '--binary-identifier', 'com.noteject.desktop', '--digest', 'sha256',
    '--info-plist-file', contents + 'Info.plist',
    '--code-resources-file', contents + '_CodeSignature/CodeResources',
    '--entitlements-xml-file', entitlements, executable
  ], { cwd: appStage, stdio: 'inherit' });
  await verifyAdHocSignature(path.join(appStage, executable), infoPath,
    path.join(appStage, contents, '_CodeSignature', 'CodeResources'));

  const manifest = path.join(appStage, 'manifest.json');
  await fs.writeFile(manifest, JSON.stringify({ entries }));
  const destination = path.join(output, `Noteject-Mac-${metadata.version}-${architecture}-development.dmg`);
  execFileSync(go, [
    'run', '.', manifest, destination, 'Noteject', path.join(root, 'noteject-logo.png')
  ], {
    cwd: path.join(root, 'apple', 'windows-dmg'), stdio: 'inherit',
    env: { ...process.env, GOPATH: path.join(tools, 'gopath'), GOCACHE: path.join(tools, 'gocache') }
  });
  console.log(`Created ${destination}`);
}
if (!stage.startsWith(path.join(root, '.apple-build') + path.sep)) {
  throw new Error('Refusing to remove a build stage outside .apple-build.');
}
await fs.rm(stage, { recursive: true, force: true });
