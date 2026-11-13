import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Arch, Platform, build } from 'electron-builder';

if (process.platform !== 'darwin') {
  throw new Error('Run the Mac installer build on macOS or through the Apple Apps workflow.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const notarize = process.env.NOTEJECT_MAC_NOTARIZE === '1';
if (notarize && (!(process.env.APPLE_API_KEY || process.env.APPLE_API_KEY_P8) ||
  !process.env.APPLE_API_KEY_ID || !process.env.APPLE_API_ISSUER)) {
  throw new Error('Set the App Store Connect API key, key ID, and issuer before notarizing.');
}

await import('./build-vercel.mjs');

const stagingRoot = path.join(root, '.apple-build');
await fs.mkdir(stagingRoot, { recursive: true });
const stage = await fs.mkdtemp(path.join(stagingRoot, 'mac-'));
try {
  if (notarize && process.env.APPLE_API_KEY_P8) {
    const key = path.join(stage, 'notarization.p8');
    await fs.writeFile(key, Buffer.from(process.env.APPLE_API_KEY_P8, 'base64'), { mode: 0o600 });
    process.env.APPLE_API_KEY = key;
    delete process.env.APPLE_API_KEY_P8;
  }

  const assets = path.join(stage, 'workspace');
  await fs.cp(path.join(root, 'site-build', 'app'), assets, { recursive: true });
  // The desktop server serves the app from / and provides the native preload.
  for (const file of ['index.html', 'ai-server.mjs', 'noteject-logo.png', 'LICENSE',
    'LICENSE-AGPL-3.0-or-later.txt', 'THIRD_PARTY_NOTICES.md']) {
    await fs.copyFile(path.join(root, file), path.join(assets, file));
  }

  const output = path.join(stage, 'output');
  // A separate config keeps the Windows-only runtime out of the Mac bundle.
  const configPath = path.join(stage, 'electron-builder.json');
  await fs.writeFile(configPath, JSON.stringify({
    extends: null,
    appId: 'com.noteject.desktop',
    productName: 'Noteject',
    directories: { output },
    files: ['desktop/**/*', 'package.json'],
    extraResources: [{ from: assets, to: 'app' }],
    forceCodeSigning: true,
    mac: {
      icon: 'noteject-logo.png',
      category: 'public.app-category.productivity',
      identity: notarize ? undefined : '-',
      hardenedRuntime: notarize,
      notarize
    },
    dmg: { artifactName: 'Noteject-Mac-${version}-${arch}.${ext}' }
  }));
  const artifacts = await build({
    projectDir: root,
    targets: Platform.MAC.createTarget(['dmg'], Arch.universal),
    publish: 'never',
    config: configPath
  });

  const installer = artifacts.find(file => file.endsWith('.dmg'));
  if (!installer) throw new Error('The macOS build did not produce a disk image.');
  const app = path.join(output, 'mac-universal', 'Noteject.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  if (notarize) execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });

  const release = path.join(root, 'release', 'apple');
  await fs.mkdir(release, { recursive: true });
  const destination = path.join(release, path.basename(installer));
  await fs.copyFile(installer, destination);
  console.log(`Created ${destination}`);
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
