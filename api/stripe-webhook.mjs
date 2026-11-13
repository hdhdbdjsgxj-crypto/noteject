import shared from './_shared.js';
import billing from './_billing.js';
const { stripeClient, syncSubscription } = billing;
const supported = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'checkout.session.completed']);
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Web Request keeps the exact bytes needed for Stripe signature verification.
export default {
  async fetch(request) {
    if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return reply(503, { error: 'Payment notifications are not configured.' });
    let event, stripe;
    try {
      const reader = request.body?.getReader(), chunks = [];
      let size = 0;
      if (!reader) return reply(400, { error: 'Missing notification body.' });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) { await reader.cancel(); return reply(413, { error: 'Notification is too large.' }); }
        chunks.push(Buffer.from(value));
      }
      stripe = stripeClient();
      event = stripe.webhooks.constructEvent(Buffer.concat(chunks), request.headers.get('stripe-signature') || '', secret);
    } catch { return reply(400, { error: 'Invalid payment notification signature.' }); }
    if (!supported.has(event.type)) return reply(200, { received: true });
    try {
      const duplicate = await shared.adminRequest('noteject_webhook_events?event_id=eq.' + encodeURIComponent(event.id) + '&provider=eq.stripe&select=event_id', undefined, 'GET');
      if (duplicate?.length) return reply(200, { received: true });
      const object = event.data.object;
      const subscriptionId = event.type === 'checkout.session.completed' ? (typeof object.subscription === 'string' ? object.subscription : object.subscription?.id) : object.id;
      if (!subscriptionId) return reply(200, { received: true });
      const observedAt = new Date().toISOString();
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await syncSubscription(subscription, event, observedAt);
      return reply(200, { received: true });
    } catch { return reply(503, { error: 'Payment notification will be retried.' }); }
  }
};
