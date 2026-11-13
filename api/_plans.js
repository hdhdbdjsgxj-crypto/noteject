'use strict';
const PLANS = Object.freeze({
  free: { name: 'Free', cents: 0, basic: 10, advanced: 0, backupBytes: 50 * 1024 * 1024 },
  starter: { name: 'Starter', cents: 599, basic: 200, advanced: 10, backupBytes: 1 * 1024 * 1024 * 1024 },
  pro: { name: 'Pro', cents: 1299, basic: 1000, advanced: 100, backupBytes: 5 * 1024 * 1024 * 1024 },
  team: { name: 'Team', cents: 3499, basic: 5000, advanced: 250, backupBytes: 15 * 1024 * 1024 * 1024 }
});
const MAX_BACKUP_BYTES = 15 * 1024 * 1024 * 1024;
function syncStorageCeilingBytes() {
  const configured = Number(process.env.NOTEJECT_SYNC_MAX_BYTES) || 50 * 1024 * 1024;
  return Math.min(MAX_BACKUP_BYTES, Math.max(1_000_000, configured));
}
function backupLimitBytes(plan) {
  return Math.min(PLANS[String(plan || 'free').toLowerCase()]?.backupBytes || PLANS.free.backupBytes, syncStorageCeilingBytes());
}
function backupQuotas() {
  // The public plan cards describe the intended plan caps, including paid
  // tiers that remain marked "Coming soon". The signed-in backup meter and
  // upload checks continue to use backupLimitBytes(), which also enforces the
  // currently configured storage-provider ceiling.
  return Object.fromEntries(Object.keys(PLANS).map(plan => [plan, PLANS[plan].backupBytes]));
}
function siteUrl() {
  const url = new URL(process.env.NOTEJECT_SITE_URL || 'https://noteject.vercel.app');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Object.assign(new Error('The Noteject website address is not configured correctly.'), { statusCode: 503 });
  return url.origin;
}
function billingReady() {
  return process.env.NOTEJECT_BILLING_ENABLED === 'true' &&
    ['sandbox', 'live'].includes(process.env.PADDLE_ENVIRONMENT) &&
    !!(process.env.OPENAI_API_KEY && process.env.PADDLE_API_KEY && process.env.PADDLE_CLIENT_TOKEN && process.env.PADDLE_WEBHOOK_SECRET && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
}
function purchasablePlans() {
  if (!billingReady()) return [];
  // Team checkout stays closed until shared workspace membership is implemented.
  return ['starter', 'pro'].filter(id => !!process.env['PADDLE_PRICE_' + id.toUpperCase()]);
}
const isLiveMode = () => process.env.PADDLE_ENVIRONMENT === 'live';
const stripeLiveMode = () => /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '');
const accountLiveMode = () => ['sandbox', 'live'].includes(process.env.PADDLE_ENVIRONMENT) ? isLiveMode() : stripeLiveMode();
module.exports = { PLANS, siteUrl, billingReady, purchasablePlans, isLiveMode, stripeLiveMode, accountLiveMode, syncStorageCeilingBytes, backupLimitBytes, backupQuotas };
