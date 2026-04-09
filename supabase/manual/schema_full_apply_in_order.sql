-- =============================================================================
-- hijama-no1-bot: ПОЛНАЯ схема — только для ПУСТОЙ / НОВОЙ базы Supabase
--
-- ВНИМАНИЕ: если таблица public.slots УЖЕ существует, НЕ запускайте этот файл
-- (будет ERROR: relation "slots" already exists).
-- Вместо этого выполните: supabase/manual/apply_incremental_only.sql
--
-- Команды SQL только на английском (CREATE TABLE, …). Комментарии — на русском.
-- Очистка старых слотов в конце месяца — в коде бота (Node.js), не здесь.
-- =============================================================================

-- --- 20260404120000_initial.sql ---
-- hijama-no1-bot: слоты, клиенты, записи, события оплат, настройки
-- RLS: доступ с PostgREST для anon/authenticated закрыт; backend использует service_role.

create extension if not exists "pgcrypto";

create table public.slots (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_published boolean not null default true,
  is_booked boolean not null default false,
  created_at timestamptz not null default now(),
  constraint slots_ends_after_start check (ends_at > starts_at)
);

create unique index slots_starts_at_idx on public.slots (starts_at);

comment on table public.slots is
  'Слоты приёма; календарь и часы в приложении — Иркутск. Пять стандартных окон в день создаёт бот (AUTO_SLOTS_*).';

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  telegram_username text,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.appointments (
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
  reminder_skip_one_hour boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Одна активная запись (ожидание оплаты или подтверждённая) на слот
create unique index appointments_active_slot_idx
  on public.appointments (slot_id)
  where status in ('pending_payment', 'confirmed');

create index appointments_client_idx on public.appointments (client_id);
create index appointments_status_idx on public.appointments (status);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  yookassa_event_id text not null unique,
  appointment_id uuid references public.appointments (id) on delete set null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value jsonb not null
);

alter table public.slots enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.payment_events enable row level security;
alter table public.settings enable row level security;

-- Явно не создаём политики для anon/authenticated → доступ только через service_role

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

create trigger appointments_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

-- --- 20260405140000_add_yookassa_confirmation_url.sql ---
-- Ссылка на оплату ЮKassa (повтор при /start и /mybooking, пока pending_payment)

alter table public.appointments
  add column if not exists yookassa_confirmation_url text;

-- --- 20260406120000_closure_days.sql ---
-- Дни, когда запись на приём не ведётся (дата в календаре Иркутска относительно слота).
create table public.closure_days (
  day date primary key,
  created_at timestamptz not null default now()
);

alter table public.closure_days enable row level security;
