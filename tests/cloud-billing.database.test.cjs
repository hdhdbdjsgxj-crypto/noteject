const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const user = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const sql = name => fs.readFileSync(path.join(__dirname, '../supabase', name), 'utf8');

test('PostgreSQL enforces cloud plans, billing ordering, isolation, and server-only usage writes', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role', true)$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text);
    create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
    insert into auth.users values('${user}'),('${other}');
    select set_config('request.jwt.claim.role','service_role',false);`);
  await db.exec(sql('schema.sql'));
  await db.exec(sql('billing.sql'));
  const account = async () => (await db.query('select noteject_ai_account($1) as value', [user])).rows[0].value;
  const reserve = async (kind = 'basic', id = randomUUID()) => (await db.query('select noteject_reserve_ai_action($1,$2,$3) as value', [user, kind, id])).rows[0].value;
  const complete = async (id, owner = user) => (await db.query("select noteject_complete_ai_action($1,$2,'test',100,20) as value", [owner, id])).rows[0].value;
  const apply = async (event, created, plan = 'team', status = 'active', end = '2099-01-01') => (await db.query("select noteject_apply_subscription($1,$2,now(),$3,'cus_test','sub_test',$4,$5,$6,false) as value", [event, created, user, plan, status, end])).rows[0].value;
  await db.query("insert into noteject_billing_customers(user_id,customer_id) values($1,'cus_test')", [user]);

  await t.test('Free has 10 basic actions, no advanced, and no client-controlled limit', async () => {
    assert.equal((await account()).basic.limit, 10);
    await assert.rejects(reserve('advanced'), /AI_ADVANCED_UNAVAILABLE/);
    await db.query("insert into ai_usage_events(user_id,status,created_at) select $1,'complete',now()-interval '10 minutes' from generate_series(1,10)", [user]);
    await assert.rejects(reserve(), /AI_MONTHLY_LIMIT/);
    assert.equal((await db.query("select to_regprocedure('noteject_reserve_ai_action(integer)') as old")).rows[0].old, null);
    await db.exec('truncate ai_usage_events');
  });
  await t.test('Team reaches exactly 5000 basic and 250 advanced actions', async () => {
    await apply('evt_team', 100);
    assert.equal((await account()).plan, 'team');
    await db.query("insert into ai_usage_events(user_id,status,created_at) select $1,'complete',now()-interval '10 minutes' from generate_series(1,4999)", [user]);
    const last = await reserve();
    assert.equal(last.remaining, 0); await complete(last.id);
    await assert.rejects(reserve(), /AI_MONTHLY_LIMIT/);
    await db.query("insert into ai_usage_events(user_id,status,action_kind,created_at) select $1,'complete','advanced',now()-interval '10 minutes' from generate_series(1,249)", [user]);
    const advanced = await reserve('advanced'); assert.equal(advanced.remaining, 0); await complete(advanced.id);
    await assert.rejects(reserve('advanced'), /AI_MONTHLY_LIMIT/);
    await db.exec('truncate ai_usage_events');
  });
  await t.test('requests cannot be replayed, completion is owner-bound, refunds are server-only', async () => {
    const id = randomUUID(), first = await reserve('basic', id);
    await assert.rejects(reserve('basic', id), /AI_DUPLICATE_REQUEST/);
    assert.equal(await complete(first.id, other), false);
    await db.query('select noteject_fail_ai_action($1,$2)', [user, first.id]);
    assert.equal((await account()).basic.used, 0);
    const a = await reserve(), b = await reserve();
    await assert.rejects(reserve(), /AI_BUSY/);
    await complete(a.id); await complete(b.id);
    await db.exec('truncate ai_usage_events');
  });
  await t.test('duplicate and older webhooks cannot revoke newer access; cancellation and expiry downgrade', async () => {
    assert.equal(await apply('evt_pro', 200, 'pro'), true);
    assert.equal(await apply('evt_pro', 200, 'free', 'canceled'), false);
    await apply('evt_old', 150, 'free', 'canceled');
    assert.equal((await account()).plan, 'pro');
    await apply('evt_cancel', 300, 'pro', 'canceled');
    assert.equal((await account()).plan, 'free');
    await apply('evt_expired', 400, 'pro', 'active', '2001-01-01');
    assert.equal((await account()).plan, 'free');
    await apply('evt_starter', 500, 'starter');
    assert.deepEqual([(await account()).basic.limit, (await account()).advanced.limit], [200, 10]);
  });
  await t.test('checkout retries share one attempt and concurrent plan changes are blocked', async () => {
    const begin = async plan => (await db.query('select noteject_begin_checkout($1,$2) as value', [user, plan])).rows[0].value;
    const a = await begin('starter');
    await assert.rejects(begin('starter'), /BILLING_BUSY/);
    await db.query("update noteject_billing_customers set checkout_session_id='txn_fixture' where user_id=$1", [user]);
    const b = await begin('starter');
    assert.equal(a.nonce, b.nonce);
    await assert.rejects(begin('pro'), /BILLING_BUSY/);
    await db.exec("update noteject_billing_customers set checkout_started_at=now()-interval '2 minutes'");
    assert.notEqual((await begin('pro')).nonce, a.nonce);
  });
  await t.test('signed-in app users can only read their own usage and cannot change plans or usage', async () => {
    await db.query("insert into ai_usage_events(user_id,status) values($1,'complete'),($2,'complete')", [user, other]);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${user}',false);`);
    assert.equal((await db.query('select * from ai_usage_events')).rows.length, 1);
    await assert.rejects(db.query('select noteject_reserve_ai_action($1,$2,$3)', [user, 'basic', randomUUID()]), /permission denied/);
    await assert.rejects(db.query('select noteject_fail_ai_action($1,1)', [user]), /permission denied/);
    await assert.rejects(db.exec("update noteject_subscriptions set plan_id='team'"), /permission denied/);
    await db.exec("reset role; select set_config('request.jwt.claim.role','service_role',false);");
  });
  await t.test('both setup scripts can be rerun without losing account data', async () => {
    await db.exec(sql('schema.sql')); await db.exec(sql('billing.sql'));
    assert.equal((await account()).plan, 'starter');
    const live = (await db.query('select noteject_ai_account($1,true) as value', [user])).rows[0].value;
    assert.equal(live.plan, 'free', 'test-mode subscriptions must never grant live access');
    assert.equal(live.basic.used, 0, 'test-mode AI usage must not consume the live allowance');
  });
});
