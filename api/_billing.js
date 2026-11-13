'use strict';
const Stripe = require('stripe');
const { adminRequest } = require('./_shared');
const { PLANS, stripeLiveMode } = require('./_plans');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw Object.assign(new Error('Payments are not configured yet.'), { statusCode: 503 });
  return new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 1, timeout: 8000 });
}
async function customerFor(user, stripe, create = false) {
  const live = stripeLiveMode();
  const rows = await adminRequest('noteject_billing_customers?user_id=eq.' + user.id + '&livemode=eq.' + live + '&provider=eq.stripe&select=customer_id', undefined, 'GET');
  if (rows?.[0]?.customer_id) return rows[0].customer_id;
  if (!create) return null;
  const customer = await stripe.customers.create({ metadata: { noteject_user_id: user.id } }, { idempotencyKey: 'noteject-customer-' + user.id });
  const saved = await adminRequest('noteject_billing_customers?on_conflict=user_id,livemode,provider', { user_id: user.id, customer_id: customer.id, livemode: live, provider: 'stripe' }, 'POST');
  return saved?.[0]?.customer_id || customer.id;
}
async function syncSubscription(subscription, event, observedAt) {
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customer) throw new Error('Subscription has no customer.');
  const rows = await adminRequest('noteject_billing_customers?customer_id=eq.' + encodeURIComponent(customer) + '&provider=eq.stripe&select=user_id', undefined, 'GET');
  const userId = rows?.[0]?.user_id;
  if (!userId) return { ignored: true };
  if (!uuid.test(userId) || subscription.metadata?.noteject_user_id !== userId) throw new Error('Subscription owner does not match the Noteject account.');
  const items = subscription.items?.data || [];
  const item = items.length === 1 ? items[0] : null;
  const price = item?.price;
  const plan = ['starter', 'pro', 'team'].find(id => process.env['STRIPE_PRICE_' + id.toUpperCase()] === price?.id && price?.currency === 'usd' && price?.unit_amount === PLANS[id].cents && price?.recurring?.interval === 'month' && price?.recurring?.interval_count === 1 && item.quantity === 1) || 'free';
  const periodEnd = item?.current_period_end || subscription.current_period_end;
  return adminRequest('rpc/noteject_apply_subscription', {
    p_event_id: event.id, p_event_created: event.created, p_observed_at: observedAt,
    p_user_id: userId, p_customer_id: customer, p_subscription_id: subscription.id,
    p_plan_id: plan, p_status: subscription.status, p_provider: 'stripe',
    p_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    p_cancel_at_period_end: !!(subscription.cancel_at_period_end || subscription.cancel_at), p_livemode: !!subscription.livemode
  });
}
module.exports = { stripeClient, customerFor, syncSubscription };
