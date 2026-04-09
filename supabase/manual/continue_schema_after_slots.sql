-- РУЧНОЙ скрипт для Supabase SQL Editor, если вы уже создали только public.slots,
-- а clients / appointments / payment_events / settings ещё нет.
-- Полный вариант для новых проектов: supabase/migrations/20260404120000_initial.sql целиком.

drop index if exists public.slots_starts_at_idx;
create unique index slots_starts_at_idx on public.slots (starts_at);

comment on table public.slots is
  'Слоты приёма; календарь и часы в приложении — Иркутск. Пять стандартных окон в день создаёт бот (AUTO_SLOTS_*).';

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  telegram_username text,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.slots (id) on delete restrict,
  client_id uuid not null references public.clients (id) on delete restrict,
  status text not null
    check (status in ('pending_payment', 'confirmed', 'cancelled', 'completed')),
  session_price_min_rub int not null default 3500,
  session_price_max_rub int not null default 6000,
  prepayment_rub int not null default 500,
  yookassa_payment_id text unique,
  idempotency_key text unique,
  notes text,
  reminder_2h_sent_at timestamptz,
  reminder_1h_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists appointments_active_slot_idx
  on public.appointments (slot_id)
  where status in ('pending_payment', 'confirmed');

create index if not exists appointments_client_idx on public.appointments (client_id);
create index if not exists appointments_status_idx on public.appointments (status);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  yookassa_event_id text not null unique,
  appointment_id uuid references public.appointments (id) on delete set null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

alter table public.slots enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.payment_events enable row level security;
alter table public.settings enable row level security;

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists clients_updated_at on public.clients;
create trigger clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

drop trigger if exists appointments_updated_at on public.appointments;
create trigger appointments_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

alter table public.appointments
  add column if not exists reminder_skip_one_hour boolean not null default false;
