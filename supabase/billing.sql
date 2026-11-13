-- Run after schema.sql. Safe to rerun. All billing and metering writes are server-only.
begin;

create table if not exists public.noteject_billing_customers (
  user_id uuid not null references auth.users(id) on delete cascade,
  livemode boolean not null default false,
  provider text not null default 'stripe',
  customer_id text not null unique,
  checkout_nonce uuid,
  checkout_plan text,
  checkout_started_at timestamptz,
  checkout_session_id text,
  primary key(user_id,livemode,provider)
);
create table if not exists public.noteject_subscriptions (
  subscription_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  livemode boolean not null default false,
  provider text not null default 'stripe',
  customer_id text not null,
  plan_id text not null check (plan_id in ('free','starter','pro','team')),
  status text not null,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  event_created bigint not null,
  observed_at timestamptz not null
);
create index if not exists noteject_subscriptions_owner on public.noteject_subscriptions(user_id);
create table if not exists public.noteject_webhook_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);
alter table public.noteject_billing_customers enable row level security;
alter table public.noteject_subscriptions enable row level security;
alter table public.noteject_webhook_events enable row level security;
alter table public.noteject_billing_customers add column if not exists livemode boolean not null default false;
alter table public.noteject_billing_customers add column if not exists provider text not null default 'stripe';
alter table public.noteject_billing_customers drop constraint if exists noteject_billing_customers_provider_check;
alter table public.noteject_billing_customers add constraint noteject_billing_customers_provider_check check (provider in ('stripe','paddle'));
alter table public.noteject_billing_customers drop constraint if exists noteject_billing_customers_pkey;
alter table public.noteject_billing_customers add primary key(user_id,livemode,provider);
alter table public.noteject_subscriptions add column if not exists livemode boolean not null default false;
alter table public.noteject_subscriptions add column if not exists provider text not null default 'stripe';
alter table public.noteject_subscriptions drop constraint if exists noteject_subscriptions_provider_check;
alter table public.noteject_subscriptions add constraint noteject_subscriptions_provider_check check (provider in ('stripe','paddle'));
alter table public.noteject_subscriptions drop constraint if exists noteject_subscriptions_pkey;
alter table public.noteject_subscriptions add primary key(provider,subscription_id);
alter table public.noteject_webhook_events add column if not exists provider text not null default 'stripe';
alter table public.noteject_webhook_events drop constraint if exists noteject_webhook_events_provider_check;
alter table public.noteject_webhook_events add constraint noteject_webhook_events_provider_check check (provider in ('stripe','paddle'));
alter table public.noteject_webhook_events drop constraint if exists noteject_webhook_events_pkey;
alter table public.noteject_webhook_events add primary key(provider,event_id);
revoke all on public.noteject_billing_customers, public.noteject_subscriptions, public.noteject_webhook_events from public, anon, authenticated;
grant all on public.noteject_billing_customers, public.noteject_subscriptions, public.noteject_webhook_events to service_role;

alter table public.ai_usage_events add column if not exists action_kind text not null default 'basic' check (action_kind in ('basic','advanced'));
alter table public.ai_usage_events add column if not exists request_id uuid;
alter table public.ai_usage_events add column if not exists billing_livemode boolean not null default false;
create unique index if not exists ai_usage_requests on public.ai_usage_events(user_id, request_id) where request_id is not null;
revoke all on public.ai_usage_events from public, anon, authenticated;
grant select on public.ai_usage_events to authenticated;
grant all on public.ai_usage_events to service_role;
grant usage, select on sequence public.ai_usage_events_id_seq to service_role;

