'use strict';
const { json, getSupabaseConfig, preflight } = require('./_shared');
const { purchasablePlans, syncStorageCeilingBytes, backupQuotas } = require('./_plans');
const releases = require('../release-manifest.json');

module.exports = function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  let cloud = null;
  try { cloud = getSupabaseConfig(); } catch {}
  const downloads = {
    windows: releases.windows?.url || process.env.WINDOWS_DOWNLOAD_URL || '',
    android: releases.android?.url || process.env.ANDROID_DOWNLOAD_URL || '',
    macArm64: releases.macArm64?.url || '',
    macX64: releases.macX64?.url || ''
  };
  for (const key of Object.keys(downloads)) {
    try { if (downloads[key] && new URL(downloads[key]).protocol !== 'https:') downloads[key] = ''; }
    catch { downloads[key] = ''; }
  }
  const linkedVersion = (url, pattern) => {
    try {
      const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      return filename.match(pattern)?.[1] || '';
    } catch { return ''; }
  };
  // The download itself is the source of truth. Version environment variables
  // can lag behind when a newer build has not yet been uploaded to Blob.
  const versions = {
    web: require('../package.json').version,
    windows: linkedVersion(downloads.windows, /^Noteject-Setup-(.+?)-x64\.exe$/i) || process.env.WINDOWS_VERSION || 'Latest release',
    android: linkedVersion(downloads.android, /^Noteject-Android-(.+?)\.apk$/i) || process.env.ANDROID_VERSION || 'Latest release',
    macArm64: linkedVersion(downloads.macArm64, /^Noteject-Mac-(.+?)-arm64-development\.dmg$/i),
    macX64: linkedVersion(downloads.macX64, /^Noteject-Mac-(.+?)-x64-development\.dmg$/i)
  };
  json(res, 200, {
    cloudEnabled: !!cloud,
    supabaseUrl: cloud?.url || '',
    supabaseAnonKey: cloud?.anonKey || '',
    aiEnabled: !!(process.env.OPENAI_API_KEY && cloud && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)),
    checkoutPlans: cloud ? purchasablePlans() : [],
    downloads,
    versions,
    syncMaxBytes: syncStorageCeilingBytes(),
    backupQuotas: backupQuotas()
  });
};
