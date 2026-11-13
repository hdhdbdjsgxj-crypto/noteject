'use strict';

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '');
  if (!url || !anonKey || !/^https:\/\//i.test(url)) throw Object.assign(new Error('Cloud accounts are not configured yet.'), { statusCode: 503 });
  let role;
  try { role = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString()).role; } catch {}
  if (anonKey.startsWith('sb_secret_') || role === 'service_role') throw Object.assign(new Error('The public cloud key must be a publishable key.'), { statusCode: 503 });
  return { url, anonKey };
}

function bearer(req) {
  const value = String(req.headers?.authorization || '');
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1] || '';
}

async function requireUser(req) {
  const token = bearer(req);
  if (!token) throw Object.assign(new Error('Sign in to your Noteject account first.'), { statusCode: 401 });
  const { url, anonKey } = getSupabaseConfig();
  const response = await fetch(url + '/auth/v1/user', { headers: { apikey: anonKey, Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Object.assign(new Error('Your Noteject session expired. Sign in again.'), { statusCode: 401 });
  return { user: await response.json(), token, url, anonKey };
}

function json(res, status, value) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).json(value);
}

function preflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.status(204).end();
  return true;
}

function bodyObject(req) {
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { throw Object.assign(new Error('Send a valid JSON request.'), { statusCode: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Send a valid JSON request.'), { statusCode: 400 });
  return body;
}

async function adminRequest(path, body, method = 'POST') {
  const { url } = getSupabaseConfig();
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw Object.assign(new Error('Cloud account metering is not configured yet.'), { statusCode: 503 });
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' + (path.includes('on_conflict=') ? ',resolution=merge-duplicates' : '') };
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  const response = await fetch(url + '/rest/v1/' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const code = String(result?.message || '');
    const known = /^(AI_MONTHLY_LIMIT|AI_RATE_LIMIT|AI_BUSY|AI_ADVANCED_UNAVAILABLE|AI_DUPLICATE_REQUEST|BILLING_BUSY)$/.exec(code)?.[1];
    console.error('Noteject Supabase admin request failed', {
      endpoint: String(path).split('?')[0].replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 100),
      method,
      status: response.status,
      code: String(result?.code || '').slice(0, 40),
      message: String(result?.message || '').slice(0, 180)
    });
    throw Object.assign(new Error(known === 'BILLING_BUSY' ? 'Another checkout is opening. Please wait a moment before changing plans.' : (known || 'Cloud account setup needs to be completed.')), { code: known, statusCode: known ? (['AI_DUPLICATE_REQUEST', 'BILLING_BUSY'].includes(known) ? 409 : 429) : 503 });
  }
  return result;
}

function fail(res, error, fallback = 'The request could not be completed.') {
  const status = Number(error?.statusCode) || 500;
  json(res, status, { error: status >= 500 && status !== 503 ? fallback : String(error?.message || fallback) });
}

module.exports = { getSupabaseConfig, requireUser, json, fail, preflight, bodyObject, adminRequest };