-- Remove the old RPCs that let a client choose its quota or refund its own requests.
drop function if exists public.noteject_reserve_ai_action();
drop function if exists public.noteject_reserve_ai_action(integer);
drop function if exists public.noteject_complete_ai_action(bigint,text,integer,integer);
drop function if exists public.noteject_fail_ai_action(bigint);
drop function if exists public.noteject_ai_account(uuid);
drop function if exists public.noteject_reserve_ai_action(uuid,text,uuid);
drop function if exists public.noteject_begin_checkout(uuid,text);
drop function if exists public.noteject_apply_subscription(text,bigint,timestamptz,uuid,text,text,text,text,timestamptz,boolean);
drop function if exists public.noteject_begin_checkout(uuid,text,boolean);
drop function if exists public.noteject_begin_checkout(uuid,text,boolean,text);
drop function if exists public.noteject_apply_subscription(text,bigint,timestamptz,uuid,text,text,text,text,timestamptz,boolean,boolean);
drop function if exists public.noteject_apply_subscription(text,bigint,timestamptz,uuid,text,text,text,text,timestamptz,boolean,boolean,text);
drop function if exists public.noteject_save_billing_customer(uuid,text,boolean,text);

create or replace function public.noteject_ai_account(p_user_id uuid,p_livemode boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_plan text := 'free'; v_basic integer; v_advanced integer;
  v_basic_used integer; v_advanced_used integer;
  v_start timestamptz;
  v_subscription public.noteject_subscriptions%rowtype; v_provider text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  select * into v_subscription from public.noteject_subscriptions
    where user_id = p_user_id and livemode=p_livemode and status in ('active','trialing') and period_end > now()
    order by case plan_id when 'team' then 3 when 'pro' then 2 when 'starter' then 1 else 0 end desc, observed_at desc limit 1;
  if found then v_plan := v_subscription.plan_id; end if;
  if found then v_provider := v_subscription.provider; else
    select provider into v_provider from public.noteject_subscriptions
      where user_id=p_user_id and livemode=p_livemode and status not in ('canceled','incomplete_expired')
      order by observed_at desc limit 1;
    if not found then
      select provider into v_provider from public.noteject_billing_customers
        where user_id=p_user_id and livemode=p_livemode order by case provider when 'paddle' then 0 else 1 end limit 1;
    end if;
  end if;
  v_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_basic := case v_plan when 'starter' then 200 when 'pro' then 1000 when 'team' then 5000 else 10 end;
  v_advanced := case v_plan when 'starter' then 10 when 'pro' then 100 when 'team' then 250 else 0 end;
  select count(*) filter (where action_kind = 'basic'), count(*) filter (where action_kind = 'advanced')
    into v_basic_used, v_advanced_used from public.ai_usage_events
    where user_id = p_user_id and billing_livemode=p_livemode and created_at >= v_start and status in ('reserved','complete');
  return jsonb_build_object('plan', v_plan, 'basic', jsonb_build_object('limit',v_basic,'used',v_basic_used),
    'advanced',jsonb_build_object('limit',v_advanced,'used',v_advanced_used),
    'resetsAt', (v_start at time zone 'UTC' + interval '1 month') at time zone 'UTC',
    'canManageSubscription',exists(select 1 from public.noteject_billing_customers where user_id = p_user_id and livemode=p_livemode),
    'billingProvider',v_provider,
    'cancelAtPeriodEnd',coalesce(v_subscription.cancel_at_period_end,false),'paidUntil',v_subscription.period_end);
end; $$;

create or replace function public.noteject_reserve_ai_action(p_user_id uuid, p_action_kind text, p_request_id uuid,p_livemode boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_account jsonb; v_limit integer; v_used integer; v_event bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  if p_user_id is null or p_request_id is null or p_action_kind not in ('basic','advanced') or p_action_kind is null then raise exception 'Invalid action'; end if;
  perform pg_advisory_xact_lock(hashtext('noteject-ai'), hashtext(p_user_id::text));
  if exists(select 1 from public.ai_usage_events where user_id=p_user_id and request_id=p_request_id) then raise exception 'AI_DUPLICATE_REQUEST'; end if;
  v_account := public.noteject_ai_account(p_user_id,p_livemode);
  v_limit := (v_account->p_action_kind->>'limit')::integer;
  v_used := (v_account->p_action_kind->>'used')::integer;
  if v_limit = 0 then raise exception 'AI_ADVANCED_UNAVAILABLE'; end if;
  if v_used >= v_limit then raise exception 'AI_MONTHLY_LIMIT'; end if;
  if (select count(*) from public.ai_usage_events where user_id=p_user_id and created_at > now()-interval '1 minute') >= 10 then raise exception 'AI_RATE_LIMIT'; end if;
  if (select count(*) from public.ai_usage_events where user_id=p_user_id and status='reserved' and created_at > now()-interval '3 minutes') >= 2 then raise exception 'AI_BUSY'; end if;
  insert into public.ai_usage_events(user_id,status,action_kind,request_id,billing_livemode) values(p_user_id,'reserved',p_action_kind,p_request_id,p_livemode) returning id into v_event;
  return jsonb_build_object('id',v_event,'plan',v_account->>'plan','kind',p_action_kind,'remaining',v_limit-v_used-1);
end; $$;

create or replace function public.noteject_complete_ai_action(p_user_id uuid,p_event_id bigint,p_model text,p_input_tokens integer,p_output_tokens integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  update public.ai_usage_events set status='complete',model=left(p_model,100),input_tokens=greatest(0,least(coalesce(p_input_tokens,0),2000000)),
    output_tokens=greatest(0,least(coalesce(p_output_tokens,0),2000000)),completed_at=now()
    where id=p_event_id and user_id=p_user_id and status='reserved';
  return found;
end; $$;
create or replace function public.noteject_fail_ai_action(p_user_id uuid,p_event_id bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  update public.ai_usage_events set status='failed',completed_at=now() where id=p_event_id and user_id=p_user_id and status='reserved';
  return found;
end; $$;

create or replace function public.noteject_save_billing_customer(p_user_id uuid,p_customer_id text,p_livemode boolean,p_provider text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_customer_id text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  if p_user_id is null or p_customer_id is null or p_provider is null or p_provider not in ('stripe','paddle') then raise exception 'Invalid billing customer'; end if;
  perform pg_advisory_xact_lock(hashtext('noteject-customer'), hashtext(p_user_id::text || ':' || p_livemode::text || ':' || p_provider));
  select customer_id into v_customer_id from public.noteject_billing_customers
    where user_id=p_user_id and livemode=p_livemode and provider=p_provider for update;
  if v_customer_id is null then
    insert into public.noteject_billing_customers(user_id,livemode,provider,customer_id)
      values(p_user_id,p_livemode,p_provider,p_customer_id)
      on conflict(user_id,livemode,provider) do nothing;
    select customer_id into v_customer_id from public.noteject_billing_customers
      where user_id=p_user_id and livemode=p_livemode and provider=p_provider;
  end if;
  return jsonb_build_object('customer_id',v_customer_id);
end; $$;

create or replace function public.noteject_begin_checkout(p_user_id uuid,p_plan_id text,p_livemode boolean default false,p_provider text default 'stripe')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_customer public.noteject_billing_customers%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  if p_plan_id not in ('starter','pro') or p_plan_id is null or p_provider is null or p_provider not in ('stripe','paddle') then raise exception 'Invalid checkout plan'; end if;
  select * into v_customer from public.noteject_billing_customers where user_id=p_user_id and livemode=p_livemode and provider=p_provider for update;
  if not found then raise exception 'Billing customer not found'; end if;
  if v_customer.checkout_nonce is not null and v_customer.checkout_started_at > now()-interval '90 seconds' then
    if v_customer.checkout_plan <> p_plan_id then raise exception 'BILLING_BUSY'; end if;
    if v_customer.checkout_session_id is null then raise exception 'BILLING_BUSY'; end if;
  else
    update public.noteject_billing_customers set checkout_nonce=gen_random_uuid(),checkout_plan=p_plan_id,checkout_started_at=now(),checkout_session_id=null
      where user_id=p_user_id and livemode=p_livemode and provider=p_provider returning * into v_customer;
  end if;
  return jsonb_build_object('nonce',v_customer.checkout_nonce,'session_id',v_customer.checkout_session_id);
end; $$;

create or replace function public.noteject_restart_checkout(p_user_id uuid,p_provider text,p_livemode boolean,p_nonce uuid,p_session_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_nonce uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  update public.noteject_billing_customers set checkout_nonce=gen_random_uuid(),checkout_session_id=null,checkout_started_at=now()
    where user_id=p_user_id and provider=p_provider and livemode=p_livemode and checkout_nonce=p_nonce and checkout_session_id=p_session_id
    returning checkout_nonce into v_nonce;
  if v_nonce is null then return null; end if;
  return jsonb_build_object('nonce',v_nonce);
end; $$;

create or replace function public.noteject_apply_subscription(p_event_id text,p_event_created bigint,p_observed_at timestamptz,
  p_user_id uuid,p_customer_id text,p_subscription_id text,p_plan_id text,p_status text,p_period_end timestamptz,p_cancel_at_period_end boolean,p_livemode boolean default false,p_provider text default 'stripe')
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_inserted integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required'; end if;
  if p_provider is null or p_provider not in ('stripe','paddle') or not exists(select 1 from public.noteject_billing_customers where user_id=p_user_id and customer_id=p_customer_id and livemode=p_livemode and provider=p_provider) then raise exception 'Invalid customer owner'; end if;
  perform pg_advisory_xact_lock(hashtext('noteject-billing'), hashtext(p_user_id::text));
  insert into public.noteject_webhook_events(event_id,provider) values(p_event_id,p_provider) on conflict(provider,event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return false; end if;
  if exists(select 1 from public.noteject_subscriptions where subscription_id=p_subscription_id and provider=p_provider and user_id<>p_user_id) then raise exception 'Invalid subscription owner'; end if;
  insert into public.noteject_subscriptions(subscription_id,user_id,customer_id,provider,plan_id,status,period_end,cancel_at_period_end,event_created,observed_at,livemode)
    values(p_subscription_id,p_user_id,p_customer_id,p_provider,p_plan_id,p_status,p_period_end,p_cancel_at_period_end,p_event_created,p_observed_at,p_livemode)
    on conflict(provider,subscription_id) do update set plan_id=excluded.plan_id,status=excluded.status,period_end=excluded.period_end,
      cancel_at_period_end=excluded.cancel_at_period_end,event_created=excluded.event_created,observed_at=excluded.observed_at
    where public.noteject_subscriptions.event_created < excluded.event_created or
      (public.noteject_subscriptions.event_created = excluded.event_created and public.noteject_subscriptions.observed_at <= excluded.observed_at);
  return true;
end; $$;

revoke all on function public.noteject_ai_account(uuid,boolean), public.noteject_reserve_ai_action(uuid,text,uuid,boolean),
 public.noteject_complete_ai_action(uuid,bigint,text,integer,integer), public.noteject_fail_ai_action(uuid,bigint),
 public.noteject_save_billing_customer(uuid,text,boolean,text), public.noteject_begin_checkout(uuid,text,boolean,text),
 public.noteject_restart_checkout(uuid,text,boolean,uuid,text),
 public.noteject_apply_subscription(text,bigint,timestamptz,uuid,text,text,text,text,timestamptz,boolean,boolean,text)
 from public, anon, authenticated;
grant execute on function public.noteject_ai_account(uuid,boolean), public.noteject_reserve_ai_action(uuid,text,uuid,boolean),
 public.noteject_complete_ai_action(uuid,bigint,text,integer,integer), public.noteject_fail_ai_action(uuid,bigint),
 public.noteject_save_billing_customer(uuid,text,boolean,text), public.noteject_begin_checkout(uuid,text,boolean,text),
 public.noteject_restart_checkout(uuid,text,boolean,uuid,text),
 public.noteject_apply_subscription(text,bigint,timestamptz,uuid,text,text,text,text,timestamptz,boolean,boolean,text)
 to service_role;
commit;
