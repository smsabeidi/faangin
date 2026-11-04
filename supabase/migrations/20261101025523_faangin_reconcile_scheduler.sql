-- Service-only single-use claims for HMAC-signed scheduled reconciliation.
-- pg_cron/pg_net activation, Vault/Edge secret sync, and the project-specific job are
-- installed idempotently by backend/scripts/setup-supabase-reconcile.mjs.
create table if not exists faangin.reconcile_dispatches (
  nonce uuid primary key,
  signed_at_seconds bigint not null,
  request_id bigint unique,
  requested_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz
);
create index if not exists reconcile_dispatches_requested_at on faangin.reconcile_dispatches(requested_at);
alter table faangin.reconcile_dispatches enable row level security;
revoke all on faangin.reconcile_dispatches from public,anon,authenticated,service_role;
grant select,update on faangin.reconcile_dispatches to service_role;

create or replace function public.faangin_reconcile_dispatch_claim(p_nonce uuid,p_timestamp bigint) returns boolean
language plpgsql security invoker set search_path='' as $claim$
declare claimed uuid; now_seconds bigint:=floor(extract(epoch from clock_timestamp()))::bigint;
begin
  if p_timestamp < now_seconds-60 or p_timestamp > now_seconds+60 then return false; end if;
  update faangin.reconcile_dispatches
  set claimed_at=clock_timestamp()
  where nonce=p_nonce and signed_at_seconds=p_timestamp and claimed_at is null and request_id is not null
  returning nonce into claimed;
  return claimed is not null;
end $claim$;
revoke all on function public.faangin_reconcile_dispatch_claim(uuid,bigint) from public,anon,authenticated;
grant execute on function public.faangin_reconcile_dispatch_claim(uuid,bigint) to service_role;
