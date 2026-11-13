'use strict';

const { adminRequest } = require('./_shared');
const { PLANS, isLiveMode } = require('./_plans');

function environment() {
  const value = process.env.PADDLE_ENVIRONMENT;
  if (value !== 'sandbox' && value !== 'live') throw Object.assign(new Error('Paddle is not configured yet.'), { statusCode: 503 });
  return value;
}

function apiRoot() {
  return environment() === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}

async function paddleRequest(path, method = 'GET', body) {
  const key = process.env.PADDLE_API_KEY;
  if (!key) throw Object.assign(new Error('Paddle is not configured yet.'), { statusCode: 503 });
  const response = await fetch(apiRoot() + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error('Paddle could not complete this billing request.'), { statusCode: 503, paddleFailure: true });
  return result?.data;
}

async function validatePrice(plan) {
  const priceId = process.env['PADDLE_PRICE_' + plan.toUpperCase()];
  if (!priceId) throw Object.assign(new Error('The selected plan is not configured yet.'), { statusCode: 503 });
  const price = await paddleRequest('/prices/' + encodeURIComponent(priceId));
  const amount = Number(price?.unit_price?.amount);
  if (price?.status !== 'active' || price?.unit_price?.currency_code !== 'USD' || amount !== PLANS[plan].cents ||
      price?.billing_cycle?.interval !== 'month' || Number(price?.billing_cycle?.frequency) !== 1 || price?.trial_period) {
    throw Object.assign(new Error('The subscription price needs to be checked by the site owner.'), { statusCode: 503 });
  }
  return priceId;
}

async function customerFor(user, create = false) {
  const live = isLiveMode();
  const rows = await adminRequest('noteject_billing_customers?user_id=eq.' + encodeURIComponent(user.id) + '&livemode=eq.' + live + '&provider=eq.paddle&select=customer_id', undefined, 'GET');
  if (rows?.[0]?.customer_id) return rows[0].customer_id;
  if (!create) return null;
  const email = String(user.email || '').trim();
  if (!email || email.length > 320) throw Object.assign(new Error('Add a valid email address to your Noteject account before subscribing.'), { statusCode: 400 });
  const customer = await paddleRequest('/customers', 'POST', { email, custom_data: { noteject_user_id: user.id } });
  if (!customer?.id) throw Object.assign(new Error('Paddle did not return a customer ID.'), { statusCode: 503 });
  const saved = await adminRequest('rpc/noteject_save_billing_customer', {
    p_user_id: user.id, p_customer_id: customer.id, p_livemode: live, p_provider: 'paddle'
  });
  const canonical = typeof saved === 'string' ? saved : saved?.customer_id;
  if (!canonical) throw Object.assign(new Error('Could not link the payment account to Noteject.'), { statusCode: 503 });
  return canonical;
}

function publicPortalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'customer-portal.paddle.com' ? url.href : '';
  } catch { return ''; }
}

module.exports = { paddleRequest, validatePrice, customerFor, publicPortalUrl, environment, isLiveMode };
