-- Intake Desk schema. Safe to run more than once (npm run db:setup).

create sequence if not exists referral_no_seq start with 1001;

create table if not exists referrals (
  id            uuid primary key default gen_random_uuid(),
  ref_no        text not null unique default ('R-' || nextval('referral_no_seq')),
  received_at   timestamptz not null default now(),
  status        text not null,
  owner         text,
  start_of_care date,
  -- { field_key: { value, confidence, evidence, source, verified } }, shaped by config/intake.yaml
  data          jsonb not null default '{}'::jsonb,
  -- [{ key, label, kind, blocking, field?, message? }]
  flags         jsonb not null default '[]'::jsonb,
  -- { model, ms, fallbackUsed, error? }
  extraction    jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists referrals_status_idx on referrals (status);
create index if not exists referrals_received_idx on referrals (received_at desc);
-- So the queue can be queried by flag or field in SQL, for example:
--   select ref_no from referrals where flags @> '[{"key": "unsigned_order"}]';
--   select ref_no from referrals where data @> '{"payer_type": {"value": "medicare"}}';
create index if not exists referrals_flags_idx on referrals using gin (flags jsonb_path_ops);
create index if not exists referrals_data_idx on referrals using gin (data jsonb_path_ops);

create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  referral_id uuid not null references referrals (id) on delete cascade,
  filename    text not null,
  mime        text not null,
  -- The same fax uploaded twice maps to one referral, even under concurrent uploads.
  sha256      text not null unique,
  bytes       bytea not null,
  created_at  timestamptz not null default now()
);

create index if not exists documents_referral_idx on documents (referral_id);

create table if not exists saved_views (
  slug         text primary key,
  title        text not null,
  config       jsonb not null,
  yaml         text not null,
  prompt       text,
  created_by   text not null,
  created_role text not null,
  created_at   timestamptz not null default now()
);

-- Every view and change, allowed or denied. It stores field names, never field
-- values, so the log never turns into a second copy of patient data.
create table if not exists audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  role        text not null,
  action      text not null,
  outcome     text not null check (outcome in ('allowed', 'denied')),
  referral_id uuid,
  fields      jsonb not null default '[]'::jsonb,
  detail      jsonb not null default '{}'::jsonb
);

create index if not exists audit_log_referral_idx on audit_log (referral_id, id desc);

-- The audit log is append-only. Updates, deletes and truncates are refused.
create or replace function audit_log_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

drop trigger if exists audit_log_no_change on audit_log;
create trigger audit_log_no_change
  before update or delete on audit_log
  for each row execute function audit_log_append_only();

drop trigger if exists audit_log_no_truncate on audit_log;
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_log_append_only();
