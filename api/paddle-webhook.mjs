import { createHmac, timingSafeEqual } from 'node:crypto';
import shared from './_shared.js';
const { adminRequest } = shared;
const supported = new Set([
  'subscription.created', 'subscription.activated', 'subscription.updated', 'subscription.trialing',
  'subscription.past_due', 'subscription.paused', 'subscription.resumed', 'subscription.canceled'
]);
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function verified(raw, signature, secret) {
  const fields = String(signature || '').split(';').map(part => part.trim().split('='));
  const timestamp = fields.find(([key]) => key === 'ts')?.[1];
  const hashes = fields.filter(([key]) => key === 'h1').map(([, value]) => value).filter(value => /^[a-f0-9]{64}$/i.test(value || ''));
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || !hashes.length || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const expected = createHmac('sha256', secret).update(timestamp + ':').update(raw).digest();
  return hashes.some(value => {
    const actual = Buffer.from(value, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function planFor(subscription) {
  const items = Array.isArray(subscription.items) ? subscription.items : [];
  if (items.length !== 1 || Number(items[0]?.quantity) !== 1) return 'free';
  const priceId = items[0]?.price?.id || items[0]?.price_id;
  return ['starter', 'pro'].find(plan => process.env['PADDLE_PRICE_' + plan.toUpperCase()] === priceId) || 'free';
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    const environment = process.env.PADDLE_ENVIRONMENT;
    if (!secret || !['sandbox', 'live'].includes(environment)) return reply(503, { error: 'Payment notifications are not configured.' });
    let raw;
    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 1024 * 1024) return reply(413, { error: 'Notification is too large.' });
      raw = Buffer.from(bytes);
      if (!verified(raw, request.headers.get('paddle-signature'), secret)) return reply(400, { error: 'Invalid payment notification signature.' });
    } catch { return reply(400, { error: 'Invalid payment notification signature.' }); }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'Invalid payment notification body.' }); }
    if (!supported.has(event?.event_type)) return reply(200, { received: true });
    const subscription = event.data || {};
    const customerId = subscription.customer_id;
    const userId = subscription.custom_data?.noteject_user_id;
    const timestamp = Date.parse(event.occurred_at);
    if (!event.event_id || !customerId || !subscription.id || !Number.isFinite(timestamp) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId || '')) return reply(400, { error: 'Incomplete subscription notification.' });
    try {
      const live = environment === 'live';
      const rows = await adminRequest('noteject_billing_customers?customer_id=eq.' + encodeURIComponent(customerId) + '&provider=eq.paddle&livemode=eq.' + live + '&select=user_id', undefined, 'GET');
      if (!rows?.length) return reply(200, { received: true });
      if (rows[0].user_id !== userId) return reply(400, { error: 'Subscription account could not be matched.' });
      const periodEnd = subscription.current_billing_period?.ends_at || null;
      const status = String(subscription.status || '').toLowerCase();
      await adminRequest('rpc/noteject_apply_subscription', {
        p_event_id: event.event_id,
        p_event_created: Math.floor(timestamp / 1000),
        p_observed_at: new Date().toISOString(),
        p_user_id: userId,
        p_customer_id: customerId,
        p_subscription_id: subscription.id,
        p_plan_id: planFor(subscription),
        p_status: status,
        p_period_end: periodEnd,
        p_cancel_at_period_end: subscription.scheduled_change?.action === 'cancel',
        p_livemode: live,
        p_provider: 'paddle'
      });
      return reply(200, { received: true });
    } catch { return reply(503, { error: 'Payment notification will be retried.' }); }
  }
};
