-- PlayBoard Phase 1: event-driven funnel foundation
-- Run this in Supabase SQL editor before deploying the API changes.

create extension if not exists pgcrypto;

alter table public.leads
  add column if not exists current_state text default 'lead_created',
  add column if not exists lead_score integer not null default 0,
  add column if not exists last_event_type text,
  add column if not exists last_event_at timestamptz,
  add column if not exists readiness_started_at timestamptz,
  add column if not exists readiness_completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  event_type text not null,
  event_source text not null default 'server',
  event_metadata jsonb not null default '{}'::jsonb,
  score_delta integer not null default 0,
  session_id text,
  idempotency_key text unique,
  user_agent text,
  referrer text,
  ip_hash text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists lead_events_lead_id_occurred_at_idx on public.lead_events (lead_id, occurred_at desc);
create index if not exists lead_events_event_type_occurred_at_idx on public.lead_events (event_type, occurred_at desc);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete set null,
  campaign_key text not null,
  provider text not null default 'resend',
  provider_message_id text,
  to_email text not null,
  subject text,
  status text not null default 'queued',
  tracking_open_url text,
  tracking_click_url text,
  metadata jsonb not null default '{}'::jsonb,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_messages_lead_id_created_at_idx on public.email_messages (lead_id, created_at desc);
create index if not exists email_messages_status_queued_at_idx on public.email_messages (status, queued_at);

create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  email_message_id uuid references public.email_messages(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  event_type text not null,
  provider_event_id text unique,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists email_events_message_id_occurred_at_idx on public.email_events (email_message_id, occurred_at desc);

create table if not exists public.form_sessions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  form_key text not null,
  status text not null default 'started',
  current_field text,
  fields_completed integer not null default 0,
  session_id text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists form_sessions_lead_form_status_idx on public.form_sessions (lead_id, form_key, status);

create table if not exists public.form_answers (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  form_session_id uuid references public.form_sessions(id) on delete set null,
  form_key text not null,
  field_key text not null,
  answer_value text,
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (lead_id, form_key, field_key)
);

create index if not exists form_answers_form_field_idx on public.form_answers (form_key, field_key);

create table if not exists public.lead_scores (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  score integer not null default 0,
  score_band text generated always as (
    case
      when score >= 150 then 'sales_ready'
      when score >= 80 then 'very_hot'
      when score >= 40 then 'warm'
      when score >= 10 then 'engaged'
      else 'new'
    end
  ) stored,
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_queue (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  rule_key text not null,
  status text not null default 'pending',
  priority integer not null default 100,
  run_after timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  dedupe_key text unique,
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  failed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_queue_pending_idx on public.automation_queue (status, run_after, priority) where status = 'pending';

create table if not exists public.automation_history (
  id uuid primary key default gen_random_uuid(),
  automation_queue_id uuid references public.automation_queue(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  rule_key text not null,
  action_type text not null,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists automation_history_lead_created_at_idx on public.automation_history (lead_id, created_at desc);

alter table public.lead_events enable row level security;
alter table public.email_messages enable row level security;
alter table public.email_events enable row level security;
alter table public.form_sessions enable row level security;
alter table public.form_answers enable row level security;
alter table public.lead_scores enable row level security;
alter table public.automation_queue enable row level security;
alter table public.automation_history enable row level security;

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

drop trigger if exists set_leads_updated_at on public.leads;
create trigger set_leads_updated_at before update on public.leads for each row execute function public.set_updated_at();

drop trigger if exists set_email_messages_updated_at on public.email_messages;
create trigger set_email_messages_updated_at before update on public.email_messages for each row execute function public.set_updated_at();

drop trigger if exists set_form_sessions_updated_at on public.form_sessions;
create trigger set_form_sessions_updated_at before update on public.form_sessions for each row execute function public.set_updated_at();

drop trigger if exists set_automation_queue_updated_at on public.automation_queue;
create trigger set_automation_queue_updated_at before update on public.automation_queue for each row execute function public.set_updated_at();

insert into public.lead_scores (lead_id, score, updated_at)
select id, coalesce(lead_score, 0), now()
from public.leads
on conflict (lead_id) do nothing;
