-- Gateway-only Supabase schema. Combine with backend/supabase/schema-billing.sql before deployment.
create schema if not exists faangin;
create table if not exists faangin.gateway_usage (
  uid uuid not null references auth.users(id) on delete cascade,
  period text not null check (length(period) between 1 and 64),
  document jsonb not null default '{}'::jsonb,
  primary key (uid, period)
);
create table if not exists faangin.gateway_leases (
  uid uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('answers','audio')),
  id text not null check (length(id) between 1 and 128),
  expires_at bigint not null,
  primary key (uid,kind,id)
);
create index if not exists gateway_leases_expiry on faangin.gateway_leases(uid,kind,expires_at);
alter table faangin.gateway_usage enable row level security;
alter table faangin.gateway_leases enable row level security;
revoke all on faangin.gateway_usage,faangin.gateway_leases from public,anon,authenticated;
grant usage on schema faangin to service_role;
grant select,insert,update,delete on faangin.gateway_usage,faangin.gateway_leases to service_role;

create or replace function faangin.gateway_empty_usage() returns jsonb
language sql immutable security invoker set search_path='' as $$
  select '{"audioSeconds":0,"handsfree":0,"fast":0,"smart":0,"spendUsd":0,"days":{}}'::jsonb
$$;

create or replace function public.faangin_gateway_usage(p_uid uuid,p_period text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select faangin.gateway_empty_usage() || coalesce((select document from faangin.gateway_usage where uid=p_uid and period=p_period),'{}'::jsonb)
$$;

-- Internal mutation; callers hold the uid transaction lock. All arithmetic remains inside this transaction.
create or replace function faangin.gateway_increment_locked(p_uid uuid,p_period text,p_day text,p_delta jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare u jsonb; d jsonb; k text; n numeric;
begin
  u := public.faangin_gateway_usage(p_uid,p_period);
  if p_day !~ '^\d{4}-\d{2}-\d{2}$' or jsonb_typeof(p_delta)<>'object' then raise exception 'invalid usage delta'; end if;
  for k in select jsonb_object_keys(p_delta) loop
    if k not in ('audioSeconds','handsfree','fast','smart','spendUsd','graceUsedAt') or jsonb_typeof(p_delta->k)<>'number' then raise exception 'invalid usage delta'; end if;
    n := (p_delta->>k)::numeric;
    if n<0 then raise exception 'invalid usage delta'; end if;
    if k='graceUsedAt' then u:=jsonb_set(u,array[k],to_jsonb(n));
    else u:=jsonb_set(u,array[k],to_jsonb(coalesce((u->>k)::numeric,0)+n)); end if;
  end loop;
  d:=coalesce(u->'days'->p_day,'{"audioSeconds":0,"spendUsd":0}'::jsonb);
  for k in select unnest(array['audioSeconds','spendUsd']) loop
    if p_delta ? k then d:=jsonb_set(d,array[k],to_jsonb(coalesce((d->>k)::numeric,0)+(p_delta->>k)::numeric)); end if;
  end loop;
  if p_delta ? 'audioSeconds' or p_delta ? 'spendUsd' then u:=jsonb_set(u,array['days',p_day],d); end if;
  insert into faangin.gateway_usage(uid,period,document) values(p_uid,p_period,u)
  on conflict(uid,period) do update set document=excluded.document;
end
$$;

create or replace function public.faangin_gateway_increment(p_uid uuid,p_period text,p_day text,p_delta jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('faangin:gateway:'||p_uid::text,0));
  perform faangin.gateway_increment_locked(p_uid,p_period,p_day,p_delta);
end
$$;

create or replace function public.faangin_gateway_admit_answer(p_uid uuid,p_period text,p_input jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare u jsonb; mode text:=p_input->>'mode'; lim jsonb:=p_input->'limits'; now_ms bigint:=(p_input->>'now')::bigint; downgraded boolean:=false; running integer;
begin
  if mode not in ('fast','smart','handsfree') or length(p_input->>'leaseId') not between 1 and 128 then raise exception 'invalid admission'; end if;
  perform pg_advisory_xact_lock(hashtextextended('faangin:gateway:'||p_uid::text,0));
  delete from faangin.gateway_leases where uid=p_uid and expires_at<=now_ms;
  select count(*) into running from faangin.gateway_leases where uid=p_uid and kind='answers';
  if running >= least((lim->>'maxAnswers')::integer,2) then return '{"kind":"concurrency"}'::jsonb; end if;
  u:=public.faangin_gateway_usage(p_uid,p_period);
  if mode='smart' and ((u->>'smart')::numeric >= (lim->>'smart')::numeric or coalesce((p_input->'flags'->>'smartToFast')::boolean,false)) then mode:='fast'; downgraded:=true; end if;
  if mode='fast' and (u->>'fast')::numeric >= (lim->>'fast')::numeric then return '{"kind":"exhausted","allowance":"fast"}'::jsonb; end if;
  if mode='handsfree' and ((u->>'handsfree')::numeric >= (lim->>'handsfree')::numeric or coalesce((p_input->'flags'->>'handsfreeOff')::boolean,false)) then return '{"kind":"skip"}'::jsonb; end if;
  if (u->>'spendUsd')::numeric >= (lim->>'monthUsd')::numeric or coalesce((u->'days'->(p_input->>'day')->>'spendUsd')::numeric,0) >= (lim->>'dayUsd')::numeric then return '{"kind":"backstop"}'::jsonb; end if;
  insert into faangin.gateway_leases(uid,kind,id,expires_at) values(p_uid,'answers',p_input->>'leaseId',least((p_input->>'expiresAt')::bigint,now_ms+135000));
  perform faangin.gateway_increment_locked(p_uid,p_period,p_input->>'day',jsonb_build_object(mode,1));
  return jsonb_build_object('kind','run','mode',mode,'downgraded',downgraded);
end
$$;

create or replace function public.faangin_gateway_claim_lease(p_uid uuid,p_kind text,p_id text,p_now bigint,p_expires_at bigint,p_limit integer,p_renew_only boolean default false) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer; present boolean;
begin
  if p_kind not in ('answers','audio') or length(p_id) not between 1 and 128 or p_limit not between 1 and 2 or p_expires_at<=p_now then raise exception 'invalid lease'; end if;
  perform pg_advisory_xact_lock(hashtextextended('faangin:gateway:'||p_uid::text,0));
  delete from faangin.gateway_leases where uid=p_uid and expires_at<=p_now;
  select exists(select 1 from faangin.gateway_leases where uid=p_uid and kind=p_kind and id=p_id) into present;
  select count(*) into n from faangin.gateway_leases where uid=p_uid and kind=p_kind;
  if not present and (p_renew_only or n>=p_limit) then return false; end if;
  insert into faangin.gateway_leases(uid,kind,id,expires_at) values(p_uid,p_kind,p_id,least(p_expires_at,p_now+135000))
  on conflict(uid,kind,id) do update set expires_at=excluded.expires_at;
  return true;
end
$$;

create or replace function public.faangin_gateway_release_lease(p_uid uuid,p_kind text,p_id text) returns void
language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('faangin:gateway:'||p_uid::text,0));
  delete from faangin.gateway_leases where uid=p_uid and kind=p_kind and id=p_id;
end
$$;

create or replace function public.faangin_gateway_claim_grace(p_uid uuid,p_period text,p_now bigint) returns bigint
language plpgsql security invoker set search_path='' as $$
declare u jsonb; first_ms bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('faangin:gateway:'||p_uid::text,0));
  u:=public.faangin_gateway_usage(p_uid,p_period);
  first_ms:=coalesce((u->>'graceUsedAt')::bigint,p_now);
  insert into faangin.gateway_usage(uid,period,document) values(p_uid,p_period,jsonb_set(u,'{graceUsedAt}',to_jsonb(first_ms)))
  on conflict(uid,period) do update set document=excluded.document;
  return first_ms;
end
$$;

create or replace function public.faangin_gateway_entitlement(p_uid uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select document from faangin.entitlements where uid=p_uid
$$;
create or replace function public.faangin_gateway_flags() returns jsonb
language sql stable security invoker set search_path='' as $$
  select document from faangin.flags where key='global'
$$;

-- RPCs are an internal server API: no anonymous or authenticated caller can execute them.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname like 'faangin_gateway_%') or (n.nspname='faangin' and p.proname like 'gateway_%') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
