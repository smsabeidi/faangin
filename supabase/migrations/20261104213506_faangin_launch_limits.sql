-- Launch limits: room for 100,000 Pro subscribers and 100,000 active devices per account.
update faangin.flags set document = document || '{"proSeatCap":100000}'::jsonb where key = 'global';

create or replace function public.faangin_device_touch(p_uid uuid,p_device_id text,p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_state jsonb; v_now timestamptz := clock_timestamp(); v_active boolean; v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_uid::text,0));
  v_state := public.faangin_entitlement_read(p_uid);
  if not ((v_state->'document'->>'plan'='byok' and v_state->'document'->>'status'='active') or (v_state->'document'->>'plan'='pro' and v_state->'document'->>'status' in ('active','past_due'))) then raise exception using errcode='FA409',message='No active plan'; end if;
  select exists(select 1 from faangin.devices where uid=p_uid and device_id=p_device_id and last_seen_at>=v_now-interval '30 days'),count(*) into v_active,v_count from faangin.devices where uid=p_uid and last_seen_at>=v_now-interval '30 days';
  if not v_active and v_count>=100000 then raise exception using errcode='FA429',message='Up to 100000 devices in 30 days'; end if;
  insert into faangin.devices(uid,device_id,name,first_seen_at,last_seen_at,last_license_at) values(p_uid,p_device_id,p_name,v_now,v_now,v_now)
  on conflict(uid,device_id) do update set name=p_name,last_seen_at=v_now,last_license_at=v_now;
  return v_state || jsonb_build_object('now',floor(extract(epoch from v_now)*1000));
end;
$$;
