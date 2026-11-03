-- Faangin account/billing storage. Root combines this reviewed local source into a CLI-created migration.
-- No application table is exposed to browser roles; privileged Edge clients call narrow service-only RPCs.
create schema if not exists faangin;
revoke all on schema faangin from public, anon, authenticated;
grant usage on schema faangin to service_role;

create table faangin.entitlements (
  uid uuid primary key references auth.users(id),
  document jsonb not null default '{"plan":"none","status":"active","updatedAt":0}'::jsonb,
  version bigint not null default 0 check (version >= 0),
  check (jsonb_typeof(document) = 'object'),
  check (document ? 'plan' and document->>'plan' in ('none','byok','pro')),
  check (document ? 'status' and document->>'status' in ('active','past_due','canceled','revoked'))
);
create table faangin.customers (
  uid uuid primary key references auth.users(id),
  stripe_customer_id text not null unique check (stripe_customer_id like 'cus\_%'),
  email text,
  created_at timestamptz not null default now()
);
create table faangin.device_codes (
  user_code text primary key check (user_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
  device_code_hash text not null unique check (device_code_hash ~ '^[0-9a-f]{64}$'),
  device_id text not null unique check (device_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  device_name text not null check (length(device_name) between 1 and 64 and length(btrim(device_name)) > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','exchanging')),
  uid uuid references auth.users(id),
  exchange_owner uuid,
  exchange_expires_at timestamptz,
  check ((status = 'pending' and uid is null and exchange_owner is null) or (status = 'approved' and uid is not null and exchange_owner is null) or (status = 'exchanging' and uid is not null and exchange_owner is not null and exchange_expires_at is not null))
);
create index faangin_device_codes_expiry on faangin.device_codes(expires_at);
create table faangin.devices (
  uid uuid not null references auth.users(id),
  device_id text not null check (device_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  name text not null check (length(name) between 1 and 64 and length(btrim(name)) > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_license_at timestamptz not null default now(),
  primary key (uid,device_id)
);
create index faangin_devices_active on faangin.devices(uid,last_seen_at);
create table faangin.checkout_leases (
  uid uuid primary key references auth.users(id), owner uuid not null, expires_at timestamptz not null
);
create table faangin.stripe_events (
  event_id text primary key, event_type text not null, owner uuid not null,
  claimed_at timestamptz not null default now(), processed_at timestamptz, outcome text
);
create index faangin_stripe_events_pending on faangin.stripe_events(claimed_at) where processed_at is null;
create table faangin.flags (key text primary key, document jsonb not null check (jsonb_typeof(document) = 'object'));
create table faangin.stats (key text primary key, active_seats integer not null default 0 check (active_seats >= 0));
insert into faangin.flags(key,document) values ('global','{"checkoutOpen":true,"proSessionsOpen":true,"smartToFast":false,"handsfreeOff":false,"transcriptionOff":false,"blockedUids":[],"proSeatCap":200,"automaticTax":false,"termsConsent":false}'::jsonb);
insert into faangin.stats(key,active_seats) values ('pro',0);

alter table faangin.entitlements enable row level security;
alter table faangin.customers enable row level security;
alter table faangin.device_codes enable row level security;
alter table faangin.devices enable row level security;
alter table faangin.checkout_leases enable row level security;
alter table faangin.stripe_events enable row level security;
alter table faangin.flags enable row level security;
alter table faangin.stats enable row level security;
revoke all on faangin.entitlements,faangin.customers,faangin.device_codes,faangin.devices,faangin.checkout_leases,faangin.stripe_events,faangin.flags,faangin.stats from public,anon,authenticated;
grant select,insert,update,delete on faangin.entitlements,faangin.customers,faangin.device_codes,faangin.devices,faangin.checkout_leases,faangin.stripe_events,faangin.flags,faangin.stats to service_role;

create function public.faangin_entitlement_read(p_uid uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select jsonb_build_object('document',coalesce(e.document,'{"plan":"none","status":"active","updatedAt":0}'::jsonb),'version',coalesce(e.version,0))
  from (select 1) x left join faangin.entitlements e on e.uid = p_uid;
$$;
create function public.faangin_billing_state(p_uid uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select jsonb_build_object('entitlement',public.faangin_entitlement_read(p_uid),'flags',coalesce((select document from faangin.flags where key='global'),'{}'::jsonb),'activeSeats',coalesce((select active_seats from faangin.stats where key='pro'),0));
$$;
create function public.faangin_customer_get(p_uid uuid) returns text
language sql security invoker set search_path = '' as $$ select stripe_customer_id from faangin.customers where uid=p_uid; $$;
create function public.faangin_customer_uid(p_customer text) returns uuid
language sql security invoker set search_path = '' as $$ select uid from faangin.customers where stripe_customer_id=p_customer; $$;
create function public.faangin_customer_bind(p_uid uuid,p_customer text,p_email text) returns text
language plpgsql security invoker set search_path = '' as $$
declare v_customer text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_uid::text,0));
  select stripe_customer_id into v_customer from faangin.customers where uid=p_uid;
  if v_customer is not null then return v_customer; end if;
  insert into faangin.customers(uid,stripe_customer_id,email) values(p_uid,p_customer,p_email);
  return p_customer;
end;
$$;

create function public.faangin_device_start(p_user_code text,p_hash text,p_device_id text,p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('device:'||p_device_id,0));
  v_expires := v_now + interval '10 minutes';
  insert into faangin.device_codes(user_code,device_code_hash,device_id,device_name,created_at,expires_at)
  values(p_user_code,p_hash,p_device_id,p_name,v_now,v_expires)
  on conflict(device_id) do update set user_code=excluded.user_code,device_code_hash=excluded.device_code_hash,device_name=excluded.device_name,created_at=v_now,expires_at=v_expires,status='pending',uid=null,exchange_owner=null,exchange_expires_at=null;
  return jsonb_build_object('expiresAt',floor(extract(epoch from v_expires)*1000));
end;
$$;
create function public.faangin_device_approve(p_user_code text,p_uid uuid) returns text
language plpgsql security invoker set search_path = '' as $$
declare v_code faangin.device_codes%rowtype;
begin
  select * into v_code from faangin.device_codes where user_code=p_user_code for update;
  if not found or v_code.expires_at <= clock_timestamp() then raise exception using errcode='FA404',message='Unknown or expired code'; end if;
  if v_code.status <> 'pending' then raise exception using errcode='FA409',message='Code already approved'; end if;
  update faangin.device_codes set status='approved',uid=p_uid where user_code=p_user_code;
  return v_code.device_name;
end;
$$;
create function public.faangin_device_claim(p_hash text,p_owner uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_code faangin.device_codes%rowtype; v_now timestamptz := clock_timestamp();
begin
  select * into v_code from faangin.device_codes where device_code_hash=p_hash for update;
  if not found or v_code.expires_at <= v_now then return jsonb_build_object('status','expired'); end if;
  if v_code.status='pending' then return jsonb_build_object('status','pending'); end if;
  if v_code.status='exchanging' and v_code.exchange_expires_at > v_now then return jsonb_build_object('status','pending'); end if;
  -- Longer than a hosted Edge invocation; a dead worker cannot compete with a live issuer after takeover.
  update faangin.device_codes set status='exchanging',exchange_owner=p_owner,exchange_expires_at=least(expires_at,v_now+interval '10 minutes') where user_code=v_code.user_code;
  return jsonb_build_object('status','claimed','uid',v_code.uid,'deviceId',v_code.device_id,'deviceName',v_code.device_name);
end;
$$;
create function public.faangin_device_complete(p_hash text,p_owner uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_deleted text;
begin
  delete from faangin.device_codes where device_code_hash=p_hash and status='exchanging' and exchange_owner=p_owner and expires_at>clock_timestamp() returning user_code into v_deleted;
  return v_deleted is not null;
end;
$$;
create function public.faangin_device_release(p_hash text,p_owner uuid) returns void
language sql security invoker set search_path = '' as $$
  update faangin.device_codes set status='approved',exchange_owner=null,exchange_expires_at=null where device_code_hash=p_hash and status='exchanging' and exchange_owner=p_owner and expires_at>clock_timestamp();
$$;
create function public.faangin_device_touch(p_uid uuid,p_device_id text,p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_state jsonb; v_now timestamptz := clock_timestamp(); v_active boolean; v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_uid::text,0));
  v_state := public.faangin_entitlement_read(p_uid);
  if not ((v_state->'document'->>'plan'='byok' and v_state->'document'->>'status'='active') or (v_state->'document'->>'plan'='pro' and v_state->'document'->>'status' in ('active','past_due'))) then raise exception using errcode='FA409',message='No active plan'; end if;
  select exists(select 1 from faangin.devices where uid=p_uid and device_id=p_device_id and last_seen_at>=v_now-interval '30 days'),count(*) into v_active,v_count from faangin.devices where uid=p_uid and last_seen_at>=v_now-interval '30 days';
  if not v_active and v_count>=3 then raise exception using errcode='FA429',message='Up to 3 devices in 30 days'; end if;
  insert into faangin.devices(uid,device_id,name,first_seen_at,last_seen_at,last_license_at) values(p_uid,p_device_id,p_name,v_now,v_now,v_now)
  on conflict(uid,device_id) do update set name=p_name,last_seen_at=v_now,last_license_at=v_now;
  return v_state || jsonb_build_object('now',floor(extract(epoch from v_now)*1000));
end;
$$;

create function public.faangin_checkout_claim(p_uid uuid,p_owner uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid;
begin
  insert into faangin.checkout_leases(uid,owner,expires_at) values(p_uid,p_owner,clock_timestamp()+interval '5 minutes')
  on conflict(uid) do update set owner=excluded.owner,expires_at=excluded.expires_at where faangin.checkout_leases.expires_at<=clock_timestamp()
  returning owner into v_owner;
  return coalesce(v_owner=p_owner,false);
end;
$$;
create function public.faangin_checkout_release(p_uid uuid,p_owner uuid) returns void
language sql security invoker set search_path = '' as $$ delete from faangin.checkout_leases where uid=p_uid and owner=p_owner; $$;

create function public.faangin_stripe_claim(p_event_id text,p_type text,p_owner uuid) returns text
language plpgsql security invoker set search_path = '' as $$
declare v_event faangin.stripe_events%rowtype;
begin
  insert into faangin.stripe_events(event_id,event_type,owner) values(p_event_id,p_type,p_owner) on conflict(event_id) do nothing;
  select * into v_event from faangin.stripe_events where event_id=p_event_id for update;
  if v_event.processed_at is not null then return 'processed'; end if;
  if v_event.owner=p_owner then return 'claimed'; end if;
  if v_event.claimed_at>clock_timestamp()-interval '10 minutes' then return 'inflight'; end if;
  update faangin.stripe_events set owner=p_owner,claimed_at=clock_timestamp() where event_id=p_event_id;
  return 'claimed';
end;
$$;
create function public.faangin_stripe_release(p_event_id text,p_owner uuid) returns void
language sql security invoker set search_path = '' as $$ delete from faangin.stripe_events where event_id=p_event_id and owner=p_owner and processed_at is null; $$;
create function public.faangin_stripe_ignore(p_event_id text,p_owner uuid,p_outcome text) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_id text;
begin
  update faangin.stripe_events set processed_at=clock_timestamp(),outcome=p_outcome where event_id=p_event_id and owner=p_owner and processed_at is null returning event_id into v_id;
  return v_id is not null;
end;
$$;
create function public.faangin_stripe_commit(p_uid uuid,p_version bigint,p_document jsonb,p_event_id text default null,p_owner uuid default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_current faangin.entitlements%rowtype; v_event faangin.stripe_events%rowtype; v_before boolean; v_after boolean; v_delta integer;
begin
  -- Every account operation takes this uid lock before row locks; event then stats is the fixed remaining order.
  perform pg_advisory_xact_lock(hashtextextended(p_uid::text,0));
  if p_event_id is not null then
    select * into v_event from faangin.stripe_events where event_id=p_event_id for update;
    if not found or v_event.owner is distinct from p_owner then return jsonb_build_object('kind','lost_claim'); end if;
    if v_event.processed_at is not null then return jsonb_build_object('kind','processed'); end if;
  end if;
  insert into faangin.entitlements(uid) values(p_uid) on conflict(uid) do nothing;
  select * into v_current from faangin.entitlements where uid=p_uid for update;
  if v_current.version<>p_version then return jsonb_build_object('kind','conflict','document',v_current.document,'version',v_current.version); end if;
  v_before := v_current.document->>'plan'='pro' and v_current.document->>'status' in ('active','past_due');
  v_after := p_document->>'plan'='pro' and p_document->>'status' in ('active','past_due');
  v_delta := (case when v_after then 1 else 0 end)-(case when v_before then 1 else 0 end);
  update faangin.entitlements set document=p_document,version=version+1 where uid=p_uid;
  if v_delta<>0 then
    insert into faangin.stats(key,active_seats) values('pro',greatest(0,v_delta)) on conflict(key) do update set active_seats=greatest(0,faangin.stats.active_seats+v_delta);
  end if;
  if p_event_id is not null then update faangin.stripe_events set processed_at=clock_timestamp(),outcome='applied' where event_id=p_event_id; end if;
  return jsonb_build_object('kind','committed','document',p_document,'version',v_current.version+1);
end;
$$;
create function public.faangin_reconcile_list(p_after uuid default null) returns jsonb
language sql security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('uid',uid,'document',document) order by uid),'[]'::jsonb) from (
    select uid,document from faangin.entitlements where (p_after is null or uid>p_after) and document->'pro'->>'subscriptionId' is not null and document->'pro'->>'status'<>'revoked' order by uid limit 200
  ) e;
$$;

-- Revoke every freshly created Faangin function's default PUBLIC execution, including direct role grants.
do $$
declare v_function record;
begin
  for v_function in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
    'faangin_entitlement_read','faangin_billing_state','faangin_customer_get','faangin_customer_uid','faangin_customer_bind',
    'faangin_device_start','faangin_device_approve','faangin_device_claim','faangin_device_complete','faangin_device_release','faangin_device_touch',
    'faangin_checkout_claim','faangin_checkout_release','faangin_stripe_claim','faangin_stripe_release','faangin_stripe_ignore','faangin_stripe_commit','faangin_reconcile_list'
  ) loop
    execute format('revoke all on function %s from public,anon,authenticated',v_function.signature);
    execute format('grant execute on function %s to service_role',v_function.signature);
  end loop;
end;
$$;
