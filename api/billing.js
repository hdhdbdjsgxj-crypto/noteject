'use strict';
const { requireUser, adminRequest, json, fail, preflight, bodyObject } = require('./_shared');
const { siteUrl, purchasablePlans, isLiveMode, accountLiveMode } = require('./_plans');
const { stripeClient, customerFor: stripeCustomerFor } = require('./_billing');
const paddle = require('./_paddle');
module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  try {
    const auth = await requireUser(req), body = bodyObject(req);
    const returnUrl = siteUrl() + '/app/?billing=returned';
    if (body.action === 'portal') {
      const account = await adminRequest('rpc/noteject_ai_account', { p_user_id: auth.user.id, p_livemode: accountLiveMode() });
      if (account?.billingProvider === 'stripe') {
        const stripe = stripeClient(), customer = await stripeCustomerFor(auth.user, stripe);
        if (!customer) return json(res, 409, { error: 'This account has no subscription to manage.' });
        const session = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
        return json(res, 200, { url: session.url, provider: 'stripe' });
      }
      const customer = await paddle.customerFor(auth.user);
      if (!customer) return json(res, 409, { error: 'This account has no subscription to manage.' });
      const session = await paddle.paddleRequest('/customers/' + encodeURIComponent(customer) + '/portal-sessions', 'POST', {});
      const url = paddle.publicPortalUrl(session?.urls?.general?.overview);
      if (!url) throw Object.assign(new Error('Paddle did not return a valid customer portal link.'), { statusCode: 503 });
      return json(res, 200, { url, provider: 'paddle' });
    }
    if (body.action !== 'checkout' || !['starter', 'pro'].includes(body.plan)) return json(res, 400, { error: 'Choose Starter or Pro. Team subscriptions are not available yet.' });
    if (!purchasablePlans().includes(body.plan)) return json(res, 503, { error: 'Subscriptions are not available yet. Your current plan remains available.' });
    const priceId = await paddle.validatePrice(body.plan);
    const customer = await paddle.customerFor(auth.user, true);
    const account = await adminRequest('rpc/noteject_ai_account', { p_user_id: auth.user.id, p_livemode: isLiveMode() });
    if (account?.plan && account.plan !== 'free') return json(res, 409, { error: 'You already have a subscription. Use Manage subscription to change it.' });
    const attempt = await adminRequest('rpc/noteject_begin_checkout', { p_user_id: auth.user.id, p_plan_id: body.plan, p_livemode: isLiveMode(), p_provider: 'paddle' });
    if (attempt.session_id) {
      const previous = await paddle.paddleRequest('/transactions/' + encodeURIComponent(attempt.session_id));
      const matching = previous?.customer_id === customer && previous?.custom_data?.noteject_user_id === auth.user.id && previous?.custom_data?.noteject_plan === body.plan && previous?.items?.length === 1 && previous.items[0]?.price?.id === priceId && Number(previous.items[0]?.quantity) === 1;
      if (!matching) throw Object.assign(new Error('This checkout could not be verified. Please retry.'), { statusCode: 409 });
      if (['draft', 'ready'].includes(previous.status)) return json(res, 200, { transactionId: previous.id, token: process.env.PADDLE_CLIENT_TOKEN, environment: process.env.PADDLE_ENVIRONMENT, provider: 'paddle' });
      if (['completed', 'paid', 'billed'].includes(previous.status)) return json(res, 409, { error: 'Your payment is being confirmed. Refresh your plan in a moment.' });
      if (previous.status === 'canceled') {
        const restarted = await adminRequest('rpc/noteject_restart_checkout', {
          p_user_id: auth.user.id, p_provider: 'paddle', p_livemode: isLiveMode(), p_nonce: attempt.nonce, p_session_id: previous.id
        });
        if (!restarted?.nonce) return json(res, 409, { error: 'Another checkout is opening. Please wait a moment before retrying.' });
        attempt.nonce = restarted.nonce;
      } else return json(res, 409, { error: 'This checkout is already being processed. Refresh your plan in a moment.' });
    }
    const transaction = await paddle.paddleRequest('/transactions', 'POST', {
      items: [{ price_id: priceId, quantity: 1 }], customer_id: customer, collection_mode: 'automatic',
      custom_data: { noteject_user_id: auth.user.id, noteject_plan: body.plan }
    });
    if (!transaction?.id || !['draft', 'ready'].includes(transaction.status) || transaction.customer_id !== customer ||
        transaction.custom_data?.noteject_user_id !== auth.user.id || transaction.custom_data?.noteject_plan !== body.plan) {
      throw Object.assign(new Error('Paddle returned a checkout that could not be verified.'), { statusCode: 503 });
    }
    const saved = await adminRequest('noteject_billing_customers?user_id=eq.' + auth.user.id + '&livemode=eq.' + isLiveMode() + '&provider=eq.paddle&checkout_nonce=eq.' + attempt.nonce, { checkout_session_id: transaction.id }, 'PATCH');
    if (!saved?.length) throw Object.assign(new Error('Checkout changed while opening. Please retry.'), { statusCode: 409 });
    json(res, 200, { transactionId: transaction.id, token: process.env.PADDLE_CLIENT_TOKEN, environment: process.env.PADDLE_ENVIRONMENT, provider: 'paddle' });
  } catch (error) {
    if (error.type?.startsWith('Stripe') || error.raw || error.paddleFailure) return json(res, 503, { error: 'The payment service is unavailable. Please try again later.' });
    fail(res, error, 'Could not open subscription checkout. Please try again.');
  }
};
