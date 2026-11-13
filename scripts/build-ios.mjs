import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
if (process.platform !== 'darwin') {
  console.error('No IPA was created: this native iOS project needs Xcode on macOS. Run the Apple Apps workflow on a hosted Mac, or run this command on a Mac with Xcode.');
  process.exit(1);
}
for (const [command, args] of [
  ['npm', ['run', 'apple:sync-ios']],
  ['bash', ['apple/build-ios-unsigned.sh']]
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
