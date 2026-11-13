import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(root, 'site-build', 'app');
const stage = path.join(root, '.desktop-build', 'agpl-source');
const archive = path.join(root, 'site', 'source.tar.gz');
if (!stage.startsWith(root + path.sep) || !archive.startsWith(root + path.sep)) {
  throw new Error('Source packaging paths must stay inside the Noteject workspace.');
}
const manifest = [
  'LICENSE', 'LICENSE-AGPL-3.0-or-later.txt', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json', 'release-manifest.json', 'index.html', 'ai-server.mjs', 'launcher.cs', 'noteject-logo.png',
  'Start-Noteject.ps1', 'Build-Windows-Installer.ps1', 'Sync-Distribution-Assets.ps1',
  'LICENSES', 'README.md'
];
const optionalRootFiles = new Set(['README.md', 'LICENSES']);

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
async function copyFile(relative, destination = relative, optional = false) {
  const from = path.join(root, relative), to = path.join(stage, destination);
  if (!(await exists(from))) { if (optional) return; throw new Error(`Missing source component: ${relative}`); }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}
function include(relative, entry) {
  const normalized = relative.split(path.sep).join('/');
  const segments = normalized.split('/');
  if (segments.some(part => ['.git', '.vercel', '.toolchain', '.gradle', '.kotlin', '.cxx', 'build', 'node_modules', 'release'].includes(part))) return false;
  if (/^dist(?:\/|$)/.test(normalized)) return false;
  if (normalized === 'ios/App/App/public' || normalized === 'ios/App/App/capacitor.config.json' ||
      normalized === 'ios/capacitor-cordova-ios-plugins' || segments.includes('xcuserdata') ||
      /\.(p8|p12|mobileprovision|provisionprofile)$/i.test(normalized)) return false;
  if (normalized === 'site/source.tar.gz' || /(^|\/)(?:\.env[^/]*|\.noteject-storage\.json|debug\.log|local\.properties)$/.test(normalized)) return false;
  if (/^android\/app\/src\/main\/assets\//.test(normalized) && !/\.txt$/i.test(normalized)) return false;
  if (/^android\/vendor\/maven\/com\/artifex\/mupdf\/fitz\/1\.28\.5\/fitz-1\.28\.5\.aar$/.test(normalized)) return false;
  if (/^android\/app\/src\/main\/assets\/audio-model.*\.zip$/i.test(normalized)) return false;
  return true;
}
async function copyTree(from, relative, to = relative) {
  if (!(await exists(from))) return;
  const stat = await fs.stat(from);
  if (stat.isFile()) {
    const rel = path.relative(root, from);
    if (!include(rel, { isDirectory: () => false })) return;
    const target = path.join(stage, to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(from, target);
    return;
  }
  const target = path.join(stage, to);
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const sourceChild = path.join(from, entry.name), relativeChild = path.join(relative, entry.name);
    if (!include(relativeChild, entry)) continue;
    await copyTree(sourceChild, relativeChild, path.join(to, entry.name));
  }
}
async function runTar() {
  await new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-czf', archive, '-C', stage, '.'], { stdio: 'inherit', windowsHide: true });
    proc.once('error', reject);
    proc.once('exit', code => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)));
  });
}

if (!(await exists(appRoot))) throw new Error('Build the Vercel web app before preparing its source archive.');
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });

// Copy the exact app dependency graph used by the web build, retaining its root layout.
for (const entry of await fs.readdir(appRoot, { withFileTypes: true })) {
  if (entry.name === 'index.html') continue;
  await copyTree(path.join(appRoot, entry.name), entry.name, entry.name);
}
await copyFile('index.html');
for (const item of manifest) await copyFile(item, item, optionalRootFiles.has(item));
for (const directory of ['api', 'site', 'supabase', 'scripts', 'desktop', 'locales', 'android/ui', 'android/vendor', 'ios']) {
  await copyTree(path.join(root, directory), directory);
}
for (const file of ['capacitor.config.json', 'apple/README.md', 'apple/build-ios-ci.sh', 'apple/build-ios-unsigned.sh', 'apple/prepare-ios-icon.swift', 'apple/entitlements.mac.plist']) {
  await copyFile(file);
}
await copyFile('.github/workflows/apple-apps.yml', '.github/workflows/apple-apps.yml', true);
await copyFile('.gitignore', '.gitignore', true);
await copyTree(path.join(root, 'apple/windows-dmg'), 'apple/windows-dmg');
for (const file of ['tests/cloud-billing.api.test.cjs', 'tests/cloud-billing.database.test.cjs', 'tests/cloud-billing.browser.test.cjs', 'tests/web-files-cloud.browser.test.cjs', 'tests/web-management.browser.test.cjs', 'tests/backup-fixture.cjs', 'tests/localization.browser.test.cjs', 'tests/reader-translation.native.test.cjs']) await copyFile(file);
await copyFile('tests/apple-native-routing.browser.test.cjs');
await copyFile('locales/inventory.json', 'audits/languages/catalog-inventory.json');
await copyFile('tests/web-reader-touch.browser.test.cjs');
await copyFile('tests/reader-panel-close.browser.test.cjs');
await copyFile('tests/epub-continuous.browser.test.cjs');
await copyFile('tests/cloud-account-lifecycle.test.cjs');
await copyFile('tests/backup-integrity.browser.test.cjs');
await copyFile('locales/additional-keys.json', 'audits/languages/missing-keys.json');
for (const file of [
  'android/Build-Android.ps1', 'android/Sync-Android-Assets.ps1', 'android/build.gradle',
  'android/settings.gradle', 'android/gradle.properties', 'android/gradlew', 'android/gradlew.bat',
  'android/app/build.gradle', 'android/app/src/main/AndroidManifest.xml'
]) await copyFile(file);
for (const directory of ['android/app/src/main/java', 'android/app/src/main/cpp', 'android/app/src/main/res']) {
  await copyTree(path.join(root, directory), directory);
}
await copyTree(path.join(root, 'android/gradle'), 'android/gradle');
await copyTree(path.join(root, 'android/app/src/main/assets'), 'android/app/src/main/assets');

const readme = `# Noteject source package\n\nThis source archive corresponds to the public Noteject release. Noteject application source is licensed under GNU AGPL-3.0-or-later; see LICENSE and LICENSE-AGPL-3.0-or-later.txt. Third-party software keeps its own licenses.\n\n## Build\n\n- Web: run \`npm ci --omit=dev\`, then \`npm run build:web\`.\n- Windows: install the desktop development dependencies with \`npm ci\`, then run \`npm run desktop:installer\`.\n- Android: install Android Studio/SDK, NDK, and CMake, then run \`npm run build:android\`.\n\nThe large Vosk speech-model data archives are not bundled in this source archive. Their official download URLs and required SHA-256 hashes are listed in android/app/src/main/assets/audio-open-source-notices.txt. Place the downloaded archives in android/app/src/main/assets before building Android. Gradle obtains the unmodified MuPDF Android dependency from Artifex's Maven repository; its exact source and license details are in android/vendor/maven/com/artifex/mupdf/NOTICE.md.\n`;
await fs.writeFile(path.join(stage, 'README-SOURCE.md'), readme, 'utf8');
await fs.mkdir(path.dirname(archive), { recursive: true });
await fs.rm(archive, { force: true });
await runTar();
const { size } = await fs.stat(archive);
console.log(`Prepared AGPL source archive (${(size / 1024 / 1024).toFixed(1)} MB): ${path.relative(root, archive)}`);
