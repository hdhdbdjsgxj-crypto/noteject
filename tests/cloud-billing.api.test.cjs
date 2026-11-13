const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { randomUUID } = require('node:crypto');
const user = '11111111-1111-4111-8111-111111111111';
const ask = require('../api/ask');
const config = require('../api/site-config');
const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', OPENAI_API_KEY: 'owner-test-only', STRIPE_SECRET_KEY: 'sk_test_noteject_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_test', NOTEJECT_BILLING_ENABLED: 'true', STRIPE_PRICE_STARTER:'price_starter', STRIPE_PRICE_PRO:'price_pro', PADDLE_ENVIRONMENT:'sandbox', PADDLE_API_KEY:'fixture-paddle-key', PADDLE_CLIENT_TOKEN:'test_fixture', PADDLE_WEBHOOK_SECRET:'fixture-webhook', PADDLE_PRICE_STARTER:'pri_starter', PADDLE_PRICE_PRO:'pri_pro' };
function response() { return { headers: {}, code: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; }, end() {} }; }
async function fixture(run, fetcher) {
  const saved = {}, originalFetch = global.fetch;
  for (const [key, value] of Object.entries(fakeEnv)) { saved[key] = process.env[key]; process.env[key] = value; }
  global.fetch = fetcher;
  try { await run(); } finally { global.fetch = originalFetch; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const req = body => ({ method: 'POST', headers: { authorization: 'Bearer user-token' }, body });
const valid = () => ({ question: 'Explain the passage', context: '[S1] The passage.', requestId: randomUUID() });
const ok = data => new Response(JSON.stringify(data), { status: 200 });
function cloudFetch(options = {}) {
  return async (url, init = {}) => {
    if (url.includes('/auth/v1/user')) return ok({ id: user, app_metadata: { noteject_plan: 'team' }, user_metadata: { plan: 'team' } });
    if (url.includes('/rest/v1/')) {
      assert.equal(init.headers.apikey, fakeEnv.SUPABASE_SECRET_KEY);
      assert.equal(init.headers.Authorization, undefined, 'new Supabase secret must not be sent as a user JWT');
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith('noteject_reserve_ai_action')) {
        assert.equal(body.p_user_id, user); assert.equal(body.p_monthly_limit, undefined);
        options.reserve?.(body);
        if (options.limit) return new Response(JSON.stringify({ message: options.limit }), { status: 400 });
        return ok({ id: 1, plan: 'free', remaining: 9 });
      }
      if (url.endsWith('noteject_complete_ai_action')) {
        if (options.recordFailure) throw Error('database connection failed');
        return ok(true);
      }
      if (url.endsWith('noteject_fail_ai_action')) { options.refund?.(); return ok(true); }
      throw Error('Unexpected cloud path: ' + url);
    }
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer ' + fakeEnv.OPENAI_API_KEY);
    options.provider?.(JSON.parse(init.body));
    if (options.providerFailure) return new Response(JSON.stringify({ error: { message: 'Bad key ' + fakeEnv.OPENAI_API_KEY } }), { status: 401 });
    return ok({ output: [{ content: [{ type: 'output_text', text: 'Supported answer. [S1]' }] }], usage: { input_tokens: 20, output_tokens: 10 } });
  };
}

test('AI uses one server key and authoritative metering, ignores client model/plan/quota, bounds context', async () => {
  await fixture(async () => {
    const res = response();
    await ask(req({ ...valid(), context: 'x'.repeat(80000), model: 'expensive-user-model', plan: 'team', monthlyLimit: 999999 }), res);
    assert.equal(res.code, 200); assert.equal(res.body.plan, 'free');
    assert(!JSON.stringify(res.body).includes(fakeEnv.OPENAI_API_KEY));
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  }, cloudFetch({ provider(body) { assert.equal(body.model, 'gpt-5-nano'); assert.equal(body.store, false); assert(body.input[1].content.length < 32100); } }));
});
test('Advanced mode selects the owner-configured advanced model and quota bucket', async () => {
  await fixture(async () => { const res = response(); await ask(req({ ...valid(), aiTier: 'advanced' }), res); assert.equal(res.code, 200); }, cloudFetch({ reserve(body) { assert.equal(body.p_action_kind, 'advanced'); }, provider(body) { assert.equal(body.model, 'gpt-5-mini'); } }));
});
test('quota rejection prevents provider calls; malformed JSON returns 400', async () => {
  let calls = 0;
  await fixture(async () => {
    const limited = response(); await ask(req(valid()), limited); assert.equal(limited.code, 429); assert.equal(calls, 0);
    const malformed = response(); await ask(req('{broken'), malformed); assert.equal(malformed.code, 400);
  }, cloudFetch({ limit: 'AI_MONTHLY_LIMIT', provider() { calls++; } }));
});
test('an explicit provider rejection releases its reservation without revealing a key', async () => {
  let refunded = false;
  await fixture(async () => { const res = response(); await ask(req(valid()), res); assert.equal(res.code, 503); assert.equal(refunded, true); assert(!JSON.stringify(res.body).includes(fakeEnv.OPENAI_API_KEY)); }, cloudFetch({ providerFailure: true, refund() { refunded = true; } }));
});
test('a generated answer survives a metering outage and its reservation remains counted', async () => {
  let refunded = false;
  await fixture(async () => { const res = response(); await ask(req(valid()), res); assert.equal(res.code, 200); assert.equal(res.body.usage.recorded, false); assert.equal(refunded, false); }, cloudFetch({ recordFailure: true, refund() { refunded = true; } }));
});
test('public configuration never exposes a mistakenly configured Supabase admin secret', async () => {
  await fixture(async () => {
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_secret_accident';
    const res = response(); config({ method: 'GET' }, res);
    assert.equal(res.body.cloudEnabled, false); assert.equal(res.body.supabaseAnonKey, ''); assert.equal(res.body.aiEnabled, false);
    assert(!JSON.stringify(res.body).includes('sb_secret_'));
  }, async () => { throw Error('No network expected'); });
});
test('payment notifications verify exact raw bytes, reject altered payloads, and skip duplicate events', async () => {
  const billing = require('../api/_billing'), original = billing.stripeClient;
  const signing = new Stripe('payment-test-only');
  let retrieved = 0, duplicate = false, applied = false;
  billing.stripeClient = () => ({ webhooks: signing.webhooks, subscriptions: { async retrieve(id) { retrieved++; return { id, customer: 'cus_test', metadata: { noteject_user_id: user }, status: 'active', items: { data: [{ quantity: 1, current_period_end: 4102444800, price: { id: 'price_pro', currency: 'usd', unit_amount: 1299, recurring: { interval: 'month', interval_count: 1 } } }] } }; } } });
  try {
    const { default: webhook } = await import('../api/stripe-webhook.mjs?api-test');
    const payload = JSON.stringify({ id: 'evt_test', type: 'customer.subscription.updated', created: 100, data: { object: { id: 'sub_test' } } });
    const header = signing.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
    await fixture(async () => {
      const request = (body, signature = header) => new Request('https://noteject.test/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body });
      assert.equal((await webhook.fetch(request(payload + ' '))).status, 400);
      assert.equal((await webhook.fetch(request(payload))).status, 200); assert.equal(applied, true); assert.equal(retrieved, 1);
      duplicate = true;
      assert.equal((await webhook.fetch(request(payload))).status, 200); assert.equal(retrieved, 1);
      const stale = signing.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test', timestamp: 1 });
      assert.equal((await webhook.fetch(request(payload, stale))).status, 400);
    }, async (url, init = {}) => {
      if (url.includes('noteject_webhook_events?')) return ok(duplicate ? [{ event_id: 'evt_test' }] : []);
      if (url.includes('noteject_billing_customers?')) return ok([{ user_id: user }]);
      assert(url.endsWith('noteject_apply_subscription'));
      const body = JSON.parse(init.body); assert.equal(body.p_plan_id, 'pro'); assert.equal(body.p_user_id, user); applied = true; return ok(true);
    });
  } finally { billing.stripeClient = original; }
});

test('Paddle checkout validates prices, binds the customer and user, and keeps Team unavailable',async()=>{
 const billing=require('../api/billing');let amount=599,created=0,providerError=false;
 await fixture(async()=>{
  const result=response();await billing(req({action:'checkout',plan:'starter',price:'attacker'}),result);assert.equal(result.code,200);assert.equal(result.body.transactionId,'txn_fixture');assert.equal(created,1);
  amount=1;const wrong=response();await billing(req({action:'checkout',plan:'starter'}),wrong);assert.equal(wrong.code,503);assert.equal(created,1);
  const team=response();await billing(req({action:'checkout',plan:'team'}),team);assert.equal(team.code,400);
  providerError=true;const failed=response();await billing(req({action:'checkout',plan:'starter'}),failed);assert.equal(failed.code,503);assert(!JSON.stringify(failed.body).includes(fakeEnv.PADDLE_API_KEY));
 },async(url,init={})=>{
  if(url.includes('/auth/v1/user'))return ok({id:user,email:'fixture@test.invalid'});
  if(url.includes('/prices/'))return providerError?new Response(JSON.stringify({error:{message:fakeEnv.PADDLE_API_KEY}}),{status:401}):ok({data:{status:'active',unit_price:{currency_code:'USD',amount:String(amount)},billing_cycle:{interval:'month',frequency:1},trial_period:null}});
  if(url.includes('noteject_billing_customers?'))return ok([{customer_id:'ctm_fixture'}]);
  if(url.includes('noteject_ai_account'))return ok({plan:'free'});
  if(url.includes('noteject_begin_checkout'))return ok({nonce:'attempt-fixture',session_id:null});
  if(url.endsWith('/transactions')){const body=JSON.parse(init.body);created++;assert.equal(body.customer_id,'ctm_fixture');assert.equal(body.custom_data.noteject_user_id,user);assert.equal(body.items[0].price_id,'pri_starter');return ok({data:{...body,id:'txn_fixture',status:'ready'}});}
  throw Error('Unexpected fixture path');
 });
});
